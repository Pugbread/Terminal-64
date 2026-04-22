//! Voice orchestrator — owns the state machine and coordinates the mic
//! stream, wake word detector, command STT, and dictation STT.
//!
//! States (matching the frontend contract in `src/stores/voiceStore.ts`):
//!   Idle       → listen for wake word
//!   Listening  → buffer post-wake audio, run Moonshine, classify intent
//!   Dictating  → streaming whisper.cpp, VAD-terminated, emits voice-partial
//!                then voice-final and a Dictation intent.
//!
//! Runners (wake / command / dictation / vad) are injected as trait objects
//! so the model-runtime agent can land concrete implementations without
//! touching the orchestrator. When a runner is absent, the relevant
//! transition is a no-op (the frontend stays in Idle).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::mic_manager::MicManager;
use crate::types::{VoiceIntent, VoiceIntentKind, VoiceState};

/// Split a dictation transcript around a "jarvis" marker into
/// `(residual_prompt, control_intent, has_command_tail)`.
///
/// - `residual_prompt`: tokens before "jarvis" (minus optional
///   "hey"/"ok"/"yo" filler), preserving original casing/punctuation.
/// - `control_intent`: parsed from tokens AFTER "jarvis". If an explicit
///   keyword (send/exit/rewrite/...) matches, that's the intent. If the
///   tail is non-empty but unknown, defaults to Send (unrecognized
///   follow-up still signals "commit"). If the tail is empty, caller
///   should treat this as "enter command mode" and wait for the next
///   utterance; the returned intent is a placeholder Send.
/// - `has_command_tail`: whether any tokens followed "jarvis". Caller
///   uses this to decide between firing the intent now vs. entering
///   command mode.
///
/// Address-word tokens that can precede an in-dictation command. "jarvis"
/// is always accepted so muscle memory works regardless of the configured
/// wake word. When the wake word is T64 we also accept "sixty"/"four" and
/// the spelled-out "t" so "T sixty four send" parses correctly. The parser
/// looks for a multi-token suffix match starting from the end.
/// Substring patterns that mark the boundary between residual prompt and
/// trailing command word(s). These are matched against the flattened
/// lowercased transcript (punct → space, digits intact), so whisper's
/// habit of fusing numbers into adjacent words ("64send") still parses.
fn address_substrings_for_wake(wake: &str) -> &'static [&'static str] {
    match wake {
        "t64" => &[
            // Canonical written form.
            "sixty four",
            "sixty-four",
            "sixtyfour",
            // Whisper's fused forms when you actually say "T sixty four".
            "t64",
            "t 64",
            "tee 64",
            "tee sixty four",
            // Bare number — last-resort. Longer substrings win on ties
            // (see rfind + tie-break in split_address), so "t64" and
            // "sixty four" take precedence when present.
            "64",
        ],
        _ => &["hey jarvis", "ok jarvis", "okay jarvis", "jarvis"],
    }
}

/// Command-word substrings (no word-boundary requirement) — matched in
/// the tail text after the address. Ordered longer-first so "submit"
/// isn't shadowed by "sub" etc.
const CMD_SEND: &[&str] = &["submit", "sendit", "send", "ship", "fire", "go"];
const CMD_EXIT: &[&str] = &[
    "cancel",
    "nevermind",
    "abort",
    "scratch",
    "quit",
    "stop",
    "exit",
    "never",
];
const CMD_REWRITE: &[&str] = &["rephrase", "rewrite", "cleanup", "polish", "clean", "fix"];

fn classify_command_tail_str(tail: &str) -> VoiceIntent {
    let t = tail.to_ascii_lowercase();
    for w in CMD_SEND {
        if t.contains(w) {
            return VoiceIntent::send();
        }
    }
    for w in CMD_EXIT {
        if t.contains(w) {
            return VoiceIntent::exit();
        }
    }
    for w in CMD_REWRITE {
        if t.contains(w) {
            return VoiceIntent::rewrite();
        }
    }
    // Non-empty tail with unknown word → default Send.
    VoiceIntent::send()
}

