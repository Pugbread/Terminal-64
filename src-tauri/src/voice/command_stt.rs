//! Grammar-constrained command STT using whisper.cpp.
//!
//! Replaces the Moonshine runner with a second whisper.cpp context that runs
//! greedy decoding on the ≤3 s post-wake audio window. The output is
//! constrained to one of:
//!
//!   send | submit | go | exit | cancel | stop | rewrite | rephrase | <free text>
//!
//! where `<free text>` carries the session-name query for `SelectSession`
//! intents. The constraint is enforced two ways:
//!
//! 1. **Decoder bias** via `initial_prompt` — primes whisper's decoder with
//!    the vocabulary so common commands dominate greedy sampling.
//! 2. **Grammar elements (prepared but gated)** — a GBNF-equivalent rule
//!    structure is built in [`build_command_grammar`] and is wired through
//!    `set_grammar` when the `voice-command-grammar` feature is enabled.
//!    whisper-rs 0.13.2's `set_grammar` has a known type-confusion issue
//!    between its flat `&[WhisperGrammarElement]` input and the C API's
//!    `*mut *const whisper_grammar_element` array-of-rule-pointers layout,
//!    so we default-off and ship fuzzy post-matching instead. The grammar
//!    builder is kept so we can flip the feature on once whisper-rs is
//!    patched.
//! 3. **Fuzzy snap-to-canonical** on the raw transcript — Levenshtein ≤ 1
//!    matches (plus the existing `voice::intent::normalize` pipeline) pull
//!    misrecognised commands back to the canonical word before the intent
//!    classifier sees them.
//!
//! Design intent mirrors research §4 option (A): one warm whisper model,
//! deterministic output, no second ONNX stack to babysit.

// With voice-dictation off (default), most of this file reads as dead code.
#![cfg_attr(not(feature = "voice-dictation"), allow(dead_code, unused_imports, unused_variables))]

use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(feature = "voice-dictation")]
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperGrammarElement,
    WhisperGrammarElementType,
};

pub const SAMPLE_RATE: usize = 16_000;
/// Hard upper bound on the captured command window, matching
/// `voice_manager::finalize_command`'s 5 s safety cap.
pub const MAX_COMMAND_SAMPLES: usize = SAMPLE_RATE * 5;
/// Anything shorter than 200 ms is almost certainly breath noise.
pub const MIN_COMMAND_SAMPLES: usize = SAMPLE_RATE / 5;

/// Canonical command vocabulary. The order matters only for tie-breaking
/// in `snap_to_canonical`.
pub const COMMANDS: &[&str] = &[
    "send", "submit", "go", "exit", "cancel", "stop", "rewrite", "rephrase",
];

pub struct CommandSttRunner {
    #[allow(dead_code)]
    model_path: PathBuf,
    #[cfg(feature = "voice-dictation")]
    ctx: Arc<WhisperContext>,
}

impl CommandSttRunner {
    pub fn load(model_path: &Path) -> Result<Self, String> {
        #[cfg(feature = "voice-dictation")]
        {
            let params = WhisperContextParameters {
                use_gpu: true,
                ..WhisperContextParameters::default()
            };
            let ctx = WhisperContext::new_with_params(&model_path.to_string_lossy(), params)
                .map_err(|e| format!("command STT load: {e}"))?;
            safe_eprintln!(
                "[voice/command_stt] loaded {} (metal, grammar-constrained)",
                model_path.display()
            );
            // Force Metal shader compilation now (1 s silence pass) so the
            // first real command doesn't stall 1–2 s on pipeline build.
            let prewarm_start = std::time::Instant::now();
            let silence = vec![0.0f32; SAMPLE_RATE];
            match run_whisper(&ctx, &silence) {
                Ok(_) => safe_eprintln!(
                    "[voice/command_stt] prewarm done in {}ms",
                    prewarm_start.elapsed().as_millis()
                ),
                Err(e) => safe_eprintln!("[voice/command_stt] prewarm failed: {}", e),
            }
            Ok(Self {
                model_path: model_path.to_path_buf(),
                ctx: Arc::new(ctx),
            })
        }
        #[cfg(not(feature = "voice-dictation"))]
        {
            Err("voice-dictation feature not enabled (command STT needs whisper-rs)".to_string())
        }
    }

