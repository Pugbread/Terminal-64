//! whisper.cpp streaming dictation via `whisper-rs` 0.13.
//!
//! Runs inference on a background thread that decodes a bounded trailing
//! window of the rolling audio buffer every ~250 ms and emits
//! `voice-committed` / `voice-tentative` / `voice-partial` events as the
//! user speaks. On `flush()`, the worker stops, one final whisper pass
//! runs on the full buffer, and the committed text is returned.
//!
//! The goal is Claude-Code-style live dictation: words appear in the UI as
//! the user speaks, not after a silence boundary. Batched flushes only
//! happen for committing; partials are rendered in near-realtime.
//!
//! Gated behind the `voice-dictation` feature. When off, the module
//! compiles to a stub whose `flush` errors out and whose `start`/`push`
//! are no-ops.

// With voice-dictation off (default), most of this module is unreachable —
// allow the whole file to read as dead code instead of gating every helper.
#![cfg_attr(not(feature = "voice-dictation"), allow(dead_code, unused_imports, unused_variables))]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

pub const SAMPLE_RATE: usize = 16_000;
/// Maximum rolling-buffer length. Anything older than this is dropped;
/// prevents unbounded memory growth during long dictation.
pub const MAX_BUFFER_SECS: usize = 30;
/// How often the worker thread runs partial inference.
pub const PARTIAL_INTERVAL_MS: u64 = 250;
/// Minimum audio length to bother running whisper on (0.25 s).
pub const MIN_AUDIO_SAMPLES: usize = SAMPLE_RATE / 4;
/// Longest trailing window (seconds) ever handed to the partial decoder.
/// Older audio stays in the rolling buffer for `flush()`, but partials only
/// see the last `PARTIAL_WINDOW_SECS`. Bounds per-tick decode cost at ~O(window)
/// instead of O(utterance) — the single biggest cause of dictation lag.
///
/// Sized at 25 s because whisper is trained on 30 s segments and needs enough
/// context to stabilize its hypothesis; shorter windows (we tried 15 s)
/// produce wildly different text tick-to-tick and the AgreementBuffer LCP
/// almost never converges, so nothing gets committed.
pub const PARTIAL_WINDOW_SECS: f32 = 25.0;
/// Minimum amount of *new* audio since the last decode before we spend CPU on
/// another partial. ~120 ms avoids double-decoding when the mic frame cadence
/// (~80 ms) is close to the tick cadence (250 ms).
pub const PARTIAL_STEP_MIN_MS: u64 = 120;
/// If a partial decode takes longer than this (2× the tick interval), skip
/// the next tick so the worker doesn't queue work faster than the model
/// clears it. Guards against cascade lag on thermal throttle.
pub const PARTIAL_DECODE_WATCHDOG_MS: u128 = (PARTIAL_INTERVAL_MS as u128) * 2;

#[cfg(feature = "voice-dictation")]
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct WhisperRunner {
    #[allow(dead_code)]
    model_path: PathBuf,
    #[cfg(feature = "voice-dictation")]
    ctx: Arc<WhisperContext>,
    audio: Arc<Mutex<Vec<f32>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    app: Option<AppHandle>,
    /// Shared LocalAgreement-2 state. Lives outside the worker so `flush()`
    /// can see the committed prefix and reset cleanly between utterances.
    agreement: Arc<Mutex<AgreementBuffer>>,
}

