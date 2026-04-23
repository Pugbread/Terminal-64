use crate::types::*;
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub fn resolve_claude_path() -> String {
    // Try the platform-appropriate PATH lookup (GUI apps often have a limited PATH).
    // On Windows, pass the bare name (no extension) so `where` respects PATHEXT
    // and finds `.cmd`/`.bat` shims (npm-installed claude is usually a .cmd).
    let lookup = {
        let (cmd, arg) = if cfg!(windows) {
            ("where", "claude")
        } else {
            ("which", "claude")
        };
        let mut c = std::process::Command::new(cmd);
        c.arg(arg)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        c.output()
    };
    if let Ok(p) = lookup {
        if p.status.success() {
            // `where` on Windows may return multiple lines; take the first
            let s = String::from_utf8_lossy(&p.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }

    // Fall back to well-known install locations
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();

    let mut candidates: Vec<String> = Vec::new();

    if cfg!(windows) {
        if let Some(ref h) = home {
            candidates.push(format!("{}\\.local\\bin\\claude.exe", h));
            candidates.push(format!("{}\\.local\\bin\\claude.cmd", h));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{}\\npm\\claude.cmd", appdata));
            candidates.push(format!("{}\\npm\\claude.exe", appdata));
        }
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            candidates.push(format!("{}\\Programs\\claude\\claude.exe", localappdata));
        }
    } else {
        if let Some(ref h) = home {
            candidates.push(format!("{}/.local/bin/claude", h));
            candidates.push(format!("{}/.npm-global/bin/claude", h));
        }
        candidates.push("/usr/local/bin/claude".to_string());
        candidates.push("/opt/homebrew/bin/claude".to_string());
    }

    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    // On Windows, bare "claude" won't resolve via PATHEXT through Command::new,
    // so prefer ".cmd" (the npm shim form) as the last-resort name.
    #[cfg(target_os = "windows")]
    return "claude.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "claude".to_string();
}

struct ClaudeInstance {
    child: Child,
    generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Resolve the session JSONL path the CLI writes to. Mirrors
/// `session_jsonl_path` in lib.rs (duplicated to keep module boundaries clean).
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
fn sanitize_dangling_tool_uses(cwd: &str, session_id: &str) -> Result<(), String> {
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

    safe_eprintln!(
        "[claude] Patched {} dangling tool_use call(s) in {} to prevent replay",
        dangling.len(),
        path.display()
    );
    Ok(())
}

/// A heavy bash (or any tool) can emit a tool_result hundreds of MB long.
/// Shipping that as one Tauri event freezes the renderer (JSON.parse +
/// React render + localStorage.setItem on megabytes of text). Cap oversized
/// event lines here before they leave the backend. The CLI's own JSONL
/// still holds the full content for future turns; only the live UI stream
/// is truncated.
const MAX_EVENT_LINE_BYTES: usize = 512 * 1024;
const TRUNCATE_HEAD_BYTES: usize = 96 * 1024;
const TRUNCATE_TAIL_BYTES: usize = 96 * 1024;

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

fn cap_event_size(line: String) -> String {
    if line.len() <= MAX_EVENT_LINE_BYTES {
        return line;
    }
    // Oversized. Try to parse and truncate the large tool_result content
    // fields in place; if that fails, fall back to a hard byte-slice cap.
    let mut val: serde_json::Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(_) => {
            let head = char_boundary_floor(&line, TRUNCATE_HEAD_BYTES);
            return format!(
                "{}\n[Terminal 64: truncated {} bytes of non-JSON event]",
                &line[..head],
                line.len() - head
            );
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

    match serde_json::to_string(&val) {
        Ok(s) if s.len() < line.len() => s,
        _ => {
            // Truncation didn't help (structure unexpected) — hard cap.
            let head = char_boundary_floor(&line, TRUNCATE_HEAD_BYTES);
            format!(
                "{}\n[Terminal 64: truncated {} bytes of oversized event]",
                &line[..head],
                line.len() - head
            )
        }
    }
}

use std::sync::Arc;

pub struct ClaudeManager {
    instances: Arc<Mutex<HashMap<String, ClaudeInstance>>>,
}

/// Build a Command for a binary path that may be a Windows .cmd/.bat shim.
/// On Windows, wraps in `cmd /C` so PATHEXT-style resolution works and arg
/// escaping flows through cmd.exe's parser (CREATE_NO_WINDOW suppresses the
/// console flash). On Unix, returns a plain Command.
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

// Claude CLI invocation needs every flag threaded through as a distinct argument; bundling
// these would just introduce an internal struct that maps 1:1 to parameters, with no real gain.
#[allow(clippy::too_many_arguments)]
fn build_command(
    session_flag: &str,
    session_value: &str,
    _prompt: &str,
    permission_mode: &str,
    model: &Option<String>,
    effort: &Option<String>,
    cwd: &str,
    disallowed_tools: &Option<String>,
    settings_path: &Option<String>,
    channel_server: &Option<String>,
    mcp_config: &Option<String>,
    approver_mcp_config: &Option<String>,
    resume_session_at: &Option<String>,
    max_turns: &Option<u32>,
    max_budget_usd: &Option<f64>,
    no_session_persistence: &Option<bool>,
    fork_session: &Option<String>,
) -> Command {
    let claude_bin = resolve_claude_path();
    let mut cmd = shim_command(&claude_bin);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg(session_flag)
        .arg(session_value);

    match permission_mode {
        "bypass_all" => {
            cmd.arg("--permission-mode").arg("bypassPermissions");
        }
        "accept_edits" => {
            cmd.arg("--permission-mode").arg("acceptEdits");
        }
        "plan" => {
            cmd.arg("--permission-mode").arg("plan");
        }
        "auto" => {
            cmd.arg("--permission-mode").arg("auto");
        }
        _ => {
            cmd.arg("--permission-mode").arg("default");
        }
    }

    if let Some(m) = model {
        if !m.is_empty() {
            cmd.arg("--model").arg(m);
        }
    }
    if let Some(e) = effort {
        if !e.is_empty() {
            cmd.arg("--effort").arg(e);
        }
    }
    if let Some(dt) = disallowed_tools {
        if !dt.is_empty() {
            cmd.arg("--disallowed-tools").arg(dt);
        }
    }
    if let Some(sp) = settings_path {
        if !sp.is_empty() {
            cmd.arg("--settings").arg(sp);
        }
    }
    if let Some(ch) = channel_server {
        if !ch.is_empty() {
            cmd.arg("--dangerously-load-development-channels")
                .arg(format!("server:{}", ch));
        }
    }
    if !cwd.is_empty() && cwd != "." {
        cmd.current_dir(cwd);
    }
    if let Some(mc) = mcp_config {
        if !mc.is_empty() {
            cmd.arg("--mcp-config").arg(mc);
            cmd.arg("--strict-mcp-config");
        }
    }

    // Permission-prompt tool: a stdio MCP server shipped as a subcommand of
    // this same binary. Anthropic's sensitive-file classifier returns
    // `{behavior:"ask", type:"safetyCheck"}` for paths like `.mcp.json`,
    // `.zshrc`, `.git/*`, and `.claude/settings.json`, BEFORE bypass mode or
    // any PreToolUse hook can intervene. `--permission-prompt-tool` is the
    // only documented escape hatch: when the CLI's internal check returns
    // "ask", it routes the decision through this MCP tool instead of the TUI
    // prompt, and our shim returns `{behavior:"allow", updatedInput}`
    // (synchronously) so the stream never pauses. See
    // `.wolf/bypass-investigation/agent-2.md` for the empirical confirmation.
    if let Some(amc) = approver_mcp_config {
        if !amc.is_empty() {
            cmd.arg("--mcp-config").arg(amc);
            cmd.arg("--permission-prompt-tool").arg("mcp__t64__approve");
        }
    }

    // Rewind support: tell Claude CLI to slice conversation at a specific message UUID
    if let Some(uuid) = resume_session_at {
        if !uuid.is_empty() {
            cmd.arg("--resume-session-at").arg(uuid);
        }
    }

    // Session limit flags
    if let Some(turns) = max_turns {
        cmd.arg("--max-turns").arg(turns.to_string());
    }
    if let Some(budget) = max_budget_usd {
        cmd.arg("--max-budget-usd").arg(budget.to_string());
    }
    if let Some(true) = no_session_persistence {
        cmd.arg("--no-session-persistence");
    }
    if let Some(parent_id) = fork_session {
        if !parent_id.is_empty() {
            cmd.arg("--fork-session").arg(parent_id);
        }
    }

    // Prompt is sent via stdin (see spawn_and_stream). We do NOT pass it as a
    // CLI arg because cmd.exe (used by shim_command on Windows) truncates
    // arguments at literal newline characters, silently losing multi-line
    // prompts. Claude CLI's --print mode reads stdin when no positional
    // prompt is given.
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());

    cmd
}

/// Resolve a session UUID up-front: use the caller-provided value if it
/// looks non-empty, otherwise mint a fresh `uuid::Uuid::new_v4()`. Doing
/// this before spawn means the JSONL path is known the instant
/// `create_session` returns — no TOCTOU window waiting on the CLI's first
/// `system/init` event.
fn resolve_session_id(provided: &str) -> String {
    let trimmed = provided.trim();
    if trimmed.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        trimmed.to_string()
    }
}

/// Stderr pattern that a strict CLI uses when it doesn't recognize
/// `--session-id`. Checked against the buffered stderr so we can surface a
/// meaningful error instead of the opaque "exited without output".
fn stderr_rejects_session_id_flag(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    (lower.contains("unrecognized") || lower.contains("unknown argument"))
        && lower.contains("session-id")
}

fn spawn_and_stream(
    instances: &Arc<Mutex<HashMap<String, ClaudeInstance>>>,
    app_handle: &AppHandle,
    session_id: String,
    cwd: &str,
    mut cmd: Command,
    prompt: &str,
) -> Result<(), String> {
    {
        let mut inst = instances.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = inst.remove(&session_id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
            // Brief delay for OS to release file locks on session JSONL
            drop(inst); // release mutex before sleeping
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }

    // Resume-path safety net: if the previous run left a tool_use without a
    // matching tool_result (app killed mid-Bash), Claude CLI will re-execute
    // the dangling tool on the next turn — infinite replay. Stitch a cancelled
    // tool_result into the JSONL before spawning so the CLI skips past it.
    if let Err(e) = sanitize_dangling_tool_uses(cwd, &session_id) {
        safe_eprintln!(
            "[claude] sanitize_dangling_tool_uses({}): {}",
            session_id,
            e
        );
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;

    // Write prompt to stdin and close it. Done in a thread so a very large
    // prompt cannot block this function if the child's stdin pipe buffer fills
    // before it begins reading.
    if let Some(mut stdin) = child.stdin.take() {
        let prompt_bytes = prompt.as_bytes().to_vec();
        std::thread::spawn(move || {
            use std::io::Write;
            if let Err(e) = stdin.write_all(&prompt_bytes) {
                safe_eprintln!("[claude] Failed to write prompt to stdin: {}", e);
            }
            // Drop stdin to send EOF so Claude knows the prompt is complete.
        });
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    // Capture stderr into a shared buffer so the stdout reader can surface errors
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sid_for_stderr = session_id.clone();
        let buf = stderr_buf.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!(
                    "[claude:stderr:{}] {}",
                    &sid_for_stderr[..8.min(sid_for_stderr.len())],
                    line
                );
                match buf.lock() {
                    Ok(mut b) => {
                        if b.len() < 4000 {
                            if !b.is_empty() {
                                b.push('\n');
                            }
                            b.push_str(&line);
                        }
                    }
                    Err(e) => safe_eprintln!("[claude] Stderr buffer lock poisoned: {}", e),
                }
            }
        });
    }

    let gen = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let sid = session_id.clone();
    let handle = app_handle.clone();
    let instances_clone = instances.clone();

    std::thread::spawn(move || {
        safe_eprintln!("[claude] Reader thread started for {} (gen {})", sid, gen);
        let reader = std::io::BufReader::new(stdout);
        let mut had_output = false;
        for line in reader.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    had_output = true;
                    let data = cap_event_size(line);
                    if let Err(e) = handle.emit(
                        "claude-event",
                        ClaudeEvent {
                            session_id: sid.clone(),
                            data,
                        },
                    ) {
                        safe_eprintln!("[claude] Failed to emit claude-event for {}: {}", sid, e);
                    }
                }
                Err(e) => {
                    safe_eprintln!("[claude] Reader error: {} for {}", e, sid);
                    break;
                }
            }
        }
        // If process produced no stdout, it likely failed — surface stderr as an error
        if !had_output {
            // Brief wait for stderr thread to finish capturing
            std::thread::sleep(std::time::Duration::from_millis(150));
            let stderr_msg = stderr_buf.lock().map(|s| s.clone()).unwrap_or_default();
            let error_msg = if stderr_msg.is_empty() {
                "Claude process exited without output. The session may not exist or the CLI may not be installed.".to_string()
            } else if stderr_rejects_session_id_flag(&stderr_msg) {
                // A stricter/older CLI rejected the pre-generated `--session-id`
                // flag. Frontends can fall back to the existing capture-from-
                // `system/init` path by re-spawning without it; surface a
                // typed error string so they can detect the condition.
                format!(
                    "claude_cli_rejects_session_id: {}. Update the claude CLI or remove `--session-id` from build_command().",
                    stderr_msg.trim()
                )
            } else {
                stderr_msg
            };
            safe_eprintln!(
                "[claude] No stdout output for {} — emitting error: {}",
                sid,
                &error_msg[..error_msg.len().min(200)]
            );
            if let Err(e) = handle.emit(
                "claude-event",
                ClaudeEvent {
                    session_id: sid.clone(),
                    data: serde_json::json!({
                        "type": "result",
                        "subtype": "error",
                        "is_error": true,
                        "result": error_msg
                    })
                    .to_string(),
                },
            ) {
                safe_eprintln!("[claude] Failed to emit error event for {}: {}", sid, e);
            }
        }
        safe_eprintln!("[claude] Reader thread ended for {} (gen {})", sid, gen);
        // Only clean up and emit claude-done if this is still the current generation.
        // A newer generation means the session was re-spawned — emitting claude-done
        // from a stale reader would incorrectly flip isStreaming to false in the frontend.
        let is_current = if let Ok(mut inst) = instances_clone.lock() {
            if let Some(instance) = inst.get(&sid) {
                if instance.generation == gen {
                    inst.remove(&sid);
                    true
                } else {
                    safe_eprintln!("[claude] Stale reader gen {} != current gen {} for {} — skipping claude-done", gen, instance.generation, sid);
                    false
                }
            } else {
                true // instance already removed, we're the last one
            }
        } else {
            true // lock failed, emit anyway to avoid silent hangs
        };
        if is_current {
            if let Err(e) = handle.emit(
                "claude-done",
                ClaudeDone {
                    session_id: sid.clone(),
                },
            ) {
                safe_eprintln!("[claude] Failed to emit claude-done for {}: {}", sid, e);
            }
        }
    });

    instances.lock().map_err(|e| e.to_string())?.insert(
        session_id,
        ClaudeInstance {
            child,
            generation: gen,
        },
    );

    Ok(())
}