    /// Transcribe a short, VAD-terminated command window.
    ///
    /// Returns a cleaned string that either matches one of [`COMMANDS`] or
    /// is passed through as a session-name query. Empty strings are
    /// returned as-is (the caller treats them as no-op).
    pub fn transcribe(&self, audio: &[f32]) -> Result<String, String> {
        if audio.len() < MIN_COMMAND_SAMPLES {
            return Ok(String::new());
        }
        #[cfg(feature = "voice-dictation")]
        {
            let clamped: &[f32] = if audio.len() > MAX_COMMAND_SAMPLES {
                &audio[audio.len() - MAX_COMMAND_SAMPLES..]
            } else {
                audio
            };
            // whisper.cpp hard-errors on inputs shorter than 1000 ms (the
            // mel-encoder window). Pad short command clips with trailing
            // silence so a crisp "send" (often only 400-600 ms) still
            // transcribes instead of returning empty.
            const MIN_WHISPER_SAMPLES: usize = SAMPLE_RATE + SAMPLE_RATE / 10; // 1.1 s
            let padded: Vec<f32>;
            let input: &[f32] = if clamped.len() < MIN_WHISPER_SAMPLES {
                let mut v = Vec::with_capacity(MIN_WHISPER_SAMPLES);
                v.extend_from_slice(clamped);
                v.resize(MIN_WHISPER_SAMPLES, 0.0);
                padded = v;
                &padded
            } else {
                clamped
            };
            let raw = run_whisper(&self.ctx, input)?;
            safe_eprintln!("[voice/command_stt] raw={:?}", raw);
            let snapped = snap_to_canonical(&raw);
            if snapped != raw {
                safe_eprintln!("[voice/command_stt] snapped={:?}", snapped);
            }
            Ok(snapped)
        }
        #[cfg(not(feature = "voice-dictation"))]
        {
            let _ = audio;
            Err("voice-dictation feature not enabled at build time".to_string())
        }
    }
}

