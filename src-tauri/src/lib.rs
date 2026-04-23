/// Safe stderr logging — never panics if the pipe is broken.
#[macro_export]
macro_rules! safe_eprintln {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let mut err = std::io::stderr();
        let _ = err.write_fmt(format_args!($($arg)*));
        let _ = err.write_all(b"\n");
    }};
}

/// Safe stdout logging — never panics if the pipe is broken.
#[macro_export]
macro_rules! safe_println {
    ($($arg:tt)*) => {{
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_fmt(format_args!($($arg)*));
        let _ = out.write_all(b"\n");
    }};
}

mod audio_manager;
mod browser_manager;
mod claude_manager;
mod discord_bot;
mod mic_manager;
mod permission_mcp;
mod permission_server;
mod plugin_manifest_store;
mod pty_manager;
mod types;
mod voice;
mod voice_manager;
mod widget_server;

// ---- Security ----

/// Blocklist of dangerous shell patterns. Returns an error message if the command matches.
fn validate_shell_command(command: &str) -> Result<(), String> {
    let lower = command.to_lowercase();
    let blocked_patterns: &[(&str, &str)] = &[
        (
            "rm -rf /",
            "Refusing to run destructive command targeting root",
        ),
        (
            "rm -rf ~",
            "Refusing to run destructive command targeting home directory",
        ),
        ("mkfs", "Refusing to run filesystem format command"),
        ("dd if=", "Refusing to run raw disk write command"),
        (":(){", "Refusing to run fork bomb"),
        (
            "chmod -r 777 /",
            "Refusing to run recursive permission change on root",
        ),
        ("chown -r", "Refusing to run recursive ownership change"),
        ("> /dev/sd", "Refusing to write to raw block device"),
        ("> /dev/nvme", "Refusing to write to raw block device"),
        ("curl|sh", "Refusing to pipe remote script to shell"),
        ("curl|bash", "Refusing to pipe remote script to shell"),
        ("wget|sh", "Refusing to pipe remote script to shell"),
        ("wget|bash", "Refusing to pipe remote script to shell"),
        ("curl | sh", "Refusing to pipe remote script to shell"),
        ("curl | bash", "Refusing to pipe remote script to shell"),
        ("wget | sh", "Refusing to pipe remote script to shell"),
        ("wget | bash", "Refusing to pipe remote script to shell"),
        ("shutdown", "Refusing to run shutdown command"),
        ("reboot", "Refusing to run reboot command"),
        ("halt", "Refusing to run halt command"),
        ("poweroff", "Refusing to run poweroff command"),
        ("init 0", "Refusing to run init command"),
        ("init 6", "Refusing to run init command"),
        ("systemctl poweroff", "Refusing to run system power command"),
        ("systemctl reboot", "Refusing to run system reboot command"),
    ];

    // Remove spaces for pattern matching to catch obfuscation like "rm  -rf  /"
    let compressed = lower.replace(' ', "");

    for (pattern, reason) in blocked_patterns {
        let compressed_pattern = pattern.replace(' ', "");
        if compressed.contains(&compressed_pattern) {
            return Err(reason.to_string());
        }
    }

    Ok(())
}

use audio_manager::AudioManager;
use browser_manager::BrowserManager;
use claude_manager::ClaudeManager;
use discord_bot::DiscordBot;
use mic_manager::MicManager;
use permission_server::PermissionServer;
use plugin_manifest_store::{read_widget_approval, read_widget_manifest, write_widget_approval};
use pty_manager::PtyManager;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use types::*;
use voice_manager::VoiceManager;
use widget_server::WidgetServer;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
    "vendor",
];

fn session_project_dir(cwd: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir_hash = cwd.replace([':', '\\', '/'], "-");
    Ok(home.join(".claude").join("projects").join(dir_hash))
}

fn session_jsonl_path(cwd: &str, session_id: &str) -> Result<std::path::PathBuf, String> {
    Ok(session_project_dir(cwd)?.join(format!("{}.jsonl", session_id)))
}

/// Atomic write: stage to a sibling tmp file then rename onto the target. Prevents
/// partially-written JSONL when truncate/fork is interrupted (crash, kill, OOM).
/// `rename` is atomic on the same filesystem on macOS/Linux, and on Windows when
/// the target exists (`MoveFileExW` with REPLACE_EXISTING — std uses this internally).
fn atomic_write_jsonl(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("jsonl path has no parent")?;
    if !parent.exists() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    // Per-pid + per-call suffix avoids collisions if two truncates race.
    let suffix = format!(
        ".tmp.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    );
    let tmp = path.with_extension(format!(
        "{}{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("jsonl"),
        suffix
    ));
    {
        use std::io::Write;
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("create {}: {}", tmp.display(), e))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
        // Best-effort fsync — on some filesystems (notably macOS), data may sit in
        // the buffer cache after rename. Don't error if fsync isn't supported.
        if let Err(e) = f.sync_all() {
            safe_eprintln!("[atomic_write] sync_all {}: {}", tmp.display(), e);
        }
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        // Try to clean the tmp file so we don't leave litter on failure.
        let _ = std::fs::remove_file(&tmp);
        format!("rename {} -> {}: {}", tmp.display(), path.display(), e)
    })?;
    // Best-effort parent-dir fsync so the rename itself survives a crash on Unix.
    // On macOS/Linux this is required for durability of the directory entry change.
    #[cfg(unix)]
    {
        if let Err(e) = std::fs::File::open(parent).and_then(|d| d.sync_all()) {
            safe_eprintln!("[atomic_write] parent sync_all {}: {}", parent.display(), e);
        }
    }
    Ok(())
}

/// Hard upper bound for rewriting operations (truncate / fork). Sessions
/// beyond this size stall the UI when loaded into a `String` and risk OOM on
/// small laptops, so we refuse the rewrite rather than try. 100 MiB is well
/// above any realistic conversation and still safe on 8 GB machines.
const MAX_REWRITE_BYTES: u64 = 100 * 1024 * 1024;

/// Stat a JSONL path and reject it if it exceeds `MAX_REWRITE_BYTES`. Returns
/// the size on success. Missing files fall through (caller decides whether
/// absence is an error). Used to guard truncate/fork against pathological
/// inputs before we pull the whole file into memory.
fn check_rewrite_size_limit(path: &std::path::Path) -> Result<Option<u64>, String> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let size = meta.len();
            if size > MAX_REWRITE_BYTES {
                return Err(format!(
                    "jsonl_too_large: {} is {} bytes, exceeds {}-byte rewrite cap (refusing to load entire file into memory for truncate/fork)",
                    path.display(),
                    size,
                    MAX_REWRITE_BYTES
                ));
            }
            Ok(Some(size))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("stat {}: {}", path.display(), e)),
    }
}

struct AppState {
    pty_manager: PtyManager,
    claude_manager: Arc<ClaudeManager>,
    discord_bot: Mutex<DiscordBot>,
    permission_server: Arc<PermissionServer>,
    audio_manager: Arc<AudioManager>,
    browser_manager: BrowserManager,
    widget_server: WidgetServer,
    // Retained on AppState so its subscribers stay alive for the duration of the app,
    // even though all mic access currently flows through VoiceManager.
    #[allow(dead_code)]
    mic_manager: Arc<MicManager>,
    voice_manager: Arc<VoiceManager>,
}

#[tauri::command]
fn create_terminal(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateTerminalRequest,
) -> Result<(), String> {
    state.pty_manager.create(&app_handle, req)
}

#[tauri::command]
fn write_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.pty_manager.write(&id, &data)
}

#[tauri::command]
fn resize_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&id, cols, rows)
}

#[tauri::command]
fn close_terminal(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.pty_manager.close(&id)
}

/// If OpenWolf is enabled, ensure .wolf/ exists and merge its hooks into the settings file.
/// Hard safety net: never init OpenWolf inside T64's own managed directories
/// (widgets, skills). Guards against stale session state or frontend bugs where
/// skipOpenwolf wasn't propagated.
fn is_t64_managed_dir(cwd: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let t64 = home.join(".terminal64");
    std::path::Path::new(cwd).starts_with(&t64)
}

fn maybe_apply_openwolf(
    settings_path: &Option<String>,
    cwd: &str,
    enabled: bool,
    auto_init: bool,
    design_qc: bool,
) {
    if !enabled || is_t64_managed_dir(cwd) {
        return;
    }
    claude_manager::ensure_openwolf(cwd, auto_init);
    if let Some(ref sp) = settings_path {
        if let Err(e) = claude_manager::merge_openwolf_hooks(sp, cwd, design_qc) {
            safe_eprintln!("[openwolf] Failed to merge hooks: {}", e);
        }
    }
}

/// Map frontend permission_mode strings to the CLI's internal names. Anything
/// else (default/auto/plan/acceptEdits) we pass through as-is — the MCP
/// approver only short-circuits on the exact `bypassPermissions` string.
fn cli_permission_mode(mode: &str) -> &str {
    match mode {
        "bypass_all" => "bypassPermissions",
        "accept_edits" => "acceptEdits",
        "plan" => "plan",
        "auto" => "auto",
        _ => "default",
    }
}

#[tauri::command]
fn create_claude_session(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateClaudeRequest,
    openwolf_enabled: Option<bool>,
    openwolf_auto_init: Option<bool>,
    openwolf_design_qc: Option<bool>,
) -> Result<String, String> {
    let cli_mode = cli_permission_mode(&req.permission_mode);
    let registration = state
        .permission_server
        .register_session(&req.session_id, cli_mode)
        .ok();
    let settings_path = registration
        .as_ref()
        .map(|(_, s, _)| s.to_string_lossy().to_string());
    let approver_path = registration
        .as_ref()
        .map(|(_, _, m)| m.to_string_lossy().to_string());
    maybe_apply_openwolf(
        &settings_path,
        &req.cwd,
        openwolf_enabled.unwrap_or(false),
        openwolf_auto_init.unwrap_or(true),
        openwolf_design_qc.unwrap_or(false),
    );
    let channel = req.channel_server.clone();
    // Returns the resolved session UUID so the frontend can adopt the
    // backend-generated id (when it sent an empty one) without waiting for
    // the first `system/init` stream event.
    state
        .claude_manager
        .create_session(&app_handle, req, settings_path, approver_path, channel)
}

#[tauri::command]
fn send_claude_prompt(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: SendClaudePromptRequest,
    openwolf_enabled: Option<bool>,
    openwolf_auto_init: Option<bool>,
    openwolf_design_qc: Option<bool>,
) -> Result<(), String> {
    let cli_mode = cli_permission_mode(&req.permission_mode);
    let registration = state
        .permission_server
        .register_session(&req.session_id, cli_mode)
        .ok();
    let settings_path = registration
        .as_ref()
        .map(|(_, s, _)| s.to_string_lossy().to_string());
    let approver_path = registration
        .as_ref()
        .map(|(_, _, m)| m.to_string_lossy().to_string());
    maybe_apply_openwolf(
        &settings_path,
        &req.cwd,
        openwolf_enabled.unwrap_or(false),
        openwolf_auto_init.unwrap_or(true),
        openwolf_design_qc.unwrap_or(false),
    );
    let channel = req.channel_server.clone();
    state
        .claude_manager
        .send_prompt(&app_handle, req, settings_path, approver_path, channel)
}

#[tauri::command]
fn cancel_claude(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.claude_manager.cancel(&session_id)
}

#[tauri::command]
fn close_claude_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Clean up permission server temp files for this session
    let tokens_to_remove: Vec<String> = {
        let map = state
            .permission_server
            .session_map
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.iter()
            .filter(|(_, sid)| **sid == session_id)
            .map(|(t, _)| t.clone())
            .collect()
    };
    for token in tokens_to_remove {
        state.permission_server.unregister_session(&token);
    }
    state.claude_manager.close(&session_id)
}

#[tauri::command]
fn rewrite_prompt(
    app_handle: tauri::AppHandle,
    prompt: String,
    is_voice: Option<bool>,
) -> Result<String, String> {
    const SYSTEM_PROMPT: &str = "You are a prompt engineering expert. Your job is to rewrite user prompts to get dramatically better results from AI coding assistants like Claude Code.\n\nRules:\n- Keep the user's INTENT exactly the same\n- Make the prompt more specific, structured, and actionable\n- Add context that was implied but not stated\n- Break vague requests into clear, concrete steps\n- Specify expected output format when helpful\n- Add constraints that prevent common failure modes\n- If the prompt references code, remind the AI to read relevant files first\n- Keep it concise — longer isn't better, clearer is better\n- Don't add fluff or meta-commentary, just output the improved prompt\n- Output ONLY the rewritten prompt, nothing else";

    // When the prompt came from voice dictation, give the rewriter extra
    // context so it can forgive transcription artifacts instead of treating
    // them as the user's literal intent.
    const VOICE_ADDENDUM: &str = "\n\nVoice-message handling:\n- The user dictated this prompt via speech-to-text (whisper.cpp).\n- Expect missing/extra punctuation, homophones (\"their/there\", \"to/too\"), misheard technical terms, run-on sentences, and filler words (\"um\", \"uh\", \"like\", \"you know\").\n- Infer the intended technical terms from context (e.g. \"react\" not \"wrecked\", \"async\" not \"a sync\").\n- Fix punctuation/capitalisation silently; don't flag these as issues.\n- Preserve the user's actual request — don't invent requirements they didn't state.\n- Treat the trailing \"This message was a voice message.\" marker as metadata, NOT part of the prompt content. Do not echo it.";

    static REWRITE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let rewrite_id = format!(
        "rw-{}",
        REWRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let voice = is_voice.unwrap_or(false);
    let system = if voice {
        format!("{}{}", SYSTEM_PROMPT, VOICE_ADDENDUM)
    } else {
        SYSTEM_PROMPT.to_string()
    };
    let user_prompt = if voice {
        format!("{}\n\nThis message was a voice message.", prompt)
    } else {
        prompt
    };
    let full_prompt = format!("{}\n\nRewrite this prompt:\n{}", system, user_prompt);
    let claude_bin = claude_manager::resolve_claude_path();
    let mut cmd = claude_manager::shim_command(&claude_bin);
    cmd.arg("-p")
        .arg(&full_prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--model")
        .arg("haiku")
        .arg("--effort")
        .arg("high")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    // Run from the OS temp dir so Claude doesn't pick up this project's
    // CLAUDE.md / .wolf/*.md / .claude/ config. The rewriter should only
    // see its own system prompt — anything else (OpenWolf rules, cerebrum
    // entries, skill docs) pollutes the output and makes rewrites hallucinate
    // project-specific conventions.
    cmd.current_dir(std::env::temp_dir());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    // Log stderr for debugging
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!("[rewrite:stderr] {}", line);
            }
        });
    }

    let rid = rewrite_id.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = parsed["type"].as_str().unwrap_or("");
                if event_type == "content_block_delta" {
                    if let Some(text) = parsed["delta"]["text"].as_str() {
                        let _ = app_handle.emit(
                            "rewrite-chunk",
                            serde_json::json!({ "id": rid, "text": text }),
                        );
                    }
                } else if event_type == "assistant" {
                    if let Some(content) = parsed["message"]["content"].as_array() {
                        for block in content {
                            if block["type"].as_str() == Some("text") {
                                if let Some(text) = block["text"].as_str() {
                                    let _ = app_handle.emit(
                                        "rewrite-chunk",
                                        serde_json::json!({ "id": rid, "text": text }),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        let _ = app_handle.emit("rewrite-done", serde_json::json!({ "id": rid }));
        safe_eprintln!("[rewrite] Done ({})", rid);
    });

    Ok(rewrite_id)
}

#[tauri::command]
fn generate_theme(app_handle: tauri::AppHandle, prompt: String) -> Result<String, String> {
    const SYSTEM_PROMPT: &str = r##"You are a theme generator for a terminal emulator app. Given a user's description, generate a complete color theme as valid JSON.

The JSON must have this EXACT structure with all fields:
{
  "name": "<theme name based on the prompt>",
  "ui": {
    "bg": "#hex", "bgSecondary": "#hex", "bgTertiary": "#hex",
    "fg": "#hex", "fgSecondary": "#hex", "fgMuted": "#hex",
    "border": "#hex", "accent": "#hex", "accentHover": "#hex",
    "tabActiveBg": "#hex", "tabInactiveBg": "#hex",
    "tabActiveFg": "#hex", "tabInactiveFg": "#hex",
    "tabHoverBg": "#hex", "scrollbar": "#hex", "scrollbarHover": "#hex"
  },
  "terminal": {
    "background": "#hex", "foreground": "#hex", "cursor": "#hex",
    "cursorAccent": "#hex", "selectionBackground": "#hex", "selectionForeground": "#hex",
    "black": "#hex", "red": "#hex", "green": "#hex", "yellow": "#hex",
    "blue": "#hex", "magenta": "#hex", "cyan": "#hex", "white": "#hex",
    "brightBlack": "#hex", "brightRed": "#hex", "brightGreen": "#hex",
    "brightYellow": "#hex", "brightBlue": "#hex", "brightMagenta": "#hex",
    "brightCyan": "#hex", "brightWhite": "#hex"
  }
}

Rules:
- Output ONLY valid JSON, nothing else. No markdown, no explanation.
- All values must be 6-digit hex colors with # prefix.
- Make the theme visually cohesive and appealing.
- bg should be the darkest, bgTertiary even darker, bgSecondary between them.
- Ensure sufficient contrast between text and backgrounds.
- accent should be a vibrant, distinctive color that fits the theme mood.
- Terminal ANSI colors should be usable (readable on the background).
- The name should be creative and short (2-3 words max)."##;

    static THEME_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let gen_id = format!(
        "theme-{}",
        THEME_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let full_prompt = format!("{}\n\nGenerate a theme for: {}", SYSTEM_PROMPT, prompt);
    let claude_bin = claude_manager::resolve_claude_path();
    let mut cmd = claude_manager::shim_command(&claude_bin);
    cmd.arg("-p")
        .arg(&full_prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--model")
        .arg("haiku")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    // Same project-context isolation as rewrite_prompt — run from tmp so
    // we don't inherit this repo's CLAUDE.md into the theme prompt.
    cmd.current_dir(std::env::temp_dir());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!("[theme-gen:stderr] {}", line);
            }
        });
    }

    let gid = gen_id.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        // Prefer the terminal `result` event (single source of truth for final
        // text). Fall back to accumulating top-level `assistant` text blocks
        // if `result` never arrives (e.g. CLI error before completion).
        let mut final_text: Option<String> = None;
        let mut fallback_text = String::new();
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let event_type = parsed["type"].as_str().unwrap_or("");
            match event_type {
                // Live-streamed text deltas for UI preview. Claude Code ≥2.1
                // wraps deltas inside a `stream_event` envelope.
                "stream_event" => {
                    let inner_type = parsed["event"]["type"].as_str().unwrap_or("");
                    if inner_type == "content_block_delta" {
                        let delta_type = parsed["event"]["delta"]["type"].as_str().unwrap_or("");
                        if delta_type == "text_delta" {
                            if let Some(text) = parsed["event"]["delta"]["text"].as_str() {
                                let _ = app_handle.emit(
                                    "theme-gen-chunk",
                                    serde_json::json!({ "id": gid, "text": text }),
                                );
                            }
                        }
                    }
                }
                "assistant" => {
                    if let Some(content) = parsed["message"]["content"].as_array() {
                        for block in content {
                            if block["type"].as_str() == Some("text") {
                                if let Some(text) = block["text"].as_str() {
                                    fallback_text.push_str(text);
                                }
                            }
                        }
                    }
                }
                "result" => {
                    if let Some(text) = parsed["result"].as_str() {
                        final_text = Some(text.to_string());
                    }
                }
                _ => {}
            }
        }
        let text = final_text.unwrap_or(fallback_text);
        safe_eprintln!("[theme-gen] Done ({}), {} chars", gid, text.len());
        let _ = app_handle.emit(
            "theme-gen-done",
            serde_json::json!({ "id": gid, "text": text }),
        );
    });

    Ok(gen_id)
}