impl ClaudeManager {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(
        &self,
        app_handle: &AppHandle,
        req: CreateClaudeRequest,
        settings_path: Option<String>,
        approver_mcp_config: Option<String>,
        channel_server: Option<String>,
    ) -> Result<String, String> {
        // Pre-generate the session UUID before spawning Claude CLI. The
        // frontend normally supplies one (crypto-grade via `uuid` crate in
        // the browser); if it didn't, mint one locally so the JSONL path
        // and `--session-id` flag agree from the first byte. Returning the
        // resolved UUID lets callers avoid waiting on the first
        // `system/init` event to learn what session they got.
        let resolved_id = resolve_session_id(&req.session_id);
        safe_eprintln!(
            "[claude] Creating session id={} (provided={:?}) cwd={} mcp_config={:?}",
            resolved_id,
            if req.session_id == resolved_id {
                "as-is"
            } else {
                "regenerated"
            },
            req.cwd,
            req.mcp_config.as_deref().map(|s| &s[..s.len().min(80)])
        );
        let cmd = build_command(
            "--session-id",
            &resolved_id,
            &req.prompt,
            &req.permission_mode,
            &req.model,
            &req.effort,
            &req.cwd,
            &None,
            &settings_path,
            &channel_server,
            &req.mcp_config,
            &approver_mcp_config,
            &None,
            &req.max_turns,
            &req.max_budget_usd,
            &req.no_session_persistence,
            &None,
        );
        let cwd = req.cwd.clone();
        let prompt = req.prompt.clone();
        spawn_and_stream(
            &self.instances,
            app_handle,
            resolved_id.clone(),
            &cwd,
            cmd,
            &prompt,
        )?;
        Ok(resolved_id)
    }