/// Returns `None` when no address substring is found.
///
/// Matches on the flattened lowercased transcript (letters/digits kept,
/// punctuation → space, run of spaces collapsed). This lets it handle
/// whisper's quirk of fusing numbers with adjacent words, e.g. "64send"
/// or "64cend" — it finds "64" and the tail "send"/"cend" is then
/// substring-matched for command words.
fn split_address(text: &str, wake: &str) -> Option<(String, VoiceIntent, bool)> {
    // Build the flattened string + a map from flat-index → original-index
    // so we can reconstruct the residual with original casing/punctuation.
    let mut flat = String::with_capacity(text.len());
    let mut flat_to_orig: Vec<usize> = Vec::with_capacity(text.len());
    let mut prev_space = true;
    for (i, c) in text.char_indices() {
        let ok = c.is_alphanumeric();
        let space = c.is_whitespace();
        if ok {
            flat.push(c.to_ascii_lowercase());
            flat_to_orig.push(i);
            prev_space = false;
        } else if (space || !ok) && !prev_space {
            flat.push(' ');
            flat_to_orig.push(i);
            prev_space = true;
        }
    }
    if flat.trim().is_empty() {
        return None;
    }

    // Find the RIGHTMOST occurrence of any address substring in flat.
    let addresses = address_substrings_for_wake(wake);
    let mut best: Option<(usize, usize)> = None; // (flat_start, substr_len)
    for addr in addresses {
        // rfind handles overlap correctly and is O(n·m) which is fine here.
        if let Some(pos) = flat.rfind(addr) {
            let len = addr.len();
            match best {
                Some((prev_pos, _)) if prev_pos >= pos => {}
                _ => best = Some((pos, len)),
            }
        }
    }
    // Tie-break: among matches ending AT the same flat position, prefer
    // the longest substring ("sixty four" over "64" if both end there).
    for addr in addresses {
        if let Some(pos) = flat.rfind(addr) {
            let len = addr.len();
            if let Some((best_pos, best_len)) = best {
                if pos + len == best_pos + best_len && len > best_len {
                    best = Some((pos, len));
                }
            }
        }
    }
    let (flat_start, flat_addr_len) = best?;
    let flat_addr_end = flat_start + flat_addr_len;

    // Tail text (after the address) for command classification.
    let tail_flat = flat[flat_addr_end..].trim();
    let has_command_tail = !tail_flat.is_empty();
    let intent = if has_command_tail {
        classify_command_tail_str(tail_flat)
    } else {
        // Empty tail → no command was spoken after the address; caller
        // will treat this as "enter command mode" and wait for the next
        // utterance. We return a placeholder intent; it's not consumed.
        VoiceIntent::send()
    };

    // Map flat_start back to the original text byte offset so we can
    // slice the residual in original form (preserving casing + punct).
    let orig_end_byte = if flat_start == 0 {
        0
    } else {
        flat_to_orig
            .get(flat_start.saturating_sub(1))
            .copied()
            .map(|b| {
                // Advance past the char at that byte so the residual
                // doesn't include the trailing space-separator.
                let c = text[b..].chars().next().map(|c| c.len_utf8()).unwrap_or(0);
                b + c
            })
            .unwrap_or(text.len())
    };
    let residual = text[..orig_end_byte.min(text.len())]
        .trim_end_matches(|c: char| {
            c.is_whitespace() || c == ',' || c == '.' || c == '!' || c == '?'
        })
        .to_string();

    Some((residual, intent, has_command_tail))
}

// ---- Runner trait contracts (implemented by the model-runtime agent) ----

/// Wake-word detector. Receives f32 frames at 16 kHz mono and returns
/// `true` when the wake word fires.
pub trait WakeRunner: Send + Sync {
    fn feed(&mut self, frame: &[f32]) -> bool;
    #[allow(dead_code)]
    fn reset(&mut self);
    /// Primary-network score threshold in 0..1. Lower = more sensitive.
    /// Called from the settings UI via `voice_set_sensitivity`.
    fn set_threshold(&mut self, t: f32) {
        let _ = t;
    }
}

