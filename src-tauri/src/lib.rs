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
mod permission_server;
mod pty_manager;
mod types;
mod widget_server;

// ---- Security: path sandboxing ----

/// Returns the list of allowed root directories for file operations.
/// Currently: the current working directory of the app and ~/.terminal64/.
// ---- Security: shell command validation ----

/// Blocklist of dangerous shell patterns. Returns an error message if the command matches.
fn validate_shell_command(command: &str) -> Result<(), String> {
    let lower = command.to_lowercase();
    let blocked_patterns: &[(&str, &str)] = &[
        ("rm -rf /", "Refusing to run destructive command targeting root"),
        ("rm -rf ~", "Refusing to run destructive command targeting home directory"),
        ("mkfs", "Refusing to run filesystem format command"),
        ("dd if=", "Refusing to run raw disk write command"),
        (":(){", "Refusing to run fork bomb"),
        ("chmod -r 777 /", "Refusing to run recursive permission change on root"),
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
use permission_server::PermissionServer;
use pty_manager::PtyManager;
use widget_server::WidgetServer;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use types::*;

const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", ".next", "__pycache__", ".venv", "vendor"];

fn session_project_dir(cwd: &str) -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir_hash = cwd.replace(':', "-").replace('\\', "-").replace('/', "-");
    Ok(home.join(".claude").join("projects").join(dir_hash))
}

fn session_jsonl_path(cwd: &str, session_id: &str) -> Result<std::path::PathBuf, String> {
    Ok(session_project_dir(cwd)?.join(format!("{}.jsonl", session_id)))
}

struct AppState {
    pty_manager: PtyManager,
    claude_manager: Arc<ClaudeManager>,
    discord_bot: Mutex<DiscordBot>,
    permission_server: Arc<PermissionServer>,
    audio_manager: Arc<AudioManager>,
    browser_manager: BrowserManager,
    widget_server: WidgetServer,
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
fn close_terminal(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.pty_manager.close(&id)
}

#[tauri::command]
fn create_claude_session(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: CreateClaudeRequest,
) -> Result<(), String> {
    let settings_path = if req.permission_mode != "bypass_all" {
        state.permission_server.register_session(&req.session_id).ok().map(|(_, p)| p.to_string_lossy().to_string())
    } else { None };
    let channel = req.channel_server.clone();
    state.claude_manager.create_session(&app_handle, req, settings_path, channel)
}

#[tauri::command]
fn send_claude_prompt(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    req: SendClaudePromptRequest,
) -> Result<(), String> {
    let settings_path = if req.permission_mode != "bypass_all" {
        state.permission_server.register_session(&req.session_id).ok().map(|(_, p)| p.to_string_lossy().to_string())
    } else { None };
    let channel = req.channel_server.clone();
    state.claude_manager.send_prompt(&app_handle, req, settings_path, channel)
}

#[tauri::command]
fn cancel_claude(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state.claude_manager.cancel(&session_id)
}

#[tauri::command]
fn close_claude_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Clean up permission server temp files for this session
    let tokens_to_remove: Vec<String> = {
        let map = state.permission_server.session_map.lock().unwrap_or_else(|e| e.into_inner());
        map.iter().filter(|(_, sid)| **sid == session_id).map(|(t, _)| t.clone()).collect()
    };
    for token in tokens_to_remove {
        state.permission_server.unregister_session(&token);
    }
    state.claude_manager.close(&session_id)
}

#[tauri::command]
fn rewrite_prompt(app_handle: tauri::AppHandle, prompt: String) -> Result<String, String> {
    const SYSTEM_PROMPT: &str = "You are a prompt engineering expert. Your job is to rewrite user prompts to get dramatically better results from AI coding assistants like Claude Code.\n\nRules:\n- Keep the user's INTENT exactly the same\n- Make the prompt more specific, structured, and actionable\n- Add context that was implied but not stated\n- Break vague requests into clear, concrete steps\n- Specify expected output format when helpful\n- Add constraints that prevent common failure modes\n- If the prompt references code, remind the AI to read relevant files first\n- Keep it concise — longer isn't better, clearer is better\n- Don't add fluff or meta-commentary, just output the improved prompt\n- Output ONLY the rewritten prompt, nothing else";

    static REWRITE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let rewrite_id = format!("rw-{}", REWRITE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));

    let full_prompt = format!("{}\n\nRewrite this prompt:\n{}", SYSTEM_PROMPT, prompt);
    let claude_bin = claude_manager::resolve_claude_path();
    let mut cmd = std::process::Command::new(&claude_bin);
    cmd.arg("-p").arg(&full_prompt)
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--model").arg("haiku")
        .arg("--effort").arg("high")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn claude: {}", e))?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    // Log stderr for debugging
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().flatten() {
                safe_eprintln!("[rewrite:stderr] {}", line);
            }
        });
    }

    let rid = rewrite_id.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if line.trim().is_empty() { continue; }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = parsed["type"].as_str().unwrap_or("");
                if event_type == "content_block_delta" {
                    if let Some(text) = parsed["delta"]["text"].as_str() {
                        let _ = app_handle.emit("rewrite-chunk", serde_json::json!({ "id": rid, "text": text }));
                    }
                } else if event_type == "assistant" {
                    if let Some(content) = parsed["message"]["content"].as_array() {
                        for block in content {
                            if block["type"].as_str() == Some("text") {
                                if let Some(text) = block["text"].as_str() {
                                    let _ = app_handle.emit("rewrite-chunk", serde_json::json!({ "id": rid, "text": text }));
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
    let gen_id = format!("theme-{}", THEME_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));

    let full_prompt = format!("{}\n\nGenerate a theme for: {}", SYSTEM_PROMPT, prompt);
    let claude_bin = claude_manager::resolve_claude_path();
    let mut cmd = std::process::Command::new(&claude_bin);
    cmd.arg("-p").arg(&full_prompt)
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--model").arg("haiku")
        .arg("--effort").arg("high")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn claude: {}", e))?;
    let stdout = child.stdout.take().ok_or("No stdout")?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().flatten() {
                safe_eprintln!("[theme-gen:stderr] {}", line);
            }
        });
    }

    let gid = gen_id.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        let mut full_text = String::new();
        for line in reader.lines().flatten() {
            if line.trim().is_empty() { continue; }
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                let event_type = parsed["type"].as_str().unwrap_or("");
                if event_type == "content_block_delta" {
                    if let Some(text) = parsed["delta"]["text"].as_str() {
                        full_text.push_str(text);
                        let _ = app_handle.emit("theme-gen-chunk", serde_json::json!({ "id": gid, "text": text }));
                    }
                } else if event_type == "assistant" {
                    if let Some(content) = parsed["message"]["content"].as_array() {
                        for block in content {
                            if block["type"].as_str() == Some("text") {
                                if let Some(text) = block["text"].as_str() {
                                    full_text.push_str(text);
                                    let _ = app_handle.emit("theme-gen-chunk", serde_json::json!({ "id": gid, "text": text }));
                                }
                            }
                        }
                    }
                }
            }
        }
        let _ = app_handle.emit("theme-gen-done", serde_json::json!({ "id": gid, "text": full_text }));
        safe_eprintln!("[theme-gen] Done ({})", gid);
    });

    Ok(gen_id)
}