    pub fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: SendClaudePromptRequest,
        settings_path: Option<String>,
        approver_mcp_config: Option<String>,
        channel_server: Option<String>,
    ) -> Result<(), String> {
        safe_eprintln!(
            "[claude] Sending prompt to session {} (cwd: {}) resume_session_at={:?}",
            req.session_id,
            req.cwd,
            req.resume_session_at
        );
        let cmd = build_command(
            "--resume",
            &req.session_id,
            &req.prompt,
            &req.permission_mode,
            &req.model,
            &req.effort,
            &req.cwd,
            &req.disallowed_tools,
            &settings_path,
            &channel_server,
            &None,
            &approver_mcp_config,
            &req.resume_session_at,
            &req.max_turns,
            &req.max_budget_usd,
            &req.no_session_persistence,
            &req.fork_session,
        );
        spawn_and_stream(
            &self.instances,
            app_handle,
            req.session_id,
            &req.cwd,
            cmd,
            &req.prompt,
        )
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = instances.get_mut(session_id) {
            // Kill but don't remove — spawn_and_stream will find the dead instance,
            // remove it, and wait for file locks to release before spawning a new one.
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            safe_eprintln!("[claude] Cancelled session {}", session_id);
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        self.cancel(session_id)
    }
}

// ── OpenWolf integration ───────────────────────────────────