/// One-shot command STT (Moonshine). Receives the captured post-wake
/// audio buffer and returns a transcript.
pub trait CommandRunner: Send + Sync {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String>;
}

/// Streaming dictation STT (whisper.cpp).
pub trait DictationRunner: Send + Sync {
    #[allow(dead_code)]
    fn start(&mut self);
    fn push(&mut self, frame: &[f32]);
    fn flush(&mut self) -> Result<String, String>;
}

/// Voice activity detector used to terminate dictation on silence.
pub trait VadDetector: Send + Sync {
    fn is_speech(&mut self, frame: &[f32]) -> bool;
    /// Reset the VAD's internal hysteresis/pad counters. The orchestrator
    /// calls this across state transitions so the `speech_pad_ms` tail of
    /// the wake word doesn't bleed into the command-capture window as
    /// false-positive speech.
    fn reset(&mut self) {}
}

// ---- Orchestrator ----

struct Runners {
    wake: Option<Box<dyn WakeRunner>>,
    command: Option<Box<dyn CommandRunner>>,
    dictation: Option<Box<dyn DictationRunner>>,
    vad: Option<Box<dyn VadDetector>>,
}

pub struct VoiceManager {
    mic: Arc<MicManager>,
    running: Arc<AtomicBool>,
    state: Arc<Mutex<VoiceState>>,
    runners: Arc<Mutex<Runners>>,
    app: Arc<Mutex<Option<AppHandle>>>,
    /// Which wake-word bundle is active. Drives the mid-dictation command
    /// parser's address-phrase set ("jarvis" vs "T sixty four").
    wake_word: Arc<Mutex<String>>,
}