#[tauri::command]
fn save_pasted_image(base64_data: String, extension: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    let tmp = std::env::temp_dir().join(format!("t64-paste-{}.{}", uuid::Uuid::new_v4(), extension));
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
        if !root.is_dir() { return vec![]; }
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        fn walk(dir: &std::path::Path, root: &std::path::Path, query: &str, results: &mut Vec<String>, skip: &[&str], depth: u8) {
            if depth > 6 || results.len() >= 20 { return; }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                if results.len() >= 20 { return; }
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if skip.iter().any(|s| name == *s) { continue; }
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                if rel.to_lowercase().contains(query) || name.to_lowercase().contains(query) {
                    results.push(rel);
                }
                if path.is_dir() {
                    walk(&path, root, query, results, skip, depth + 1);
                }
            }
        }
        walk(root, root, &query_lower, &mut results, SKIP_DIRS, 0);
        results.sort_by(|a, b| a.len().cmp(&b.len()));
        results.truncate(12);
        results
    }).await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct DiskSession {
    id: String,
    modified: u64,
    size: u64,
    summary: String,
}

#[derive(serde::Serialize)]
struct HistoryToolCall {
    id: String,
    name: String,
    input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(default)]
    is_error: bool,
}

#[derive(serde::Serialize)]
struct HistoryMessage {
    id: String,
    role: String,  // "user" or "assistant"
    content: String,
    timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<HistoryToolCall>>,
}

fn extract_session_summary(path: &std::path::Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    // Read the tail of the file to find the last "last-prompt" event
    let mut file = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return String::new() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let tail_size = 4096u64.min(len);
    if tail_size == 0 { return String::new(); }
    let _ = file.seek(SeekFrom::End(-(tail_size as i64)));
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);

    for line in buf.lines().rev() {
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => continue };
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
    if !project_dir.exists() { return Ok(vec![]); }

    let mut sessions = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&project_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if id.is_empty() { continue; }
            let meta = std::fs::metadata(&path).ok();
            let modified = meta.as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let size = meta.map(|m| m.len()).unwrap_or(0);
            let summary = extract_session_summary(&path);
            sessions.push(DiskSession { id, modified, size, summary });
        }
    }
    // Sort newest first
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(sessions)
}