/// Resolve the openwolf CLI binary path, similar to resolve_claude_path.
/// Cached after first lookup to avoid shelling out `which` on every prompt.
pub fn resolve_openwolf_path() -> String {
    static CACHED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHED.get_or_init(resolve_openwolf_path_inner).clone()
}

/// PATH that includes common locations for node, npm, pm2.
pub fn openwolf_env_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        format!(
            "{appdata}\\npm;{home}\\.cargo\\bin;{home}\\.npm-global;{localappdata}\\Programs\\nodejs;{program_files}\\nodejs;{existing}"
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        format!(
            "/opt/homebrew/bin:/usr/local/bin:{home}/.cargo/bin:{home}/.npm-global/bin:/opt/homebrew/lib/node_modules/.bin:{existing}"
        )
    }
}

fn resolve_openwolf_path_inner() -> String {
    // Bare name on Windows so `where` uses PATHEXT to find .cmd shims.
    let lookup = {
        let (cmd, arg) = if cfg!(windows) {
            ("where", "openwolf")
        } else {
            ("which", "openwolf")
        };
        let mut c = std::process::Command::new(cmd);
        c.arg(arg)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
        }
        c.output()
    };
    if let Ok(p) = lookup {
        if p.status.success() {
            let s = String::from_utf8_lossy(&p.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();

    let mut candidates: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok();
        if let Some(ref a) = appdata {
            candidates.push(format!("{}\\npm\\openwolf.cmd", a));
            candidates.push(format!("{}\\npm\\openwolf.exe", a));
        }
        if let Some(ref h) = home {
            candidates.push(format!("{}\\.npm-global\\openwolf.cmd", h));
            let npx_dir = format!("{}\\AppData\\Local\\npm-cache\\_npx", h);
            if let Ok(entries) = std::fs::read_dir(&npx_dir) {
                for entry in entries.flatten() {
                    let bin = entry
                        .path()
                        .join("node_modules")
                        .join(".bin")
                        .join("openwolf.cmd");
                    if bin.exists() {
                        candidates.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(ref h) = home {
            candidates.push(format!("{}/.local/bin/openwolf", h));
            candidates.push(format!("{}/.npm-global/bin/openwolf", h));
            let npx_dir = format!("{}/.npm/_npx", h);
            if let Ok(entries) = std::fs::read_dir(&npx_dir) {
                for entry in entries.flatten() {
                    let bin = entry
                        .path()
                        .join("node_modules")
                        .join(".bin")
                        .join("openwolf");
                    if bin.exists() {
                        candidates.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
        candidates.push("/usr/local/bin/openwolf".to_string());
        candidates.push("/opt/homebrew/bin/openwolf".to_string());
    }

    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }

    #[cfg(target_os = "windows")]
    return "openwolf.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "openwolf".to_string();
}

/// Check if .wolf/ exists in the project CWD. If auto_init is true
/// and .wolf/ is missing, run `openwolf init` to create it.
/// Returns true if .wolf/ exists (or was just created).
pub fn ensure_openwolf(cwd: &str, auto_init: bool) -> bool {
    let wolf_dir = std::path::Path::new(cwd).join(".wolf");
    if wolf_dir.is_dir() {
        return true;
    }

    if !auto_init {
        safe_eprintln!(
            "[openwolf] .wolf/ not found in {} and auto-init disabled",
            cwd
        );
        return false;
    }

    safe_eprintln!("[openwolf] .wolf/ not found in {} — running init", cwd);
    let wolf_bin = resolve_openwolf_path();
    let mut cmd = shim_command(&wolf_bin);
    cmd.arg("init")
        .current_dir(cwd)
        .env("PATH", openwolf_env_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                safe_eprintln!("[openwolf] Init succeeded in {}", cwd);
                true
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                safe_eprintln!("[openwolf] Init failed: {}", stderr.trim());
                false
            }
        }
        Err(e) => {
            safe_eprintln!("[openwolf] Failed to run openwolf init: {}", e);
            false
        }
    }
}

/// OpenWolf hook entries matching the upstream spec in
/// `openwolf/src/cli/init.ts` (HOOK_SETTINGS). Uses `$CLAUDE_PROJECT_DIR`
/// so hooks resolve correctly even if CWD changes mid-session.
/// `_design_qc` is kept for signature compatibility but no longer gates
/// PreToolUse/PostToolUse — those always register when OpenWolf is enabled.
fn openwolf_hook_entries(_cwd: &str, _design_qc: bool) -> Vec<(&'static str, serde_json::Value)> {
    let mk = |script: &str, timeout: u64| {
        serde_json::json!({
            "type": "command",
            "command": format!("node \"$CLAUDE_PROJECT_DIR/.wolf/hooks/{}\"", script),
            "timeout": timeout,
        })
    };

    vec![
        (
            "SessionStart",
            serde_json::json!({
                "matcher": "",
                "hooks": [mk("session-start.js", 5)]
            }),
        ),
        (
            "PreToolUse",
            serde_json::json!({
                "matcher": "Read",
                "hooks": [mk("pre-read.js", 5)]
            }),
        ),
        (
            "PreToolUse",
            serde_json::json!({
                "matcher": "Write|Edit|MultiEdit",
                "hooks": [mk("pre-write.js", 5)]
            }),
        ),
        (
            "PostToolUse",
            serde_json::json!({
                "matcher": "Read",
                "hooks": [mk("post-read.js", 5)]
            }),
        ),
        (
            "PostToolUse",
            serde_json::json!({
                "matcher": "Write|Edit|MultiEdit",
                "hooks": [mk("post-write.js", 10)]
            }),
        ),
        (
            "Stop",
            serde_json::json!({
                "matcher": "",
                "hooks": [mk("stop.js", 10)]
            }),
        ),
    ]
}

/// Merge OpenWolf hook entries into an existing settings JSON file.
/// Reads the file, adds OpenWolf hooks alongside T64's existing hooks
/// (combining arrays, not overwriting), and writes back.
pub fn merge_openwolf_hooks(settings_path: &str, cwd: &str, design_qc: bool) -> Result<(), String> {
    let content =
        std::fs::read_to_string(settings_path).map_err(|e| format!("read settings: {}", e))?;
    let mut settings: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse settings: {}", e))?;

    let hooks_obj = settings
        .as_object_mut()
        .ok_or("settings not an object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let hooks_map = hooks_obj.as_object_mut().ok_or("hooks not an object")?;

    let is_openwolf_entry = |entry: &serde_json::Value| -> bool {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| {
                hooks.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|s| s.contains(".wolf/hooks/") || s.contains("openwolf hook"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    };

    let desired = openwolf_hook_entries(cwd, design_qc);
    let mut desired_grouped: std::collections::HashMap<&'static str, Vec<&serde_json::Value>> =
        std::collections::HashMap::new();
    for (event, entry) in &desired {
        desired_grouped.entry(*event).or_default().push(entry);
    }

    // Equality check using refs (no clones). Rewrite only if the current set
    // of openwolf entries differs from desired.
    let already_correct = desired_grouped.iter().all(|(k, desired_vec)| {
        hooks_map
            .get(*k)
            .and_then(|v| v.as_array())
            .map(|arr| {
                let cur: Vec<&serde_json::Value> =
                    arr.iter().filter(|e| is_openwolf_entry(e)).collect();
                cur.len() == desired_vec.len()
                    && cur.iter().zip(desired_vec.iter()).all(|(a, b)| a == b)
            })
            .unwrap_or(false)
    }) && hooks_map.iter().all(|(k, v)| {
        let has_ow = v
            .as_array()
            .map(|arr| arr.iter().any(is_openwolf_entry))
            .unwrap_or(false);
        !has_ow || desired_grouped.contains_key(k.as_str())
    });

    if already_correct {
        return Ok(());
    }

    for (_event, arr_val) in hooks_map.iter_mut() {
        if let Some(arr) = arr_val.as_array_mut() {
            arr.retain(|e| !is_openwolf_entry(e));
        }
    }

    for (event_name, entry) in desired {
        let arr = hooks_map
            .entry(event_name)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(existing) = arr.as_array_mut() {
            existing.push(entry);
        }
    }

    let settings_json =
        serde_json::to_string(&settings).map_err(|e| format!("serialize settings: {}", e))?;
    std::fs::write(settings_path, settings_json).map_err(|e| format!("write settings: {}", e))?;

    safe_eprintln!("[openwolf] Merged hooks into {}", settings_path);
    Ok(())
}