#[tauri::command]
fn generate_rewind_summary(
    app_handle: tauri::AppHandle,
    summary: String,
) -> Result<String, String> {
    const SYSTEM_PROMPT: &str = "You are a concise code change summarizer. Given a list of tool calls (file writes, edits, bash commands) that an AI made during a coding session, write a 1-3 sentence description of what was accomplished. Focus on the PURPOSE and EFFECT of the changes, not individual file operations. Use past tense. Be specific but brief. Output ONLY the description, nothing else.";

    static REWIND_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let gen_id = format!(
        "rwdesc-{}",
        REWIND_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let full_prompt = format!("{}\n\nSummarize these changes:\n{}", SYSTEM_PROMPT, summary);
    let claude_bin = claude_manager::resolve_claude_path();
    let mut cmd = claude_manager::shim_command(&claude_bin);
    cmd.arg("-p")
        .arg(&full_prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--model")
        .arg("haiku")
        .arg("--effort")
        .arg("high")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!("[rewind-desc:stderr] {}", line);
            }
        });
    }

    let gid = gen_id.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = parsed["type"].as_str().unwrap_or("");
                if event_type == "content_block_delta" {
                    if let Some(text) = parsed["delta"]["text"].as_str() {
                        let _ = app_handle.emit(
                            "rewind-desc-chunk",
                            serde_json::json!({ "id": gid, "text": text }),
                        );
                    }
                } else if event_type == "assistant" {
                    if let Some(content) = parsed["message"]["content"].as_array() {
                        for block in content {
                            if block["type"].as_str() == Some("text") {
                                if let Some(text) = block["text"].as_str() {
                                    let _ = app_handle.emit(
                                        "rewind-desc-chunk",
                                        serde_json::json!({ "id": gid, "text": text }),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        let _ = app_handle.emit("rewind-desc-done", serde_json::json!({ "id": gid }));
        safe_eprintln!("[rewind-desc] Done ({})", gid);
    });

    Ok(gen_id)
}

#[tauri::command]
fn save_pasted_image(base64_data: String, extension: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    let tmp =
        std::env::temp_dir().join(format!("t64-paste-{}.{}", uuid::Uuid::new_v4(), extension));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write temp file: {}", e))?;
    Ok(tmp.to_string_lossy().to_string())
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
async fn search_files(cwd: String, query: String) -> Result<Vec<String>, String> {
    // Run filesystem walk on a blocking thread to avoid freezing the UI
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::Path::new(&cwd);
        if !root.is_dir() {
            return vec![];
        }
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        fn walk(
            dir: &std::path::Path,
            root: &std::path::Path,
            query: &str,
            results: &mut Vec<String>,
            skip: &[&str],
            depth: u8,
        ) {
            if depth > 6 || results.len() >= 20 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                if results.len() >= 20 {
                    return;
                }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if skip.iter().any(|s| name == *s) {
                    continue;
                }
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if rel.to_lowercase().contains(query) || name.to_lowercase().contains(query) {
                    results.push(rel);
                }
                if path.is_dir() {
                    walk(&path, root, query, results, skip, depth + 1);
                }
            }
        }
        walk(root, root, &query_lower, &mut results, SKIP_DIRS, 0);
        results.sort_by_key(|a| a.len());
        results.truncate(12);
        results
    })
    .await
    .map_err(|e| e.to_string())
}

fn extract_session_summary(path: &std::path::Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    // Read the tail of the file to find the last "last-prompt" event
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let tail_size = 4096u64.min(len);
    if tail_size == 0 {
        return String::new();
    }
    let _ = file.seek(SeekFrom::End(-(tail_size as i64)));
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);

    for line in buf.lines().rev() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if val["type"] == "last-prompt" {
            if let Some(s) = val["lastPrompt"].as_str() {
                return s.chars().take(120).collect();
            }
        }
    }
    String::new()
}

#[tauri::command]
fn list_disk_sessions(cwd: String) -> Result<Vec<DiskSession>, String> {
    let project_dir = session_project_dir(&cwd)?;
    if !project_dir.exists() {
        return Ok(vec![]);
    }

    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                continue;
            }
            let meta = std::fs::metadata(&path).ok();
            let modified = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let size = meta.map(|m| m.len()).unwrap_or(0);
            let summary = extract_session_summary(&path);
            sessions.push(DiskSession {
                id,
                modified,
                size,
                summary,
            });
        }
    }
    // Sort newest first
    sessions.sort_by_key(|s| std::cmp::Reverse(s.modified));
    Ok(sessions)
}

/// Remove `<system-reminder>…</system-reminder>` blocks from user-facing text.
/// These are harness-injected reminders (TodoWrite nudges, skill availability lists,
/// file-read malware notices, etc.) that get persisted into JSONL as part of the
/// user message content. They should never be shown in the chat UI.
fn strip_system_reminders(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + OPEN.len()..];
        if let Some(end) = after.find(CLOSE) {
            rest = &after[end + CLOSE.len()..];
        } else {
            // Unterminated block — drop the rest to be safe
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    // Collapse leading/trailing whitespace left behind after removal
    out.trim().to_string()
}

/// Strip a leading UTF-8 BOM (U+FEFF, bytes EF BB BF) from a string slice.
/// Some tools/editors prepend a BOM to text files; with it attached the first
/// JSONL record fails `serde_json::from_str` and the record is silently dropped.
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

#[tauri::command]
fn load_session_history(session_id: String, cwd: String) -> Result<Vec<HistoryMessage>, String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("read: {}", e)),
    };
    Ok(parse_session_history_lines(content.lines()))
}

/// Shared JSONL → HistoryMessage pipeline used by both the full loader and
/// the reverse-tail loader. Scans lines in order, merging tool_result blocks
/// back into their originating assistant message via tool_use_id. Strips a
/// UTF-8 BOM from the very first line if present (harmless if already
/// stripped by the caller — the prefix simply won't match).
fn parse_session_history_lines<'a>(
    lines: impl IntoIterator<Item = &'a str>,
) -> Vec<HistoryMessage> {
    let mut messages: Vec<HistoryMessage> = Vec::new();
    // Track tool_use_id → index in messages vec + index in tool_calls vec for result merging
    let mut tool_index: std::collections::HashMap<String, (usize, usize)> =
        std::collections::HashMap::new();

    let mut first_line = true;
    for line in lines {
        let parse_line = if first_line {
            first_line = false;
            strip_bom(line)
        } else {
            line
        };
        let val: serde_json::Value = match serde_json::from_str(parse_line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let rec_type = val["type"].as_str().unwrap_or("");

        if rec_type == "user" {
            let msg = &val["message"];
            let role = msg["role"].as_str().unwrap_or("user");
            if role != "user" {
                continue;
            }

            let content_val = &msg["content"];
            // Content can be a string (simple prompt) or array (with tool_results)
            if let Some(text) = content_val.as_str() {
                let uuid = val["uuid"].as_str().unwrap_or("").to_string();
                let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));
                let cleaned = strip_system_reminders(text);
                if !cleaned.is_empty() {
                    messages.push(HistoryMessage {
                        id: uuid,
                        role: "user".to_string(),
                        content: cleaned,
                        timestamp: ts,
                        tool_calls: None,
                    });
                }
            } else if let Some(blocks) = content_val.as_array() {
                // Array content may contain tool_results AND/OR text blocks
                let mut user_text = String::new();
                for block in blocks {
                    if block["type"].as_str() == Some("tool_result") {
                        let tool_use_id = block["tool_use_id"].as_str().unwrap_or("");
                        if let Some(&(msg_idx, tc_idx)) = tool_index.get(tool_use_id) {
                            if let Some(tcs) = messages[msg_idx].tool_calls.as_mut() {
                                let result_text = if let Some(s) = block["content"].as_str() {
                                    s.to_string()
                                } else if let Some(arr) = block["content"].as_array() {
                                    arr.iter()
                                        .filter_map(|c| {
                                            if c["type"].as_str() == Some("text") {
                                                c["text"].as_str().map(|s| s.to_string())
                                            } else {
                                                None
                                            }
                                        })
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                } else {
                                    String::new()
                                };
                                tcs[tc_idx].result = Some(result_text);
                                tcs[tc_idx].is_error = block["is_error"].as_bool().unwrap_or(false);
                            }
                        }
                    } else if block["type"].as_str() == Some("text") {
                        if let Some(t) = block["text"].as_str() {
                            if !user_text.is_empty() {
                                user_text.push('\n');
                            }
                            user_text.push_str(t);
                        }
                    }
                }
                // If the array contained text blocks (not just tool_results), emit a user message
                let cleaned = strip_system_reminders(&user_text);
                if !cleaned.is_empty() {
                    let uuid = val["uuid"].as_str().unwrap_or("").to_string();
                    let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));
                    messages.push(HistoryMessage {
                        id: uuid,
                        role: "user".to_string(),
                        content: cleaned,
                        timestamp: ts,
                        tool_calls: None,
                    });
                }
            }
        } else if rec_type == "assistant" {
            let msg = &val["message"];
            let content_arr = match msg["content"].as_array() {
                Some(a) => a,
                None => continue,
            };
            let uuid = val["uuid"].as_str().unwrap_or("").to_string();
            let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));

            let mut text = String::new();
            let mut tool_calls: Vec<HistoryToolCall> = Vec::new();

            for block in content_arr {
                match block["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = block["text"].as_str() {
                            text.push_str(t);
                        }
                    }
                    Some("tool_use") => {
                        let tc_id = block["id"].as_str().unwrap_or("").to_string();
                        let tc_name = block["name"].as_str().unwrap_or("").to_string();
                        let tc_input = block["input"].clone();
                        tool_calls.push(HistoryToolCall {
                            id: tc_id.clone(),
                            name: tc_name,
                            input: tc_input,
                            result: None,
                            is_error: false,
                        });
                        // Register for result merging
                        tool_index.insert(tc_id, (messages.len(), tool_calls.len() - 1));
                    }
                    _ => {}
                }
            }

            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() || !tool_calls.is_empty() {
                messages.push(HistoryMessage {
                    id: uuid,
                    role: "assistant".to_string(),
                    content: trimmed,
                    timestamp: ts,
                    tool_calls: if tool_calls.is_empty() {
                        None
                    } else {
                        Some(tool_calls)
                    },
                });
            }
        }
        // Skip queue-operation, last-prompt, etc.
    }
    messages
}

/// Read up to `limit` complete trailing lines from `path` without parsing the
/// whole file. Seeks to EOF and reads backward in 64 KiB chunks until we
/// either collect `limit` complete lines (separated by `\n`) or reach byte 0.
/// Returns lines in file-order. The final line of a file that is NOT
/// newline-terminated is considered truncated and is dropped. If we reach
/// byte 0, a leading UTF-8 BOM is stripped so the first JSON line parses
/// cleanly — matching the full-file loader's behavior.
fn read_jsonl_tail_lines(path: &std::path::Path, limit: usize) -> Result<Vec<String>, String> {
    use std::io::{Read, Seek, SeekFrom};
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Match `load_session_history`: a missing JSONL is not an error —
            // the session may not have persisted to disk yet. Return empty.
            return Ok(Vec::new());
        }
        Err(e) => return Err(format!("open {}: {}", path.display(), e)),
    };
    let size = f
        .metadata()
        .map_err(|e| format!("stat {}: {}", path.display(), e))?
        .len();
    if size == 0 {
        return Ok(Vec::new());
    }

    const CHUNK: u64 = 64 * 1024;
    let mut buf: Vec<u8> = Vec::new();
    let mut pos: u64 = size;
    let mut reached_start = false;

    // Read backwards in 64 KiB chunks, prepending each to `buf`, until we
    // have enough complete line terminators in the usable portion (i.e.
    // after the earliest '\n' in the buffer — everything before the first
    // '\n' is a partial head of a line whose full content lives further
    // back in the file).
    loop {
        let read_size = CHUNK.min(pos);
        let new_pos = pos - read_size;
        f.seek(SeekFrom::Start(new_pos))
            .map_err(|e| format!("seek: {}", e))?;
        let mut chunk = vec![0u8; read_size as usize];
        f.read_exact(&mut chunk)
            .map_err(|e| format!("read chunk: {}", e))?;
        chunk.extend_from_slice(&buf);
        buf = chunk;
        pos = new_pos;
        if pos == 0 {
            reached_start = true;
        }

        // Lines fully contained in the buffer = '\n's that appear AFTER
        // the earliest '\n' boundary (or the whole buffer if we're at SOF).
        let usable_start = if reached_start {
            0
        } else {
            match buf.iter().position(|&b| b == b'\n') {
                Some(p) => p + 1,
                None => {
                    // No newline anywhere in buffer yet — keep reading back.
                    if reached_start {
                        break;
                    }
                    continue;
                }
            }
        };
        let complete = buf[usable_start..].iter().filter(|&&b| b == b'\n').count();
        if complete >= limit || reached_start {
            break;
        }
    }

    // Slice off the partial-head byte range, then handle BOM if we reached
    // byte 0 of the file.
    let mut start: usize = 0;
    if !reached_start {
        match buf.iter().position(|&b| b == b'\n') {
            Some(p) => start = p + 1,
            None => return Ok(Vec::new()),
        }
    } else if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        start = 3;
    }

    let slice = &buf[start..];
    // JSONL is always UTF-8, but a chunk boundary can land mid-codepoint.
    // `from_utf8_lossy` substitutes U+FFFD for any invalid byte; the caller
    // parses JSON per-line so a corrupted line just fails parse and is
    // skipped — no worse than the full-file loader handles today.
    let decoded = String::from_utf8_lossy(slice);

    // `split('\n')` on UTF-8 text: the final element is either "" (file
    // ended with '\n') or a trailing fragment (file did not). Either way we
    // drop it — an unterminated tail line is, by definition, truncated.
    let mut parts: Vec<&str> = decoded.split('\n').collect();
    parts.pop();

    let start_idx = parts.len().saturating_sub(limit);
    Ok(parts[start_idx..]
        .iter()
        .map(|l| (*l).to_string())
        .collect())
}

