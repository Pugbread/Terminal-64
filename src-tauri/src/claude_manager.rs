use crate::types::*;
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub fn resolve_claude_path() -> String {
    // Try the platform-appropriate PATH lookup (GUI apps often have a limited PATH)
    let lookup = {
        let (cmd, arg) = if cfg!(windows) { ("where", "claude.exe") } else { ("which", "claude") };
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
    "claude".to_string()
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

fn build_command(
    session_flag: &str,
    session_value: &str,
    prompt: &str,
    permission_mode: &str,
    model: &Option<String>,
    effort: &Option<String>,
    cwd: &str,
    disallowed_tools: &Option<String>,
    settings_path: &Option<String>,
    channel_server: &Option<String>,
    mcp_config: &Option<String>,
) -> Command {
    let claude_bin = resolve_claude_path();
    let mut cmd = Command::new(&claude_bin);
    cmd.arg("--print")
        .arg("--output-format").arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg(session_flag).arg(session_value);

    // Safe tools that should never require permission
    const SAFE_TOOLS: &str = "Read,Glob,Grep,LS,WebSearch,WebFetch,TodoRead,TodoWrite,Agent,EnterPlanMode,ExitPlanMode,TaskCreate,TaskUpdate,TaskGet,TaskList,TaskStop,ToolSearch";

    match permission_mode {
        "bypass_all" => { cmd.arg("--permission-mode").arg("bypassPermissions"); }
        "accept_edits" => {
            cmd.arg("--permission-mode").arg("acceptEdits");
            cmd.arg("--allowedTools").arg(SAFE_TOOLS);
        }
        "plan" => {
            cmd.arg("--permission-mode").arg("plan");
            cmd.arg("--allowedTools").arg(SAFE_TOOLS);
        }
        "auto" => {
            cmd.arg("--permission-mode").arg("auto");
            cmd.arg("--allowedTools").arg(SAFE_TOOLS);
        }
        _ => {
            // Default mode: ask for writes/bash, but reads are always free
            cmd.arg("--permission-mode").arg("default");
            cmd.arg("--allowedTools").arg(SAFE_TOOLS);
        }
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

    // Prompt must be the last positional argument, after all flags
    cmd.arg(prompt);

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    cmd
}

fn spawn_and_stream(
    instances: &Arc<Mutex<HashMap<String, ClaudeInstance>>>,
    app_handle: &AppHandle,
    session_id: String,
    mut cmd: Command,
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
                if let Ok(mut b) = buf.lock() {
                    if b.len() < 4000 {
                        if !b.is_empty() { b.push('\n'); }
                        b.push_str(&line);
                    }
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
        // Debug: write mcp_config to temp file for diagnosis
        let _ = std::fs::write("/tmp/t64-rust-debug.log", format!(
            "create_session: id={} mcp_config={:?}\n", req.session_id, req.mcp_config
        ));
        let cmd = build_command(
            "--session-id", &req.session_id, &req.prompt,
            &req.permission_mode, &req.model, &req.effort, &req.cwd, &None, &settings_path, &channel_server, &req.mcp_config,
        );
        spawn_and_stream(&self.instances, app_handle, req.session_id, cmd)
    }

    pub fn send_prompt(&self, app_handle: &AppHandle, req: SendClaudePromptRequest, settings_path: Option<String>, channel_server: Option<String>) -> Result<(), String> {
        safe_eprintln!("[claude] Sending prompt to session {} (cwd: {})", req.session_id, req.cwd);
        let cmd = build_command(
            "--resume", &req.session_id, &req.prompt,
            &req.permission_mode, &req.model, &req.effort, &req.cwd, &req.disallowed_tools, &settings_path, &channel_server, &None,
        );
        spawn_and_stream(&self.instances, app_handle, req.session_id, cmd)
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