impl WhisperRunner {
    pub fn load(model_path: &Path) -> Result<Self, String> {
        #[cfg(feature = "voice-dictation")]
        {
            let params = WhisperContextParameters {
                use_gpu: true,
                ..WhisperContextParameters::default()
            };
            let ctx = WhisperContext::new_with_params(&model_path.to_string_lossy(), params)
                .map_err(|e| format!("whisper load: {e}"))?;
            safe_eprintln!("[voice/whisper] loaded {} (metal)", model_path.display());
            // Pre-warm Metal shaders: one synchronous transcribe pass on 1s of
            // silence forces Metal pipeline compilation now instead of on the
            // user's first real utterance (which otherwise stalls 1-2s).
            let prewarm_start = std::time::Instant::now();
            let silence = vec![0.0f32; SAMPLE_RATE];
            match transcribe(&ctx, &silence) {
                Ok(_) => safe_eprintln!(
                    "[voice/whisper] prewarm done in {}ms",
                    prewarm_start.elapsed().as_millis()
                ),
                Err(e) => safe_eprintln!("[voice/whisper] prewarm failed: {}", e),
            }
            Ok(Self {
                model_path: model_path.to_path_buf(),
                ctx: Arc::new(ctx),
                audio: Arc::new(Mutex::new(Vec::with_capacity(SAMPLE_RATE * 10))),
                stop: Arc::new(AtomicBool::new(true)),
                worker: None,
                app: None,
                agreement: Arc::new(Mutex::new(AgreementBuffer::new())),
            })
        }
        #[cfg(not(feature = "voice-dictation"))]
        {
            Err("whisper feature not enabled at build time".to_string())
        }
    }

    /// Inject the Tauri handle so the background worker can emit
    /// `voice-partial` events. Must be called once after `load`.
    pub fn set_app(&mut self, app: AppHandle) {
        self.app = Some(app);
    }

    /// Reset the audio buffer and (re-)spawn the background inference
    /// thread. Called when entering Dictating and after every flush so
    /// the runner is ready for the next utterance.
    pub fn start(&mut self) {
        self.stop_worker();
        if let Ok(mut g) = self.audio.lock() {
            g.clear();
        }
        if let Ok(mut ag) = self.agreement.lock() {
            ag.reset();
        }
        #[cfg(feature = "voice-dictation")]
        {
            self.stop.store(false, Ordering::SeqCst);
            let audio = Arc::clone(&self.audio);
            let ctx = Arc::clone(&self.ctx);
            let stop = Arc::clone(&self.stop);
            let app = self.app.clone();
            let agreement = Arc::clone(&self.agreement);
            self.worker = Some(std::thread::spawn(move || {
                partial_worker(audio, ctx, stop, app, agreement);
            }));
        }
    }

    /// Append fresh mic samples to the rolling buffer. The worker picks
    /// them up on its next tick.
    pub fn push(&mut self, frame: &[f32]) {
        if let Ok(mut g) = self.audio.lock() {
            g.extend_from_slice(frame);
            let cap = SAMPLE_RATE * MAX_BUFFER_SECS;
            if g.len() > cap {
                let drop = g.len() - cap;
                g.drain(..drop);
            }
        }
    }

    /// Stop the worker, run one final inference pass on whatever is in
    /// the buffer, clear the buffer, and return the finalized text.
    pub fn flush(&mut self) -> Result<String, String> {
        self.stop_worker();
        #[cfg(feature = "voice-dictation")]
        {
            let audio = {
                let mut g = self
                    .audio
                    .lock()
                    .map_err(|_| "audio lock poisoned".to_string())?;
                std::mem::take(&mut *g)
            };
            // Snapshot the LocalAgreement-2 committed prefix — this is what
            // the user saw on screen (it grew across many partial decodes,
            // each of which agreed on these words). The fresh full-buffer
            // decode below can occasionally disagree with this stream
            // (whisper's anti-hallucination thresholds sometimes drop early
            // segments when the buffer contains silence/noise). When that
            // happens, the fresh text is SHORTER than what the user said —
            // manifested as "Jarvis send only sends the last few words of a
            // long dictation". We reconcile the two below.
            let committed_words: Vec<String> = self
                .agreement
                .lock()
                .map(|a| a.committed_words.clone())
                .unwrap_or_default();
            let committed_text = committed_words.join(" ");

            if audio.len() < MIN_AUDIO_SAMPLES {
                if let Ok(mut ag) = self.agreement.lock() {
                    ag.reset();
                }
                return Ok(committed_text);
            }
            safe_eprintln!("[voice/whisper] flush: {} samples", audio.len());
            let fresh = transcribe(&self.ctx, &audio)?;
            safe_eprintln!(
                "[voice/whisper] final fresh -> {:?} / committed -> {:?}",
                fresh,
                committed_text
            );
            if let Ok(mut ag) = self.agreement.lock() {
                ag.reset();
            }
            Ok(reconcile_flush(&committed_text, &fresh))
        }
        #[cfg(not(feature = "voice-dictation"))]
        {
            if let Ok(mut g) = self.audio.lock() {
                g.clear();
            }
            Err("whisper feature not enabled at build time".to_string())
        }
    }