/// Tail variant: returns up to `limit` trailing visible messages without
/// parsing the entire JSONL. Reads the file tail in 64 KiB reverse chunks
/// until we have `limit` complete lines, then runs those lines through the
/// same parsing pipeline as `load_session_history`. The frontend merges the
/// tail into the store by message id, so older already-loaded messages
/// survive.
#[tauri::command]
fn load_session_history_tail(
    session_id: String,
    cwd: String,
    limit: usize,
) -> Result<Vec<HistoryMessage>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let path = session_jsonl_path(&cwd, &session_id)?;
    let tail_lines = read_jsonl_tail_lines(&path, limit)?;
    let mut messages = parse_session_history_lines(tail_lines.iter().map(|s| s.as_str()));
    // Tool-result merges only land if both ends of the pair fell inside the
    // tail window. That's the same trade the old split_off tail made — and
    // the frontend's merge-by-id logic is fine with partial records.
    if messages.len() > limit {
        let start = messages.len() - limit;
        messages = messages.split_off(start);
    }
    Ok(messages)
}

/// Lightweight stat for the session JSONL so the frontend can reuse a cached
/// hydration when mtime+size haven't changed. Returns `None` if the file is
/// missing (fresh session or never persisted).
#[tauri::command]
fn stat_session_jsonl(session_id: String, cwd: String) -> Result<Option<SessionJsonlStat>, String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("stat {}: {}", path.display(), e)),
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(Some(SessionJsonlStat {
        mtime_ms,
        size: meta.len(),
    }))
}

/// Collect JSONL lines up to `keep_turns` user messages (actual user prompts, not tool_result-only messages).
/// A "real" user turn has non-empty, non-whitespace text content — matching load_session_history's filtering.
fn collect_jsonl_lines_up_to_turns(content: &str, keep_turns: usize) -> Vec<&str> {
    let mut kept: Vec<&str> = Vec::new();
    let mut user_turn_count = 0;
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                kept.push(line);
                continue;
            }
        };
        if val["type"].as_str().unwrap_or("") == "user" {
            let is_real = val["message"]["content"]
                .as_str()
                .map(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    val["message"]["content"]
                        .as_array()
                        .map(|arr| {
                            arr.iter().any(|b| {
                                b["type"].as_str() == Some("text")
                                    && b["text"]
                                        .as_str()
                                        .map(|t| !t.trim().is_empty())
                                        .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                });
            if is_real {
                user_turn_count += 1;
            }
        }
        if user_turn_count > keep_turns {
            break;
        }
        kept.push(line);
    }
    kept
}

#[tauri::command]
fn truncate_session_jsonl(
    session_id: String,
    cwd: String,
    keep_turns: usize,
) -> Result<(), String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    check_rewrite_size_limit(&path)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            safe_eprintln!(
                "[rewind] truncate skipped: JSONL does not exist at {}",
                path.display()
            );
            return Ok(());
        }
        Err(e) => return Err(format!("read {}: {}", path.display(), e)),
    };
    let kept = collect_jsonl_lines_up_to_turns(&content, keep_turns);
    let truncated = kept.join("\n") + "\n";
    atomic_write_jsonl(&path, &truncated)?;
    safe_eprintln!(
        "[rewind] Truncated JSONL to {} turns (was {} lines, now {} lines)",
        keep_turns,
        content.lines().count(),
        kept.len()
    );
    Ok(())
}

/// Truncate JSONL to keep exactly `keep_messages` visible messages (as load_session_history would produce).
/// This matches the frontend's message count precisely — no turn-counting mismatches.
#[tauri::command]
fn truncate_session_jsonl_by_messages(
    session_id: String,
    cwd: String,
    keep_messages: usize,
) -> Result<serde_json::Value, String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    safe_eprintln!(
        "[rewind] truncate_session_jsonl_by_messages: path={} keep_messages={}",
        path.display(),
        keep_messages
    );
    check_rewrite_size_limit(&path)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Match `truncate_session_jsonl`: a missing JSONL means the session
            // never persisted to disk, so there's nothing to truncate. Treat as
            // a no-op rather than erroring — the UI may optimistically call
            // rewind on a freshly-created session before its first write.
            safe_eprintln!(
                "[rewind] truncate_by_messages skipped: JSONL does not exist at {}",
                path.display()
            );
            return Ok(serde_json::json!({
                "status": "skipped",
                "reason": "jsonl_not_found",
                "path": path.display().to_string(),
            }));
        }
        Err(e) => return Err(format!("read {}: {}", path.display(), e)),
    };
    let original_lines = content.lines().count();
    let original_bytes = content.len();

    let mut kept: Vec<&str> = Vec::new();
    let mut visible_count: usize = 0;
    let mut done = false;
    // Track the last visible message for diagnostics
    let mut last_visible_role = String::new();
    let mut last_visible_preview = String::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if done {
            // After reaching the target, still keep tool-result-only user records
            // (they pair with the last assistant's tool_use and don't produce visible messages).
            // A JSON parse failure must NOT abort the whole trailing sweep — pass the
            // malformed line through and keep scanning. Any other record type means we've
            // crossed into a later turn and must stop.
            let val: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => {
                    kept.push(line);
                    continue;
                }
            };
            if val["type"].as_str().unwrap_or("") == "user" {
                let has_text = is_real_user_message(&val);
                if !has_text {
                    kept.push(line);
                    continue;
                }
            }
            break;
        }
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                kept.push(line);
                continue;
            }
        };
        let rec_type = val["type"].as_str().unwrap_or("");
        // Count visible messages the same way load_session_history does
        if rec_type == "user" && is_real_user_message(&val) {
            visible_count += 1;
            if visible_count > keep_messages {
                break; // Don't keep this line
            }
            last_visible_role = "user".to_string();
            let c = &val["message"]["content"];
            last_visible_preview = if let Some(s) = c.as_str() {
                s.chars().take(80).collect()
            } else if let Some(arr) = c.as_array() {
                arr.iter()
                    .filter_map(|b| {
                        if b["type"].as_str() == Some("text") {
                            b["text"]
                                .as_str()
                                .map(|t| t.chars().take(80).collect::<String>())
                        } else {
                            None
                        }
                    })
                    .next()
                    .unwrap_or_default()
            } else {
                String::new()
            };
        } else if rec_type == "assistant" {
            let msg = &val["message"];
            if let Some(content_arr) = msg["content"].as_array() {
                let has_text = content_arr.iter().any(|b| {
                    b["type"].as_str() == Some("text")
                        && b["text"]
                            .as_str()
                            .map(|t| !t.trim().is_empty())
                            .unwrap_or(false)
                });
                let has_tools = content_arr
                    .iter()
                    .any(|b| b["type"].as_str() == Some("tool_use"));
                if has_text || has_tools {
                    visible_count += 1;
                    if visible_count > keep_messages {
                        break;
                    }
                    last_visible_role = "assistant".to_string();
                    last_visible_preview = content_arr
                        .iter()
                        .filter_map(|b| {
                            if b["type"].as_str() == Some("text") {
                                b["text"]
                                    .as_str()
                                    .map(|t| t.chars().take(80).collect::<String>())
                            } else {
                                None
                            }
                        })
                        .next()
                        .unwrap_or_else(|| "[tool calls]".to_string());
                }
            }
        }
        kept.push(line);
        if visible_count == keep_messages && rec_type == "assistant" {
            // Check if this assistant has tool_use — if so, keep trailing tool-result records
            if let Some(content_arr) = val["message"]["content"].as_array() {
                if content_arr
                    .iter()
                    .any(|b| b["type"].as_str() == Some("tool_use"))
                {
                    done = true;
                    continue; // Enter trailing mode
                }
            }
        }
    }

    if visible_count == 0 && keep_messages > 0 {
        return Err(format!(
            "No visible messages found in JSONL at {}. Total lines: {}",
            path.display(),
            original_lines
        ));
    }

    let truncated = kept.join("\n") + "\n";
    let new_bytes = truncated.len();
    atomic_write_jsonl(&path, &truncated)?;

    // Verification: re-read and count
    let verify = std::fs::read_to_string(&path)
        .map_err(|e| format!("verify-read {}: {}", path.display(), e))?;
    let verify_lines = verify.lines().filter(|l| !l.trim().is_empty()).count();

    safe_eprintln!("[rewind] Truncated JSONL: keep_messages={} actual_kept={} original_lines={} new_lines={} original_bytes={} new_bytes={}",
        keep_messages, visible_count, original_lines, kept.len(), original_bytes, new_bytes);
    safe_eprintln!(
        "[rewind] Last kept message: [{}] {}",
        last_visible_role,
        &last_visible_preview[..last_visible_preview.len().min(80)]
    );
    safe_eprintln!(
        "[rewind] Verify: file now has {} non-empty lines (expected {})",
        verify_lines,
        kept.len()
    );

    Ok(serde_json::json!({
        "path": path.display().to_string(),
        "keep_messages": keep_messages,
        "actual_visible_kept": visible_count,
        "original_lines": original_lines,
        "new_lines": kept.len(),
        "original_bytes": original_bytes,
        "new_bytes": new_bytes,
        "verify_lines": verify_lines,
        "last_visible_role": last_visible_role,
        "last_visible_preview": last_visible_preview,
    }))
}

/// Check if a user JSONL record would produce a visible message in load_session_history.
fn is_real_user_message(val: &serde_json::Value) -> bool {
    let content = &val["message"]["content"];
    if let Some(s) = content.as_str() {
        return !s.is_empty();
    }
    if let Some(arr) = content.as_array() {
        return arr.iter().any(|b| {
            b["type"].as_str() == Some("text")
                && b["text"]
                    .as_str()
                    .map(|t| !t.trim().is_empty())
                    .unwrap_or(false)
        });
    }
    false
}

#[tauri::command]
fn fork_session_jsonl(
    parent_session_id: String,
    new_session_id: String,
    cwd: String,
    keep_messages: usize,
) -> Result<String, String> {
    let src = session_jsonl_path(&cwd, &parent_session_id)?;
    let dest = session_jsonl_path(&cwd, &new_session_id)?;
    check_rewrite_size_limit(&src)?;
    // Stage the copy through atomic_write so a crash mid-copy can't leave a
    // half-written sibling JSONL that future loads would try to parse.
    let src_content = match std::fs::read_to_string(&src) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "fork source JSONL not found: {} (parent session never wrote to disk?)",
                src.display()
            ));
        }
        Err(e) => return Err(format!("read {}: {}", src.display(), e)),
    };
    atomic_write_jsonl(&dest, &src_content)?;
    // Reuse find_rewind_uuid (chain-walking) to locate the fork point UUID
    let uuid = find_rewind_uuid(new_session_id.clone(), cwd.clone(), keep_messages)?;
    // Truncate the copy so reloads from JSONL show only the pre-fork messages.
    // Without this, the fork appears with the full parent history until a new
    // prompt is sent with --resume-session-at.
    // If truncate fails AFTER the atomic copy succeeded, the dest file is a
    // full clone of the parent — a misleading "ghost fork" that would surface
    // in the session browser with the entire parent transcript and likely
    // cause resume-at to reference a parent UUID that's not at the fork point.
    // Roll back by removing dest (best-effort; log if cleanup itself fails)
    // and bubble up the truncate error so the caller can surface or retry.
    if let Err(e) = truncate_session_jsonl_by_messages(new_session_id.clone(), cwd, keep_messages) {
        if let Err(rm_err) = std::fs::remove_file(&dest) {
            safe_eprintln!(
                "[fork] rollback: failed to remove dest {} after truncate error: {}",
                dest.display(),
                rm_err
            );
        }
        return Err(format!("fork truncate failed: {}", e));
    }
    safe_eprintln!(
        "[fork] Copied + truncated JSONL {} -> {} (fork at msg {}, uuid={})",
        parent_session_id,
        new_session_id,
        keep_messages,
        &uuid,
    );
    Ok(uuid)
}

/// Walk the parentUuid chain in a session JSONL (matching how Claude CLI's
/// buildConversationChain works) and return the UUID of the Nth visible message.
/// Correct even after prior rewinds leave orphaned branches in append-only JSONL.
#[tauri::command]
fn find_rewind_uuid(
    session_id: String,
    cwd: String,
    keep_messages: usize,
) -> Result<String, String> {
    use std::collections::{HashMap, HashSet};

    let path = session_jsonl_path(&cwd, &session_id)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "JSONL not found at {} — cannot rewind a session that hasn't persisted to disk",
                path.display()
            ));
        }
        Err(e) => return Err(format!("read {}: {}", path.display(), e)),
    };

    let mut records: HashMap<String, serde_json::Value> = HashMap::new();
    let mut all_uuids: Vec<String> = Vec::new();
    let mut children: HashSet<String> = HashSet::new();

    let mut first_line = true;
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parse_line = if first_line {
            first_line = false;
            strip_bom(line)
        } else {
            line
        };
        let val: serde_json::Value = match serde_json::from_str(parse_line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(uuid) = val["uuid"].as_str() {
            let uuid = uuid.to_string();
            if let Some(parent) = val["parentUuid"].as_str() {
                children.insert(parent.to_string());
            }
            all_uuids.push(uuid.clone());
            records.insert(uuid, val);
        }
    }

    // Find leaf: last TRANSCRIPT uuid not referenced as anyone's parentUuid.
    // Only user/assistant records participate in the conversation chain — summary,
    // task-summary, context-collapse and other metadata entries have their own UUIDs
    // that would otherwise be picked as "leaves" and send the chain walk down a dead end.
    let is_transcript = |v: &serde_json::Value| -> bool {
        matches!(v["type"].as_str(), Some("user") | Some("assistant"))
    };
    let leaf = all_uuids
        .iter()
        .rev()
        .find(|u| {
            if children.contains(u.as_str()) {
                return false;
            }
            records.get(u.as_str()).map(is_transcript).unwrap_or(false)
        })
        .cloned()
        .ok_or_else(|| "No transcript leaf found in JSONL".to_string())?;

    // Walk backward from leaf via parentUuid to build active chain
    let mut chain: Vec<String> = Vec::new();
    let mut current = Some(leaf);
    while let Some(uuid) = current {
        chain.push(uuid.clone());
        current = records
            .get(&uuid)
            .and_then(|v| v["parentUuid"].as_str())
            .map(|s| s.to_string());
    }
    chain.reverse();

    // Count visible messages along the chain
    let mut visible_count: usize = 0;
    let mut last_uuid = String::new();

    for uuid in &chain {
        let val = match records.get(uuid) {
            Some(v) => v,
            None => continue,
        };
        let rec_type = val["type"].as_str().unwrap_or("");

        if rec_type == "user" && is_real_user_message(val) {
            visible_count += 1;
            if visible_count > keep_messages {
                break;
            }
            last_uuid = uuid.clone();
        } else if rec_type == "assistant" {
            if let Some(content_arr) = val["message"]["content"].as_array() {
                let has_text = content_arr.iter().any(|b| {
                    b["type"].as_str() == Some("text")
                        && b["text"]
                            .as_str()
                            .map(|t| !t.trim().is_empty())
                            .unwrap_or(false)
                });
                let has_tools = content_arr
                    .iter()
                    .any(|b| b["type"].as_str() == Some("tool_use"));
                if has_text || has_tools {
                    visible_count += 1;
                    if visible_count > keep_messages {
                        break;
                    }
                    last_uuid = uuid.clone();
                }
            }
        }
    }

    if last_uuid.is_empty() {
        return Err(format!(
            "No visible message at position {} in chain ({} records, {} in chain)",
            keep_messages,
            records.len(),
            chain.len()
        ));
    }
    safe_eprintln!(
        "[rewind] find_rewind_uuid: keep_messages={} uuid={} (chain={}, total={})",
        keep_messages,
        &last_uuid,
        chain.len(),
        records.len()
    );
    Ok(last_uuid)
}

/// Stream-parse the JSONL line-by-line and return only the metadata the session
/// browser needs (count, first user prompt, last assistant preview, last timestamp).
/// Cheap enough to call for every session in a project dir — does not allocate
/// the full `Vec<HistoryMessage>`. Malformed lines are skipped with a warning.
/// Returns `exists=false, msg_count=0` instead of an error when the JSONL is missing,
/// so callers can treat "not yet persisted" the same as "empty session".
#[tauri::command]
fn load_session_metadata(session_id: String, cwd: String) -> Result<SessionMetadata, String> {
    use std::io::BufRead;
    let path = session_jsonl_path(&cwd, &session_id)?;
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SessionMetadata {
                session_id,
                exists: false,
                ..Default::default()
            });
        }
        Err(e) => return Err(format!("open {}: {}", path.display(), e)),
    };
    let reader = std::io::BufReader::new(file);

    const PREVIEW_CHARS: usize = 240;
    let mut meta = SessionMetadata {
        session_id,
        exists: true,
        ..Default::default()
    };
    let mut malformed = 0usize;
    let mut first_line = true;

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => {
                // I/O error mid-read (e.g. CLI mid-write). Stop scanning but keep
                // whatever metadata we collected — never return Err that would erase
                // an existing chat from the UI.
                safe_eprintln!(
                    "[metadata] read interrupted; returning partial metadata for {}",
                    meta.session_id
                );
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let parse_line = if first_line {
            first_line = false;
            strip_bom(&line)
        } else {
            line.as_str()
        };
        let val: serde_json::Value = match serde_json::from_str(parse_line) {
            Ok(v) => v,
            Err(_) => {
                malformed += 1;
                continue;
            }
        };
        let rec_type = val["type"].as_str().unwrap_or("");
        let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));
        if ts > meta.last_timestamp {
            meta.last_timestamp = ts;
        }

        if rec_type == "user" && is_real_user_message(&val) {
            meta.msg_count += 1;
            if meta.first_user_prompt.is_empty() {
                let raw = extract_user_text(&val);
                let cleaned = strip_system_reminders(&raw);
                if !cleaned.is_empty() {
                    meta.first_user_prompt = cleaned.chars().take(PREVIEW_CHARS).collect();
                }
            }
        } else if rec_type == "assistant" {
            if let Some(content_arr) = val["message"]["content"].as_array() {
                let text: String = content_arr
                    .iter()
                    .filter_map(|b| {
                        if b["type"].as_str() == Some("text") {
                            b["text"].as_str().map(str::to_string)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let has_text = !text.trim().is_empty();
                let has_tools = content_arr
                    .iter()
                    .any(|b| b["type"].as_str() == Some("tool_use"));
                if has_text || has_tools {
                    meta.msg_count += 1;
                    if has_text {
                        meta.last_assistant_preview =
                            text.trim().chars().take(PREVIEW_CHARS).collect();
                    } else if meta.last_assistant_preview.is_empty() {
                        meta.last_assistant_preview = "[tool calls]".to_string();
                    }
                }
            }
        }
    }

    if malformed > 0 {
        safe_eprintln!(
            "[metadata] {} skipped {} malformed line(s)",
            meta.session_id,
            malformed
        );
    }
    Ok(meta)
}

/// Pull the user's text out of a JSONL `user` record, handling both the
/// string-content and array-content shapes the CLI emits.
fn extract_user_text(val: &serde_json::Value) -> String {
    let content = &val["message"]["content"];
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let mut out = String::new();
        for block in arr {
            if block["type"].as_str() == Some("text") {
                if let Some(t) = block["text"].as_str() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
        }
        return out;
    }
    String::new()
}

fn parse_timestamp(ts: &str) -> f64 {
    chrono::DateTime::parse_from_rfc3339(ts)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&format!("{}Z", ts)))
        .map(|dt| dt.timestamp_millis() as f64)
        .unwrap_or(0.0)
}

