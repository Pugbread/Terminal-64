//! Provider-agnostic helpers reused by every adapter.
//!
//! Step 1 copies these verbatim from `claude_manager.rs` so Agent 2 can
//! delete the originals and point `claude.rs` at this module. The helpers
//! are provider-neutral in effect:
//!
//! - [`shim_command`] — wraps a binary path in `cmd /C` on Windows so
//!   `.cmd`/`.bat` shims resolve via PATHEXT. Any adapter spawning a CLI
//!   needs it.
//! - [`cap_event_size`] — truncates oversized tool-result event lines
//!   before they leave the backend. Saves the renderer when a bash tool
//!   dumps hundreds of MB.
//! - [`sanitize_dangling_tool_uses`] — patches Claude-CLI JSONL files to
//!   close dangling `tool_use` blocks on resume. **Claude-specific today**,
//!   but lives here because `cap_event_size`'s helpers (`truncate_text_field`,
//!   the char-boundary helpers) are shared.

use std::collections::HashMap;
use std::process::Command;

/// PATH used for app-spawned shells and provider CLIs. macOS GUI launches and
/// embedded tool runners often do not inherit the user's login-shell PATH, so
/// common Homebrew/npm/Cargo locations need to be restored explicitly.
pub fn expanded_tool_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        format!(
            "{appdata}\\npm;{home}\\.cargo\\bin;{home}\\.npm-global\\bin;{localappdata}\\Programs\\nodejs;{program_files}\\nodejs;{existing}"
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        format!(
            "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:{home}/.local/bin:{home}/.cargo/bin:{home}/.npm-global/bin:/opt/homebrew/lib/node_modules/.bin:{existing}"
        )
    }
}

// --- shim_command ---------------------------------------------------------

/// Build a `Command` for a binary path that may be a Windows `.cmd`/`.bat`
/// shim. On Windows wraps in `cmd /C` so PATHEXT-style resolution works and
/// arg escaping flows through cmd.exe's parser (`CREATE_NO_WINDOW`
/// suppresses the console flash). On Unix returns a plain `Command`.
pub fn shim_command(bin: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.arg("/C").arg(bin);
        c.creation_flags(0x08000000);
        c
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(bin)
    }
}

// --- cap_event_size + helpers --------------------------------------------

/// A heavy bash (or any tool) can emit a tool_result hundreds of MB long.
/// Shipping that as one Tauri event freezes the renderer (JSON.parse +
/// React render + localStorage.setItem on megabytes of text). Cap oversized
/// event lines here before they leave the backend. The CLI's own JSONL
/// still holds the full content for future turns; only the live UI stream
/// is truncated.
pub const MAX_EVENT_LINE_BYTES: usize = 512 * 1024;
pub const TRUNCATE_HEAD_BYTES: usize = 96 * 1024;
pub const TRUNCATE_TAIL_BYTES: usize = 96 * 1024;

fn char_boundary_floor(s: &str, mut end: usize) -> usize {
    if end >= s.len() {
        return s.len();
    }
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn char_boundary_ceil(s: &str, mut start: usize) -> usize {
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    start
}

fn truncate_text_field(s: &str) -> String {
    if s.len() <= TRUNCATE_HEAD_BYTES + TRUNCATE_TAIL_BYTES {
        return s.to_string();
    }
    let head_end = char_boundary_floor(s, TRUNCATE_HEAD_BYTES);
    let tail_start = char_boundary_ceil(s, s.len() - TRUNCATE_TAIL_BYTES);
    let dropped = tail_start.saturating_sub(head_end);
    format!(
        "{}\n\n[Terminal 64: truncated {} bytes — output too large to display inline]\n\n{}",
        &s[..head_end],
        dropped,
        &s[tail_start..]
    )
}

fn truncate_large_json_strings(value: &mut serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > TRUNCATE_HEAD_BYTES + TRUNCATE_TAIL_BYTES {
                *s = truncate_text_field(s);
                true
            } else {
                false
            }
        }
        serde_json::Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= truncate_large_json_strings(item);
            }
            changed
        }
        serde_json::Value::Object(map) => {
            let mut changed = false;
            for value in map.values_mut() {
                changed |= truncate_large_json_strings(value);
            }
            changed
        }
        _ => false,
    }
}