    fn stop_worker(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }

    /// One-shot transcribe of a pre-loaded 16 kHz mono f32 buffer. Does not
    /// touch the streaming state (rolling buffer, worker thread, agreement
    /// prefix). Used by the Discord voice-note pipeline to feed an entire
    /// OGG-Opus attachment through whisper in a single pass.
    #[cfg(feature = "voice-dictation")]
    pub fn transcribe_oneshot(&self, audio: &[f32]) -> Result<String, String> {
        transcribe(&self.ctx, audio)
    }
    #[cfg(not(feature = "voice-dictation"))]
    pub fn transcribe_oneshot(&self, _audio: &[f32]) -> Result<String, String> {
        Err("whisper feature not enabled at build time".to_string())
    }
}

impl Drop for WhisperRunner {
    fn drop(&mut self) {
        self.stop_worker();
    }
}

#[cfg(feature = "voice-dictation")]
fn partial_worker(
    audio: Arc<Mutex<Vec<f32>>>,
    ctx: Arc<WhisperContext>,
    stop: Arc<AtomicBool>,
    app: Option<AppHandle>,
    agreement: Arc<Mutex<AgreementBuffer>>,
) {
    // Decode only a bounded trailing window per tick; AgreementBuffer
    // accumulates the committed prefix across ticks (LocalAgreement-2).
    let window_samples = (PARTIAL_WINDOW_SECS * SAMPLE_RATE as f32) as usize;
    let step_min_new_samples = (PARTIAL_STEP_MIN_MS as usize * SAMPLE_RATE) / 1000;

    let mut last_buf_len: usize = 0;
    let mut last_window_start: usize = 0;
    let mut skip_next = false;

    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(PARTIAL_INTERVAL_MS));
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if skip_next {
            skip_next = false;
            continue;
        }

        let (window_audio, buf_len, window_start) = {
            let g = match audio.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if g.len() < MIN_AUDIO_SAMPLES {
                continue;
            }
            let new_samples = g.len().saturating_sub(last_buf_len);
            if new_samples < step_min_new_samples {
                continue;
            }
            let start = g.len().saturating_sub(window_samples);
            (g[start..].to_vec(), g.len(), start)
        };
        last_buf_len = buf_len;

        // Window shift → drop short-term hypothesis only (LCP is misaligned
        // against the new audio span), but keep committed_words intact.
        let window_shifted = window_start != last_window_start;
        if window_shifted {
            if let Ok(mut ag) = agreement.lock() {
                ag.reset_hypothesis();
            }
        }
        last_window_start = window_start;

        let decode_t0 = std::time::Instant::now();
        let text = match transcribe(&ctx, &window_audio) {
            Ok(t) => t,
            Err(e) => {
                safe_eprintln!("[voice/whisper] partial err: {}", e);
                continue;
            }
        };
        let decode_ms = decode_t0.elapsed().as_millis();

        // Re-check stop: flush() may have set it while this decode was
        // in-flight. Dropping the result here prevents a late emit from
        // repainting the textarea after the intent fires.
        if stop.load(Ordering::SeqCst) {
            break;
        }

        let (committed, tentative) = if let Ok(mut ag) = agreement.lock() {
            ag.ingest(&text)
        } else {
            (String::new(), text.clone())
        };

        if let Some(app) = app.as_ref() {
            let _ = app.emit("voice-committed", serde_json::json!({ "text": committed }));
            let _ = app.emit("voice-tentative", serde_json::json!({ "text": tentative }));
            let combined = if committed.is_empty() {
                tentative.clone()
            } else if tentative.is_empty() {
                committed.clone()
            } else {
                format!("{committed} {tentative}")
            };
            let _ = app.emit("voice-partial", serde_json::json!({ "text": combined }));
            let _ = app.emit(
                "voice-telemetry",
                serde_json::json!({
                    "kind": "partial_decode",
                    "decode_ms": decode_ms as u64,
                    "window_samples": window_audio.len(),
                    "window_start": window_start,
                    "buffer_samples": buf_len,
                    "window_shifted": window_shifted,
                    "committed_len": committed.len(),
                    "tentative_len": tentative.len(),
                }),
            );
        }

        if decode_ms > PARTIAL_DECODE_WATCHDOG_MS {
            safe_eprintln!(
                "[voice/whisper] decode watchdog: {} ms > {} ms; skipping next tick",
                decode_ms,
                PARTIAL_DECODE_WATCHDOG_MS
            );
            skip_next = true;
        }
    }
}