#[tauri::command]
fn resolve_permission(
    state: tauri::State<'_, AppState>,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    let reason = if allow {
        "Approved by user"
    } else {
        "Denied by user"
    };
    state.permission_server.resolve(&request_id, allow, reason);
    Ok(())
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err("Not a directory".into());
    }
    let mut entries = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return Ok(entries);
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.iter().any(|s| name == *s) {
            continue;
        }
        if name.starts_with('.') && name != ".." {
            continue;
        }
        let is_dir = entry.path().is_dir();
        entries.push(DirEntry { name, is_dir });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
async fn shell_exec(command: String, cwd: Option<String>) -> Result<serde_json::Value, String> {
    // Validate command against blocklist of dangerous patterns
    validate_shell_command(&command)?;

    let shell = if cfg!(windows) { "cmd" } else { "sh" };
    let flag = if cfg!(windows) { "/C" } else { "-c" };
    let mut cmd = std::process::Command::new(shell);
    cmd.arg(flag)
        .arg(&command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    if let Some(ref dir) = cwd {
        if !dir.is_empty() {
            cmd.current_dir(dir);
        }
    }
    // Ensure common tools are on PATH for macOS GUI apps
    if cfg!(target_os = "macos") {
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{}", path));
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd.output().map_err(|e| format!("exec failed: {}", e))?;
    Ok(serde_json::json!({
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
        "code": output.status.code().unwrap_or(-1),
    }))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path, e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
fn parse_mcp_server(name: &str, cfg: &serde_json::Value, scope: &str) -> McpServer {
    let transport = cfg
        .get("type")
        .or(cfg.get("transport"))
        .and_then(|v| v.as_str())
        .unwrap_or("stdio")
        .to_string();
    let url = cfg
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let command = cfg
        .get("command")
        .and_then(|v| v.as_str())
        .or(url.as_deref())
        .unwrap_or("")
        .to_string();
    let args = cfg.get("args").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    });
    let env = cfg.get("env").and_then(|v| v.as_object()).map(|obj| {
        obj.iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
            .collect()
    });
    let headers = cfg.get("headers").and_then(|v| v.as_object()).map(|obj| {
        obj.iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
            .collect()
    });
    McpServer {
        name: name.to_string(),
        transport,
        command,
        scope: scope.to_string(),
        url,
        args,
        env,
        headers,
    }
}

#[tauri::command]
fn list_mcp_servers(cwd: String) -> Result<Vec<McpServer>, String> {
    let mut servers = Vec::new();
    let mut seen = std::collections::HashSet::new();

    if let Some(home) = dirs::home_dir() {
        for name in &["settings.json", "settings.local.json"] {
            let path = home.join(".claude").join(name);
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                    if let Some(obj) = val.get("mcpServers").and_then(|v| v.as_object()) {
                        for (name, cfg) in obj {
                            if seen.insert(name.clone()) {
                                servers.push(parse_mcp_server(name, cfg, "user"));
                            }
                        }
                    }
                }
            }
        }
    }

    let project_mcp = std::path::Path::new(&cwd).join(".mcp.json");
    if let Ok(data) = std::fs::read_to_string(&project_mcp) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(obj) = val.get("mcpServers").and_then(|v| v.as_object()) {
                for (name, cfg) in obj {
                    if seen.insert(name.clone()) {
                        servers.push(parse_mcp_server(name, cfg, "project"));
                    }
                }
            }
        }
    }

    Ok(servers)
}

#[tauri::command]
fn list_slash_commands() -> Result<Vec<SlashCommand>, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let claude_dir = home.join(".claude");

    let mut commands = Vec::new();

    // Built-in Claude Code commands — (name, description, usage hint)
    let builtins: Vec<(&str, &str, Option<&str>)> = vec![
        (
            "add-dir",
            "Add a working directory for file access",
            Some("/add-dir <path>"),
        ),
        ("agents", "Manage agent configurations", None),
        (
            "branch",
            "Branch the conversation at this point",
            Some("/branch [name] — alias: /fork"),
        ),
        (
            "btw",
            "Ask a side question without adding to context",
            Some("/btw <question>"),
        ),
        ("clear", "Clear conversation history", None),
        (
            "color",
            "Set session prompt bar color",
            Some("/color [red|blue|green|yellow|purple|orange|pink|cyan|default]"),
        ),
        (
            "compact",
            "Compact conversation to save context",
            Some("/compact [instructions]"),
        ),
        ("config", "Open settings interface", None),
        ("context", "Visualize current context usage", None),
        (
            "copy",
            "Copy last assistant response to clipboard",
            Some("/copy [N] — N=2 for second-to-last"),
        ),
        ("cost", "Show token usage and cost for this session", None),
        (
            "diff",
            "Interactive diff viewer for uncommitted changes",
            None,
        ),
        ("doctor", "Check Claude Code setup for issues", None),
        (
            "effort",
            "Set model effort level",
            Some("/effort [low|medium|high|max|auto]"),
        ),
        (
            "export",
            "Export conversation as plain text",
            Some("/export [filename]"),
        ),
        ("fast", "Toggle fast mode", Some("/fast [on|off]")),
        ("feedback", "Submit feedback about Claude Code", None),
        ("help", "Show help and available commands", None),
        ("hooks", "View hook configurations for tool events", None),
        ("init", "Initialize a CLAUDE.md for this project", None),
        ("insights", "Generate session analysis report", None),
        ("keybindings", "Open keybindings configuration file", None),
        ("login", "Sign in to your Anthropic account", None),
        ("logout", "Sign out from your Anthropic account", None),
        ("mcp", "Manage MCP server connections", None),
        ("memory", "Edit CLAUDE.md memory files", None),
        (
            "model",
            "Switch the AI model",
            Some("/model [sonnet|opus|haiku]"),
        ),
        ("permissions", "View and manage tool permissions", None),
        ("plan", "Enter plan mode", Some("/plan [description]")),
        ("plugin", "Manage Claude Code plugins", None),
        (
            "pr-comments",
            "Fetch comments from a GitHub PR",
            Some("/pr-comments [PR number or URL]"),
        ),
        ("release-notes", "View the full changelog", None),
        (
            "rename",
            "Rename the current session",
            Some("/rename [name]"),
        ),
        (
            "resume",
            "Resume a conversation by ID or name",
            Some("/resume [session]"),
        ),
        ("rewind", "Rewind conversation to a previous point", None),
        (
            "schedule",
            "Create, update, or list scheduled remote agents",
            Some("/schedule [create|list|run] ..."),
        ),
        (
            "security-review",
            "Analyze pending changes for security vulnerabilities",
            None,
        ),
        ("skills", "List available skills", None),
        ("stats", "Visualize daily usage and session history", None),
        (
            "status",
            "Show version, model, account, and connectivity",
            None,
        ),
        ("tasks", "List and manage background tasks", None),
        ("theme", "Change the color theme", None),
        (
            "usage",
            "Show plan usage limits and rate limit status",
            None,
        ),
        ("voice", "Toggle push-to-talk voice dictation", None),
    ];
    for (name, desc, usage) in &builtins {
        commands.push(SlashCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: "built-in".to_string(),
            usage: usage.map(|u| u.to_string()),
        });
    }

    fn scan_dir(dir: &std::path::Path, commands: &mut Vec<SlashCommand>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().map(|n| n == "skills").unwrap_or(false) {
                    if let Ok(skill_dirs) = std::fs::read_dir(&path) {
                        for skill_entry in skill_dirs.flatten() {
                            let skill_path = skill_entry.path();
                            if skill_path.is_dir() {
                                let skill_md = skill_path.join("SKILL.md");
                                if skill_md.exists() {
                                    if let Some(cmd) = parse_skill_md(&skill_md, &skill_path) {
                                        commands.push(cmd);
                                    }
                                }
                            }
                        }
                    }
                } else if path.file_name().map(|n| n == "commands").unwrap_or(false) {
                    if let Ok(cmd_files) = std::fs::read_dir(&path) {
                        for cmd_entry in cmd_files.flatten() {
                            let cmd_path = cmd_entry.path();
                            if cmd_path.extension().map(|e| e == "md").unwrap_or(false) {
                                if let Some(cmd) = parse_command_md(&cmd_path) {
                                    commands.push(cmd);
                                }
                            }
                        }
                    }
                } else if path
                    .file_name()
                    .map(|n| n == "node_modules" || n == ".git")
                    .unwrap_or(false)
                {
                    // Skip
                } else {
                    scan_dir(&path, commands);
                }
            }
        }
    }

    fn parse_frontmatter(content: &str) -> Option<(&str, &str)> {
        let content = content.trim_start();
        if !content.starts_with("---") {
            return None;
        }
        let rest = &content[3..];
        let end = rest.find("---")?;
        Some((rest[..end].trim(), rest[end + 3..].trim()))
    }

    fn extract_yaml_field<'a>(yaml: &'a str, field: &str) -> Option<&'a str> {
        for line in yaml.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix(field) {
                if let Some(rest) = rest.strip_prefix(':') {
                    let val = rest.trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        return Some(val);
                    }
                }
            }
        }
        None
    }

    fn derive_source(path: &std::path::Path) -> &str {
        for ancestor in path.ancestors() {
            if let Some(parent) = ancestor.parent() {
                if let Some(pname) = parent.file_name() {
                    if pname == "cache" || pname == "plugins" || pname == "marketplaces" {
                        if let Some(name) = ancestor.file_name() {
                            return name.to_str().unwrap_or("unknown");
                        }
                    }
                }
            }
        }
        "unknown"
    }

    fn parse_skill_md(path: &std::path::Path, skill_dir: &std::path::Path) -> Option<SlashCommand> {
        let content = std::fs::read_to_string(path).ok()?;
        let (yaml, _) = parse_frontmatter(&content)?;
        let name = extract_yaml_field(yaml, "name").or_else(|| skill_dir.file_name()?.to_str())?;
        let desc = extract_yaml_field(yaml, "description").unwrap_or("");
        let source = derive_source(path);
        Some(SlashCommand {
            name: name.to_string(),
            description: desc.to_string(),
            source: source.to_string(),
            usage: None,
        })
    }

    fn parse_command_md(path: &std::path::Path) -> Option<SlashCommand> {
        let content = std::fs::read_to_string(path).ok()?;
        let name = path.file_stem()?.to_str()?;
        let desc = if let Some((yaml, _)) = parse_frontmatter(&content) {
            extract_yaml_field(yaml, "description")
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };
        let source = derive_source(path);
        Some(SlashCommand {
            name: name.to_string(),
            description: desc,
            source: source.to_string(),
            usage: None,
        })
    }

    // Scan plugins cache (installed versions)
    let cache_dir = claude_dir.join("plugins").join("cache");
    if cache_dir.exists() {
        scan_dir(&cache_dir, &mut commands);
    }

    // Scan user-level skills (~/.claude/skills/)
    let user_skills = claude_dir.join("skills");
    if user_skills.exists() {
        if let Ok(entries) = std::fs::read_dir(&user_skills) {
            for entry in entries.flatten() {
                let skill_path = entry.path();
                if skill_path.is_dir() {
                    let skill_md = skill_path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Some(mut cmd) = parse_skill_md(&skill_md, &skill_path) {
                            cmd.source = "user".to_string();
                            commands.push(cmd);
                        }
                    }
                }
            }
        }
    }

    // Scan project-level skills (.claude/skills/)
    if let Ok(cwd) = std::env::current_dir() {
        let project_skills = cwd.join(".claude").join("skills");
        if project_skills.exists() {
            if let Ok(entries) = std::fs::read_dir(&project_skills) {
                for entry in entries.flatten() {
                    let skill_path = entry.path();
                    if skill_path.is_dir() {
                        let skill_md = skill_path.join("SKILL.md");
                        if skill_md.exists() {
                            if let Some(mut cmd) = parse_skill_md(&skill_md, &skill_path) {
                                cmd.source = "project".to_string();
                                commands.push(cmd);
                            }
                        }
                    }
                }
            }
        }
    }

    // Scan user-level commands (~/.claude/commands/)
    let user_cmds = claude_dir.join("commands");
    if user_cmds.exists() {
        if let Ok(entries) = std::fs::read_dir(&user_cmds) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "md").unwrap_or(false) {
                    if let Some(mut cmd) = parse_command_md(&path) {
                        cmd.source = "user".to_string();
                        commands.push(cmd);
                    }
                }
            }
        }
    }

    // Scan project-level .claude/commands/
    if let Ok(cwd) = std::env::current_dir() {
        let project_cmds = cwd.join(".claude").join("commands");
        if project_cmds.exists() {
            if let Ok(entries) = std::fs::read_dir(&project_cmds) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map(|e| e == "md").unwrap_or(false) {
                        if let Some(mut cmd) = parse_command_md(&path) {
                            cmd.source = "project".to_string();
                            commands.push(cmd);
                        }
                    }
                }
            }
        }
    }

    // Scan Terminal 64 skill library (~/.terminal64/skills/)
    let t64_skills = home.join(".terminal64").join("skills");
    if t64_skills.exists() {
        if let Ok(entries) = std::fs::read_dir(&t64_skills) {
            for entry in entries.flatten() {
                let skill_path = entry.path();
                if skill_path.is_dir() {
                    let skill_md = skill_path.join("SKILL.md");
                    if skill_md.exists() {
                        if let Some(mut cmd) = parse_skill_md(&skill_md, &skill_path) {
                            cmd.source = "Terminal 64".to_string();
                            commands.push(cmd);
                        }
                    }
                }
            }
        }
    }

    // Deduplicate by name (keep first occurrence — builtins first, then cache, then marketplace)
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands.dedup_by(|a, b| a.name == b.name);

    Ok(commands)
}

#[tauri::command]
fn start_discord_bot(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    token: String,
    guild_id: String,
) -> Result<(), String> {
    let gid: u64 = guild_id.parse().map_err(|_| "Invalid guild ID")?;
    let mut bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.start(token, gid, app_handle)
}

#[tauri::command]
fn stop_discord_bot(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.stop()
}

#[tauri::command]
fn discord_bot_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    Ok(bot.is_running())
}

// ── OpenWolf daemon management ─────────────────────────────

/// Build a Command that works for npm shim scripts (.cmd/.ps1) on Windows
/// AND plain binaries on Unix. On Windows it routes through `cmd /C` so
/// PATHEXT resolution works and .cmd shims (pm2, claude, openwolf) execute
/// correctly. CREATE_NO_WINDOW suppresses the console flash.
fn shim_command(bin: &str) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(bin);
        c.creation_flags(0x08000000);
        c
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(bin)
    }
}

