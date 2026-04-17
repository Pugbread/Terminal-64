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
        let (cmd, arg) = if cfg!(windows) { ("where", "claude") } else { ("which", "claude") };
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
                .lines().next().unwrap_or("").trim().to_string();
            if !s.is_empty() { return s; }
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
        if std::path::Path::new(c).exists() { return c.clone(); }
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
    resume_session_at: &Option<String>,
    max_turns: &Option<u32>,
    max_budget_usd: &Option<f64>,
    no_session_persistence: &Option<bool>,
    fork_session: &Option<String>,
) -> Command {
    let claude_bin = resolve_claude_path();
    let mut cmd = shim_command(&claude_bin);
    cmd.arg("--print")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg(session_flag).arg(session_value);

    match permission_mode {
        "bypass_all" => { cmd.arg("--permission-mode").arg("bypassPermissions"); }
        "accept_edits" => { cmd.arg("--permission-mode").arg("acceptEdits"); }
        "plan" => { cmd.arg("--permission-mode").arg("plan"); }
        "auto" => { cmd.arg("--permission-mode").arg("auto"); }
        _ => { cmd.arg("--permission-mode").arg("default"); }
    }

    if let Some(m) = model {
        if !m.is_empty() { cmd.arg("--model").arg(m); }
    }
    if let Some(e) = effort {
        if !e.is_empty() { cmd.arg("--effort").arg(e); }
    }
    if let Some(dt) = disallowed_tools {
        if !dt.is_empty() { cmd.arg("--disallowed-tools").arg(dt); }
    }
    if let Some(sp) = settings_path {
        if !sp.is_empty() { cmd.arg("--settings").arg(sp); }
    }
    if let Some(ch) = channel_server {
        if !ch.is_empty() {
            cmd.arg("--dangerously-load-development-channels").arg(format!("server:{}", ch));
        }
    }
    if !cwd.is_empty() && cwd != "." { cmd.current_dir(cwd); }
    if let Some(mc) = mcp_config {
        if !mc.is_empty() {
            cmd.arg("--mcp-config").arg(mc);
            cmd.arg("--strict-mcp-config");
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
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::piped());

    cmd
}

fn spawn_and_stream(
    instances: &Arc<Mutex<HashMap<String, ClaudeInstance>>>,
    app_handle: &AppHandle,
    session_id: String,
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

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn claude: {}", e))?;

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
            for line in reader.lines().flatten() {
                safe_eprintln!("[claude:stderr:{}] {}", &sid_for_stderr[..8.min(sid_for_stderr.len())], line);
                match buf.lock() {
                    Ok(mut b) => {
                        if b.len() < 4000 {
                            if !b.is_empty() { b.push('\n'); }
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
                    if let Err(e) = handle.emit("claude-event", ClaudeEvent {
                        session_id: sid.clone(),
                        data: line,
                    }) {
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
            } else {
                stderr_msg
            };
            safe_eprintln!("[claude] No stdout output for {} — emitting error: {}", sid, &error_msg[..error_msg.len().min(200)]);
            if let Err(e) = handle.emit("claude-event", ClaudeEvent {
                session_id: sid.clone(),
                data: serde_json::json!({
                    "type": "result",
                    "subtype": "error",
                    "is_error": true,
                    "result": error_msg
                }).to_string(),
            }) {
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
            if let Err(e) = handle.emit("claude-done", ClaudeDone { session_id: sid.clone() }) {
                safe_eprintln!("[claude] Failed to emit claude-done for {}: {}", sid, e);
            }
        }
    });

    instances.lock().map_err(|e| e.to_string())?
        .insert(session_id, ClaudeInstance { child, generation: gen });

    Ok(())
}

impl ClaudeManager {
    pub fn new() -> Self {
        Self { instances: Arc::new(Mutex::new(HashMap::new())) }
    }


    pub fn create_session(&self, app_handle: &AppHandle, req: CreateClaudeRequest, settings_path: Option<String>, channel_server: Option<String>) -> Result<(), String> {
        safe_eprintln!("[claude] Creating session id={} cwd={} mcp_config={:?}", req.session_id, req.cwd, req.mcp_config.as_deref().map(|s| &s[..s.len().min(80)]));
        let cmd = build_command(
            "--session-id", &req.session_id, &req.prompt,
            &req.permission_mode, &req.model, &req.effort, &req.cwd, &None, &settings_path, &channel_server, &req.mcp_config, &None,
            &req.max_turns, &req.max_budget_usd, &req.no_session_persistence, &None,
        );
        spawn_and_stream(&self.instances, app_handle, req.session_id, cmd, &req.prompt)
    }

    pub fn send_prompt(&self, app_handle: &AppHandle, req: SendClaudePromptRequest, settings_path: Option<String>, channel_server: Option<String>) -> Result<(), String> {
        safe_eprintln!("[claude] Sending prompt to session {} (cwd: {}) resume_session_at={:?}", req.session_id, req.cwd, req.resume_session_at);
        let cmd = build_command(
            "--resume", &req.session_id, &req.prompt,
            &req.permission_mode, &req.model, &req.effort, &req.cwd, &req.disallowed_tools, &settings_path, &channel_server, &None, &req.resume_session_at,
            &req.max_turns, &req.max_budget_usd, &req.no_session_persistence, &req.fork_session,
        );
        spawn_and_stream(&self.instances, app_handle, req.session_id, cmd, &req.prompt)
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
    return CACHED.get_or_init(resolve_openwolf_path_inner).clone();
}

/// PATH that includes common locations for node, npm, pm2.
pub fn openwolf_env_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let localappdata = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        return format!(
            "{appdata}\\npm;{home}\\.cargo\\bin;{home}\\.npm-global;{localappdata}\\Programs\\nodejs;{program_files}\\nodejs;{existing}"
        );
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
        let (cmd, arg) = if cfg!(windows) { ("where", "openwolf") } else { ("which", "openwolf") };
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
                .lines().next().unwrap_or("").trim().to_string();
            if !s.is_empty() { return s; }
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
                    let bin = entry.path().join("node_modules").join(".bin").join("openwolf.cmd");
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
                    let bin = entry.path().join("node_modules").join(".bin").join("openwolf");
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
        if std::path::Path::new(c).exists() { return c.clone(); }
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
        safe_eprintln!("[openwolf] .wolf/ not found in {} and auto-init disabled", cwd);
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

/// OpenWolf's 6 hook event types and their command-line hook configurations.
/// Each returns a (event_name, hook_entry) pair for the settings JSON.
fn openwolf_hook_entries(cwd: &str, design_qc: bool) -> Vec<(&'static str, serde_json::Value)> {
    let wolf_bin = resolve_openwolf_path();
    let q = |s: &str| {
        if s.contains(' ') || s.contains('\t') {
            format!("\"{}\"", s.replace('"', "\\\""))
        } else {
            s.to_string()
        }
    };
    let bin_q = q(&wolf_bin);
    let cwd_q = q(cwd);
    let mk = |event: &str| format!("{} hook {} --cwd {}", bin_q, event, cwd_q);
    let mut hooks = vec![
        ("Notification", serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": mk("notification") }]
        })),
        ("Stop", serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": mk("stop") }]
        })),
        ("SubagentStart", serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": mk("subagent-start") }]
        })),
        ("SubagentStop", serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": mk("subagent-stop") }]
        })),
    ];

    if design_qc {
        hooks.push(("PreToolUse", serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": mk("pre-tool-use") }]
        })));
        hooks.push(("PostToolUse", serde_json::json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": mk("post-tool-use") }]
        })));
    }

    hooks
}