#[tauri::command]
fn load_session_history(session_id: String, cwd: String) -> Result<Vec<HistoryMessage>, String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("read: {}", e)),
    };
    let mut messages: Vec<HistoryMessage> = Vec::new();
    // Track tool_use_id → index in messages vec + index in tool_calls vec for result merging
    let mut tool_index: std::collections::HashMap<String, (usize, usize)> = std::collections::HashMap::new();

    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => continue };
        let rec_type = val["type"].as_str().unwrap_or("");

        if rec_type == "user" {
            let msg = &val["message"];
            let role = msg["role"].as_str().unwrap_or("user");
            if role != "user" { continue; }

            let content_val = &msg["content"];
            // Content can be a string (simple prompt) or array (with tool_results)
            if let Some(text) = content_val.as_str() {
                let uuid = val["uuid"].as_str().unwrap_or("").to_string();
                let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));
                if !text.is_empty() {
                    messages.push(HistoryMessage {
                        id: uuid, role: "user".to_string(), content: text.to_string(), timestamp: ts, tool_calls: None,
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
                                    arr.iter().filter_map(|c| {
                                        if c["type"].as_str() == Some("text") { c["text"].as_str().map(|s| s.to_string()) }
                                        else { None }
                                    }).collect::<Vec<_>>().join("\n")
                                } else {
                                    String::new()
                                };
                                tcs[tc_idx].result = Some(result_text);
                                tcs[tc_idx].is_error = block["is_error"].as_bool().unwrap_or(false);
                            }
                        }
                    } else if block["type"].as_str() == Some("text") {
                        if let Some(t) = block["text"].as_str() {
                            if !user_text.is_empty() { user_text.push('\n'); }
                            user_text.push_str(t);
                        }
                    }
                }
                // If the array contained text blocks (not just tool_results), emit a user message
                if !user_text.trim().is_empty() {
                    let uuid = val["uuid"].as_str().unwrap_or("").to_string();
                    let ts = parse_timestamp(val["timestamp"].as_str().unwrap_or(""));
                    messages.push(HistoryMessage {
                        id: uuid, role: "user".to_string(), content: user_text.trim().to_string(), timestamp: ts, tool_calls: None,
                    });
                }
            }
        } else if rec_type == "assistant" {
            let msg = &val["message"];
            let content_arr = match msg["content"].as_array() { Some(a) => a, None => continue };
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
                            id: tc_id.clone(), name: tc_name, input: tc_input, result: None, is_error: false,
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
                    tool_calls: if tool_calls.is_empty() { None } else { Some(tool_calls) },
                });
            }
        }
        // Skip queue-operation, last-prompt, etc.
    }
    Ok(messages)
}

/// Collect JSONL lines up to `keep_turns` user messages (actual user prompts, not tool_result-only messages).
/// A "real" user turn has non-empty, non-whitespace text content — matching load_session_history's filtering.
fn collect_jsonl_lines_up_to_turns<'a>(content: &'a str, keep_turns: usize) -> Vec<&'a str> {
    let mut kept: Vec<&str> = Vec::new();
    let mut user_turn_count = 0;
    for line in content.lines() {
        if line.trim().is_empty() { continue; }
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => { kept.push(line); continue; } };
        if val["type"].as_str().unwrap_or("") == "user" {
            let is_real = val["message"]["content"].as_str().map(|s| !s.is_empty()).unwrap_or_else(||
                val["message"]["content"].as_array().map(|arr| arr.iter().any(|b| {
                    b["type"].as_str() == Some("text") && b["text"].as_str().map(|t| !t.trim().is_empty()).unwrap_or(false)
                })).unwrap_or(false)
            );
            if is_real { user_turn_count += 1; }
        }
        if user_turn_count > keep_turns { break; }
        kept.push(line);
    }
    kept
}

#[tauri::command]
fn truncate_session_jsonl(session_id: String, cwd: String, keep_turns: usize) -> Result<(), String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let kept = collect_jsonl_lines_up_to_turns(&content, keep_turns);
    let truncated = kept.join("\n") + "\n";
    std::fs::write(&path, truncated).map_err(|e| format!("write: {}", e))?;
    safe_eprintln!("[rewind] Truncated JSONL to {} turns (was {} lines, now {} lines)", keep_turns, content.lines().count(), kept.len());
    Ok(())
}