#[tauri::command]
fn start_openwolf_daemon(cwd: String) -> Result<(), String> {
    let wolf_bin = claude_manager::resolve_openwolf_path();
    let output = shim_command(&wolf_bin)
        .args(["daemon", "start"])
        .current_dir(&cwd)
        .env("PATH", claude_manager::openwolf_env_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Failed to start OpenWolf daemon: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{} {}", stdout, stderr).to_lowercase();

    if combined.contains("pm2 not found") || combined.contains("pm2: not found") {
        return Err(
            "pm2 is required for the OpenWolf daemon. Install with: npm install -g pm2".into(),
        );
    }
    if combined.contains("not initialized") {
        return Err(format!(
            "OpenWolf not initialized in {}. Run: openwolf init",
            cwd
        ));
    }

    if !output.status.success() && !combined.contains("already") {
        return Err(format!("OpenWolf daemon failed: {}", stderr.trim()));
    }

    safe_eprintln!("[openwolf] Daemon started for {}", cwd);
    Ok(())
}

#[tauri::command]
fn stop_openwolf_daemon(cwd: String) -> Result<(), String> {
    let wolf_bin = claude_manager::resolve_openwolf_path();
    let output = shim_command(&wolf_bin)
        .args(["daemon", "stop"])
        .current_dir(&cwd)
        .env("PATH", claude_manager::openwolf_env_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Failed to stop OpenWolf daemon: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.to_lowercase().contains("not running") {
            return Err(format!("OpenWolf daemon stop failed: {}", stderr.trim()));
        }
    }
    safe_eprintln!("[openwolf] Daemon stopped for {}", cwd);
    Ok(())
}

#[tauri::command]
fn openwolf_daemon_status() -> Result<bool, String> {
    // openwolf has no `daemon status` subcommand — check pm2 directly
    let output = shim_command("pm2")
        .args(["jlist"])
        .env("PATH", claude_manager::openwolf_env_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) {
                Ok(arr.iter().any(|proc| {
                    let name = proc.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let status = proc
                        .get("pm2_env")
                        .and_then(|env| env.get("status"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    name.contains("openwolf") && status == "online"
                }))
            } else {
                Ok(false)
            }
        }
        _ => Ok(false),
    }
}

/// List all pm2 processes whose name starts with `openwolf-`.
fn pm2_openwolf_processes() -> Vec<serde_json::Value> {
    let output = shim_command("pm2")
        .args(["jlist"])
        .env("PATH", claude_manager::openwolf_env_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .output();

    let Ok(o) = output else {
        return vec![];
    };
    if !o.status.success() {
        return vec![];
    }
    let stdout = String::from_utf8_lossy(&o.stdout);
    let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) else {
        return vec![];
    };
    arr.into_iter()
        .filter(|p| {
            p.get("name")
                .and_then(|v| v.as_str())
                .map(|n| n.starts_with("openwolf-"))
                .unwrap_or(false)
        })
        .collect()
}

/// Delete a single pm2 process by name (removes from list, including errored ones).
fn pm2_delete(name: &str) {
    let _ = shim_command("pm2")
        .args(["delete", name])
        .env("PATH", claude_manager::openwolf_env_path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .status();
}

/// Stop all openwolf daemons (online or errored), then start one in the given cwd.
/// Only one openwolf daemon can run at a time because it listens on a fixed port (18791).
#[tauri::command]
fn openwolf_daemon_switch(cwd: String) -> Result<(), String> {
    for proc in pm2_openwolf_processes() {
        if let Some(name) = proc.get("name").and_then(|v| v.as_str()) {
            pm2_delete(name);
        }
    }
    start_openwolf_daemon(cwd)
}

#[derive(serde::Serialize)]
struct OpenWolfDaemonInfo {
    running: bool,
    name: Option<String>,
    cwd: Option<String>,
    pid: Option<i64>,
    uptime_ms: Option<i64>,
    memory: Option<u64>,
    cpu: Option<f64>,
    restarts: Option<i64>,
    status: Option<String>,
}

/// Return detailed info on the openwolf daemon (prefers the online one,
/// falls back to the most recently-restarted errored one).
#[tauri::command]
fn openwolf_daemon_info() -> Result<OpenWolfDaemonInfo, String> {
    let procs = pm2_openwolf_processes();
    if procs.is_empty() {
        return Ok(OpenWolfDaemonInfo {
            running: false,
            name: None,
            cwd: None,
            pid: None,
            uptime_ms: None,
            memory: None,
            cpu: None,
            restarts: None,
            status: None,
        });
    }

    let target = procs
        .iter()
        .find(|p| {
            p.get("pm2_env")
                .and_then(|e| e.get("status"))
                .and_then(|v| v.as_str())
                == Some("online")
        })
        .or_else(|| procs.first())
        .ok_or_else(|| "no pm2 process entries".to_string())?;

    let env = target.get("pm2_env");
    let monit = target.get("monit");
    let status = env
        .and_then(|e| e.get("status"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let running = status.as_deref() == Some("online");

    let uptime_ms = if running {
        env.and_then(|e| e.get("pm_uptime"))
            .and_then(|v| v.as_i64())
            .map(|started| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                (now - started).max(0)
            })
    } else {
        None
    };

    Ok(OpenWolfDaemonInfo {
        running,
        name: target
            .get("name")
            .and_then(|v| v.as_str())
            .map(String::from),
        cwd: env
            .and_then(|e| e.get("pm_cwd").or_else(|| e.get("cwd")))
            .and_then(|v| v.as_str())
            .map(String::from),
        pid: target
            .get("pid")
            .and_then(|v| v.as_i64())
            .filter(|n| *n > 0),
        uptime_ms,
        memory: monit.and_then(|m| m.get("memory")).and_then(|v| v.as_u64()),
        cpu: monit.and_then(|m| m.get("cpu")).and_then(|v| v.as_f64()),
        restarts: env
            .and_then(|e| e.get("restart_time"))
            .and_then(|v| v.as_i64()),
        status,
    })
}

/// Stop all openwolf daemons in pm2 (online or errored).
#[tauri::command]
fn openwolf_daemon_stop_all() -> Result<(), String> {
    for proc in pm2_openwolf_processes() {
        if let Some(name) = proc.get("name").and_then(|v| v.as_str()) {
            pm2_delete(name);
        }
    }
    Ok(())
}

/// Read the project-intel widget's saved project cwd, if any.
/// Used by App.tsx on startup so the daemon tracks the widget's last-used dir.
#[tauri::command]
fn openwolf_project_cwd() -> Result<Option<String>, String> {
    let path = match widget_state_path("project-intel") {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    Ok(json
        .get("pi-project-cwd")
        .and_then(|v| v.as_str())
        .map(String::from))
}

#[tauri::command]
fn unlink_session_from_discord(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.unlink_session(&session_id)
}

#[tauri::command]
fn link_session_to_discord(
    state: tauri::State<'_, AppState>,
    session_id: String,
    session_name: String,
    cwd: String,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.link_session(session_id, session_name, cwd)
}

#[tauri::command]
fn rename_discord_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    session_name: String,
    cwd: String,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.rename_or_link_session(session_id, session_name, cwd)
}

#[tauri::command]
fn discord_cleanup_orphaned(
    state: tauri::State<'_, AppState>,
    active_session_ids: Vec<String>,
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.cleanup_orphaned(active_session_ids)
}

#[tauri::command]
fn get_delegation_port(state: tauri::State<'_, AppState>) -> Result<u16, String> {
    state.permission_server.ensure_alive()
}

#[tauri::command]
fn get_delegation_secret(state: tauri::State<'_, AppState>) -> String {
    state.permission_server.secret().to_string()
}

fn resolve_node_path() -> &'static str {
    static NODE_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NODE_PATH.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            let mut cands: Vec<String> = Vec::new();
            if let Ok(pf) = std::env::var("ProgramFiles") {
                cands.push(format!("{}\\nodejs\\node.exe", pf));
            }
            if let Ok(lad) = std::env::var("LOCALAPPDATA") {
                cands.push(format!("{}\\Programs\\nodejs\\node.exe", lad));
            }
            if let Ok(h) = std::env::var("USERPROFILE") {
                cands.push(format!("{}\\scoop\\apps\\nodejs\\current\\node.exe", h));
                cands.push(format!("{}\\AppData\\Roaming\\nvm\\node.exe", h));
            }
            for p in &cands {
                if std::path::Path::new(p).exists() {
                    return p.clone();
                }
            }
            let mut c = std::process::Command::new("where");
            c.arg("node.exe")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null());
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
            if let Ok(output) = c.output() {
                if output.status.success() {
                    let s = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !s.is_empty() && std::path::Path::new(&s).exists() {
                        return s;
                    }
                }
            }
            "node.exe".to_string()
        }
        #[cfg(not(target_os = "windows"))]
        {
            for p in &[
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ] {
                if std::path::Path::new(p).exists() {
                    return p.to_string();
                }
            }
            if let Ok(output) = std::process::Command::new("/bin/sh")
                .args(["-lc", "which node"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output()
            {
                if output.status.success() {
                    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !s.is_empty() && std::path::Path::new(&s).exists() {
                        return s;
                    }
                }
            }
            "node".to_string()
        }
    })
}

#[tauri::command]
fn create_mcp_config_file(
    app_handle: tauri::AppHandle,
    delegation_port: u16,
    delegation_secret: String,
    group_id: String,
    agent_label: String,
) -> Result<String, String> {
    let app_dir = get_app_dir(app_handle)?;
    let script_path = format!("{}/mcp/t64-server.mjs", app_dir);
    let node_path = resolve_node_path();
    safe_eprintln!("[mcp] Using node: {}", node_path);
    let config = serde_json::json!({
        "mcpServers": {
            "terminal-64": {
                "command": node_path,
                "args": [script_path],
                "env": {
                    "T64_DELEGATION_PORT": delegation_port.to_string(),
                    "T64_DELEGATION_SECRET": delegation_secret,
                    "T64_GROUP_ID": group_id,
                    "T64_AGENT_LABEL": agent_label,
                }
            }
        }
    });
    let dir = std::env::temp_dir().join("t64-mcp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let filename = format!("{}.json", uuid::Uuid::new_v4());
    let path = dir.join(&filename);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    safe_eprintln!("[mcp] Created config file: {}", path.display());
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_node_path() -> String {
    resolve_node_path().to_string()
}

#[tauri::command]
fn ensure_t64_mcp(app_handle: tauri::AppHandle, cwd: String) -> Result<(), String> {
    let app_dir = get_app_dir(app_handle)?;
    let script_path = format!("{}/mcp/t64-server.mjs", app_dir);
    let node_path = resolve_node_path();
    let mcp_path = format!("{}/.mcp.json", cwd);

    let mut config: serde_json::Value = std::fs::read_to_string(&mcp_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let servers = config
        .as_object_mut()
        .ok_or("Invalid .mcp.json")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));

    // Only write if missing or command/args changed
    if let Some(existing) = servers.get("terminal-64") {
        if existing.get("command").and_then(|v| v.as_str()) == Some(node_path)
            && existing
                .get("args")
                .and_then(|v| v.get(0))
                .and_then(|v| v.as_str())
                == Some(&script_path)
        {
            return Ok(());
        }
    }

    servers.as_object_mut().ok_or("Invalid mcpServers")?.insert(
        "terminal-64".to_string(),
        serde_json::json!({ "command": node_path, "args": [script_path] }),
    );

    std::fs::write(
        &mcp_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    safe_eprintln!("[mcp] Updated .mcp.json with node_path={}", node_path);
    Ok(())
}

#[tauri::command]
fn get_app_dir(app_handle: tauri::AppHandle) -> Result<String, String> {
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        if res_dir.join("mcp").is_dir() {
            safe_eprintln!("[app] Found mcp/ in resource dir: {}", res_dir.display());
            return Ok(res_dir.to_string_lossy().to_string());
        }
    }
    // Walk up from exe to find project root (dev mode)
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut dir = exe.parent();
    while let Some(d) = dir {
        if d.join("mcp").is_dir() {
            return Ok(d.to_string_lossy().to_string());
        }
        dir = d.parent();
    }
    // Fallback: check current working directory
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("mcp").is_dir() {
            return Ok(cwd.to_string_lossy().to_string());
        }
    }
    Err("Could not locate app directory with mcp/ folder".into())
}

#[tauri::command]
fn get_delegation_messages(
    state: tauri::State<'_, AppState>,
    group_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let msgs = state
        .permission_server
        .delegation_messages
        .lock()
        .map_err(|e| e.to_string())?;
    let group_msgs = msgs.get(&group_id).cloned().unwrap_or_default();
    Ok(group_msgs
        .iter()
        .map(|m| {
            serde_json::json!({
                "agent": m.agent,
                "message": m.message,
                "timestamp": m.timestamp,
                "msg_type": m.msg_type,
            })
        })
        .collect())
}

#[tauri::command]
fn cleanup_delegation_group(
    state: tauri::State<'_, AppState>,
    group_id: String,
) -> Result<(), String> {
    state.permission_server.cleanup_delegation_group(&group_id);
    Ok(())
}

// ---- Widget commands ----

fn widgets_base_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    Ok(home.join(".terminal64").join("widgets"))
}

/// Create a directory link (symlink on Unix, symlink-or-junction on Windows).
/// On Windows, junctions don't require Admin/Developer Mode like symlinks do,
/// so we fall back to `mklink /J` when symlink_dir fails.
fn create_dir_link(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return Ok(());
        }
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.creation_flags(0x08000000)
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target);
        let out = c.output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "mklink /J failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )))
        }
    }
}

#[tauri::command]
fn create_widget_folder(widget_id: String) -> Result<String, String> {
    let dir = widgets_base_dir()?.join(&widget_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn read_widget_html(widget_id: String) -> Result<String, String> {
    let path = widgets_base_dir()?.join(&widget_id).join("index.html");
    match std::fs::read_to_string(&path) {
        Ok(c) => Ok(c),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read: {}", e)),
    }
}

#[tauri::command]
fn list_widget_folders() -> Result<Vec<serde_json::Value>, String> {
    let base = widgets_base_dir()?;
    if !base.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let index_exists = entry.path().join("index.html").exists();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| std::io::Error::other("time"))
            })
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(serde_json::json!({
            "widget_id": name,
            "has_index": index_exists,
            "modified": modified,
        }));
    }
    out.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Ok(out)
}

#[tauri::command]
fn delete_widget_folder(widget_id: String) -> Result<(), String> {
    let dir = widgets_base_dir()?.join(&widget_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("rm: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn install_widget_zip(zip_path: String) -> Result<String, String> {
    let src = std::path::Path::new(&zip_path);
    if !src.exists() {
        return Err(format!("File not found: {}", zip_path));
    }
    let file = std::fs::File::open(src).map_err(|e| format!("open: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("invalid zip: {}", e))?;

    // Determine widget id: if every entry shares a common top-level folder, use that;
    // otherwise fall back to the zip filename (without extension).
    let mut top_dirs = std::collections::HashSet::<String>::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry: {}", e))?;
        let name: &str = entry.name();
        if let Some(first) = name.split('/').next() {
            if !first.is_empty() {
                top_dirs.insert(first.to_string());
            }
        }
    }
    let (widget_id, strip_prefix) = if let Some(name) = top_dirs
        .iter()
        .next()
        .cloned()
        .filter(|_| top_dirs.len() == 1)
    {
        let id = name
            .to_lowercase()
            .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-");
        (id, true)
    } else {
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        let id = stem
            .to_lowercase()
            .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-");
        (id, false)
    };

    let dest = widgets_base_dir()?.join(&widget_id);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| format!("cleanup: {}", e))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("mkdir: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry: {}", e))?;
        let raw_name = entry.name().to_string();

        let rel = if strip_prefix {
            // Strip the single top-level directory
            match raw_name.find('/') {
                Some(idx) => &raw_name[idx + 1..],
                None => &raw_name,
            }
        } else {
            &raw_name
        };

        if rel.is_empty() {
            continue;
        }

        // Reject path traversal BEFORE joining — PathBuf::starts_with is a
        // lexical prefix check that doesn't collapse ".." segments, so a
        // crafted zip with "..\..\foo" would escape `dest` on Windows.
        let rel_norm = rel.replace('\\', "/");
        let rel_path = std::path::Path::new(&rel_norm);
        if rel_path.is_absolute() {
            continue;
        }
        let has_traversal = rel_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
        if has_traversal {
            continue;
        }

        let out_path = dest.join(rel_path);
        if !out_path.starts_with(&dest) {
            continue;
        }

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("mkdir: {}", e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("create {}: {}", out_path.display(), e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("write {}: {}", out_path.display(), e))?;
        }
    }

    Ok(widget_id)
}

#[tauri::command]
fn widget_file_modified(widget_id: String) -> Result<u64, String> {
    let dir = widgets_base_dir()?.join(&widget_id);
    if !dir.exists() {
        return Ok(0);
    }
    fn newest_mtime(dir: &std::path::Path) -> u64 {
        let mut max = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let ft = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                if ft.is_dir() {
                    // Skip node_modules and hidden dirs
                    let name = entry.file_name();
                    let n = name.to_string_lossy();
                    if n.starts_with('.') || n == "node_modules" {
                        continue;
                    }
                    max = max.max(newest_mtime(&entry.path()));
                } else {
                    // Skip state.json — written by widget state API, not user edits
                    let name = entry.file_name();
                    if name.to_string_lossy() == "state.json" {
                        continue;
                    }
                    let mt = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .and_then(|t| {
                            t.duration_since(std::time::UNIX_EPOCH)
                                .map_err(|_| std::io::Error::other("time"))
                        })
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    max = max.max(mt);
                }
            }
        }
        max
    }
    Ok(newest_mtime(&dir))
}

#[tauri::command]
fn get_widget_server_port(state: tauri::State<'_, AppState>) -> u16 {
    state.widget_server.port()
}

// ---- Widget persistent state ----

fn validate_widget_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains("..")
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid widget id".into());
    }
    Ok(())
}

fn widget_state_path(widget_id: &str) -> Result<std::path::PathBuf, String> {
    validate_widget_id(widget_id)?;
    Ok(widgets_base_dir()?.join(widget_id).join("state.json"))
}