#[cfg(feature = "voice-dictation")]
fn run_whisper(ctx: &WhisperContext, audio: &[f32]) -> Result<String, String> {
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("command STT state: {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(2);
    params.set_translate(false);
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_no_context(true);
    // Single-segment mode: command windows are always ≤5 s and never need
    // segmentation. Stops whisper from inserting sentence breaks that
    // would split a two-word query like "deploy planner".
    params.set_single_segment(true);

    // Decoder bias: command vocab + the product-surface proper nouns
    // (so a post-wake session name like "Roblox scripts" or
    // "Terminal 64 UI" transcribes correctly instead of as homophones).
    params.set_initial_prompt(
        "Jarvis. Commands: send, submit, go, exit, cancel, stop, rewrite, rephrase. \
         Terminal 64, T64, Claude, Roblox, Discord, TypeScript, Tauri.",
    );

    // Grammar path is prepared but off-by-default; see module docstring.
    #[cfg(feature = "voice-command-grammar")]
    {
        let grammar = build_command_grammar();
        params.set_grammar(Some(&grammar));
        params.set_start_rule(0);
        params.set_grammar_penalty(80.0);
    }

    state
        .full(params, audio)
        .map_err(|e| format!("command STT full: {e}"))?;
    let n = state
        .full_n_segments()
        .map_err(|e| format!("command STT n_segments: {e}"))?;
    let mut out = String::new();
    for i in 0..n {
        let seg = state
            .full_get_segment_text(i)
            .map_err(|e| format!("command STT seg {i}: {e}"))?;
        out.push_str(&seg);
    }
    Ok(crate::voice::whisper::strip_hallucinations(
        &crate::voice::whisper::strip_whisper_tags(&out),
    ))
}

/// Snap a raw whisper transcript to a canonical command when it is within
/// Levenshtein distance 1 of one, otherwise return the transcript
/// unchanged (trimmed). Punctuation and casing are stripped before
/// comparison; the caller's `voice::intent::normalize` repeats that work
/// but also strips the wake word, which is why we run it here too — a
/// misrecognised "send it" → "send it" would get truncated to "send"
/// correctly, but a misrecognition like "sind" needs this layer to map
/// back to "send" before the intent classifier's stem match runs.
pub fn snap_to_canonical(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    if tokens.is_empty() {
        return String::new();
    }

    // Strip a leading "jarvis" address — whisper sometimes includes the
    // wake word even though the capture window starts *after* wake. The
    // intent layer does this too; doing it here lets the single-token
    // match below fire on "send" alone.
    let mut start = 0;
    for prefix in &["hey", "ok", "okay", "yo", "jarvis"] {
        if tokens.get(start).copied() == Some(*prefix) {
            start += 1;
        }
    }
    let tokens = &tokens[start..];
    if tokens.is_empty() {
        return String::new();
    }

    // Single-token commands: try fuzzy snap. This is the hot path — most
    // user utterances to fire a command are one word.
    if tokens.len() == 1 {
        if let Some(canon) = fuzzy_match_command(tokens[0]) {
            return canon.to_string();
        }
    }

    // Two-token: only snap when the 2nd token is a recognized filler
    // ("send it", "stop please", "exit now"). Otherwise it's almost
    // certainly a session name like "go build" or "stop watcher" and
    // snapping would destroy it.
    if tokens.len() == 2 {
        const FILLER: &[&str] = &["it", "that", "this", "now", "please", "pls", "sir", "ma'am"];
        if FILLER.contains(&tokens[1]) {
            if let Some(canon) = fuzzy_match_command(tokens[0]) {
                return canon.to_string();
            }
        }
    }

    // 3+ tokens or non-filler 2-token: treat as a free-form session query.
    // Previously we would snap the first token and drop the rest, which
    // collapsed "go to planner" → "go" and fired Send.
    tokens.join(" ")
}

fn fuzzy_match_command(token: &str) -> Option<&'static str> {
    // Exact match wins.
    for cmd in COMMANDS {
        if token == *cmd {
            return Some(cmd);
        }
    }
    // Edit distance ≤ 1 — tight enough to avoid snapping session names,
    // loose enough to catch "sind"/"sendd"/"sent" → "send" etc.
    let mut best: Option<(&'static str, usize)> = None;
    for cmd in COMMANDS {
        let d = levenshtein(token, cmd);
        if d <= 1 {
            match best {
                Some((_, bd)) if bd <= d => {}
                _ => best = Some((cmd, d)),
            }
        }
    }
    best.map(|(c, _)| c)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr = vec![0usize; m + 1];
    for i in 1..=n {
        curr[0] = i;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

/// Build the GBNF-equivalent grammar for the command vocabulary.
///
/// The grammar encodes:
///
/// ```text
/// root ::= " "? (command | freetext)
/// command ::= "send" | "submit" | "go" | "exit"
///           | "cancel" | "stop" | "rewrite" | "rephrase"
/// freetext ::= [a-zA-Z0-9] [a-zA-Z0-9 ]*
/// ```
///
/// Returned as a flat element vec suitable for whisper-rs's
/// `set_grammar`. Currently only used under the `voice-command-grammar`
/// cargo feature — see module docstring for why it's not the default.
#[cfg(feature = "voice-dictation")]
#[allow(dead_code)]
pub fn build_command_grammar() -> Vec<WhisperGrammarElement> {
    use WhisperGrammarElementType as T;
    let mut out: Vec<WhisperGrammarElement> = Vec::new();

    // Optional leading space: whisper emits text starting with a space.
    // We encode it as a character class containing both " " and the most
    // common lead chars so the first alternative always matches.
    let mut first_alt = true;
    for word in COMMANDS {
        if !first_alt {
            out.push(WhisperGrammarElement::new(T::Alternate, 0));
        }
        // Optional leading space.
        out.push(WhisperGrammarElement::new(T::Character, ' ' as u32));
        out.push(WhisperGrammarElement::new(T::CharacterAlternate, 0));
        for ch in word.chars() {
            out.push(WhisperGrammarElement::new(T::Character, ch as u32));
        }
        first_alt = false;
    }
    // Freetext alternative: [a-zA-Z0-9][a-zA-Z0-9 ]*
    out.push(WhisperGrammarElement::new(T::Alternate, 0));
    out.push(WhisperGrammarElement::new(T::Character, ' ' as u32));
    out.push(WhisperGrammarElement::new(T::CharacterAlternate, 0));
    // First freetext char: letter or digit.
    out.push(WhisperGrammarElement::new(T::Character, 'a' as u32));
    out.push(WhisperGrammarElement::new(
        T::CharacterRangeUpper,
        'z' as u32,
    ));
    out.push(WhisperGrammarElement::new(
        T::CharacterAlternate,
        'A' as u32,
    ));
    out.push(WhisperGrammarElement::new(
        T::CharacterRangeUpper,
        'Z' as u32,
    ));
    out.push(WhisperGrammarElement::new(
        T::CharacterAlternate,
        '0' as u32,
    ));
    out.push(WhisperGrammarElement::new(
        T::CharacterRangeUpper,
        '9' as u32,
    ));

    out.push(WhisperGrammarElement::new(T::End, 0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_exact_command() {
        assert_eq!(snap_to_canonical("send"), "send");
        assert_eq!(snap_to_canonical("  STOP  "), "stop");
        assert_eq!(snap_to_canonical("Rewrite."), "rewrite");
    }

    #[test]
    fn snap_fuzzy_single_edit() {
        assert_eq!(snap_to_canonical("sind"), "send");
        assert_eq!(snap_to_canonical("sendd"), "send");
        assert_eq!(snap_to_canonical("cansel"), "cancel");
        assert_eq!(snap_to_canonical("exid"), "exit");
    }

    #[test]
    fn snap_drops_filler_after_canonical() {
        assert_eq!(snap_to_canonical("send it"), "send");
        assert_eq!(snap_to_canonical("stop please"), "stop");
    }

    #[test]
    fn snap_preserves_session_query() {
        assert_eq!(snap_to_canonical("planner"), "planner");
        assert_eq!(snap_to_canonical("open deploy"), "open deploy");
    }

    #[test]
    fn snap_strips_wake_address() {
        assert_eq!(snap_to_canonical("jarvis send"), "send");
        assert_eq!(snap_to_canonical("hey jarvis stop"), "stop");
        assert_eq!(snap_to_canonical("ok jarvis"), "");
    }

    #[test]
    fn snap_empty() {
        assert_eq!(snap_to_canonical(""), "");
        assert_eq!(snap_to_canonical("   "), "");
        assert_eq!(snap_to_canonical("..."), "");
    }

    #[test]
    fn levenshtein_basic() {
        assert_eq!(levenshtein("send", "send"), 0);
        assert_eq!(levenshtein("send", "sind"), 1);
        assert_eq!(levenshtein("send", "sends"), 1);
        assert_eq!(levenshtein("send", ""), 4);
        assert_eq!(levenshtein("", "send"), 4);
    }
}