/// Truncate JSONL to keep exactly `keep_messages` visible messages (as load_session_history would produce).
/// This matches the frontend's message count precisely — no turn-counting mismatches.
#[tauri::command]
fn truncate_session_jsonl_by_messages(session_id: String, cwd: String, keep_messages: usize) -> Result<serde_json::Value, String> {
    let path = session_jsonl_path(&cwd, &session_id)?;
    safe_eprintln!("[rewind] truncate_session_jsonl_by_messages: path={} keep_messages={}", path.display(), keep_messages);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let original_lines = content.lines().count();
    let original_bytes = content.len();

    let mut kept: Vec<&str> = Vec::new();
    let mut visible_count: usize = 0;
    let mut done = false;
    // Track the last visible message for diagnostics
    let mut last_visible_role = String::new();
    let mut last_visible_preview = String::new();

    for line in content.lines() {
        if line.trim().is_empty() { continue; }
        if done {
            // After reaching the target, still keep tool-result-only user records
            // (they pair with the last assistant's tool_use and don't produce visible messages)
            let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => break };
            if val["type"].as_str().unwrap_or("") == "user" {
                let has_text = is_real_user_message(&val);
                if !has_text {
                    kept.push(line);
                    continue;
                }
            }
            break;
        }
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => { kept.push(line); continue; } };
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
                arr.iter().filter_map(|b| {
                    if b["type"].as_str() == Some("text") { b["text"].as_str().map(|t| t.chars().take(80).collect::<String>()) }
                    else { None }
                }).next().unwrap_or_default()
            } else { String::new() };
        } else if rec_type == "assistant" {
            let msg = &val["message"];
            if let Some(content_arr) = msg["content"].as_array() {
                let has_text = content_arr.iter().any(|b| {
                    b["type"].as_str() == Some("text") && b["text"].as_str().map(|t| !t.trim().is_empty()).unwrap_or(false)
                });
                let has_tools = content_arr.iter().any(|b| b["type"].as_str() == Some("tool_use"));
                if has_text || has_tools {
                    visible_count += 1;
                    if visible_count > keep_messages {
                        break;
                    }
                    last_visible_role = "assistant".to_string();
                    last_visible_preview = content_arr.iter().filter_map(|b| {
                        if b["type"].as_str() == Some("text") { b["text"].as_str().map(|t| t.chars().take(80).collect::<String>()) }
                        else { None }
                    }).next().unwrap_or_else(|| "[tool calls]".to_string());
                }
            }
        }
        kept.push(line);
        if visible_count == keep_messages && rec_type == "assistant" {
            // Check if this assistant has tool_use — if so, keep trailing tool-result records
            if let Some(content_arr) = val["message"]["content"].as_array() {
                if content_arr.iter().any(|b| b["type"].as_str() == Some("tool_use")) {
                    done = true;
                    continue; // Enter trailing mode
                }
            }
        }
    }

    if visible_count == 0 && keep_messages > 0 {
        return Err(format!("No visible messages found in JSONL at {}. Total lines: {}", path.display(), original_lines));
    }

    let truncated = kept.join("\n") + "\n";
    let new_bytes = truncated.len();
    std::fs::write(&path, &truncated).map_err(|e| format!("write {}: {}", path.display(), e))?;

    // Verification: re-read and count
    let verify = std::fs::read_to_string(&path).map_err(|e| format!("verify-read {}: {}", path.display(), e))?;
    let verify_lines = verify.lines().filter(|l| !l.trim().is_empty()).count();

    safe_eprintln!("[rewind] Truncated JSONL: keep_messages={} actual_kept={} original_lines={} new_lines={} original_bytes={} new_bytes={}",
        keep_messages, visible_count, original_lines, kept.len(), original_bytes, new_bytes);
    safe_eprintln!("[rewind] Last kept message: [{}] {}", last_visible_role, &last_visible_preview[..last_visible_preview.len().min(80)]);
    safe_eprintln!("[rewind] Verify: file now has {} non-empty lines (expected {})", verify_lines, kept.len());

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
            b["type"].as_str() == Some("text") && b["text"].as_str().map(|t| !t.trim().is_empty()).unwrap_or(false)
        });
    }
    false
}

/// Collect JSONL lines keeping exactly `keep_messages` visible messages
/// (counting both user + assistant the same way load_session_history does).
fn collect_jsonl_lines_by_messages<'a>(content: &'a str, keep_messages: usize) -> Vec<&'a str> {
    let mut kept: Vec<&str> = Vec::new();
    let mut visible_count: usize = 0;
    let mut done = false;

    for line in content.lines() {
        if line.trim().is_empty() { continue; }
        if done {
            let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => break };
            if val["type"].as_str().unwrap_or("") == "user" && !is_real_user_message(&val) {
                kept.push(line);
                continue;
            }
            break;
        }
        let val: serde_json::Value = match serde_json::from_str(line) { Ok(v) => v, Err(_) => { kept.push(line); continue; } };
        let rec_type = val["type"].as_str().unwrap_or("");
        if rec_type == "user" && is_real_user_message(&val) {
            visible_count += 1;
            if visible_count > keep_messages { break; }
        } else if rec_type == "assistant" {
            if let Some(content_arr) = val["message"]["content"].as_array() {
                let has_text = content_arr.iter().any(|b|
                    b["type"].as_str() == Some("text") && b["text"].as_str().map(|t| !t.trim().is_empty()).unwrap_or(false)
                );
                let has_tools = content_arr.iter().any(|b| b["type"].as_str() == Some("tool_use"));
                if has_text || has_tools {
                    visible_count += 1;
                    if visible_count > keep_messages { break; }
                }
            }
        }
        kept.push(line);
        if visible_count == keep_messages && rec_type == "assistant" {
            if let Some(content_arr) = val["message"]["content"].as_array() {
                if content_arr.iter().any(|b| b["type"].as_str() == Some("tool_use")) {
                    done = true;
                    continue;
                }
            }
        }
    }
    kept
}