#[tauri::command]
fn widget_get_state(widget_id: String, key: Option<String>) -> Result<serde_json::Value, String> {
    let path = widget_state_path(&widget_id)?;
    let data: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    if let Some(k) = key {
        Ok(data.get(&k).cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Ok(data)
    }
}

#[tauri::command]
fn widget_set_state(
    widget_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    let path = widget_state_path(&widget_id)?;
    let mut data: serde_json::Map<String, serde_json::Value> = match std::fs::read_to_string(&path)
    {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    };
    data.insert(key, value);
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    // Cap at 5MB
    if json.len() > 5 * 1024 * 1024 {
        return Err("State exceeds 5MB limit".into());
    }
    std::fs::write(&path, json).map_err(|e| format!("write: {}", e))
}

#[tauri::command]
fn widget_clear_state(widget_id: String) -> Result<(), String> {
    let path = widget_state_path(&widget_id)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("rm: {}", e))?;
    }
    Ok(())
}

// ---- Skills library ----

fn skills_base_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    Ok(home.join(".terminal64").join("skills"))
}

/// Read a SKILL.md file and extract `name` and `description` from its YAML
/// frontmatter. Returns `(None, None)` on read failure or when no frontmatter
/// is present. Values are trimmed of surrounding quotes.
fn parse_skill_frontmatter(path: &std::path::Path) -> (Option<String>, Option<String>) {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return (None, None),
    };
    let content_trimmed = content.trim_start();
    let yaml_block = if let Some(rest) = content_trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("---") {
            rest[..end].trim()
        } else {
            ""
        }
    } else {
        ""
    };
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    for line in yaml_block.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("name:") {
            let val = rest.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                name = Some(val.to_string());
            }
        } else if let Some(rest) = trimmed.strip_prefix("description:") {
            let val = rest.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                description = Some(val.to_string());
            }
        }
    }
    (name, description)
}

#[tauri::command]
fn create_skill_folder(skill_id: String) -> Result<String, String> {
    let dir = skills_base_dir()?.join(&skill_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
    // Write default skill.json metadata
    let meta_path = dir.join("skill.json");
    if !meta_path.exists() {
        let meta = serde_json::json!({
            "name": skill_id,
            "description": "",
            "tags": [],
            "created": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            "modified": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        let meta_json = serde_json::to_string_pretty(&meta)
            .map_err(|e| format!("serialize skill meta: {}", e))?;
        std::fs::write(&meta_path, meta_json).map_err(|e| format!("write: {}", e))?;
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_skills() -> Result<Vec<serde_json::Value>, String> {
    let base = skills_base_dir()?;
    if !base.exists() {
        return Ok(vec![]);
    }
    let meta_dir = base.join(".meta");
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".meta" {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let is_symlink = file_type.is_symlink();
        let path = entry.path();
        // For symlinks, follow to check whether the target is a directory.
        let is_dir_target = if is_symlink {
            path.is_dir()
        } else {
            file_type.is_dir()
        };
        if !is_dir_target {
            continue;
        }
        let skill_md_path = path.join("SKILL.md");
        let skill_md_exists = skill_md_path.exists();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| std::io::Error::other("time"))
            })
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        // Prefer the sidecar sidecar at .meta/{name}.json for symlinked entries
        // (imported from outside ~/.terminal64/skills/), fall back to inline
        // skill.json for skills we own outright.
        let mut meta: Option<serde_json::Value> = None;
        if is_symlink {
            let sidecar = meta_dir.join(format!("{}.json", name));
            if let Ok(content) = std::fs::read_to_string(&sidecar) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    meta = Some(parsed);
                }
            }
        }
        if meta.is_none() {
            let meta_path = path.join("skill.json");
            if let Ok(content) = std::fs::read_to_string(&meta_path) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    meta = Some(parsed);
                }
            }
        }
        let mut meta = meta.unwrap_or_else(|| {
            serde_json::json!({
                "name": name,
                "description": "",
                "tags": [],
            })
        });
        if meta
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .is_empty()
        {
            meta["name"] = serde_json::json!(name);
        }
        // If description is still empty, fall back to the SKILL.md frontmatter
        // so imported skills without a backfilled sidecar still render a label.
        let empty_desc = meta
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.is_empty())
            .unwrap_or(true);
        if empty_desc && skill_md_exists {
            let (_, desc) = parse_skill_frontmatter(&skill_md_path);
            if let Some(d) = desc {
                meta["description"] = serde_json::json!(d);
            }
        }
        meta["has_skill_md"] = serde_json::json!(skill_md_exists);
        meta["modified"] = serde_json::json!(modified);
        if is_symlink {
            meta["is_symlink"] = serde_json::json!(true);
        }
        out.push(meta);
    }
    out.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Ok(out)
}

#[tauri::command]
fn delete_skill(skill_id: String) -> Result<(), String> {
    let base = skills_base_dir()?;
    let dir = base.join(&skill_id);
    // Use symlink_metadata so we inspect the link itself rather than the
    // target — deleting a symlink must not recurse into the imported source.
    match std::fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::remove_file(&dir).map_err(|e| format!("rm symlink: {}", e))?;
        }
        Ok(_) => {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("rm: {}", e))?;
        }
        Err(_) => {} // doesn't exist — nothing to do
    }
    // Drop sidecar metadata if it exists; ignore errors (e.g. already gone).
    let sidecar = base.join(".meta").join(format!("{}.json", skill_id));
    let _ = std::fs::remove_file(&sidecar);
    Ok(())
}

/// Scan `~/.claude/skills/` and `~/.claude/plugins/cache/*/skills/` for skills
/// not yet present in `~/.terminal64/skills/`, symlink them in, and write a
/// sidecar metadata file at `.meta/{name}.json`. Returns the names that were
/// newly imported this run.
#[tauri::command]
fn sync_claude_skills() -> Result<Vec<String>, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let base = skills_base_dir()?;
    std::fs::create_dir_all(&base).map_err(|e| format!("mkdir skills: {}", e))?;
    let meta_dir = base.join(".meta");
    std::fs::create_dir_all(&meta_dir).map_err(|e| format!("mkdir meta: {}", e))?;

    let mut sources: Vec<std::path::PathBuf> = Vec::new();
    let claude_skills = home.join(".claude").join("skills");
    if claude_skills.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&claude_skills) {
            for e in entries.flatten() {
                sources.push(e.path());
            }
        }
    }
    let cache = home.join(".claude").join("plugins").join("cache");
    if cache.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&cache) {
            for pkg in entries.flatten() {
                let skills_sub = pkg.path().join("skills");
                if skills_sub.is_dir() {
                    if let Ok(sks) = std::fs::read_dir(&skills_sub) {
                        for sk in sks.flatten() {
                            sources.push(sk.path());
                        }
                    }
                }
            }
        }
    }

    let mut imported: Vec<String> = Vec::new();
    for src in sources {
        // Skip our own outgoing bridge symlinks (ensure_skills_plugin creates
        // ~/.claude/skills/<name> -> ~/.terminal64/skills/<name>); re-importing
        // them would create a cycle.
        if let Ok(target) = std::fs::read_link(&src) {
            if target.starts_with(&base) {
                continue;
            }
        }
        // Must be a directory (real or symlinked) containing SKILL.md.
        if !src.is_dir() {
            continue;
        }
        let skill_md = src.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if name == ".meta" {
            continue;
        }
        let dest = base.join(&name);
        // Anything already occupying the slot wins — don't clobber a local
        // skill with an imported one of the same name.
        if std::fs::symlink_metadata(&dest).is_ok() {
            safe_eprintln!(
                "[skills-sync] conflict: '{}' already exists at {:?}, skipping import from {:?}",
                name,
                dest,
                src
            );
            continue;
        }
        if let Err(e) = create_dir_link(&src, &dest) {
            safe_eprintln!("[skills-sync] link {:?} -> {:?} failed: {}", dest, src, e);
            continue;
        }
        let (_, description) = parse_skill_frontmatter(&skill_md);
        // Always flag for Haiku backfill — frontmatter can give us a
        // description but never tags, so imported skills need the model pass
        // to populate tags (and fill description if the frontmatter lacked one).
        let sidecar = serde_json::json!({
            "name": name,
            "description": description.clone().unwrap_or_default(),
            "tags": Vec::<String>::new(),
            "imported_from": src.to_string_lossy(),
            "pending_backfill": true,
        });
        let side_path = meta_dir.join(format!("{}.json", name));
        match serde_json::to_string_pretty(&sidecar) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&side_path, json) {
                    safe_eprintln!("[skills-sync] write sidecar {:?} failed: {}", side_path, e);
                }
            }
            Err(e) => safe_eprintln!("[skills-sync] serialize sidecar '{}': {}", name, e),
        }
        imported.push(name);
    }
    Ok(imported)
}

#[tauri::command]
fn update_skill_meta(
    skill_id: String,
    description: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<(), String> {
    let dir = skills_base_dir()?.join(&skill_id);
    let meta_path = dir.join("skill.json");
    let mut meta: serde_json::Value = if meta_path.exists() {
        let content = std::fs::read_to_string(&meta_path).map_err(|e| format!("read: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({"name": skill_id})
    };
    if let Some(desc) = description {
        meta["description"] = serde_json::json!(desc);
    }
    if let Some(t) = tags {
        meta["tags"] = serde_json::json!(t);
    }
    meta["modified"] = serde_json::json!(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0));
    let meta_json =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("serialize skill meta: {}", e))?;
    std::fs::write(&meta_path, meta_json).map_err(|e| format!("write: {}", e))?;
    Ok(())
}

#[tauri::command]
fn read_skill_content(skill_id: String) -> Result<String, String> {
    let dir = skills_base_dir()?.join(&skill_id);
    let skill_md = dir.join("SKILL.md");
    if skill_md.exists() {
        std::fs::read_to_string(&skill_md).map_err(|e| format!("read: {}", e))
    } else {
        Err("SKILL.md not found".to_string())
    }
}

/// Finds a skill by name across all skill directories, reads its SKILL.md,
/// parses frontmatter, applies $ARGUMENTS substitution, and returns the
/// rendered body in the same format Claude Code uses for skill injection.
#[tauri::command]
fn resolve_skill_prompt(
    skill_name: String,
    arguments: String,
    cwd: Option<String>,
) -> Result<ResolvedSkill, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;

    // Search order: project .claude/skills/ → ~/.claude/skills/ → ~/.terminal64/skills/ → plugin cache
    let mut search_paths: Vec<std::path::PathBuf> = Vec::new();

    // Project-level skills
    if let Some(ref c) = cwd {
        let p = std::path::PathBuf::from(c);
        search_paths.push(p.join(".claude").join("skills").join(&skill_name));
    }
    // User-level skills
    search_paths.push(home.join(".claude").join("skills").join(&skill_name));
    // Terminal 64 skill library
    search_paths.push(home.join(".terminal64").join("skills").join(&skill_name));
    // Plugin cache — scan for matching skill name
    let cache_dir = home.join(".claude").join("plugins").join("cache");
    if cache_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let skills_dir = entry.path().join("skills").join(&skill_name);
                if skills_dir.exists() {
                    search_paths.push(skills_dir);
                }
            }
        }
    }

    // Find the first matching SKILL.md
    let mut skill_md_path = None;
    let mut skill_dir_path = None;
    for dir in &search_paths {
        let md = dir.join("SKILL.md");
        if md.exists() {
            skill_md_path = Some(md);
            skill_dir_path = Some(dir.clone());
            break;
        }
    }

    let skill_md = skill_md_path.ok_or_else(|| format!("Skill '{}' not found", skill_name))?;
    let skill_dir =
        skill_dir_path.ok_or_else(|| format!("Skill '{}' directory missing", skill_name))?;
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("read {}: {}", skill_md.display(), e))?;

    let content_trimmed = content.trim_start();
    let (yaml_block, markdown_body) = if let Some(rest) = content_trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("---") {
            (rest[..end].trim(), rest[end + 3..].trim())
        } else {
            ("", content_trimmed)
        }
    } else {
        ("", content_trimmed)
    };

    // Extract frontmatter fields. Name/description come from the shared
    // helper; allowed-tools is still parsed inline since the helper only
    // returns the two fields the rest of the codebase needs.
    let (frontmatter_name, _) = parse_skill_frontmatter(&skill_md);
    let resolved_name = frontmatter_name.unwrap_or_else(|| skill_name.clone());
    let mut allowed_tools: Vec<String> = Vec::new();
    for line in yaml_block.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("allowed-tools:") {
            let val = rest.trim();
            if !val.is_empty() {
                allowed_tools = val.split_whitespace().map(|s| s.to_string()).collect();
            }
        }
    }

    // Build the full body with skill dir prefix (matches Claude Code behavior)
    let dir_str = skill_dir.to_string_lossy().to_string();
    let mut body = format!(
        "Base directory for this skill: {}\n\n{}",
        dir_str, markdown_body
    );

    // Apply $ARGUMENTS substitutions (matches Claude Code's argumentSubstitution.ts)
    let arg_parts: Vec<&str> = if arguments.is_empty() {
        Vec::new()
    } else {
        arguments.split_whitespace().collect()
    };

    let had_placeholders = body.contains("$ARGUMENTS") || body.contains("$0");

    // $ARGUMENTS[N] → specific argument by index (e.g. $ARGUMENTS[0], $ARGUMENTS[1])
    for i in 0..10 {
        let placeholder = format!("$ARGUMENTS[{}]", i);
        let replacement = arg_parts.get(i).unwrap_or(&"").to_string();
        body = body.replace(&placeholder, &replacement);
    }

    // $ARGUMENTS → full argument string (must come after indexed to avoid partial matches)
    body = body.replace("$ARGUMENTS", &arguments);

    // $N shorthand (e.g. $0, $1) — simple replacement for digits 0-9
    for i in 0..10usize {
        let placeholder = format!("${}", i);
        let replacement = arg_parts.get(i).unwrap_or(&"").to_string();
        // Only replace if not followed by another word character (poor man's word boundary)
        let mut chars = body.char_indices().peekable();
        let mut result = String::with_capacity(body.len());
        while let Some((pos, ch)) = chars.next() {
            if body[pos..].starts_with(&placeholder) {
                let after_pos = pos + placeholder.len();
                let next_ch = body
                    .get(after_pos..after_pos + 1)
                    .and_then(|s| s.chars().next());
                if next_ch
                    .map(|c| c.is_alphanumeric() || c == '_')
                    .unwrap_or(false)
                {
                    // Followed by word char — don't replace
                    result.push(ch);
                } else {
                    result.push_str(&replacement);
                    // Skip the rest of the placeholder chars
                    for _ in 1..placeholder.len() {
                        chars.next();
                    }
                }
            } else {
                result.push(ch);
            }
        }
        body = result;
    }

    // ${CLAUDE_SKILL_DIR} → skill directory path
    body = body.replace("${CLAUDE_SKILL_DIR}", &dir_str);

    // If no placeholders were found and there are arguments, append them
    // (matches Claude Code's appendIfNoPlaceholder behavior)
    if !arguments.is_empty() && !had_placeholders {
        body.push_str(&format!("\n\nARGUMENTS: {}", arguments));
    }

    Ok(ResolvedSkill {
        name: resolved_name,
        body,
        allowed_tools,
        skill_dir: dir_str,
    })
}

#[tauri::command]
fn get_skill_creator_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    // Production: bundled in resource dir
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let bundled = res_dir.join("skill-creator");
        if bundled.join("SKILL.md").exists() {
            return Ok(bundled.to_string_lossy().to_string());
        }
    }
    // Dev mode: relative to project root
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut dir = exe.parent();
    for _ in 0..10 {
        if let Some(d) = dir {
            let candidate = d.join("src-tauri/resources/skill-creator");
            if candidate.join("SKILL.md").exists() {
                return Ok(candidate.to_string_lossy().to_string());
            }
            dir = d.parent();
        }
    }
    Err("skill-creator not found".into())
}