pub fn cap_event_size(line: String) -> String {
    if line.len() <= MAX_EVENT_LINE_BYTES {
        return line;
    }
    // Oversized. Try to parse and truncate the large tool_result content
    // fields in place; if that fails, fall back to a hard byte-slice cap.
    let mut val: serde_json::Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(_) => {
            return json_string_event("Terminal64TruncatedNonJsonEvent", &line);
        }
    };

    fn truncate_block_content(block: &mut serde_json::Value) {
        if let Some(s) = block.get("content").and_then(|v| v.as_str()) {
            if s.len() > TRUNCATE_HEAD_BYTES + TRUNCATE_TAIL_BYTES {
                let replaced = truncate_text_field(s);
                block["content"] = serde_json::Value::String(replaced);
            }
        } else if let Some(arr) = block.get_mut("content").and_then(|v| v.as_array_mut()) {
            for inner in arr.iter_mut() {
                if inner.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = inner.get("text").and_then(|v| v.as_str()) {
                        if t.len() > TRUNCATE_HEAD_BYTES + TRUNCATE_TAIL_BYTES {
                            let replaced = truncate_text_field(t);
                            inner["text"] = serde_json::Value::String(replaced);
                        }
                    }
                }
            }
        }
    }

    // user events carry tool_result blocks; assistant events can carry giant
    // text blocks. Walk both shapes.
    if let Some(arr) = val
        .pointer_mut("/message/content")
        .and_then(|v| v.as_array_mut())
    {
        for block in arr.iter_mut() {
            match block.get("type").and_then(|v| v.as_str()) {
                Some("tool_result") => truncate_block_content(block),
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        if t.len() > TRUNCATE_HEAD_BYTES + TRUNCATE_TAIL_BYTES {
                            let replaced = truncate_text_field(t);
                            block["text"] = serde_json::Value::String(replaced);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if truncate_large_json_strings(&mut val) {
        if let Ok(s) = serde_json::to_string(&val) {
            return s;
        }
    }

    match serde_json::to_string(&val) {
        Ok(s) => s,
        Err(_) => {
            // Last-resort fallback for unexpected serialization failures.
            json_string_event("Terminal64TruncatedEvent", &line)
        }
    }
}

fn json_string_event(event_type: &str, original: &str) -> String {
    let head = char_boundary_floor(original, TRUNCATE_HEAD_BYTES);
    serde_json::json!({
        "type": event_type,
        "message": format!(
            "Terminal 64 truncated {} bytes of oversized non-JSON event",
            original.len().saturating_sub(head)
        ),
        "preview": &original[..head],
    })
    .to_string()
}

// --- sanitize_dangling_tool_uses (Claude-specific, lives here for now) ----

/// Resolve the session JSONL path the Claude CLI writes to.
fn session_jsonl_path(cwd: &str, session_id: &str) -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    let dir_hash = cwd.replace([':', '\\', '/'], "-");
    Some(
        home.join(".claude")
            .join("projects")
            .join(dir_hash)
            .join(format!("{}.jsonl", session_id)),
    )
}

/// Scan the session JSONL for tool_use blocks that never received a matching
/// tool_result (e.g. Bash killed mid-flight when T64 was force-closed). For
/// each, append a synthetic `user` record with a cancelled tool_result so
/// Claude CLI doesn't re-execute the dangling tool on `--resume`.
pub fn sanitize_dangling_tool_uses(cwd: &str, session_id: &str) -> Result<(), String> {
    let Some(path) = session_jsonl_path(cwd, session_id) else {
        return Ok(());
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read jsonl: {}", e)),
    };

    // tool_use_id -> (parent assistant uuid, tool name)
    let mut pending: HashMap<String, (String, String)> = HashMap::new();
    let mut resolved: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut last_cwd = cwd.to_string();
    let mut last_version = String::new();
    let mut last_git_branch = String::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(c) = val.get("cwd").and_then(|v| v.as_str()) {
            last_cwd = c.to_string();
        }
        if let Some(v) = val.get("version").and_then(|v| v.as_str()) {
            last_version = v.to_string();
        }
        if let Some(g) = val.get("gitBranch").and_then(|v| v.as_str()) {
            last_git_branch = g.to_string();
        }

        match val.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "assistant" => {
                let msg_uuid = val
                    .get("uuid")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(arr) = val.pointer("/message/content").and_then(|v| v.as_array()) {
                    for block in arr {
                        if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                            if let Some(tu_id) = block.get("id").and_then(|v| v.as_str()) {
                                let name = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                pending.insert(tu_id.to_string(), (msg_uuid.clone(), name));
                            }
                        }
                    }
                }
            }
            "user" => {
                if let Some(arr) = val.pointer("/message/content").and_then(|v| v.as_array()) {
                    for block in arr {
                        if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                            if let Some(tuid) = block.get("tool_use_id").and_then(|v| v.as_str()) {
                                resolved.insert(tuid.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let dangling: Vec<(&String, &(String, String))> = pending
        .iter()
        .filter(|(k, _)| !resolved.contains(*k))
        .collect();
    if dangling.is_empty() {
        return Ok(());
    }

    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut to_append = String::new();
    for (tuid, (parent_uuid, tool_name)) in &dangling {
        let rec = serde_json::json!({
            "parentUuid": parent_uuid,
            "isSidechain": false,
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "tool_use_id": tuid,
                    "type": "tool_result",
                    "content": format!(
                        "[Terminal 64: the previous {} call was interrupted when the app closed. No result is available — do not retry; continue with the next step.]",
                        if tool_name.is_empty() { "tool" } else { tool_name.as_str() }
                    ),
                    "is_error": true,
                }]
            },
            "uuid": uuid::Uuid::new_v4().to_string(),
            "timestamp": timestamp,
            "sessionId": session_id,
            "userType": "external",
            "entrypoint": "cli",
            "cwd": last_cwd,
            "version": last_version,
            "gitBranch": last_git_branch,
        });
        if let Ok(s) = serde_json::to_string(&rec) {
            to_append.push_str(&s);
            to_append.push('\n');
        }
    }

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| format!("open for append: {}", e))?;
    file.write_all(to_append.as_bytes())
        .map_err(|e| format!("append: {}", e))?;

    crate::safe_eprintln!(
        "[claude] Patched {} dangling tool_use call(s) in {} to prevent replay",
        dangling.len(),
        path.display()
    );
    Ok(())
}