/// Merge OpenWolf hook entries into an existing settings JSON file.
/// Reads the file, adds OpenWolf hooks alongside T64's existing hooks
/// (combining arrays, not overwriting), and writes back.
pub fn merge_openwolf_hooks(settings_path: &str, cwd: &str, design_qc: bool) -> Result<(), String> {
    let content = std::fs::read_to_string(settings_path)
        .map_err(|e| format!("read settings: {}", e))?;
    let mut settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse settings: {}", e))?;

    let hooks_obj = settings
        .as_object_mut()
        .ok_or("settings not an object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let hooks_map = hooks_obj.as_object_mut().ok_or("hooks not an object")?;

    let mut modified = false;
    for (event_name, entry) in openwolf_hook_entries(cwd, design_qc) {
        let arr = hooks_map
            .entry(event_name)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(existing) = arr.as_array_mut() {
            let already_has = existing.iter().any(|e| {
                e.get("hooks")
                    .and_then(|h| h.as_array())
                    .map(|hooks| hooks.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|s| s.contains("openwolf"))
                            .unwrap_or(false)
                    }))
                    .unwrap_or(false)
            });
            if !already_has {
                existing.push(entry);
                modified = true;
            }
        }
    }

    if !modified { return Ok(()); }

    std::fs::write(settings_path, serde_json::to_string(&settings).unwrap())
        .map_err(|e| format!("write settings: {}", e))?;

    safe_eprintln!("[openwolf] Merged hooks into {}", settings_path);
    Ok(())
}