#[tauri::command]
fn ensure_skills_plugin() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let skills_dir = home.join(".terminal64").join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|e| format!("mkdir skills: {}", e))?;

    let plugin_dir = home
        .join(".claude/plugins/marketplaces/claude-plugins-official/plugins/terminal-64-skills");
    let claude_plugin_dir = plugin_dir.join(".claude-plugin");
    std::fs::create_dir_all(&claude_plugin_dir).map_err(|e| format!("mkdir plugin: {}", e))?;

    let manifest_path = claude_plugin_dir.join("plugin.json");
    if !manifest_path.exists() {
        let manifest = serde_json::json!({
            "name": "terminal-64-skills",
            "version": "1.0.0",
            "description": "Skills created and managed by Terminal 64's skill library.",
            "author": {
                "name": "Terminal 64",
                "email": "noreply@terminal64.app"
            },
            "keywords": ["terminal-64", "skills"]
        });
        let manifest_json = serde_json::to_string_pretty(&manifest)
            .map_err(|e| format!("serialize plugin manifest: {}", e))?;
        std::fs::write(&manifest_path, manifest_json)
            .map_err(|e| format!("write manifest: {}", e))?;
    }

    let symlink_target = plugin_dir.join("skills");
    let needs_symlink = match std::fs::read_link(&symlink_target) {
        Ok(target) => target != skills_dir,
        Err(_) => true,
    };
    if needs_symlink {
        if symlink_target.is_symlink() || symlink_target.exists() {
            if symlink_target.is_symlink() || !symlink_target.is_dir() {
                std::fs::remove_file(&symlink_target).ok();
            } else {
                std::fs::remove_dir_all(&symlink_target).ok();
            }
        }
        create_dir_link(&skills_dir, &symlink_target).map_err(|e| format!("link: {}", e))?;
    }

    // Ensure plugin is registered in installed_plugins.json
    let installed_path = home.join(".claude/plugins/installed_plugins.json");
    let plugin_key = "terminal-64-skills@claude-plugins-official";
    let mut installed: serde_json::Value = if installed_path.exists() {
        let content = std::fs::read_to_string(&installed_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({"version": 2, "plugins": {}}))
    } else {
        serde_json::json!({"version": 2, "plugins": {}})
    };
    if let Some(plugins) = installed.get_mut("plugins").and_then(|p| p.as_object_mut()) {
        if !plugins.contains_key(plugin_key) {
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            plugins.insert(
                plugin_key.to_string(),
                serde_json::json!([{
                    "scope": "user",
                    "installPath": plugin_dir.to_string_lossy(),
                    "version": "1.0.0",
                    "installedAt": now,
                    "lastUpdated": now
                }]),
            );
            let installed_json = serde_json::to_string_pretty(&installed)
                .map_err(|e| format!("serialize installed_plugins: {}", e))?;
            std::fs::write(&installed_path, installed_json)
                .map_err(|e| format!("write installed_plugins: {}", e))?;
        }
    }

    // Ensure plugin is enabled in settings.json
    let settings_path = home.join(".claude/settings.json");
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if let Some(obj) = settings.as_object_mut() {
        let enabled = obj.entry("enabledPlugins").or_insert(serde_json::json!({}));
        if let Some(ep) = enabled.as_object_mut() {
            if !ep.contains_key(plugin_key) {
                ep.insert(plugin_key.to_string(), serde_json::json!(true));
                let settings_json = serde_json::to_string_pretty(&settings)
                    .map_err(|e| format!("serialize settings: {}", e))?;
                std::fs::write(&settings_path, settings_json)
                    .map_err(|e| format!("write settings: {}", e))?;
            }
        }
    }

    // Sync symlinks: ~/.claude/skills/{name} -> ~/.terminal64/skills/{name}
    // This is the path Claude CLI actually resolves for /skill-name commands
    let claude_skills_dir = home.join(".claude").join("skills");
    if let Err(e) = std::fs::create_dir_all(&claude_skills_dir) {
        safe_eprintln!(
            "[skills] Failed to create skills dir {:?}: {}",
            claude_skills_dir,
            e
        );
    }
    if let Ok(entries) = std::fs::read_dir(&skills_dir) {
        for entry in entries.flatten() {
            let src = entry.path();
            if !src.is_dir() {
                continue;
            }
            let name = match src.file_name() {
                Some(n) => n.to_owned(),
                None => continue,
            };
            let dest = claude_skills_dir.join(&name);
            // Check if symlink already points to the right place
            match std::fs::read_link(&dest) {
                Ok(target) if target == src => continue, // already correct
                Ok(_) => {
                    std::fs::remove_file(&dest).ok();
                } // wrong target
                Err(_) if dest.exists() => continue,     // real dir exists, don't clobber
                Err(_) => {}                             // doesn't exist, create it
            }
            if let Err(e) = create_dir_link(&src, &dest) {
                safe_eprintln!("[skills] Failed to link {:?} -> {:?}: {}", dest, src, e);
            }
        }
    }

    // Clean up stale symlinks in ~/.claude/skills/ that point into ~/.terminal64/skills/ but no longer exist
    if let Ok(entries) = std::fs::read_dir(&claude_skills_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(target) = std::fs::read_link(&path) {
                if target.starts_with(&skills_dir) && !target.exists() {
                    std::fs::remove_file(&path).ok();
                }
            }
        }
    }

    safe_eprintln!(
        "[skills] Plugin bridge installed at {}",
        plugin_dir.display()
    );
    Ok(())
}

#[tauri::command]
async fn generate_skill_metadata(skill_id: String) -> Result<(), String> {
    const SYSTEM_PROMPT: &str = "You analyse the contents of a Claude Code SKILL.md file and emit metadata for a skill library entry.\n\nOutput rules:\n- Output ONLY a single JSON object, no prose, no code fences.\n- Schema: {\"description\": string, \"tags\": string[]}.\n- description: one sentence, <= 160 chars, plain English, summarising what the skill does and when to use it.\n- tags: 3 to 6 lowercase kebab-case tokens (a-z, 0-9, hyphens). No spaces, no underscores, no punctuation.\n- Do not include any other keys.";
    const MODEL: &str = "claude-haiku-4-5-20251001";

    let dir = skills_base_dir()?.join(&skill_id);
    let skill_md = dir.join("SKILL.md");
    let content = std::fs::read_to_string(&skill_md)
        .map_err(|e| format!("read {}: {}", skill_md.display(), e))?;

    // Mirror rewrite_prompt's auth: it shells out to the Claude CLI which
    // resolves credentials itself. For a direct Messages API call we use the
    // standard ANTHROPIC_API_KEY env var, which the CLI also honours.
    let api_key =
        std::env::var("ANTHROPIC_API_KEY").map_err(|_| "ANTHROPIC_API_KEY not set".to_string())?;

    let user_msg = format!("SKILL.md contents:\n\n{}", content);
    let body = serde_json::json!({
        "model": MODEL,
        "max_tokens": 300,
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user_msg }],
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {}", e))?;
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic request: {}", e))?;

    let status = resp.status();
    let resp_text = resp
        .text()
        .await
        .map_err(|e| format!("read response: {}", e))?;
    if !status.is_success() {
        return Err(format!("anthropic {}: {}", status, resp_text));
    }
    let parsed: serde_json::Value = serde_json::from_str(&resp_text)
        .map_err(|e| format!("parse response: {} body={}", e, resp_text))?;
    let text = parsed["content"]
        .as_array()
        .and_then(|blocks| {
            blocks
                .iter()
                .find_map(|b| b.get("text").and_then(|t| t.as_str()))
        })
        .ok_or_else(|| format!("no text in response: {}", resp_text))?;

    // Tolerate ```json ... ``` fences and surrounding whitespace.
    let mut payload = text.trim();
    if let Some(rest) = payload.strip_prefix("```json") {
        payload = rest.trim();
    } else if let Some(rest) = payload.strip_prefix("```") {
        payload = rest.trim();
    }
    if let Some(rest) = payload.strip_suffix("```") {
        payload = rest.trim();
    }
    // If the model wrapped its JSON in extra prose, slice between first { and last }.
    let payload_owned = if !payload.starts_with('{') {
        let start = payload
            .find('{')
            .ok_or_else(|| format!("no json object in: {}", text))?;
        let end = payload
            .rfind('}')
            .ok_or_else(|| format!("no json object close in: {}", text))?;
        payload[start..=end].to_string()
    } else {
        payload.to_string()
    };

    let meta_resp: serde_json::Value = serde_json::from_str(&payload_owned)
        .map_err(|e| format!("parse metadata json: {} body={}", e, payload_owned))?;
    let description = meta_resp["description"]
        .as_str()
        .ok_or("missing description")?
        .to_string();
    let tags: Vec<String> = meta_resp["tags"]
        .as_array()
        .ok_or("missing tags")?
        .iter()
        .filter_map(|t| t.as_str().map(|s| s.to_string()))
        .collect();

    // Sidecar metadata lives in ~/.terminal64/skills/.meta/{id}.json so the
    // skill folder itself stays untouched (it may be a symlink we don't own).
    let meta_dir = skills_base_dir()?.join(".meta");
    std::fs::create_dir_all(&meta_dir).map_err(|e| format!("mkdir meta: {}", e))?;
    let meta_path = meta_dir.join(format!("{}.json", skill_id));

    let mut meta: serde_json::Value = if meta_path.exists() {
        let existing =
            std::fs::read_to_string(&meta_path).map_err(|e| format!("read meta: {}", e))?;
        serde_json::from_str(&existing).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !meta.is_object() {
        meta = serde_json::json!({});
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    meta["name"] = serde_json::json!(skill_id);
    meta["description"] = serde_json::json!(description);
    meta["tags"] = serde_json::json!(tags);
    meta["pending_backfill"] = serde_json::json!(false);
    meta["modified"] = serde_json::json!(now);

    let serialized =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("serialize meta: {}", e))?;
    std::fs::write(&meta_path, serialized).map_err(|e| format!("write meta: {}", e))?;
    Ok(())
}

// ---- Proxy fetch (CORS bypass for widgets) ----

#[tauri::command]
async fn proxy_fetch(
    url: String,
    method: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ProxyFetchResponse, String> {
    // Block local/private addresses to prevent SSRF
    if url.starts_with("file://") {
        return Err("file:// URLs are not allowed".into());
    }

    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if let Some(host) = parsed.host_str() {
        let host_lower = host.to_lowercase();
        if host_lower == "localhost" || host_lower == "0.0.0.0" {
            return Err("Requests to local addresses are not allowed".into());
        }
        let ip_str = host.trim_start_matches('[').trim_end_matches(']');
        if let Ok(ip) = ip_str.parse::<std::net::IpAddr>() {
            let is_blocked = match ip {
                std::net::IpAddr::V4(v4) => {
                    let o = v4.octets();
                    o[0] == 127                                     // 127.0.0.0/8
                    || o[0] == 10                                   // 10.0.0.0/8
                    || (o[0] == 172 && o[1] >= 16 && o[1] <= 31)   // 172.16.0.0/12
                    || (o[0] == 192 && o[1] == 168)                 // 192.168.0.0/16
                    || (o[0] == 169 && o[1] == 254)                 // 169.254.0.0/16
                    || o[0] == 0 // 0.0.0.0/8
                }
                std::net::IpAddr::V6(v6) => {
                    v6.is_loopback()                                    // ::1
                    || v6.is_unspecified()                              // ::
                    || (v6.segments()[0] & 0xffc0) == 0xfe80           // fe80::/10 link-local
                    || (v6.segments()[0] & 0xfe00) == 0xfc00           // fc00::/7 unique-local
                    || (v6.segments()[0] & 0xff00) == 0xff00           // ff00::/8 multicast
                    || v6.segments()[0..6] == [0,0,0,0,0,0xffff] // ::ffff:0:0/96 IPv4-mapped
                }
            };
            if is_blocked {
                return Err("Requests to private/internal addresses are not allowed".into());
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(
            timeout_ms.unwrap_or(30_000).min(60_000),
        ))
        .build()
        .map_err(|e| e.to_string())?;

    let method_str = method.unwrap_or_else(|| "GET".to_string());
    let req_method = reqwest::Method::from_bytes(method_str.as_bytes())
        .map_err(|_| format!("Invalid method: {}", method_str))?;

    let mut req = client.request(req_method, &url);
    if let Some(hdrs) = headers {
        for (k, v) in hdrs {
            req = req.header(&k, &v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let ok = resp.status().is_success();

    let mut resp_headers = std::collections::HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(val) = v.to_str() {
            resp_headers.insert(k.as_str().to_string(), val.to_string());
        }
    }

    let content_type = resp_headers
        .get("content-type")
        .cloned()
        .unwrap_or_default();
    let is_text = content_type.contains("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript")
        || content_type.contains("css");

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    // 50MB cap
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("Response exceeds 50MB limit".into());
    }

    let (body_str, is_base64) = if is_text {
        (String::from_utf8_lossy(&bytes).to_string(), false)
    } else {
        use base64::Engine;
        (
            base64::engine::general_purpose::STANDARD.encode(&bytes),
            true,
        )
    };

    Ok(ProxyFetchResponse {
        status,
        ok,
        headers: resp_headers,
        body: body_str,
        is_base64,
    })
}

// ---- System notification ----

#[tauri::command]
fn send_notification(title: String, body: Option<String>) -> Result<(), String> {
    // Use osascript on macOS as a simple cross-platform notification
    #[cfg(target_os = "macos")]
    {
        // Escape for AppleScript: backslashes, quotes, and control chars
        // that could break out of the string context
        fn escape_applescript(s: &str) -> String {
            let mut out = String::with_capacity(s.len());
            for c in s.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '"' => out.push_str("\\\""),
                    '\n' | '\r' | '\t' => out.push(' '),
                    c if c.is_control() => {}
                    c => out.push(c),
                }
            }
            out
        }
        let escaped_title = escape_applescript(&title);
        let script = if let Some(b) = &body {
            let escaped_body = escape_applescript(b);
            format!(
                "display notification \"{}\" with title \"{}\"",
                escaped_body, escaped_title
            )
        } else {
            format!("display notification \"\" with title \"{}\"", escaped_title)
        };
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // Escape single quotes for PowerShell string literals by doubling them
        fn escape_powershell(s: &str) -> String {
            s.replace('\'', "''")
                .chars()
                .filter(|c| !c.is_control())
                .collect()
        }
        let escaped_title = escape_powershell(&title);
        let escaped_body = escape_powershell(&body.clone().unwrap_or_default());
        let ps_cmd = format!(
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('{}','{}')",
            escaped_body, escaped_title
        );
        std::process::Command::new("powershell")
            .args(["-Command", &ps_cmd])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        safe_eprintln!("[notification] {}: {}", title, body.unwrap_or_default());
    }
    Ok(())
}

// ---- Checkpoint commands ----

fn checkpoints_base_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    Ok(home.join(".terminal64").join("checkpoints"))
}

#[tauri::command]
fn create_checkpoint(
    session_id: String,
    turn: usize,
    files: Vec<FileSnapshot>,
) -> Result<(), String> {
    let dir = checkpoints_base_dir()?
        .join(&session_id)
        .join(format!("turn-{}", turn));
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
    // Write manifest (original paths) and file contents
    let mut manifest = Vec::new();
    for (i, snap) in files.iter().enumerate() {
        let filename = format!("{}.snap", i);
        std::fs::write(dir.join(&filename), &snap.content)
            .map_err(|e| format!("write snap: {}", e))?;
        manifest.push(format!("{}|{}", filename, snap.path));
    }
    std::fs::write(dir.join("manifest.txt"), manifest.join("\n"))
        .map_err(|e| format!("write manifest: {}", e))?;
    safe_println!(
        "[checkpoint] Created turn-{} for {} ({} files)",
        turn,
        &session_id[..8.min(session_id.len())],
        files.len()
    );
    Ok(())
}

#[tauri::command]
fn restore_checkpoint(session_id: String, turn: usize) -> Result<Vec<String>, String> {
    let dir = checkpoints_base_dir()?
        .join(&session_id)
        .join(format!("turn-{}", turn));
    if !dir.exists() {
        return Ok(vec![]); // no checkpoint for this turn — nothing to restore
    }
    let manifest_path = dir.join("manifest.txt");
    let manifest =
        std::fs::read_to_string(&manifest_path).map_err(|e| format!("read manifest: {}", e))?;
    let mut restored = Vec::new();
    for line in manifest.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(2, '|').collect();
        if parts.len() != 2 {
            continue;
        }
        let snap_file = parts[0];
        let original_path = parts[1];
        // Block path traversal in crafted manifests
        if original_path.contains("..") || snap_file.contains("..") {
            return Err("restore_checkpoint blocked: path traversal detected".to_string());
        }
        let content = std::fs::read_to_string(dir.join(snap_file))
            .map_err(|e| format!("read snap {}: {}", snap_file, e))?;
        let dest = std::path::Path::new(original_path);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(dest, &content).map_err(|e| format!("restore {}: {}", original_path, e))?;
        restored.push(original_path.to_string());
    }
    safe_println!(
        "[checkpoint] Restored turn-{} for {} ({} files)",
        turn,
        &session_id[..8.min(session_id.len())],
        restored.len()
    );
    Ok(restored)
}

#[tauri::command]
fn cleanup_checkpoints(session_id: String, keep_up_to_turn: usize) -> Result<(), String> {
    let base = checkpoints_base_dir()?.join(&session_id);
    if !base.exists() {
        return Ok(());
    }
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(num_str) = name.strip_prefix("turn-") {
            if let Ok(num) = num_str.parse::<usize>() {
                if num > keep_up_to_turn {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_files(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut deleted = Vec::new();
    for path in &paths {
        let p = std::path::Path::new(path);
        if p.exists() && p.is_file() {
            if let Err(e) = std::fs::remove_file(p) {
                safe_eprintln!("[delete_files] Failed to delete {}: {}", path, e);
            } else {
                deleted.push(path.clone());
            }
        }
    }
    if !deleted.is_empty() {
        safe_println!(
            "[rewind] Deleted {} files created during delegation",
            deleted.len()
        );
    }
    Ok(deleted)
}

#[tauri::command]
fn revert_files_git(cwd: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.exists() {
        return Err("CWD does not exist".to_string());
    }
    let mut reverted = Vec::new();

    fn git_cmd() -> std::process::Command {
        let c = std::process::Command::new("git");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut c = c;
            c.creation_flags(0x08000000);
            c
        }
        #[cfg(not(target_os = "windows"))]
        c
    }

    for path in &paths {
        let abs = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            cwd_path.join(path)
        };

        // Check if this file is tracked by git.
        // CRITICAL: distinguish "git not available" from "untracked" — deleting
        // on Err() would nuke user-edited tracked files when git isn't on PATH
        // (common on stock Windows GUI processes).
        let tracked_status = git_cmd()
            .args(["ls-files", "--error-unmatch"])
            .arg(&abs)
            .current_dir(cwd_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();

        match tracked_status {
            Ok(s) if s.success() => {
                // File is tracked — restore from HEAD
                let status = git_cmd()
                    .args(["checkout", "HEAD", "--"])
                    .arg(&abs)
                    .current_dir(cwd_path)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
                if let Ok(s) = status {
                    if s.success() {
                        reverted.push(path.clone());
                    }
                }
            }
            Ok(_) => {
                // File is untracked (new) — delete it
                if abs.exists() && std::fs::remove_file(&abs).is_ok() {
                    reverted.push(path.clone());
                }
            }
            Err(e) => {
                // git didn't even launch — refuse to touch anything (data safety).
                safe_eprintln!(
                    "[rewind] git unavailable ({}): skipping revert for {}",
                    e,
                    path
                );
            }
        }
    }

    if !reverted.is_empty() {
        safe_println!("[rewind] Git-reverted {} files", reverted.len());
    }
    Ok(reverted)
}

/// Return the subset of `paths` that are NOT tracked by git in `cwd`.
/// Used by rewind to identify created-but-not-committed files for deletion.
/// Safer than shelling from the frontend — avoids cross-platform quoting issues.
#[tauri::command]
fn filter_untracked_files(cwd: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.exists() {
        return Err("CWD does not exist".to_string());
    }
    fn git_cmd() -> std::process::Command {
        let c = std::process::Command::new("git");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let mut c = c;
            c.creation_flags(0x08000000);
            c
        }
        #[cfg(not(target_os = "windows"))]
        c
    }
    let mut untracked = Vec::new();
    for path in &paths {
        let abs = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            cwd_path.join(path)
        };
        match git_cmd()
            .args(["ls-files", "--error-unmatch"])
            .arg(&abs)
            .current_dir(cwd_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
        {
            Ok(s) if s.success() => {} // tracked — skip
            Ok(_) => untracked.push(path.clone()),
            Err(_) => {
                // git unavailable — don't classify anything as untracked (data safety)
            }
        }
    }
    Ok(untracked)
}

// Party Mode commands

#[tauri::command]
fn start_party_mode(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    state.audio_manager.start(&app_handle)
}

#[tauri::command]
fn stop_party_mode(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.audio_manager.stop()
}

#[tauri::command]
fn party_mode_status(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.audio_manager.is_active())
}

// ── Browser (native webview) commands ──

// Tauri IPC requires flat argument lists, so this command takes x/y/w/h individually.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn create_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    state
        .browser_manager
        .create(&app_handle, id, url, x, y, w, h)
}

#[tauri::command]
fn navigate_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
) -> Result<(), String> {
    state.browser_manager.navigate(&app_handle, &id, &url)
}