#[tauri::command]
fn fork_session_jsonl(parent_session_id: String, new_session_id: String, cwd: String, keep_messages: usize) -> Result<(), String> {
    let src = session_jsonl_path(&cwd, &parent_session_id)?;
    let content = std::fs::read_to_string(&src).map_err(|e| format!("read: {}", e))?;
    let kept = collect_jsonl_lines_by_messages(&content, keep_messages);
    let dest = session_jsonl_path(&cwd, &new_session_id)?;
    let truncated = kept.join("\n") + "\n";
    std::fs::write(&dest, truncated).map_err(|e| format!("write: {}", e))?;
    safe_eprintln!("[fork] Copied {} -> {} ({} messages, {} lines)", parent_session_id, new_session_id, keep_messages, kept.len());
    Ok(())
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
    let reason = if allow { "Approved by user" } else { "Denied by user" };
    state.permission_server.resolve(&request_id, allow, reason);
    Ok(())
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() { return Err("Not a directory".into()); }
    let mut entries = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else { return Ok(entries); };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.iter().any(|s| name == *s) { continue; }
        if name.starts_with('.') && name != ".." { continue; }
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
    cmd.arg(flag).arg(&command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    if let Some(ref dir) = cwd {
        if !dir.is_empty() { cmd.current_dir(dir); }
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
                                servers.push(McpServer {
                                    name: name.clone(),
                                    transport: cfg.get("type").or(cfg.get("transport"))
                                        .and_then(|v| v.as_str()).unwrap_or("stdio").to_string(),
                                    command: cfg.get("command").and_then(|v| v.as_str())
                                        .or_else(|| cfg.get("url").and_then(|v| v.as_str()))
                                        .unwrap_or("").to_string(),
                                    scope: "user".to_string(),
                                });
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
                        servers.push(McpServer {
                            name: name.clone(),
                            transport: cfg.get("type").or(cfg.get("transport"))
                                .and_then(|v| v.as_str()).unwrap_or("stdio").to_string(),
                            command: cfg.get("command").and_then(|v| v.as_str())
                                .or_else(|| cfg.get("url").and_then(|v| v.as_str()))
                                .unwrap_or("").to_string(),
                            scope: "project".to_string(),
                        });
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
        ("add-dir", "Add a working directory for file access", Some("/add-dir <path>")),
        ("agents", "Manage agent configurations", None),
        ("branch", "Branch the conversation at this point", Some("/branch [name] — alias: /fork")),
        ("btw", "Ask a side question without adding to context", Some("/btw <question>")),
        ("clear", "Clear conversation history", None),
        ("color", "Set session prompt bar color", Some("/color [red|blue|green|yellow|purple|orange|pink|cyan|default]")),
        ("compact", "Compact conversation to save context", Some("/compact [instructions]")),
        ("config", "Open settings interface", None),
        ("context", "Visualize current context usage", None),
        ("copy", "Copy last assistant response to clipboard", Some("/copy [N] — N=2 for second-to-last")),
        ("cost", "Show token usage and cost for this session", None),
        ("diff", "Interactive diff viewer for uncommitted changes", None),
        ("doctor", "Check Claude Code setup for issues", None),
        ("effort", "Set model effort level", Some("/effort [low|medium|high|max|auto]")),
        ("export", "Export conversation as plain text", Some("/export [filename]")),
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
        ("model", "Switch the AI model", Some("/model [sonnet|opus|haiku]")),
        ("permissions", "View and manage tool permissions", None),
        ("plan", "Enter plan mode", Some("/plan [description]")),
        ("plugin", "Manage Claude Code plugins", None),
        ("pr-comments", "Fetch comments from a GitHub PR", Some("/pr-comments [PR number or URL]")),
        ("release-notes", "View the full changelog", None),
        ("rename", "Rename the current session", Some("/rename [name]")),
        ("resume", "Resume a conversation by ID or name", Some("/resume [session]")),
        ("rewind", "Rewind conversation to a previous point", None),
        ("schedule", "Create, update, or list scheduled remote agents", Some("/schedule [create|list|run] ...")),
        ("security-review", "Analyze pending changes for security vulnerabilities", None),
        ("skills", "List available skills", None),
        ("stats", "Visualize daily usage and session history", None),
        ("status", "Show version, model, account, and connectivity", None),
        ("tasks", "List and manage background tasks", None),
        ("theme", "Change the color theme", None),
        ("usage", "Show plan usage limits and rate limit status", None),
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
        let Ok(entries) = std::fs::read_dir(dir) else { return };
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
                } else if path.file_name().map(|n| n == "node_modules" || n == ".git").unwrap_or(false) {
                    // Skip
                } else {
                    scan_dir(&path, commands);
                }
            }
        }
    }

    fn parse_frontmatter(content: &str) -> Option<(&str, &str)> {
        let content = content.trim_start();
        if !content.starts_with("---") { return None; }
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
        let name = extract_yaml_field(yaml, "name")
            .or_else(|| skill_dir.file_name()?.to_str())?;
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
            extract_yaml_field(yaml, "description").unwrap_or("").to_string()
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
    bot.start(token, gid, app_handle, state.claude_manager.clone())
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
) -> Result<(), String> {
    let bot = state.discord_bot.lock().map_err(|e| e.to_string())?;
    bot.cleanup_orphaned()
}