/// Word-level LocalAgreement-2 state shared between the partial worker and
/// `flush()`. The whisper decoder re-transcribes the whole rolling buffer
/// each tick; words that match their position against the previous tick's
/// hypothesis are "agreed" and promoted to a cumulative committed prefix
/// that never gets retracted. Anything after the agreement edge is the
/// tentative tail — the frontend renders it dimmed and it may disappear
/// or change on the next tick.
///
/// This keeps the textarea stable (committed text never flips) while still
/// showing live progress as the user speaks. It's the backend half of the
/// "two-span render" contract with Agent 3's UX redesign (`.wolf/voice-
/// research-shared.md` §2).
#[derive(Default)]
pub struct AgreementBuffer {
    /// Committed prefix; never retracted for the life of an utterance.
    committed_words: Vec<String>,
    /// Previous tick's full hypothesis words. Used for LCP against the
    /// current tick past `committed_words.len()`.
    last_hypothesis_words: Vec<String>,
}

impl AgreementBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reset at the start of a new utterance. Called from `start()` and
    /// after `flush()` promotes/discards the final result.
    pub fn reset(&mut self) {
        self.committed_words.clear();
        self.last_hypothesis_words.clear();
    }

    /// Reset only the short-term hypothesis. Used when the trailing decode
    /// window shifts forward: LCP between old and new hypotheses is no
    /// longer meaningful (different audio spans), but `committed_words`
    /// is cumulative utterance state and must survive.
    pub fn reset_hypothesis(&mut self) {
        self.last_hypothesis_words.clear();
    }

    /// Ingest the latest full-buffer hypothesis. Returns `(committed_text,
    /// tentative_text)` where committed is the cumulative agreed prefix and
    /// tentative is the un-agreed tail to render dimmed.
    pub fn ingest(&mut self, hypothesis_text: &str) -> (String, String) {
        let curr: Vec<String> = split_words(hypothesis_text);
        let start = self.committed_words.len();
        // LCP of last_hypothesis and curr from `start` onward = newly
        // agreed tokens. Compare with normalization (lowercase + strip
        // trailing punctuation) so capitalization/punct drift across decode
        // passes doesn't block agreement.
        let mut k = 0usize;
        while start + k < self.last_hypothesis_words.len() && start + k < curr.len() {
            if !words_equal(&self.last_hypothesis_words[start + k], &curr[start + k]) {
                break;
            }
            k += 1;
        }
        // Promote the LCP slice from curr (prefer curr's capitalization,
        // which is fresh from this decode pass).
        for i in 0..k {
            self.committed_words.push(curr[start + i].clone());
        }
        let tentative_start = start + k;
        let tentative_words: Vec<&str> = curr
            .iter()
            .skip(tentative_start)
            .map(|s| s.as_str())
            .collect();
        let committed_text = self.committed_words.join(" ");
        let tentative_text = tentative_words.join(" ");
        self.last_hypothesis_words = curr;
        (committed_text, tentative_text)
    }

    /// Drain the committed prefix (used by `flush()` on short audio where
    /// no final decode runs). Resets internal state.
    #[allow(dead_code)]
    pub fn take_committed(&mut self) -> String {
        let out = self.committed_words.join(" ");
        self.reset();
        out
    }
}