#[tauri::command]
fn set_browser_bounds(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    state
        .browser_manager
        .set_bounds(&app_handle, &id, x, y, w, h)
}

#[tauri::command]
fn set_browser_visible(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    state.browser_manager.set_visible(&app_handle, &id, visible)
}

#[tauri::command]
fn close_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.browser_manager.close(&app_handle, &id)
}

#[tauri::command]
fn browser_go_back(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.browser_manager.go_back(&app_handle, &id)
}

#[tauri::command]
fn browser_go_forward(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.browser_manager.go_forward(&app_handle, &id)
}

#[tauri::command]
fn browser_reload(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.browser_manager.reload(&app_handle, &id)
}

#[tauri::command]
fn set_all_browsers_visible(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    visible: bool,
) -> Result<(), String> {
    state.browser_manager.set_all_visible(&app_handle, visible);
    Ok(())
}

#[tauri::command]
fn set_browser_zoom(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    zoom: f64,
) -> Result<(), String> {
    state.browser_manager.set_zoom(&app_handle, &id, zoom)
}

#[tauri::command]
fn browser_eval(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    js: String,
) -> Result<(), String> {
    state.browser_manager.eval_js(&app_handle, &id, &js)
}

// ---- Voice control commands ----
// Names and payload shapes match src/lib/voiceApi.ts exactly.

#[tauri::command]
fn start_voice(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    wake_word: Option<String>,
) -> Result<(), String> {
    use voice::adapters::{CommandAdapter, DictationAdapter, VadAdapter, WakeAdapter};

    let wake = wake_word.as_deref().unwrap_or("jarvis");
    state.voice_manager.set_wake_word(wake);
    match WakeAdapter::try_load(wake) {
        Ok(a) => state.voice_manager.set_wake_runner(Box::new(a)),
        Err(e) => {
            safe_eprintln!("[voice] wake runner unavailable: {}", e);
            return Err(format!("wake runner: {e}"));
        }
    }
    match CommandAdapter::try_load() {
        Ok(a) => state.voice_manager.set_command_runner(Box::new(a)),
        Err(e) => {
            safe_eprintln!("[voice] command runner unavailable: {}", e);
            return Err(format!("command runner: {e}"));
        }
    }
    match VadAdapter::try_load() {
        Ok(a) => state.voice_manager.set_vad(Box::new(a)),
        Err(e) => safe_eprintln!("[voice] vad unavailable (amplitude fallback): {}", e),
    }
    match DictationAdapter::try_load(app_handle.clone()) {
        Ok(a) => {
            safe_eprintln!("[voice] whisper streaming dictation runner loaded");
            state.voice_manager.set_dictation_runner(Box::new(a));
        }
        Err(e) => safe_eprintln!("[voice] dictation unavailable (moonshine fallback): {}", e),
    }

    state.voice_manager.start(app_handle)
}

#[tauri::command]
fn stop_voice(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.voice_manager.stop();
    Ok(())
}

/// Wire the settings-panel sensitivity slider (0..1, higher = more sensitive)
/// to the wake-word detector threshold. Previously the slider wrote to
/// localStorage only and never reached the Rust side — users at 100% were
/// still running the 0.55 default threshold.
#[tauri::command]
fn voice_set_sensitivity(
    state: tauri::State<'_, AppState>,
    sensitivity: f32,
) -> Result<(), String> {
    state.voice_manager.set_sensitivity(sensitivity);
    Ok(())
}

/// Called when a `SelectSession` intent fails to fuzzy-match on the frontend.
/// Forces the state machine back to Idle so the user's next utterance doesn't
/// leak into whatever session happened to be active before.
#[tauri::command]
fn voice_abort_dictation(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.voice_manager.abort_dictation();
    Ok(())
}

/// Run the Agent 4 §7 self-test on demand. Emits `voice-selftest` when
/// finished; also returns the report so the caller can decide what to show.
/// Runs on the tokio blocking pool because Metal shader compile inside
/// whisper.cpp can block for 1–2 s on cold machines.
#[tauri::command]
async fn voice_run_selftest(
    app_handle: tauri::AppHandle,
) -> Result<voice::testkit::SelfTestReport, String> {
    tauri::async_runtime::spawn_blocking(move || voice::testkit::run_self_test(&app_handle))
        .await
        .map_err(|e| format!("selftest join: {e}"))
}

/// Walk a directory of WAV files and run each through wake → vad → dictation,
/// writing a JSON report. Used for regression testing (Agent 4 §10). Returns
/// the report after writing it to `out_path` (or `<dir>/voice_fixtures_report.json`
/// when `out_path` is omitted).
#[tauri::command]
async fn voice_run_fixtures(
    app_handle: tauri::AppHandle,
    dir: String,
    out_path: Option<String>,
) -> Result<voice::testkit::FixturesReport, String> {
    let dir_buf = std::path::PathBuf::from(dir);
    let out_buf = out_path.map(std::path::PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        voice::testkit::run_fixtures(&app_handle, &dir_buf, out_buf.as_deref())
    })
    .await
    .map_err(|e| format!("fixtures join: {e}"))?
}

/// Maps the granular per-kind model registry (voice::models) to the flat
/// {wake, command, dictation} view the frontend persists. `command` aggregates
/// Moonshine + Silero VAD (both must be present for commands to work).
#[tauri::command]
fn voice_models_status() -> Result<types::VoiceModelsStatus, String> {
    use voice::models::{find, is_downloaded, ModelKind};
    let wake = find(ModelKind::Wake, "jarvis")
        .map(is_downloaded)
        .unwrap_or(false);
    let moonshine = find(ModelKind::Moonshine, "base")
        .map(is_downloaded)
        .unwrap_or(false);
    let vad = find(ModelKind::Vad, "silero")
        .map(is_downloaded)
        .unwrap_or(false);
    let dictation = find(ModelKind::Whisper, "small.en-q5_1")
        .map(is_downloaded)
        .unwrap_or(false);

    Ok(types::VoiceModelsStatus {
        wake,
        command: moonshine && vad,
        dictation,
    })
}

/// Trigger download of the model bundle for a given frontend `kind`
/// (`"wake" | "command" | "dictation"`). Progress is streamed via
/// `voice-download-progress` events emitted by `voice::models::ensure`.
/// Concrete download behaviour lives in that module (owned by the
/// model-runtime agent); this command dispatches to it and awaits.
#[tauri::command]
async fn download_voice_model(app_handle: tauri::AppHandle, kind: String) -> Result<(), String> {
    use voice::models::{ensure, ModelKind};

    let targets: Vec<(ModelKind, &str)> = match kind.as_str() {
        "wake" => vec![(ModelKind::Wake, "jarvis")],
        // "command" = Moonshine STT + Silero VAD (both are required to
        // classify a voice command).
        "command" => vec![(ModelKind::Moonshine, "base"), (ModelKind::Vad, "silero")],
        "dictation" => vec![(ModelKind::Whisper, "small.en-q5_1")],
        other => return Err(format!("unknown voice model kind: {}", other)),
    };

    for (mk, name) in targets {
        ensure(&app_handle, mk, name).await?;
    }
    Ok(())
}

/// Install a specific bundled widget by name to ~/.terminal64/widgets/.
/// In production: reads from the Tauri resource dir (packaged via tauri.conf.json).
/// In dev: falls back to CARGO_MANIFEST_DIR so unpackaged runs still work.
#[tauri::command]
fn install_bundled_widget(app_handle: tauri::AppHandle, widget_name: String) -> Result<(), String> {
    use tauri::Manager;
    let dest_base = widgets_base_dir()?;

    let src_dir = {
        let resource_src = app_handle
            .path()
            .resource_dir()
            .ok()
            .map(|d| d.join("bundled-widgets").join(&widget_name));
        match resource_src {
            Some(p) if p.is_dir() => p,
            _ => std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("bundled-widgets")
                .join(&widget_name),
        }
    };

    if !src_dir.is_dir() {
        return Err(format!(
            "Bundled widget '{}' not found at {:?}",
            widget_name, src_dir
        ));
    }

    let dest_dir = dest_base.join(&widget_name);

    // Always overwrite to keep bundled widgets up to date
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("mkdir: {}", e))?;

    let files = std::fs::read_dir(&src_dir).map_err(|e| format!("read src: {}", e))?;
    for file in files.flatten() {
        if file.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            let name = file.file_name();
            // Don't overwrite user state
            if name.to_string_lossy() == "state.json" {
                continue;
            }
            let dest_file = dest_dir.join(&name);
            std::fs::copy(file.path(), &dest_file)
                .map_err(|e| format!("copy {:?}: {}", name, e))?;
        }
    }
    safe_eprintln!("[setup] Installed bundled widget: {}", widget_name);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Claude CLI re-invokes this binary as its MCP permission-prompt shim.
    // Short-circuit before Tauri bootstrap so stdio is clean for JSON-RPC.
    if permission_mcp::is_shim_mode() {
        permission_mcp::run_shim_from_env();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let perm_server = PermissionServer::start(app.handle().clone()).map_err(|e| {
                safe_eprintln!("[setup] Permission server failed to start: {}", e);
                Box::<dyn std::error::Error>::from(e)
            })?;
            let widget_srv = WidgetServer::start().map_err(|e| {
                safe_eprintln!("[setup] Widget server failed to start: {}", e);
                Box::<dyn std::error::Error>::from(e)
            })?;
            let mic_mgr = MicManager::new();
            let voice_mgr = VoiceManager::new(Arc::clone(&mic_mgr));
            app.manage(AppState {
                pty_manager: PtyManager::new(),
                claude_manager: Arc::new(ClaudeManager::new()),
                discord_bot: Mutex::new(DiscordBot::new()),
                permission_server: Arc::new(perm_server),
                audio_manager: Arc::new(AudioManager::new()),
                browser_manager: BrowserManager::new(),
                widget_server: widget_srv,
                mic_manager: mic_mgr,
                voice_manager: voice_mgr,
            });

            // Voice self-test is opt-in — only run when the user explicitly
            // triggers it via the `voice_run_selftest` Tauri command. Running it
            // at startup on fresh installs spams stderr with "model missing"
            // errors and forces whisper's Metal shader compile for a feature
            // the user hasn't opted into.

            // Bridge skills on startup: set up the outgoing ~/.claude/skills
            // symlinks, then pull in any skills that live under ~/.claude/skills
            // or plugin cache so they show up in T64's library. Runs on a
            // background thread so filesystem I/O never blocks the window from
            // appearing; both calls are idempotent (also triggered from the
            // frontend), so running twice is safe.
            {
                std::thread::spawn(|| {
                    if let Err(e) = ensure_skills_plugin() {
                        safe_eprintln!("[skills-setup] ensure_skills_plugin: {}", e);
                    }
                    match sync_claude_skills() {
                        Ok(imported) if !imported.is_empty() => safe_eprintln!(
                            "[skills-sync] imported {} skill(s): {:?}",
                            imported.len(),
                            imported
                        ),
                        Ok(_) => {}
                        Err(e) => safe_eprintln!("[skills-sync] failed: {}", e),
                    }
                });
            }

            // Disable native WKWebView pinch-to-zoom magnification on macOS
            // so our custom canvas zoom isn't fighting the browser's own zoom
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    // SAFETY: wv.inner() returns the WKWebView NSObject pointer owned by Tauri;
                    // setAllowsMagnification: accepts BOOL and has no thread requirements beyond
                    // being on the main thread (which the setup hook already runs on).
                    #[allow(unsafe_code)]
                    let _ = window.with_webview(|wv| unsafe {
                        let inner = wv.inner() as *mut objc2::runtime::AnyObject;
                        let _: () = objc2::msg_send![&*inner, setAllowsMagnification: false];
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell_exec,
            create_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            create_claude_session,
            send_claude_prompt,
            cancel_claude,
            close_claude_session,
            list_slash_commands,
            start_discord_bot,
            stop_discord_bot,
            discord_bot_status,
            start_openwolf_daemon,
            stop_openwolf_daemon,
            openwolf_daemon_status,
            openwolf_daemon_switch,
            openwolf_daemon_info,
            openwolf_daemon_stop_all,
            openwolf_project_cwd,
            link_session_to_discord,
            unlink_session_from_discord,
            rename_discord_session,
            discord_cleanup_orphaned,
            resolve_permission,
            rewrite_prompt,
            search_files,
            list_disk_sessions,
            load_session_history,
            load_session_history_tail,
            stat_session_jsonl,
            load_session_metadata,
            truncate_session_jsonl,
            truncate_session_jsonl_by_messages,
            find_rewind_uuid,
            fork_session_jsonl,
            read_file,
            write_file,
            list_mcp_servers,
            list_directory,
            get_delegation_port,
            get_delegation_secret,
            get_delegation_messages,
            cleanup_delegation_group,
            get_app_dir,
            get_node_path,
            ensure_t64_mcp,
            create_mcp_config_file,
            create_widget_folder,
            read_widget_html,
            list_widget_folders,
            widget_file_modified,
            delete_widget_folder,
            install_widget_zip,
            get_widget_server_port,
            read_widget_manifest,
            read_widget_approval,
            write_widget_approval,
            widget_get_state,
            widget_set_state,
            widget_clear_state,
            proxy_fetch,
            send_notification,
            create_checkpoint,
            delete_files,
            revert_files_git,
            filter_untracked_files,
            restore_checkpoint,
            cleanup_checkpoints,
            start_party_mode,
            stop_party_mode,
            party_mode_status,
            create_browser,
            navigate_browser,
            set_browser_bounds,
            set_browser_visible,
            close_browser,
            browser_go_back,
            browser_go_forward,
            browser_reload,
            browser_eval,
            set_browser_zoom,
            set_all_browsers_visible,
            generate_theme,
            generate_rewind_summary,
            save_pasted_image,
            read_file_base64,
            create_skill_folder,
            list_skills,
            delete_skill,
            update_skill_meta,
            read_skill_content,
            resolve_skill_prompt,
            get_skill_creator_path,
            ensure_skills_plugin,
            sync_claude_skills,
            generate_skill_metadata,
            install_bundled_widget,
            start_voice,
            stop_voice,
            voice_set_sensitivity,
            voice_abort_dictation,
            voice_models_status,
            download_voice_model,
            voice_run_selftest,
            voice_run_fixtures,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            safe_eprintln!("[fatal] tauri runtime error: {}", e);
            std::process::exit(1);
        });
}