#[tauri::command]
fn get_delegation_port(
    state: tauri::State<'_, AppState>,
) -> Result<u16, String> {
    state.permission_server.ensure_alive()
}

#[tauri::command]
fn get_delegation_secret(
    state: tauri::State<'_, AppState>,
) -> String {
    state.permission_server.secret().to_string()
}

fn resolve_node_path() -> &'static str {
    static NODE_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NODE_PATH.get_or_init(|| {
        for p in &["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if std::path::Path::new(p).exists() { return p.to_string(); }
        }
        if let Ok(output) = std::process::Command::new("/bin/sh")
            .args(["-lc", "which node"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
        {
            if output.status.success() {
                let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !s.is_empty() && std::path::Path::new(&s).exists() { return s; }
            }
        }
        "node".to_string()
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
    std::fs::write(&path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    safe_eprintln!("[mcp] Created config file: {}", path.display());
    Ok(path.to_string_lossy().to_string())
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
            && existing.get("args").and_then(|v| v.get(0)).and_then(|v| v.as_str()) == Some(&script_path)
        {
            return Ok(());
        }
    }

    servers.as_object_mut().ok_or("Invalid mcpServers")?.insert(
        "terminal-64".to_string(),
        serde_json::json!({ "command": node_path, "args": [script_path] }),
    );

    std::fs::write(&mcp_path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    safe_eprintln!("[mcp] Updated .mcp.json with node_path={}", node_path);
    Ok(())
}

#[tauri::command]
fn get_app_dir(app_handle: tauri::AppHandle) -> Result<String, String> {
    // Check Tauri resource directory first (production builds bundle mcp/ here)
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
    let msgs = state.permission_server.delegation_messages
        .lock().map_err(|e| e.to_string())?;
    let group_msgs = msgs.get(&group_id).cloned().unwrap_or_default();
    Ok(group_msgs.iter().map(|m| serde_json::json!({
        "agent": m.agent,
        "message": m.message,
        "timestamp": m.timestamp,
        "msg_type": m.msg_type,
    })).collect())
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
    if !base.exists() { return Ok(vec![]); }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        let index_exists = entry.path().join("index.html").exists();
        let modified = entry.metadata()
            .and_then(|m| m.modified())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(|_| std::io::Error::other("time")))
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
        let entry = archive.by_index(i).map_err(|e| format!("zip entry: {}", e))?;
        let name: &str = entry.name();
        if let Some(first) = name.split('/').next() {
            if !first.is_empty() {
                top_dirs.insert(first.to_string());
            }
        }
    }
    let (widget_id, strip_prefix) = if top_dirs.len() == 1 {
        let name = top_dirs.into_iter().next().unwrap();
        let id = name.to_lowercase().replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-");
        (id, true)
    } else {
        let stem = src.file_stem().unwrap_or_default().to_string_lossy();
        let id = stem.to_lowercase().replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-");
        (id, false)
    };

    let dest = widgets_base_dir()?.join(&widget_id);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| format!("cleanup: {}", e))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("mkdir: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry: {}", e))?;
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

        if rel.is_empty() { continue; }

        let out_path = dest.join(rel);

        // Prevent path traversal
        if !out_path.starts_with(&dest) { continue; }

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
    if !dir.exists() { return Ok(0); }
    fn newest_mtime(dir: &std::path::Path) -> u64 {
        let mut max = 0u64;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let ft = match entry.file_type() { Ok(ft) => ft, Err(_) => continue };
                if ft.is_dir() {
                    // Skip node_modules and hidden dirs
                    let name = entry.file_name();
                    let n = name.to_string_lossy();
                    if n.starts_with('.') || n == "node_modules" { continue; }
                    max = max.max(newest_mtime(&entry.path()));
                } else {
                    let mt = entry.metadata()
                        .and_then(|m| m.modified())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(|_| std::io::Error::other("time")))
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
    if id.is_empty() || id.contains("..") || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
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
fn widget_set_state(widget_id: String, key: String, value: serde_json::Value) -> Result<(), String> {
    let path = widget_state_path(&widget_id)?;
    let mut data: serde_json::Map<String, serde_json::Value> = match std::fs::read_to_string(&path) {
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
        std::fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap())
            .map_err(|e| format!("write: {}", e))?;
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_skills() -> Result<Vec<serde_json::Value>, String> {
    let base = skills_base_dir()?;
    if !base.exists() { return Ok(vec![]); }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&base).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        let meta_path = entry.path().join("skill.json");
        let skill_md_exists = entry.path().join("SKILL.md").exists();
        let modified = entry.metadata()
            .and_then(|m| m.modified())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(|_| std::io::Error::other("time")))
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        if let Ok(content) = std::fs::read_to_string(&meta_path) {
            if let Ok(mut meta) = serde_json::from_str::<serde_json::Value>(&content) {
                meta["has_skill_md"] = serde_json::json!(skill_md_exists);
                meta["modified"] = serde_json::json!(modified);
                out.push(meta);
                continue;
            }
        }
        // Fallback if no skill.json
        out.push(serde_json::json!({
            "name": name,
            "description": "",
            "tags": [],
            "has_skill_md": skill_md_exists,
            "modified": modified,
        }));
    }
    out.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Ok(out)
}