impl VoiceManager {
    pub fn new(mic: Arc<MicManager>) -> Arc<Self> {
        Arc::new(Self {
            mic,
            running: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(VoiceState::Idle)),
            runners: Arc::new(Mutex::new(Runners {
                wake: None,
                command: None,
                dictation: None,
                vad: None,
            })),
            app: Arc::new(Mutex::new(None)),
            wake_word: Arc::new(Mutex::new("jarvis".to_string())),
        })
    }

    pub fn set_wake_word(&self, name: &str) {
        if let Ok(mut g) = self.wake_word.lock() {
            *g = name.to_string();
        }
    }

    // --- Runner injection (called by the model-runtime agent) ---

    #[allow(dead_code)]
    pub fn set_wake_runner(&self, r: Box<dyn WakeRunner>) {
        if let Ok(mut g) = self.runners.lock() {
            g.wake = Some(r);
        }
    }
    #[allow(dead_code)]
    pub fn set_command_runner(&self, r: Box<dyn CommandRunner>) {
        if let Ok(mut g) = self.runners.lock() {
            g.command = Some(r);
        }
    }
    #[allow(dead_code)]
    pub fn set_dictation_runner(&self, r: Box<dyn DictationRunner>) {
        if let Ok(mut g) = self.runners.lock() {
            g.dictation = Some(r);
        }
    }
    #[allow(dead_code)]
    pub fn set_vad(&self, r: Box<dyn VadDetector>) {
        if let Ok(mut g) = self.runners.lock() {
            g.vad = Some(r);
        }
    }

    // --- Lifecycle ---

    pub fn start(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        *self.app.lock().map_err(|e| e.to_string())? = Some(app.clone());

        if let Err(e) = self.mic.start(&app) {
            self.running.store(false, Ordering::SeqCst);
            self.emit_error(&format!("mic start failed: {}", e));
            return Err(e);
        }
        self.set_state(VoiceState::Idle);

        let me = Arc::clone(self);
        std::thread::spawn(move || {
            if let Err(e) = me.clone().capture_loop() {
                me.emit_error(&format!("capture loop: {}", e));
                me.set_state(VoiceState::Idle);
                me.running.store(false, Ordering::SeqCst);
            }
        });

        Ok(())
    }

    pub fn stop(&self) {
        if !self.running.swap(false, Ordering::SeqCst) {
            return;
        }
        self.mic.stop();
        self.set_state(VoiceState::Idle);
    }

    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn current_state(&self) -> VoiceState {
        self.state.lock().map(|g| *g).unwrap_or(VoiceState::Idle)
    }

    /// Set the wake-word sensitivity. Input is 0..1 from the UI slider
    /// (higher = more sensitive). Mapped to the detector's *threshold*
    /// inversely: sensitivity 1.0 → threshold 0.15 (very permissive),
    /// sensitivity 0.0 → threshold 0.7 (strict).
    pub fn set_sensitivity(&self, sensitivity: f32) {
        let s = sensitivity.clamp(0.0, 1.0);
        let threshold = 0.7 - s * (0.7 - 0.15);
        if let Ok(mut g) = self.runners.lock() {
            if let Some(w) = g.wake.as_mut() {
                w.set_threshold(threshold);
            }
        }
        safe_eprintln!(
            "[voice] sensitivity {:.2} → wake threshold {:.3}",
            s,
            threshold
        );
    }

    /// Force the state machine back to Idle and discard any in-flight
    /// dictation audio. Called from the frontend when a `SelectSession`
    /// intent's fuzzy match fails — without this, the backend would have
    /// already transitioned into Dictating and the user's next utterance
    /// would route into whatever session happened to be active last.
    pub fn abort_dictation(&self) {
        if let Ok(mut g) = self.runners.lock() {
            if let Some(r) = g.dictation.as_mut() {
                // Drain the buffer so the next real dictation starts fresh.
                let _ = r.flush();
            }
        }
        self.reset_vad();
        self.set_state(VoiceState::Idle);
        safe_eprintln!("[voice] dictation aborted (no session match)");
    }

    // --- Capture loop ---

    fn capture_loop(self: Arc<Self>) -> Result<(), String> {
        let sub = self.mic.subscribe();
        let mut command_buffer: Vec<f32> = Vec::with_capacity(16_000 * 5);
        let mut command_any_speech = false;
        let mut dictation_buffer: Vec<f32> = Vec::with_capacity(16_000 * 8);
        let mut dictation_any_speech = false;
        let mut dictation_idle_frames = 0usize;
        let mut silence_run = 0usize;
        // Command mode: set after the user says "jarvis" alone (no trailing
        // command word). The very next utterance is then parsed as a
        // command (send/exit/rewrite, default Send) rather than dictation.
        let mut command_mode = false;
        const MAX_COMMAND_SAMPLES: usize = 16_000 * 5; // 5s hard cap
        const MAX_DICTATION_SAMPLES: usize = 16_000 * 10; // 10s cap
                                                          // These counters are on TOP of the VAD's own ~800ms tail
                                                          // (min_silence_duration_ms=500 + speech_pad_ms=300).
        const SILENCE_FRAMES_TO_FINALIZE: usize = 3; // ~240ms cmd
        const DICT_SILENCE_FRAMES_TO_FINALIZE: usize = 9; // ~720ms dict
        const DICT_IDLE_TIMEOUT_FRAMES: usize = 150; // ~12s of no speech → exit Dictating

        while self.running.load(Ordering::SeqCst) {
            let frame = match sub.rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let state = self.current_state();
            match state {
                VoiceState::Idle => {
                    if self.feed_wake(&frame) {
                        command_buffer.clear();
                        command_any_speech = false;
                        silence_run = 0;
                        // Reset VAD so the wake word's own trailing
                        // `speech_pad_ms` tail doesn't bleed into the
                        // command window as false speech and immediately
                        // trip silence-finalize on an empty buffer.
                        self.reset_vad();
                        self.set_state(VoiceState::Listening);
                        self.emit_listening_progress(0.0);
                    }
                }
                VoiceState::Listening => {
                    command_buffer.extend_from_slice(&frame);
                    let is_speech = self.feed_vad(&frame);
                    if is_speech {
                        silence_run = 0;
                        command_any_speech = true;
                    } else {
                        silence_run += 1;
                    }
                    // Progress bar: shows "time until pre-speech timeout"
                    // while the user is still thinking, then "time until
                    // post-speech silence finalize" once speech starts.
                    // Flipping reference frames this way gives the user a
                    // visible signal that the window extends when they
                    // actually start talking.
                    let progress = if command_any_speech {
                        (silence_run as f32 / SILENCE_FRAMES_TO_FINALIZE as f32).clamp(0.0, 1.0)
                    } else {
                        (command_buffer.len() as f32 / MAX_COMMAND_SAMPLES as f32).clamp(0.0, 1.0)
                    };
                    self.emit_listening_progress(progress);

                    // Only hard-time-out if the user never spoke. Once speech
                    // starts, the VAD + silence_run pair owns finalization —
                    // so "Hey Jarvis" + long pause + "send" still works.
                    let timed_out =
                        !command_any_speech && command_buffer.len() >= MAX_COMMAND_SAMPLES;
                    // Only finalize on silence AFTER we've heard speech — prevents
                    // an empty-buffer bail-out when the user pauses briefly after
                    // "Hey Jarvis" before speaking the command.
                    let silence_finalize =
                        command_any_speech && silence_run >= SILENCE_FRAMES_TO_FINALIZE;
                    if timed_out || silence_finalize {
                        let buf = std::mem::take(&mut command_buffer);
                        silence_run = 0;
                        let had_speech = command_any_speech;
                        command_any_speech = false;
                        self.emit_listening_progress(1.0);
                        // If we timed out with no speech at all, just abandon — no
                        // point feeding silence to Moonshine.
                        let next_state = if !had_speech {
                            VoiceState::Idle
                        } else {
                            let ns = self.finalize_command(buf);
                            if matches!(ns, VoiceState::Dictating) {
                                dictation_buffer.clear();
                                dictation_any_speech = false;
                                self.start_dictation_runner();
                            }
                            ns
                        };
                        // Reset VAD across the boundary so the command
                        // utterance's pad tail doesn't leak into whatever
                        // state we transition into next.
                        self.reset_vad();
                        self.set_state(next_state);
                    }
                }
                VoiceState::Dictating => {
                    // Emit a cheap waveform sample for the active session's
                    // ChatInput to render behind its textarea. Downsample the
                    // 1280-sample frame to 32 peak-amplitudes — low bandwidth,
                    // 80 ms cadence, no second mic stream needed.
                    self.emit_waveform(&frame);

                    // Intentionally do NOT bail out of Dictating on a wake-word
                    // detection. Mid-dictation commands flow through the
                    // transcript + split_address parser ("T sixty four send",
                    // "Jarvis rewrite", etc) so the wake word appearing here
                    // IS the expected input, not a stuck-state escape hatch.
                    // The idle-timeout below (DICT_IDLE_TIMEOUT_FRAMES) still
                    // handles actually-stuck states without killing good
                    // dictation before the command finishes.

                    // Prefer a real streaming dictation runner when present.
                    // Otherwise buffer audio and use the command runner
                    // (Moonshine) on silence as a best-effort fallback.
                    let have_dict = self.has_dictation_runner();
                    if have_dict {
                        self.push_dictation(&frame);
                    } else {
                        dictation_buffer.extend_from_slice(&frame);
                    }
                    if self.feed_vad(&frame) {
                        silence_run = 0;
                        dictation_any_speech = true;
                        dictation_idle_frames = 0;
                    } else {
                        silence_run += 1;
                        if !dictation_any_speech {
                            dictation_idle_frames += 1;
                        }
                    }
                    let timed_out = dictation_buffer.len() >= MAX_DICTATION_SAMPLES;
                    // Safety valve #2: long idle → drop back to Idle so the
                    // user isn't stuck if VAD never fires again.
                    if !dictation_any_speech && dictation_idle_frames >= DICT_IDLE_TIMEOUT_FRAMES {
                        safe_eprintln!("[voice] dictation idle timeout → Idle");
                        dictation_buffer.clear();
                        dictation_idle_frames = 0;
                        silence_run = 0;
                        command_mode = false;
                        self.set_state(VoiceState::Idle);
                        continue;
                    }
                    if dictation_any_speech
                        && (timed_out || silence_run >= DICT_SILENCE_FRAMES_TO_FINALIZE)
                    {
                        silence_run = 0;
                        dictation_any_speech = false;
                        dictation_idle_frames = 0;
                        if have_dict {
                            command_mode = self.finalize_dictation(command_mode);
                        } else {
                            let buf = std::mem::take(&mut dictation_buffer);
                            self.finalize_dictation_via_command(buf);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn has_dictation_runner(&self) -> bool {
        self.runners
            .lock()
            .map(|g| g.dictation.is_some())
            .unwrap_or(false)
    }

    fn feed_wake(&self, frame: &[f32]) -> bool {
        let mut g = match self.runners.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match g.wake.as_mut() {
            Some(r) => r.feed(frame),
            None => false,
        }
    }

    fn feed_vad(&self, frame: &[f32]) -> bool {
        let mut g = match self.runners.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        match g.vad.as_mut() {
            Some(r) => r.is_speech(frame),
            None => {
                // No VAD available: fall back to amplitude threshold.
                let rms =
                    (frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32).sqrt();
                rms > 0.005
            }
        }
    }

    fn reset_vad(&self) {
        if let Ok(mut g) = self.runners.lock() {
            if let Some(r) = g.vad.as_mut() {
                r.reset();
            }
        }
    }

    fn push_dictation(&self, frame: &[f32]) {
        if let Ok(mut g) = self.runners.lock() {
            if let Some(r) = g.dictation.as_mut() {
                r.push(frame);
            }
        }
    }

    fn start_dictation_runner(&self) {
        if let Ok(mut g) = self.runners.lock() {
            if let Some(r) = g.dictation.as_mut() {
                r.start();
            }
        }
    }

    /// Transcribe the post-wake audio window and classify it. Returns the
    /// state the machine should transition into: `SelectSession` opens a
    /// dictation window so the user can speak their prompt without re-saying
    /// the wake word; everything else returns to Idle.
    fn finalize_command(&self, buf: Vec<f32>) -> VoiceState {
        // Feed the full VAD-terminated window; whisper handles leading/
        // trailing silence natively and trimming would clip soft onsets.
        let samples: &[f32] = &buf;
        safe_eprintln!("[voice] finalize_command: {} samples", samples.len());

        let transcript = {
            let mut g = match self.runners.lock() {
                Ok(g) => g,
                Err(_) => return VoiceState::Idle,
            };
            match g.command.as_mut() {
                Some(r) => r.transcribe(samples),
                None => return VoiceState::Idle,
            }
        };

        match transcript {
            Ok(text) => {
                safe_eprintln!("[voice] moonshine -> {:?}", text);
                if let Some(intent) = crate::voice::intent::classify(&text) {
                    let is_select = matches!(intent.kind, VoiceIntentKind::SelectSession);
                    self.emit_intent(&intent);
                    if is_select {
                        return VoiceState::Dictating;
                    }
                } else {
                    safe_eprintln!("[voice] empty command transcript (raw={:?})", text);
                }
            }
            Err(e) => {
                self.emit_error(&format!("command STT failed: {}", e));
            }
        }
        VoiceState::Idle
    }

    /// Fallback dictation path: reuses the command runner (Moonshine) to
    /// transcribe a VAD-terminated audio chunk, then emits the text as a
    /// Dictation intent. Used when no streaming dictation runner is loaded
    /// (whisper.cpp is gated behind the `voice-dictation` feature). Any
    /// keyword in the dictation window is treated as a control word and
    /// short-circuits further dictation (so you can say "Hey Jarvis, one"
    /// → speak your prompt → "send" all without re-waking).
    fn finalize_dictation_via_command(&self, buf: Vec<f32>) {
        let samples: &[f32] = &buf;
        safe_eprintln!("[voice] finalize_dictation: {} samples", samples.len());
        if samples.len() < 16_000 / 4 {
            safe_eprintln!("[voice] dictation chunk too short — skipping");
            return;
        }
        let transcript = {
            let mut g = match self.runners.lock() {
                Ok(g) => g,
                Err(_) => {
                    self.set_state(VoiceState::Idle);
                    return;
                }
            };
            match g.command.as_mut() {
                Some(r) => r.transcribe(samples),
                None => {
                    self.set_state(VoiceState::Idle);
                    return;
                }
            }
        };

        match transcript {
            Ok(text) => {
                safe_eprintln!("[voice] moonshine dict -> {:?}", text);
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    return;
                }
                // If the transcript matches a Send/Exit/Rewrite keyword,
                // treat as a control intent and exit dictation.
                if let Some(intent) = crate::voice::intent::classify(trimmed) {
                    match intent.kind {
                        VoiceIntentKind::Send
                        | VoiceIntentKind::Exit
                        | VoiceIntentKind::Rewrite => {
                            self.emit_intent(&intent);
                            self.set_state(VoiceState::Idle);
                            return;
                        }
                        _ => {}
                    }
                }
                self.emit_final(trimmed);
                self.emit_intent(&VoiceIntent::dictation(trimmed.to_string()));
            }
            Err(e) => self.emit_error(&format!("dictation STT failed: {}", e)),
        }
        // Stay in Dictating so the user can keep speaking — only an explicit
        // Send/Exit/Rewrite (handled above) returns to Idle.
    }

    /// Process a finalized dictation chunk. Returns the next value for
    /// `command_mode`: true means the orchestrator should parse the next
    /// utterance as a command only; false means back to regular dictation.
    fn finalize_dictation(&self, command_mode: bool) -> bool {
        let result = {
            let mut g = match self.runners.lock() {
                Ok(g) => g,
                Err(_) => {
                    self.set_state(VoiceState::Idle);
                    return false;
                }
            };
            match g.dictation.as_mut() {
                Some(r) => {
                    let out = r.flush();
                    r.start();
                    out
                }
                None => Ok(String::new()),
            }
        };
        let trimmed = match result {
            Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
            Ok(_) => return command_mode,
            Err(e) => {
                self.emit_error(&format!("dictation flush: {}", e));
                self.set_state(VoiceState::Idle);
                return false;
            }
        };

        // --- Command mode: next utterance is a command, not dictation. ---
        if command_mode {
            safe_eprintln!("[voice] command-mode utterance: {:?}", trimmed);
            let intent = match crate::voice::intent::classify(&trimmed) {
                Some(i)
                    if matches!(
                        i.kind,
                        VoiceIntentKind::Send | VoiceIntentKind::Exit | VoiceIntentKind::Rewrite
                    ) =>
                {
                    i
                }
                // Unclassifiable follow-up → default to Send. User said
                // "jarvis" and then spoke; they want an action, not more text.
                _ => VoiceIntent::send(),
            };
            self.emit_intent(&intent);
            self.set_state(VoiceState::Idle);
            return false;
        }

        // Pure keyword check: transcript is just "send"/"exit"/etc.
        if let Some(intent) = crate::voice::intent::classify(&trimmed) {
            match intent.kind {
                VoiceIntentKind::Send | VoiceIntentKind::Exit | VoiceIntentKind::Rewrite => {
                    self.emit_intent(&intent);
                    self.set_state(VoiceState::Idle);
                    return false;
                }
                _ => {}
            }
        }

        // Address word appears in the transcript ("jarvis" / "T sixty four" /
        // etc). Split the residual from the trailing command.
        let wake = self
            .wake_word
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "jarvis".to_string());
        if let Some((residual, intent, has_command_tail)) = split_address(&trimmed, &wake) {
            let residual_trimmed = residual.trim().to_string();
            if has_command_tail {
                // "jarvis send" (or similar). Carry the residual as the
                // command intent payload so the frontend's Send/Rewrite
                // handler can use the authoritative text directly instead
                // of snapshotting whatever happens to be in the textarea
                // at event-processing time (race-prone with late partials).
                let intent_with_residual = VoiceIntent {
                    kind: intent.kind,
                    payload: if residual_trimmed.is_empty() {
                        None
                    } else {
                        Some(residual_trimmed.clone())
                    },
                };
                self.emit_intent(&intent_with_residual);
                self.set_state(VoiceState::Idle);
                return false;
            }
            // No command tail: commit the residual as plain dictation.
            if !residual_trimmed.is_empty() {
                self.emit_final(&residual_trimmed);
                self.emit_intent(&VoiceIntent::dictation(residual_trimmed));
            }
            // "jarvis" alone — enter command mode. Next utterance is the
            // command. Stay in Dictating (so whisper keeps running).
            safe_eprintln!("[voice] jarvis alone → command mode");
            return true;
        }

        // Regular dictation — append.
        self.emit_final(&trimmed);
        self.emit_intent(&VoiceIntent::dictation(trimmed));
        command_mode
    }

    // --- Event emission (payload shapes match src/lib/voiceApi.ts) ---

    fn set_state(&self, s: VoiceState) {
        if let Ok(mut g) = self.state.lock() {
            if *g == s {
                return;
            }
            *g = s;
        }
        self.emit("voice-state", &serde_json::json!({ "state": s }));
    }

    fn emit_intent(&self, intent: &VoiceIntent) {
        self.emit("voice-intent", intent);
    }

    fn emit_final(&self, text: &str) {
        self.emit("voice-final", &serde_json::json!({ "text": text }));
    }

    /// Downsample a 1280-sample mic frame into 32 peak-amplitude buckets
    /// and emit as `voice-waveform`. Used by ChatInput to render the live
    /// voice squiggle behind the active session's textarea. We pick peak
    /// abs instead of RMS so low-frequency transients (plosives, "J" in
    /// "Jarvis") show up with their full travel instead of averaging out.
    fn emit_waveform(&self, frame: &[f32]) {
        const BINS: usize = 32;
        const SILENCE_GATE: f32 = 0.01;
        if frame.is_empty() {
            return;
        }
        let chunk = frame.len().div_ceil(BINS);
        let mut out: [f32; BINS] = [0.0; BINS];
        let mut max_peak: f32 = 0.0;
        for (i, slot) in out.iter_mut().enumerate() {
            let start = i * chunk;
            if start >= frame.len() {
                break;
            }
            let end = (start + chunk).min(frame.len());
            let mut peak: f32 = 0.0;
            for s in &frame[start..end] {
                let a = s.abs();
                if a > peak {
                    peak = a;
                }
            }
            *slot = peak.min(1.0);
            if peak > max_peak {
                max_peak = peak;
            }
        }
        // Skip IPC on near-silent frames (common between utterances).
        if max_peak < SILENCE_GATE {
            return;
        }
        self.emit(
            "voice-waveform",
            &serde_json::json!({ "samples": &out[..] }),
        );
    }

    fn emit_listening_progress(&self, progress: f32) {
        self.emit(
            "voice-listening-progress",
            &serde_json::json!({ "progress": progress.clamp(0.0, 1.0) }),
        );
    }

    fn emit_error(&self, message: &str) {
        safe_eprintln!("[voice] error: {}", message);
        self.emit("voice-error", &serde_json::json!({ "message": message }));
    }

    fn emit<T: serde::Serialize>(&self, event: &str, payload: &T) {
        let Ok(app_guard) = self.app.lock() else {
            return;
        };
        if let Some(app) = app_guard.as_ref() {
            let _ = app.emit(event, payload);
        }
    }
}