/// Split on whitespace but keep punctuation attached so `"Jarvis,"` and
/// `"Jarvis"` can still be compared via `words_equal` (which normalizes
/// away trailing punctuation).
fn split_words(text: &str) -> Vec<String> {
    text.split_whitespace().map(|s| s.to_string()).collect()
}

/// Pick the authoritative finalized transcript from the committed-prefix
/// stream (what the user saw) and the fresh full-buffer decode.
///
/// Rules:
///   - If either side is empty, return the other.
///   - If the fresh decode is a word-level prefix or supersequence of the
///     committed prefix, trust the fresh decode (it's a valid extension,
///     possibly with more polished punctuation/casing).
///   - Otherwise the fresh decode disagrees with what the user saw — prefer
///     the committed prefix and append any trailing words the fresh decode
///     adds that aren't already present (often just "jarvis send").
fn reconcile_flush(committed: &str, fresh: &str) -> String {
    let committed = committed.trim();
    let fresh = fresh.trim();
    if committed.is_empty() {
        return fresh.to_string();
    }
    if fresh.is_empty() {
        return committed.to_string();
    }

    let cw = split_words(committed);
    let fw = split_words(fresh);

    let fresh_starts_with_committed =
        fw.len() >= cw.len() && cw.iter().zip(fw.iter()).all(|(a, b)| words_equal(a, b));
    if fresh_starts_with_committed {
        return fresh.to_string();
    }

    // Fresh dropped/replaced earlier words. Find the longest suffix of `fw`
    // that doesn't overlap with `cw` (walk backward skipping words already
    // present in committed) and append it.
    let mut tail_start = fw.len();
    for (i, w) in fw.iter().enumerate() {
        if !cw.iter().any(|c| words_equal(c, w)) {
            tail_start = i;
            break;
        }
    }
    let tail: Vec<String> = fw.iter().skip(tail_start).cloned().collect();
    if tail.is_empty() {
        return committed.to_string();
    }
    format!("{} {}", committed, tail.join(" "))
}

/// Word equality for agreement: case-insensitive, trailing punctuation
/// stripped. Prevents `"Jarvis"` vs `"Jarvis,"` from blocking LCP.
fn words_equal(a: &str, b: &str) -> bool {
    normalize_word(a) == normalize_word(b)
}

fn normalize_word(w: &str) -> String {
    w.trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace())
        .to_lowercase()
}