#[tauri::command]
fn delete_skill(skill_id: String) -> Result<(), String> {
    let dir = skills_base_dir()?.join(&skill_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("rm: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn update_skill_meta(skill_id: String, description: Option<String>, tags: Option<Vec<String>>) -> Result<(), String> {
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
    meta["modified"] = serde_json::json!(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    );
    std::fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap())
        .map_err(|e| format!("write: {}", e))?;
    Ok(())
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

    // Create the T64 plugin directory in Claude's plugin system
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
        std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
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
        #[cfg(unix)]
        std::os::unix::fs::symlink(&skills_dir, &symlink_target)
            .map_err(|e| format!("symlink: {}", e))?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&skills_dir, &symlink_target)
            .map_err(|e| format!("symlink: {}", e))?;
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
            plugins.insert(plugin_key.to_string(), serde_json::json!([{
                "scope": "user",
                "installPath": plugin_dir.to_string_lossy(),
                "version": "1.0.0",
                "installedAt": now,
                "lastUpdated": now
            }]));
            std::fs::write(&installed_path, serde_json::to_string_pretty(&installed).unwrap())
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
        let enabled = obj.entry("enabledPlugins")
            .or_insert(serde_json::json!({}));
        if let Some(ep) = enabled.as_object_mut() {
            if !ep.contains_key(plugin_key) {
                ep.insert(plugin_key.to_string(), serde_json::json!(true));
                std::fs::write(&settings_path, serde_json::to_string_pretty(&settings).unwrap())
                    .map_err(|e| format!("write settings: {}", e))?;
            }
        }
    }

    safe_eprintln!("[skills] Plugin bridge installed at {}", plugin_dir.display());
    Ok(())
}

// ---- Proxy fetch (CORS bypass for widgets) ----

#[derive(serde::Serialize)]
struct ProxyFetchResponse {
    status: u16,
    ok: bool,
    headers: std::collections::HashMap<String, String>,
    body: String,
    is_base64: bool,
}

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

    // Parse URL and block private/internal IP ranges
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
                    || o[0] == 0                                    // 0.0.0.0/8
                }
                std::net::IpAddr::V6(v6) => {
                    v6.is_loopback()                                    // ::1
                    || v6.is_unspecified()                              // ::
                    || (v6.segments()[0] & 0xffc0) == 0xfe80           // fe80::/10 link-local
                    || (v6.segments()[0] & 0xfe00) == 0xfc00           // fc00::/7 unique-local
                    || (v6.segments()[0] & 0xff00) == 0xff00           // ff00::/8 multicast
                    || v6.segments()[0..6] == [0,0,0,0,0,0xffff]       // ::ffff:0:0/96 IPv4-mapped
                }
            };
            if is_blocked {
                return Err("Requests to private/internal addresses are not allowed".into());
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000).min(60_000)))
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

    let content_type = resp_headers.get("content-type").cloned().unwrap_or_default();
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
        (base64::engine::general_purpose::STANDARD.encode(&bytes), true)
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

#[derive(serde::Deserialize)]
struct FileSnapshot {
    path: String,
    content: String,
}

#[tauri::command]
fn create_checkpoint(session_id: String, turn: usize, files: Vec<FileSnapshot>) -> Result<(), String> {
    let dir = checkpoints_base_dir()?.join(&session_id).join(format!("turn-{}", turn));
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
    safe_println!("[checkpoint] Created turn-{} for {} ({} files)", turn, &session_id[..8.min(session_id.len())], files.len());
    Ok(())
}