#[cfg(feature = "voice-dictation")]
fn transcribe(ctx: &WhisperContext, audio: &[f32]) -> Result<String, String> {
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("whisper state: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(4);
    params.set_translate(false);
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_suppress_non_speech_tokens(true);
    params.set_no_context(true);
    // Anti-hallucination: high no-speech + tight logprob/entropy make
    // whisper prefer emitting nothing over confabulating "Thank you" /
    // "Thanks for watching" on silence or weak signal.
    params.set_temperature(0.0);
    params.set_no_speech_thold(0.8);
    params.set_logprob_thold(-0.6);
    params.set_entropy_thold(2.0);
    // Vocabulary bias for the whole product surface: the wake word,
    // the assistant, the app, and the platforms it commonly talks
    // about. Whisper's small.en model mis-hears "Claude" as "clod",
    // "Roblox" as "roadblocks", and garbles "T64" into numerics
    // without this nudge. Keep it short — long prompts drift style.
    params.set_initial_prompt(
        "Jarvis, Claude, Terminal 64, T64, Roblox, Discord, TypeScript, Tauri.",
    );
    state
        .full(params, audio)
        .map_err(|e| format!("whisper full: {e}"))?;
    let n = state
        .full_n_segments()
        .map_err(|e| format!("whisper n_segments: {e}"))?;
    let mut out = String::new();
    for i in 0..n {
        let seg = state
            .full_get_segment_text(i)
            .map_err(|e| format!("whisper seg {i}: {e}"))?;
        out.push_str(&seg);
    }
    Ok(strip_hallucinations(&strip_whisper_tags(&out)))
}

/// Common whisper hallucinations on silence or low-confidence audio.
/// These phrases don't appear in the user's speech — whisper was trained
/// on YouTube/podcast transcripts and defaults to them when it's unsure.
/// Matched case-insensitively against the full trimmed transcript AND
/// against trailing-suffix positions (since they often appear at the end
/// of real speech as a spurious tail).
const HALLUCINATIONS: &[&str] = &[
    "thank you",
    "thank you.",
    "thanks for watching",
    "thanks for watching.",
    "thanks for watching!",
    "please subscribe",
    "please subscribe.",
    "thank you for watching",
    "thank you for watching.",
    "you",
    ".",
    " .",
    "bye.",
    "goodbye.",
];

/// Strip common whisper hallucinations from a transcript. Removes matches
/// that are either the ENTIRE trimmed string (classic silence→"Thank you")
/// or a spurious trailing phrase appended to real speech.
pub fn strip_hallucinations(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_lowercase();
    // Whole-utterance match → drop entirely.
    for h in HALLUCINATIONS {
        if lower == *h {
            return String::new();
        }
    }
    // Trailing match — drop the tail when it's preceded by sentence-ending
    // punctuation, which is the shape of the classic silence-tail
    // hallucination ("...fix the bug. Thank you."). We deliberately do NOT
    // strip mid-sentence occurrences like "I want to say thank you" because
    // there's no reliable way to tell those apart from real intent.
    let mut out = trimmed.to_string();
    loop {
        let out_lower = out.to_lowercase();
        let mut changed = false;
        for h in HALLUCINATIONS {
            if !out_lower.ends_with(h) {
                continue;
            }
            let cut = out.len() - h.len();
            let before = out[..cut].trim_end();
            let last_char = before.chars().last();
            let preceded_by_terminator = matches!(
                last_char,
                Some('.') | Some('!') | Some('?') | Some(',') | Some(';')
            );
            if preceded_by_terminator && before.len() >= 3 {
                out = before.to_string();
                changed = true;
                break;
            }
        }
        if !changed {
            break;
        }
    }
    out
}

/// Strip whisper.cpp special-token artifacts like `[BLANK_AUDIO]`,
/// `[MUSIC]`, `(silence)`, `<|nospeech|>` etc. The decoder sometimes emits
/// these as literal text even with `set_print_special(false)` — they are
/// noise that confuses Claude downstream. Keep them out of the final
/// string for both partial and flush paths.
pub fn strip_whisper_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let closer = match c {
            '[' => Some(']'),
            '(' => Some(')'),
            '<' => Some('>'),
            _ => None,
        };
        if let Some(end) = closer {
            // Look ahead to see whether the bracket group looks like a
            // whisper tag (all uppercase letters, digits, underscores,
            // spaces, pipes) — strip it. If it contains lowercase letters
            // (e.g. the user dictated a real parenthetical), keep it.
            let mut tag = String::new();
            let mut saw_end = false;
            let mut chars_seen = 0;
            for ch in chars.by_ref() {
                chars_seen += 1;
                if chars_seen > 32 {
                    // Unterminated / too long — give up, treat as literal.
                    out.push(c);
                    out.push_str(&tag);
                    out.push(ch);
                    break;
                }
                if ch == end {
                    saw_end = true;
                    break;
                }
                tag.push(ch);
            }
            if saw_end {
                let looks_like_special = !tag.is_empty()
                    && tag.chars().all(|ch| {
                        ch.is_ascii_uppercase()
                            || ch.is_ascii_digit()
                            || ch == '_'
                            || ch == ' '
                            || ch == '|'
                    });
                if !looks_like_special {
                    out.push(c);
                    out.push_str(&tag);
                    out.push(end);
                }
            }
            continue;
        }
        out.push(c);
    }
    // Collapse any whitespace runs the strip left behind.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