#[tauri::command]
fn restore_checkpoint(session_id: String, turn: usize) -> Result<Vec<String>, String> {
    let dir = checkpoints_base_dir()?.join(&session_id).join(format!("turn-{}", turn));
    if !dir.exists() {
        return Ok(vec![]); // no checkpoint for this turn — nothing to restore
    }
    let manifest_path = dir.join("manifest.txt");
    let manifest = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read manifest: {}", e))?;
    let mut restored = Vec::new();
    for line in manifest.lines() {
        if line.is_empty() { continue; }
        let parts: Vec<&str> = line.splitn(2, '|').collect();
        if parts.len() != 2 { continue; }
        let snap_file = parts[0];
        let original_path = parts[1];
        // Block path traversal in crafted manifests
        if original_path.contains("..") || snap_file.contains("..") {
            return Err(format!("restore_checkpoint blocked: path traversal detected"));
        }
        let content = std::fs::read_to_string(dir.join(snap_file))
            .map_err(|e| format!("read snap {}: {}", snap_file, e))?;
        let dest = std::path::Path::new(original_path);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(dest, &content)
            .map_err(|e| format!("restore {}: {}", original_path, e))?;
        restored.push(original_path.to_string());
    }
    safe_println!("[checkpoint] Restored turn-{} for {} ({} files)", turn, &session_id[..8.min(session_id.len())], restored.len());
    Ok(restored)
}

#[tauri::command]
fn cleanup_checkpoints(session_id: String, keep_up_to_turn: usize) -> Result<(), String> {
    let base = checkpoints_base_dir()?.join(&session_id);
    if !base.exists() { return Ok(()); }
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

/// Delete a list of files (used during rewind to remove files created by delegation agents).
/// Silently skips files that don't exist.
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
        safe_println!("[rewind] Deleted {} files created during delegation", deleted.len());
    }
    Ok(deleted)
}

/// Revert files to their git HEAD state. For files that are new (untracked), delete them.
/// For files that were modified, restore from git. For files that were deleted, restore from git.
#[tauri::command]
fn revert_files_git(cwd: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    let cwd_path = std::path::Path::new(&cwd);
    if !cwd_path.exists() {
        return Err("CWD does not exist".to_string());
    }
    let mut reverted = Vec::new();

    for path in &paths {
        let abs = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            cwd_path.join(path)
        };

        // Check if this file is tracked by git
        let is_tracked = std::process::Command::new("git")
            .args(["ls-files", "--error-unmatch"])
            .arg(&abs)
            .current_dir(cwd_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if is_tracked {
            // File is tracked — restore from HEAD
            let status = std::process::Command::new("git")
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
        } else if abs.exists() {
            // File is untracked (new) — delete it
            if std::fs::remove_file(&abs).is_ok() {
                reverted.push(path.clone());
            }
        }
        // If file doesn't exist and isn't tracked, nothing to do
    }

    if !reverted.is_empty() {
        safe_println!("[rewind] Git-reverted {} files", reverted.len());
    }
    Ok(reverted)
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

#[tauri::command]
fn create_browser(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    state.browser_manager.create(&app_handle, id, url, x, y, w, h)
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
    state.browser_manager.set_bounds(&app_handle, &id, x, y, w, h)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let perm_server = PermissionServer::start(app.handle().clone())
                .map_err(|e| {
                    safe_eprintln!("[setup] Permission server failed to start: {}", e);
                    Box::<dyn std::error::Error>::from(e)
                })?;
            let widget_srv = WidgetServer::start()
                .map_err(|e| {
                    safe_eprintln!("[setup] Widget server failed to start: {}", e);
                    Box::<dyn std::error::Error>::from(e)
                })?;
            app.manage(AppState {
                pty_manager: PtyManager::new(),
                claude_manager: Arc::new(ClaudeManager::new()),
                discord_bot: Mutex::new(DiscordBot::new()),
                permission_server: Arc::new(perm_server),
                audio_manager: Arc::new(AudioManager::new()),
                browser_manager: BrowserManager::new(),
                widget_server: widget_srv,
            });

            // Disable native WKWebView pinch-to-zoom magnification on macOS
            // so our custom canvas zoom isn't fighting the browser's own zoom
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.with_webview(|wv| {
                        unsafe {
                            let inner = wv.inner() as *mut objc2::runtime::AnyObject;
                            let _: () = objc2::msg_send![&*inner, setAllowsMagnification: false];
                        }
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
            link_session_to_discord,
            unlink_session_from_discord,
            rename_discord_session,
            discord_cleanup_orphaned,
            resolve_permission,
            rewrite_prompt,
            search_files,
            list_disk_sessions,
            load_session_history,
            truncate_session_jsonl,
            truncate_session_jsonl_by_messages,
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
            ensure_t64_mcp,
            create_mcp_config_file,
            create_widget_folder,
            read_widget_html,
            list_widget_folders,
            widget_file_modified,
            delete_widget_folder,
            install_widget_zip,
            get_widget_server_port,
            widget_get_state,
            widget_set_state,
            widget_clear_state,
            proxy_fetch,
            send_notification,
            create_checkpoint,
            delete_files,
            revert_files_git,
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
            save_pasted_image,
            read_file_base64,
            create_skill_folder,
            list_skills,
            delete_skill,
            update_skill_meta,
            get_skill_creator_path,
            ensure_skills_plugin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
