//! `CodexAdapter` — OpenAI Codex CLI-backed implementation of `ProviderAdapter`.
//!
//! The primary path uses `codex app-server --listen stdio://`, speaks the
//! JSON-RPC app-server protocol, and translates rich app-server notifications
//! back into Terminal 64's existing `codex-event` surface. The legacy
//! `codex exec --json` adapter is retained as a fallback via
//! `T64_CODEX_TRANSPORT=exec`.
//!
//! Supported flags (mapped from CreateCodexRequest / SendCodexPromptRequest):
//!   -m/--model <id>                                  → req.model
//!   -s/--sandbox {read-only|workspace-write|...}     → req.sandbox_mode
//!   --full-auto                                      → req.full_auto
//!   --dangerously-bypass-approvals-and-sandbox       → req.yolo
//!   --skip-git-repo-check                            → req.skip_git_repo_check
//!   -c approval_policy=<v>                           → req.approval_policy
//!   -c model_reasoning_effort=<v>                    → req.effort
//!   -C <cwd>                                         → req.cwd
//!
//! For Step 1 of the Codex port, multi-turn lives entirely in the CLI:
//! `codex exec resume <thread_id> ...` re-attaches to a prior session.
//! The frontend captures `thread.started.thread_id` from the first event
//! and stores it as the session's external id; subsequent prompts go
//! through `send_prompt` which uses the resume subcommand.

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::providers::events::ProviderEvent;
use crate::providers::traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderApprovalDecision,
    ProviderKind, ProviderSendTurnInput, ProviderSession, ProviderSessionModelSwitchMode,
    ProviderSessionStartInput, ProviderThreadSnapshot, ProviderTurnStartResult,
    ProviderUserInputAnswers,
};
use crate::providers::util::{cap_event_size, expanded_tool_path, shim_command};
use crate::types::{
    CodexDone, CodexEvent, CreateCodexRequest, DiskSession, HistoryMessage, HistoryToolCall,
    SendCodexPromptRequest,
};

// ── Binary discovery ───────────────────────────────────────

pub fn resolve_codex_path() -> String {
    let lookup = {
        let (cmd, arg) = if cfg!(windows) {
            ("where", "codex")
        } else {
            ("which", "codex")
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
    if cfg!(windows) {
        if let Some(ref h) = home {
            candidates.push(format!("{}\\.local\\bin\\codex.exe", h));
            candidates.push(format!("{}\\.local\\bin\\codex.cmd", h));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(format!("{}\\npm\\codex.cmd", appdata));
            candidates.push(format!("{}\\npm\\codex.exe", appdata));
        }
    } else {
        if let Some(ref h) = home {
            candidates.push(format!("{}/.local/bin/codex", h));
            candidates.push(format!("{}/.npm-global/bin/codex", h));
        }
        candidates.push("/usr/local/bin/codex".to_string());
        candidates.push("/opt/homebrew/bin/codex".to_string());
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    #[cfg(target_os = "windows")]
    return "codex.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "codex".to_string();
}

// ── Session state + command builder ────────────────────────

struct CodexInstance {
    child: Child,
    generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
enum InvokeMode<'a> {
    /// Fresh session — `codex exec --json [prompt]`.
    Fresh,
    /// Resume an existing session — `codex exec resume <id> --json [prompt]`.
    Resume(&'a str),
}

#[allow(clippy::too_many_arguments)]
fn build_command(
    mode: InvokeMode<'_>,
    cwd: &str,
    prompt: &str,
    sandbox_mode: &Option<String>,
    approval_policy: &Option<String>,
    model: &Option<String>,
    effort: &Option<String>,
    full_auto: bool,
    yolo: bool,
    skip_git_repo_check: bool,
    mcp_env: &Option<HashMap<String, String>>,
) -> Command {
    let codex_bin = resolve_codex_path();
    let mut cmd = shim_command(&codex_bin);

    // `-C, --cd` is a TOP-LEVEL codex flag (not an `exec` flag) — it must be
    // emitted before any subcommand. It's also the only way to set cwd for
    // `codex exec resume`, which does not accept -C.
    if !cwd.is_empty() && cwd != "." {
        cmd.arg("-C").arg(cwd);
        cmd.current_dir(cwd); // belt + suspenders
    }

    cmd.arg("exec");
    if matches!(mode, InvokeMode::Resume(_)) {
        cmd.arg("resume");
    }

    cmd.arg("--json");
    if skip_git_repo_check {
        cmd.arg("--skip-git-repo-check");
    }

    // Sandbox flag and the convenience presets are mutually exclusive in the
    // CLI: `--full-auto` and `--yolo` already imply a sandbox choice.
    // Extra wrinkle: `codex exec resume` does NOT accept `-s`, so we translate
    // to `-c sandbox_mode=<value>` (a generic config override that DOES work
    // on resume).
    if yolo {
        cmd.arg("--dangerously-bypass-approvals-and-sandbox");
    } else if full_auto {
        cmd.arg("--full-auto");
    } else if let Some(s) = sandbox_mode {
        if !s.is_empty() {
            match mode {
                InvokeMode::Fresh => {
                    cmd.arg("-s").arg(s);
                }
                InvokeMode::Resume(_) => {
                    cmd.arg("-c").arg(format!("sandbox_mode={}", s));
                }
            }
        }
    }

    if !yolo && !full_auto {
        if let Some(p) = approval_policy {
            if !p.is_empty() {
                cmd.arg("-c").arg(format!("approval_policy={}", p));
            }
        }
    }

    if let Some(m) = model {
        if !m.is_empty() {
            cmd.arg("-m").arg(m);
        }
    }

    if let Some(e) = effort {
        if !e.is_empty() {
            cmd.arg("-c").arg(format!("model_reasoning_effort={}", e));
        }
    }

    // Positional args come last, in the order the CLI expects:
    //   Fresh:   codex exec [OPTIONS] [PROMPT]
    //   Resume:  codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
    // NB: on Windows when shim_command routes through cmd.exe, embedded
    // newlines may be truncated. Same caveat as the Claude adapter; accepted
    // for Step 1 since the most common case (single-line prompts) works on
    // all platforms.
    if let InvokeMode::Resume(thread_id) = mode {
        cmd.arg(thread_id);
    }
    cmd.arg(prompt);

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    cmd.env("PATH", expanded_tool_path());
    if let Some(env) = mcp_env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }
    cmd
}

fn codex_transport_is_exec() -> bool {
    std::env::var("T64_CODEX_TRANSPORT")
        .map(|v| v.eq_ignore_ascii_case("exec"))
        .unwrap_or(false)
}

fn build_app_server_command(cwd: &str, mcp_env: &Option<HashMap<String, String>>) -> Command {
    let codex_bin = resolve_codex_path();
    let mut cmd = shim_command(&codex_bin);
    if !cwd.is_empty() && cwd != "." {
        cmd.current_dir(cwd);
    }
    cmd.arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());
    cmd.env("PATH", expanded_tool_path());
    if let Some(env) = mcp_env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }
    cmd
}

fn app_server_sandbox(
    sandbox_mode: &Option<String>,
    full_auto: bool,
    yolo: bool,
) -> Option<String> {
    if yolo {
        Some("danger-full-access".to_string())
    } else if full_auto {
        Some("workspace-write".to_string())
    } else {
        sandbox_mode.clone().filter(|s| !s.is_empty())
    }
}

fn app_server_approval_policy(
    approval_policy: &Option<String>,
    full_auto: bool,
    yolo: bool,
) -> Option<String> {
    if yolo || full_auto {
        Some("never".to_string())
    } else {
        approval_policy.clone().filter(|s| !s.is_empty())
    }
}

#[allow(clippy::too_many_arguments)]
fn app_server_thread_params(
    cwd: &str,
    sandbox_mode: &Option<String>,
    approval_policy: &Option<String>,
    model: &Option<String>,
    effort: &Option<String>,
    full_auto: bool,
    yolo: bool,
) -> JsonValue {
    let mut params = serde_json::Map::new();
    if !cwd.is_empty() {
        params.insert("cwd".to_string(), json!(cwd));
    }
    if let Some(model) = model.as_ref().filter(|m| !m.is_empty()) {
        params.insert("model".to_string(), json!(model));
    }
    if let Some(effort) = effort.as_ref().filter(|e| !e.is_empty()) {
        params.insert(
            "config".to_string(),
            json!({ "model_reasoning_effort": effort }),
        );
    }
    if let Some(sandbox) = app_server_sandbox(sandbox_mode, full_auto, yolo) {
        params.insert("sandbox".to_string(), json!(sandbox));
    }
    if let Some(policy) = app_server_approval_policy(approval_policy, full_auto, yolo) {
        params.insert("approvalPolicy".to_string(), json!(policy));
    }
    params.insert("serviceName".to_string(), json!("terminal-64"));
    JsonValue::Object(params)
}

#[allow(clippy::too_many_arguments)]
fn app_server_turn_params(
    thread_id: &str,
    cwd: &str,
    prompt: &str,
    sandbox_mode: &Option<String>,
    approval_policy: &Option<String>,
    model: &Option<String>,
    effort: &Option<String>,
    full_auto: bool,
    yolo: bool,
) -> JsonValue {
    let mut params = match app_server_thread_params(
        cwd,
        sandbox_mode,
        approval_policy,
        model,
        effort,
        full_auto,
        yolo,
    ) {
        JsonValue::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert(
        "input".to_string(),
        json!([{ "type": "text", "text": prompt }]),
    );
    JsonValue::Object(params)
}

fn write_json_rpc(stdin: &mut std::process::ChildStdin, value: &JsonValue) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("codex app-server write: {}", e))
}

fn emit_codex_json(app_handle: &AppHandle, session_id: &str, value: JsonValue) {
    let data = cap_event_size(value.to_string());
    if let Err(e) = app_handle.emit(
        "codex-event",
        CodexEvent {
            session_id: session_id.to_string(),
            data,
        },
    ) {
        safe_eprintln!(
            "[codex:app-server] Failed to emit codex-event for {}: {}",
            session_id,
            e
        );
    }
}

fn emit_codex_error(app_handle: &AppHandle, session_id: &str, message: impl Into<String>) {
    emit_codex_json(
        app_handle,
        session_id,
        json!({
            "type": "error",
            "message": message.into(),
        }),
    );
}

fn get_json_str<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a str> {
    let mut cur = value;
    for key in path {
        cur = cur.get(*key)?;
    }
    cur.as_str()
}

fn normalize_codex_item(item: &JsonValue) -> JsonValue {
    let mut out = item.as_object().cloned().unwrap_or_default();
    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let normalized_type = match item_type {
        "agentMessage" => "agent_message",
        "commandExecution" => "command_execution",
        "fileChange" => "file_change",
        "mcpToolCall" => "mcp_tool_call",
        "collabToolCall" => "collab_tool_call",
        "webSearch" => "web_search",
        "userMessage" => "user_message",
        other => other,
    };
    out.insert("type".to_string(), json!(normalized_type));
    if let Some(v) = item.get("aggregatedOutput") {
        out.insert("output".to_string(), v.clone());
    }
    if let Some(v) = item.get("exitCode") {
        out.insert("exit_code".to_string(), v.clone());
    }
    if let Some(v) = item.get("tool") {
        out.insert("tool_name".to_string(), v.clone());
    }
    if normalized_type == "reasoning" {
        if let Some(summary) = item.get("summary").and_then(|v| v.as_array()) {
            let text = summary
                .iter()
                .filter_map(|part| part.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            if !text.is_empty() {
                out.insert("text".to_string(), json!(text));
            }
        }
    }
    JsonValue::Object(out)
}

fn app_server_notification_to_exec_event(method: &str, params: &JsonValue) -> Option<JsonValue> {
    match method {
        "thread/started" => {
            let thread_id = get_json_str(params, &["thread", "id"])?;
            Some(json!({
                "type": "thread.started",
                "thread_id": thread_id,
                "threadId": thread_id,
            }))
        }
        "turn/started" => Some(json!({ "type": "turn.started" })),
        "turn/completed" => {
            let mut out = json!({ "type": "turn.completed" });
            if let Some(usage) = params
                .get("usage")
                .or_else(|| params.get("turn").and_then(|t| t.get("usage")))
            {
                out["usage"] = usage.clone();
            }
            if let Some(msg) = get_json_str(params, &["turn", "error", "message"]) {
                out["error"] = json!({ "message": msg });
            }
            Some(out)
        }
        "error" => {
            let message = get_json_str(params, &["error", "message"])
                .or_else(|| get_json_str(params, &["message"]))
                .unwrap_or("Codex app-server error");
            Some(json!({ "type": "error", "message": message }))
        }
        "item/started" => {
            let item = params.get("item")?;
            Some(json!({
                "type": "item.started",
                "item": normalize_codex_item(item),
            }))
        }
        "item/completed" => {
            let item = params.get("item")?;
            Some(json!({
                "type": "item.completed",
                "item": normalize_codex_item(item),
            }))
        }
        "item/agentMessage/delta" => {
            let item_id = params.get("itemId").and_then(|v| v.as_str()).unwrap_or("");
            let delta = params.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            Some(json!({
                "type": "item.updated",
                "delta": delta,
                "item": {
                    "id": item_id,
                    "type": "agent_message",
                    "text": delta,
                },
            }))
        }
        _ => None,
    }
}

fn app_server_thread_id_from_response(value: &JsonValue) -> Option<String> {
    get_json_str(value, &["result", "thread", "id"]).map(|s| s.to_string())
}

fn run_app_server_request(cwd: &str, method: &str, params: JsonValue) -> Result<JsonValue, String> {
    let mut cmd = build_app_server_command(cwd, &None);
    safe_eprintln!(
        "[codex:app-server] rpc {} cwd={}",
        method,
        if cwd.is_empty() { "<empty>" } else { cwd }
    );
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex app-server: {}", e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Failed to capture app-server stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture app-server stdout")?;
    let mut reader = std::io::BufReader::new(stdout);

    write_json_rpc(
        &mut stdin,
        &json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "terminal_64",
                    "title": "Terminal 64",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": { "experimentalApi": true },
            },
        }),
    )?;
    write_json_rpc(
        &mut stdin,
        &json!({ "method": "initialized", "params": {} }),
    )?;
    write_json_rpc(
        &mut stdin,
        &json!({ "id": 2, "method": method, "params": params }),
    )?;

    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| format!("codex app-server read: {}", e))?;
        if read == 0 {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Codex app-server exited before responding".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: JsonValue = serde_json::from_str(trimmed)
            .map_err(|e| format!("codex app-server JSON parse: {}", e))?;
        if parsed.get("id").and_then(|v| v.as_i64()) != Some(2) {
            continue;
        }
        let _ = child.kill();
        let _ = child.wait();
        if let Some(msg) = get_json_str(&parsed, &["error", "message"]) {
            return Err(msg.to_string());
        }
        return Ok(parsed.get("result").cloned().unwrap_or_else(|| json!({})));
    }
}

fn spawn_and_stream(
    instances: &Arc<Mutex<HashMap<String, CodexInstance>>>,
    app_handle: &AppHandle,
    session_id: String,
    mut cmd: Command,
) -> Result<(), String> {
    {
        let mut inst = instances.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = inst.remove(&session_id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
            drop(inst);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    // Diagnostics: dump the full argv so we can compare against a working
    // shell invocation. The child inherits the Tauri app's environment which
    // on macOS GUI launches can be surprisingly sparse.
    {
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let cwd = cmd
            .get_current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "<inherited>".to_string());
        safe_eprintln!(
            "[codex] spawn argv for {}: {} {:?} (cwd={})",
            session_id,
            prog,
            args,
            cwd
        );
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sid_for_stderr = session_id.clone();
        let buf = stderr_buf.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!(
                    "[codex:stderr:{}] {}",
                    &sid_for_stderr[..8.min(sid_for_stderr.len())],
                    line
                );
                if let Ok(mut b) = buf.lock() {
                    if b.len() < 4000 {
                        if !b.is_empty() {
                            b.push('\n');
                        }
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
        safe_eprintln!("[codex] Reader thread started for {} (gen {})", sid, gen);
        let reader = std::io::BufReader::new(stdout);
        let mut had_output = false;
        for line in reader.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    had_output = true;
                    let data = cap_event_size(line);
                    if let Err(e) = handle.emit(
                        "codex-event",
                        CodexEvent {
                            session_id: sid.clone(),
                            data,
                        },
                    ) {
                        safe_eprintln!("[codex] Failed to emit codex-event for {}: {}", sid, e);
                    }
                }
                Err(e) => {
                    safe_eprintln!("[codex] Reader error: {} for {}", e, sid);
                    break;
                }
            }
        }
        if !had_output {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let stderr_msg = stderr_buf.lock().map(|s| s.clone()).unwrap_or_default();
            let error_msg = if stderr_msg.is_empty() {
                "Codex process exited without output. The CLI may not be installed (try `which codex`) or the prompt was rejected.".to_string()
            } else {
                stderr_msg
            };
            safe_eprintln!(
                "[codex] No stdout for {} — emitting error: {}",
                sid,
                &error_msg[..error_msg.len().min(200)]
            );
            if let Err(e) = handle.emit(
                "codex-event",
                CodexEvent {
                    session_id: sid.clone(),
                    data: serde_json::json!({
                        "type": "error",
                        "message": error_msg,
                    })
                    .to_string(),
                },
            ) {
                safe_eprintln!("[codex] Failed to emit error event for {}: {}", sid, e);
            }
        }
        // Wait on the child if it's still ours so we can log the exit status
        // — otherwise silent exits look identical to normal completion in
        // the logs.
        let exit_info = {
            let mut inst_g = match instances_clone.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match inst_g.get_mut(&sid) {
                Some(instance) if instance.generation == gen => match instance.child.try_wait() {
                    Ok(Some(status)) => format!("exit={:?}", status),
                    Ok(None) => {
                        drop(inst_g);
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        let mut again = match instances_clone.lock() {
                            Ok(g) => g,
                            Err(_) => return,
                        };
                        match again.get_mut(&sid) {
                            Some(i) => match i.child.wait() {
                                Ok(status) => format!("exit={:?}", status),
                                Err(e) => format!("wait-err={}", e),
                            },
                            None => "child-already-gone".to_string(),
                        }
                    }
                    Err(e) => format!("try_wait-err={}", e),
                },
                _ => "child-not-ours".to_string(),
            }
        };
        safe_eprintln!(
            "[codex] Reader thread ended for {} (gen {}) had_output={} {}",
            sid,
            gen,
            had_output,
            exit_info
        );
        let is_current = if let Ok(mut inst) = instances_clone.lock() {
            if let Some(instance) = inst.get(&sid) {
                if instance.generation == gen {
                    inst.remove(&sid);
                    true
                } else {
                    safe_eprintln!(
                        "[codex] Stale reader gen {} != current {} for {} — skipping codex-done",
                        gen,
                        instance.generation,
                        sid
                    );
                    false
                }
            } else {
                true
            }
        } else {
            true
        };
        if is_current {
            if let Err(e) = handle.emit(
                "codex-done",
                CodexDone {
                    session_id: sid.clone(),
                },
            ) {
                safe_eprintln!("[codex] Failed to emit codex-done for {}: {}", sid, e);
            }
        }
    });

    instances.lock().map_err(|e| e.to_string())?.insert(
        session_id,
        CodexInstance {
            child,
            generation: gen,
        },
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_app_server_turn(
    instances: &Arc<Mutex<HashMap<String, CodexInstance>>>,
    app_handle: &AppHandle,
    session_id: String,
    mode: InvokeMode<'_>,
    cwd: &str,
    prompt: &str,
    sandbox_mode: &Option<String>,
    approval_policy: &Option<String>,
    model: &Option<String>,
    effort: &Option<String>,
    full_auto: bool,
    yolo: bool,
    mcp_env: &Option<HashMap<String, String>>,
) -> Result<(), String> {
    {
        let mut inst = instances.lock().map_err(|e| e.to_string())?;
        if let Some(mut old) = inst.remove(&session_id) {
            let _ = old.child.kill();
            let _ = old.child.wait();
            drop(inst);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    let mut cmd = build_app_server_command(cwd, mcp_env);
    {
        let prog = cmd.get_program().to_string_lossy().to_string();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let cwd_display = cmd
            .get_current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "<inherited>".to_string());
        safe_eprintln!(
            "[codex:app-server] spawn argv for {}: {} {:?} (cwd={})",
            session_id,
            prog,
            args,
            cwd_display
        );
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn codex app-server: {}", e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Failed to capture app-server stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture app-server stdout")?;

    let stderr_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let sid_for_stderr = session_id.clone();
        let buf = stderr_buf.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                safe_eprintln!(
                    "[codex:app-server:stderr:{}] {}",
                    &sid_for_stderr[..8.min(sid_for_stderr.len())],
                    line
                );
                if let Ok(mut b) = buf.lock() {
                    if b.len() < 4000 {
                        if !b.is_empty() {
                            b.push('\n');
                        }
                        b.push_str(&line);
                    }
                }
            }
        });
    }

    let gen = GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    instances.lock().map_err(|e| e.to_string())?.insert(
        session_id.clone(),
        CodexInstance {
            child,
            generation: gen,
        },
    );

    let sid = session_id.clone();
    let handle = app_handle.clone();
    let instances_clone = instances.clone();
    let cwd_owned = cwd.to_string();
    let prompt_owned = prompt.to_string();
    let sandbox_mode = sandbox_mode.clone();
    let approval_policy = approval_policy.clone();
    let model = model.clone();
    let effort = effort.clone();
    let resume_thread_id = match mode {
        InvokeMode::Fresh => None,
        InvokeMode::Resume(thread_id) => Some(thread_id.to_string()),
    };

    std::thread::spawn(move || {
        safe_eprintln!(
            "[codex:app-server] Worker started for {} (gen {})",
            sid,
            gen
        );
        let mut reader = std::io::BufReader::new(stdout);

        let initialize = json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "terminal_64",
                    "title": "Terminal 64",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true,
                },
            },
        });
        let initialized = json!({ "method": "initialized", "params": {} });
        if let Err(e) = write_json_rpc(&mut stdin, &initialize)
            .and_then(|_| write_json_rpc(&mut stdin, &initialized))
        {
            emit_codex_error(&handle, &sid, e);
            finish_app_server_turn(&instances_clone, &handle, &sid, gen, true);
            return;
        }

        let thread_params = if let Some(thread_id) = resume_thread_id.as_ref() {
            let mut params = match app_server_thread_params(
                &cwd_owned,
                &sandbox_mode,
                &approval_policy,
                &model,
                &effort,
                full_auto,
                yolo,
            ) {
                JsonValue::Object(map) => map,
                _ => serde_json::Map::new(),
            };
            params.insert("threadId".to_string(), json!(thread_id));
            JsonValue::Object(params)
        } else {
            app_server_thread_params(
                &cwd_owned,
                &sandbox_mode,
                &approval_policy,
                &model,
                &effort,
                full_auto,
                yolo,
            )
        };
        let thread_method = if resume_thread_id.is_some() {
            "thread/resume"
        } else {
            "thread/start"
        };
        if let Err(e) = write_json_rpc(
            &mut stdin,
            &json!({ "id": 2, "method": thread_method, "params": thread_params }),
        ) {
            emit_codex_error(&handle, &sid, e);
            finish_app_server_turn(&instances_clone, &handle, &sid, gen, true);
            return;
        }

        let mut thread_id: Option<String> = None;
        let mut turn_started = false;
        let mut saw_output = false;
        let mut line = String::new();
        loop {
            line.clear();
            let read = match reader.read_line(&mut line) {
                Ok(n) => n,
                Err(e) => {
                    emit_codex_error(&handle, &sid, format!("codex app-server read: {}", e));
                    break;
                }
            };
            if read == 0 {
                if !saw_output {
                    let stderr_msg = stderr_buf.lock().map(|s| s.clone()).unwrap_or_default();
                    let msg = if stderr_msg.is_empty() {
                        "Codex app-server exited without output. Install a recent OpenAI Codex CLI or set T64_CODEX_TRANSPORT=exec to use the legacy transport.".to_string()
                    } else {
                        stderr_msg
                    };
                    emit_codex_error(&handle, &sid, msg);
                }
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            saw_output = true;
            let parsed: JsonValue = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    safe_eprintln!("[codex:app-server] JSON parse error for {}: {}", sid, e);
                    continue;
                }
            };

            if parsed.get("error").is_some() && parsed.get("id").is_some() {
                let msg = get_json_str(&parsed, &["error", "message"])
                    .unwrap_or("Codex app-server request failed");
                emit_codex_error(&handle, &sid, msg);
                break;
            }

            if parsed.get("id").and_then(|v| v.as_i64()) == Some(2) {
                thread_id = app_server_thread_id_from_response(&parsed);
                if let Some(tid) = thread_id.as_ref() {
                    emit_codex_json(
                        &handle,
                        &sid,
                        json!({
                            "type": "thread.started",
                            "thread_id": tid,
                            "threadId": tid,
                        }),
                    );
                    let turn_params = app_server_turn_params(
                        tid,
                        &cwd_owned,
                        &prompt_owned,
                        &sandbox_mode,
                        &approval_policy,
                        &model,
                        &effort,
                        full_auto,
                        yolo,
                    );
                    if let Err(e) = write_json_rpc(
                        &mut stdin,
                        &json!({ "id": 3, "method": "turn/start", "params": turn_params }),
                    ) {
                        emit_codex_error(&handle, &sid, e);
                        break;
                    }
                    turn_started = true;
                } else {
                    emit_codex_error(&handle, &sid, "Codex app-server did not return a thread id");
                    break;
                }
                continue;
            }

            if parsed.get("id").is_some() && parsed.get("method").is_some() {
                let request_id = parsed.get("id").cloned().unwrap_or(json!(null));
                let method = parsed.get("method").and_then(|v| v.as_str()).unwrap_or("");
                safe_eprintln!(
                    "[codex:app-server] Auto-declining unsupported server request {} for {}",
                    method,
                    sid
                );
                let _ = write_json_rpc(
                    &mut stdin,
                    &json!({
                        "id": request_id,
                        "result": { "decision": "decline" },
                    }),
                );
                continue;
            }

            if let Some(method) = parsed.get("method").and_then(|v| v.as_str()) {
                let params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));
                if let Some(event) = app_server_notification_to_exec_event(method, &params) {
                    emit_codex_json(&handle, &sid, event);
                }
                if method == "turn/completed" {
                    break;
                }
            }
        }

        if !turn_started && thread_id.is_none() {
            safe_eprintln!("[codex:app-server] Turn never started for {}", sid);
        }
        finish_app_server_turn(&instances_clone, &handle, &sid, gen, false);
    });

    Ok(())
}

fn finish_app_server_turn(
    instances: &Arc<Mutex<HashMap<String, CodexInstance>>>,
    app_handle: &AppHandle,
    session_id: &str,
    generation: u64,
    suppress_done: bool,
) {
    if let Ok(mut inst) = instances.lock() {
        if let Some(instance) = inst.get(session_id) {
            if instance.generation != generation {
                return;
            }
        }
        if let Some(mut instance) = inst.remove(session_id) {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
        }
    }
    if !suppress_done {
        if let Err(e) = app_handle.emit(
            "codex-done",
            CodexDone {
                session_id: session_id.to_string(),
            },
        ) {
            safe_eprintln!(
                "[codex:app-server] Failed to emit codex-done for {}: {}",
                session_id,
                e
            );
        }
    }
}

fn resolve_session_id(provided: &str) -> String {
    let trimmed = provided.trim();
    if trimmed.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        trimmed.to_string()
    }
}

// ── CodexAdapter ──────────────────────────────────────────

pub struct CodexAdapter {
    instances: Arc<Mutex<HashMap<String, CodexInstance>>>,
    #[allow(dead_code)]
    capabilities: ProviderAdapterCapabilities,
}

impl CodexAdapter {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            capabilities: ProviderAdapterCapabilities {
                session_model_switch: ProviderSessionModelSwitchMode::InSession,
            },
        }
    }

    /// Spawn a fresh `codex exec --json` process. Returns the local UUID we
    /// minted (or echoed back). The Codex CLI assigns its own thread id and
    /// emits it in the first `thread.started` event — the frontend should
    /// adopt that as the canonical id for follow-up `send_prompt` calls.
    pub fn create_session(
        &self,
        app_handle: &AppHandle,
        req: CreateCodexRequest,
    ) -> Result<String, String> {
        let resolved_id = resolve_session_id(&req.session_id);
        safe_eprintln!(
            "[codex] Creating session id={} cwd={} model={:?} sandbox={:?}",
            resolved_id,
            req.cwd,
            req.model,
            req.sandbox_mode
        );
        if codex_transport_is_exec() {
            let cmd = build_command(
                InvokeMode::Fresh,
                &req.cwd,
                &req.prompt,
                &req.sandbox_mode,
                &req.approval_policy,
                &req.model,
                &req.effort,
                req.full_auto.unwrap_or(false),
                req.yolo.unwrap_or(false),
                req.skip_git_repo_check.unwrap_or(true),
                &req.mcp_env,
            );
            spawn_and_stream(&self.instances, app_handle, resolved_id.clone(), cmd)?;
        } else {
            spawn_app_server_turn(
                &self.instances,
                app_handle,
                resolved_id.clone(),
                InvokeMode::Fresh,
                &req.cwd,
                &req.prompt,
                &req.sandbox_mode,
                &req.approval_policy,
                &req.model,
                &req.effort,
                req.full_auto.unwrap_or(false),
                req.yolo.unwrap_or(false),
                &req.mcp_env,
            )?;
        }
        Ok(resolved_id)
    }

    /// Send a follow-up prompt to an existing Codex thread. `req.session_id`
    /// MUST be the Codex-assigned `thread_id` (captured from the
    /// `thread.started` event of the originating session) for the resume to
    /// succeed.
    pub fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: SendCodexPromptRequest,
    ) -> Result<(), String> {
        if req.session_id.trim().is_empty() {
            return Err("send_prompt: session_id is required".to_string());
        }
        // The thread_id (Codex-assigned) is what `codex exec resume` needs as
        // its positional argument. session_id (T64-local UUID) is what we
        // emit events under so the frontend can route them to the right
        // session row. Fall back to session_id for older callers that haven't
        // split the fields yet.
        let resume_id_owned = req
            .thread_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| req.session_id.clone());
        safe_eprintln!(
            "[codex] Resuming session_id={} thread_id={} cwd={}",
            req.session_id,
            resume_id_owned,
            req.cwd
        );
        if codex_transport_is_exec() {
            let cmd = build_command(
                InvokeMode::Resume(&resume_id_owned),
                &req.cwd,
                &req.prompt,
                &req.sandbox_mode,
                &req.approval_policy,
                &req.model,
                &req.effort,
                req.full_auto.unwrap_or(false),
                req.yolo.unwrap_or(false),
                req.skip_git_repo_check.unwrap_or(true),
                &req.mcp_env,
            );
            spawn_and_stream(&self.instances, app_handle, req.session_id, cmd)
        } else {
            spawn_app_server_turn(
                &self.instances,
                app_handle,
                req.session_id,
                InvokeMode::Resume(&resume_id_owned),
                &req.cwd,
                &req.prompt,
                &req.sandbox_mode,
                &req.approval_policy,
                &req.model,
                &req.effort,
                req.full_auto.unwrap_or(false),
                req.yolo.unwrap_or(false),
                &req.mcp_env,
            )
        }
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = instances.get_mut(session_id) {
            let _ = instance.child.kill();
            let _ = instance.child.wait();
            safe_eprintln!("[codex] Cancelled session {}", session_id);
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        self.cancel(session_id)
    }

    pub fn rollback_thread(
        &self,
        thread_id: &str,
        cwd: &str,
        num_turns: u32,
    ) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Err("rollback_thread: thread_id is required".to_string());
        }
        if num_turns == 0 {
            return Ok(());
        }
        if codex_transport_is_exec() {
            return Err("Codex native rollback requires app-server transport".to_string());
        }
        run_app_server_request(
            cwd,
            "thread/rollback",
            json!({
                "threadId": thread_id,
                "numTurns": num_turns,
            }),
        )?;
        Ok(())
    }

    pub fn fork_thread(
        &self,
        thread_id: &str,
        cwd: &str,
        drop_turns: u32,
    ) -> Result<String, String> {
        if thread_id.trim().is_empty() {
            return Err("fork_thread: thread_id is required".to_string());
        }
        if codex_transport_is_exec() {
            return Err("Codex native fork requires app-server transport".to_string());
        }
        let result = run_app_server_request(
            cwd,
            "thread/fork",
            json!({
                "threadId": thread_id,
                "cwd": cwd,
                "excludeTurns": true,
            }),
        )?;
        let forked = get_json_str(&result, &["thread", "id"])
            .ok_or("Codex app-server fork did not return a thread id")?
            .to_string();
        if drop_turns > 0 {
            self.rollback_thread(&forked, cwd, drop_turns)?;
        }
        Ok(forked)
    }
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

// ── ProviderAdapter trait impl ─────────────────────────────

#[async_trait]
impl ProviderAdapter for CodexAdapter {
    fn provider(&self) -> ProviderKind {
        ProviderKind::Codex
    }

    fn capabilities(&self) -> &ProviderAdapterCapabilities {
        &self.capabilities
    }

    async fn start_session(
        &self,
        _input: ProviderSessionStartInput,
    ) -> Result<ProviderSession, ProviderAdapterError> {
        Err(
            "CodexAdapter::start_session not wired in Step 1 — call inherent create_session"
                .to_string(),
        )
    }

    async fn send_turn(
        &self,
        _input: ProviderSendTurnInput,
    ) -> Result<ProviderTurnStartResult, ProviderAdapterError> {
        Err("CodexAdapter::send_turn not wired in Step 1 — call inherent send_prompt".to_string())
    }

    async fn interrupt_turn(
        &self,
        thread_id: &str,
        _turn_id: Option<&str>,
    ) -> Result<(), ProviderAdapterError> {
        self.cancel(thread_id)
    }

    async fn respond_to_request(
        &self,
        _thread_id: &str,
        _request_id: &str,
        _decision: ProviderApprovalDecision,
    ) -> Result<(), ProviderAdapterError> {
        // Codex approvals come through the JSON stream as `item.completed`
        // requests of type `command_execution` / etc., but `codex exec --json`
        // is non-interactive — once the approval policy is set at spawn
        // there's no way to respond mid-turn. Use `--full-auto` or
        // `--dangerously-bypass-approvals-and-sandbox` instead. Returning
        // an explicit error so callers don't silently drop replies.
        Err(
            "CodexAdapter::respond_to_request: codex exec --json runs non-interactively; \
             set approval_policy at spawn time"
                .to_string(),
        )
    }

    async fn respond_to_user_input(
        &self,
        _thread_id: &str,
        _request_id: &str,
        _answers: ProviderUserInputAnswers,
    ) -> Result<(), ProviderAdapterError> {
        Err("CodexAdapter::respond_to_user_input not implemented".to_string())
    }

    async fn stop_session(&self, thread_id: &str) -> Result<(), ProviderAdapterError> {
        self.close(thread_id)
    }

    async fn list_sessions(&self) -> Vec<ProviderSession> {
        let Ok(instances) = self.instances.lock() else {
            return Vec::new();
        };
        instances
            .keys()
            .map(|sid| {
                serde_json::json!({
                    "provider": "codex",
                    "threadId": sid,
                })
            })
            .collect()
    }

    async fn has_session(&self, thread_id: &str) -> bool {
        self.instances
            .lock()
            .map(|m| m.contains_key(thread_id))
            .unwrap_or(false)
    }

    async fn read_thread(
        &self,
        _thread_id: &str,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        Err("CodexAdapter::read_thread not implemented".to_string())
    }

    async fn rollback_thread(
        &self,
        _thread_id: &str,
        _num_turns: u32,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        Err("CodexAdapter::rollback_thread not implemented".to_string())
    }

    async fn stop_all(&self) -> Result<(), ProviderAdapterError> {
        let ids: Vec<String> = match self.instances.lock() {
            Ok(m) => m.keys().cloned().collect(),
            Err(_) => return Ok(()),
        };
        for sid in ids {
            let _ = self.cancel(&sid);
        }
        Ok(())
    }

    async fn stream_events(&self) -> mpsc::Receiver<ProviderEvent> {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }
}

// ── Session JSONL history loader ──────────────────────────────────
//
// Codex persists each conversation to a "rollout" file at
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl
// Each line: { timestamp, type, payload }. Real chat content lives in
// `response_item` lines whose `payload.type == "message"` and whose role
// is "user" or "assistant". A few user messages are system-injected by the
// CLI itself (environment_context, permissions blurbs, model_switch
// notes); we filter those out so the rendered chat shows only what the
// human + the model actually said.
//
// Returns messages in chronological order, mapped to the same
// HistoryMessage shape Claude uses so the frontend can route through
// existing `mapHistoryMessages` / `loadFromDisk` plumbing.

fn codex_sessions_root() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let p = std::path::Path::new(&home).join(".codex").join("sessions");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// Walk `~/.codex/sessions/**/rollout-*-<thread_id>.jsonl` and return the
/// path to the (single) rollout file matching the given Codex thread id, if
/// one exists. The directory layout is shallow enough (year/month/day) that
/// a manual three-level walk is cheaper than pulling in `walkdir`.
fn find_codex_rollout(thread_id: &str) -> Option<std::path::PathBuf> {
    let root = codex_sessions_root()?;
    let suffix = format!("-{}.jsonl", thread_id);
    for year in std::fs::read_dir(&root).ok()?.flatten() {
        if !year.file_type().ok()?.is_dir() {
            continue;
        }
        for month in std::fs::read_dir(year.path()).ok()?.flatten() {
            if !month.file_type().ok()?.is_dir() {
                continue;
            }
            for day in std::fs::read_dir(month.path()).ok()?.flatten() {
                if !day.file_type().ok()?.is_dir() {
                    continue;
                }
                for file in std::fs::read_dir(day.path()).ok()?.flatten() {
                    let p = file.path();
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        if name.ends_with(&suffix) {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

/// Detect user messages that Codex injects as part of its prompt assembly
/// (environment context, permission blurbs, model-switch nudges, developer
/// instructions, file blocks) so we can hide them from the rendered chat
/// history. Defensive fallback: any message that's wholly wrapped in a
/// matching `<tag>…</tag>` envelope is treated as injected.
fn is_codex_system_injected_user_text(text: &str) -> bool {
    let t = text.trim();
    const KNOWN: &[&str] = &[
        "<environment_context>",
        "<permissions instructions>",
        "<model_switch>",
        "<user_instructions>",
        "<developer_instructions>",
        "<files>",
    ];
    if KNOWN.iter().any(|p| t.starts_with(p)) {
        return true;
    }
    // Defensive: any wrapper that opens with <tag …> and ends with </tag>.
    if let Some(rest) = t.strip_prefix('<') {
        if let Some(close_pos) = rest.find('>') {
            let tag_inner = &rest[..close_pos];
            let tag_name = tag_inner
                .split(|c: char| c.is_whitespace())
                .next()
                .unwrap_or("");
            if !tag_name.is_empty() && !tag_name.starts_with('/') {
                let close_tag = format!("</{}>", tag_name);
                if t.ends_with(&close_tag) {
                    return true;
                }
            }
        }
    }
    false
}

/// Treat a Codex tool output blob as an error if it carries one of the
/// shell-style failure signals we render in the live event stream:
///   - `^Process exited with code N` for any non-zero N
///   - leading `Error:` (used by Codex's MCP / built-in tools on failure)
fn detect_codex_tool_error(output: &str) -> bool {
    if output.starts_with("Error:") {
        return true;
    }
    if let Some(rest) = output.strip_prefix("Process exited with code ") {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(code) = digits.parse::<i32>() {
            return code != 0;
        }
    }
    false
}

/// Append a `HistoryToolCall` to the most recent assistant `HistoryMessage`,
/// or synthesise an empty-content assistant message when none exists / the
/// trailing entry is a user turn. Records `(msg_idx, tc_idx)` in `pending`
/// so the matching `*_output` envelope can patch the result back in.
fn attach_codex_tool_call(
    out: &mut Vec<HistoryMessage>,
    pending: &mut HashMap<String, (usize, usize)>,
    tc: HistoryToolCall,
    pending_key: &str,
    ts_ms: f64,
) {
    let target_idx = match out.last() {
        Some(m) if m.role == "assistant" => out.len() - 1,
        _ => {
            out.push(HistoryMessage {
                id: format!("codex-tools-{}", pending_key),
                role: "assistant".to_string(),
                content: String::new(),
                timestamp: ts_ms,
                tool_calls: Some(Vec::new()),
            });
            out.len() - 1
        }
    };
    let msg = &mut out[target_idx];
    let tcs = msg.tool_calls.get_or_insert_with(Vec::new);
    let ti = tcs.len();
    tcs.push(tc);
    pending.insert(pending_key.to_string(), (target_idx, ti));
}

/// Parse a Codex rollout JSONL into the same HistoryMessage shape Claude uses,
/// with tool calls (function/local-shell, web_search, mcp) attached to the
/// preceding assistant turn. Single pass over the file; `pending_tools` keys
/// each in-flight `function_call` / `local_shell_call` by `call_id` so the
/// matching `*_output` envelope can patch the result back in. Web-search and
/// MCP tool calls are single-shot — we materialise them with the embedded
/// status/result on the spot.
pub fn load_codex_history_by_thread(thread_id: &str) -> Vec<HistoryMessage> {
    let Some(path) = find_codex_rollout(thread_id) else {
        return Vec::new();
    };
    let Ok(file) = std::fs::File::open(&path) else {
        return Vec::new();
    };
    let reader = std::io::BufReader::new(file);
    let mut out: Vec<HistoryMessage> = Vec::new();
    let mut pending_tools: HashMap<String, (usize, usize)> = HashMap::new();

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if envelope.get("type").and_then(|v| v.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = envelope.get("payload") else {
            continue;
        };
        let ptype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        // Codex timestamps are ISO 8601 strings; convert to ms-since-epoch
        // so the frontend's existing renderer doesn't need a separate path.
        let ts_ms = envelope
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp_millis() as f64)
            .unwrap_or(0.0);

        match ptype {
            "message" => {
                let role = match payload.get("role").and_then(|v| v.as_str()) {
                    Some(r @ ("user" | "assistant")) => r.to_string(),
                    _ => continue,
                };
                // Concatenate every text-bearing content block. Codex stores
                // assistant text under `output_text` and user text under
                // `input_text`; both have a `text` field directly.
                let mut text = String::new();
                if let Some(arr) = payload.get("content").and_then(|v| v.as_array()) {
                    for block in arr {
                        if let Some(s) = block.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(s);
                        }
                    }
                }
                if text.trim().is_empty() {
                    continue;
                }
                if role == "user" && is_codex_system_injected_user_text(&text) {
                    continue;
                }
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("codex-{}", out.len()));
                out.push(HistoryMessage {
                    id,
                    role,
                    content: text,
                    timestamp: ts_ms,
                    tool_calls: None,
                });
            }
            "function_call" | "local_shell_call" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if call_id.is_empty() {
                    continue;
                }
                let name = payload
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        if ptype == "local_shell_call" {
                            "local_shell".to_string()
                        } else {
                            "function".to_string()
                        }
                    });
                // `arguments` is a JSON string (per OpenAI tool-call schema);
                // parse it so the frontend renderer can pick fields out
                // (e.g. `command`, `path`). Fall back to a `{_raw: "..."}`
                // wrapper so malformed payloads still render. For
                // `local_shell_call`, prefer the structured `action` if
                // `arguments` is missing.
                let input =
                    if let Some(args_str) = payload.get("arguments").and_then(|v| v.as_str()) {
                        serde_json::from_str::<serde_json::Value>(args_str)
                            .unwrap_or_else(|_| serde_json::json!({ "_raw": args_str }))
                    } else if let Some(action) = payload.get("action") {
                        action.clone()
                    } else {
                        serde_json::Value::Null
                    };
                let tc = HistoryToolCall {
                    id: call_id.clone(),
                    name,
                    input,
                    result: None,
                    is_error: false,
                };
                attach_codex_tool_call(&mut out, &mut pending_tools, tc, &call_id, ts_ms);
            }
            "function_call_output" | "local_shell_call_output" => {
                let call_id = payload
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if call_id.is_empty() {
                    continue;
                }
                let output = match payload.get("output") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                    None => String::new(),
                };
                let is_error = detect_codex_tool_error(&output);
                if let Some(&(mi, ti)) = pending_tools.get(&call_id) {
                    if let Some(msg) = out.get_mut(mi) {
                        if let Some(tcs) = msg.tool_calls.as_mut() {
                            if let Some(tc) = tcs.get_mut(ti) {
                                tc.result = Some(output);
                                tc.is_error = is_error;
                            }
                        }
                    }
                    pending_tools.remove(&call_id);
                }
            }
            "web_search_call" => {
                // Single-shot: built-in search tool already includes the
                // status when persisted, so we synthesise the tool call and
                // its result in one go. No `*_output` envelope follows.
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("ws-{}", out.len()));
                let action = payload
                    .get("action")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let status = payload
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_error = !status.is_empty() && status != "completed";
                let result = if status.is_empty() {
                    None
                } else {
                    Some(status)
                };
                let tc = HistoryToolCall {
                    id: id.clone(),
                    name: "web_search".to_string(),
                    input: action,
                    result,
                    is_error,
                };
                attach_codex_tool_call(&mut out, &mut pending_tools, tc, &id, ts_ms);
            }
            "mcp_tool_call" => {
                // Single-shot: MCP tool calls embed the result in the same
                // envelope (per upstream `mcp_tool_call` schema). Pair fields
                // defensively — `server`, `tool`, `arguments`, `result`,
                // `is_error` — none are guaranteed by the spec we have.
                let id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| {
                        payload
                            .get("call_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| format!("mcp-{}", out.len()));
                let server = payload.get("server").and_then(|v| v.as_str()).unwrap_or("");
                let tool = payload.get("tool").and_then(|v| v.as_str()).unwrap_or("");
                let name = if !server.is_empty() && !tool.is_empty() {
                    format!("{}__{}", server, tool)
                } else if !tool.is_empty() {
                    tool.to_string()
                } else {
                    "mcp_tool".to_string()
                };
                let input = payload
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                let result = payload.get("result").map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                });
                let is_error = payload
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let tc = HistoryToolCall {
                    id: id.clone(),
                    name,
                    input,
                    result,
                    is_error,
                };
                attach_codex_tool_call(&mut out, &mut pending_tools, tc, &id, ts_ms);
            }
            // No UI for chain-of-thought yet; live handler also drops it.
            "reasoning" => continue,
            _ => continue,
        }
    }
    out
}

/// Walk `~/.codex/sessions/**/rollout-*.jsonl` and return one `DiskSession`
/// per rollout whose `session_meta.cwd` matches the requested directory.
/// Each rollout's id is the Codex thread id (the suffix after the timestamp
/// in the filename); summary is the first user-typed prompt or a fallback.
/// Used by the dialog's "Previous Sessions" list when provider == "openai".
pub fn list_codex_disk_sessions(cwd: &str) -> Vec<DiskSession> {
    let Some(root) = codex_sessions_root() else {
        return Vec::new();
    };
    let target = std::path::Path::new(cwd);
    let target_canon = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());

    let mut out: Vec<DiskSession> = Vec::new();
    let Ok(year_iter) = std::fs::read_dir(&root) else {
        return out;
    };
    for year in year_iter.flatten() {
        if !year.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(month_iter) = std::fs::read_dir(year.path()) else {
            continue;
        };
        for month in month_iter.flatten() {
            if !month.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(day_iter) = std::fs::read_dir(month.path()) else {
                continue;
            };
            for day in day_iter.flatten() {
                if !day.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let Ok(file_iter) = std::fs::read_dir(day.path()) else {
                    continue;
                };
                for file in file_iter.flatten() {
                    let p = file.path();
                    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                        continue;
                    };
                    if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                        continue;
                    }
                    if let Some(meta) = peek_codex_rollout(&p) {
                        let rollout_cwd = std::path::Path::new(&meta.cwd);
                        let rollout_canon = std::fs::canonicalize(rollout_cwd)
                            .unwrap_or_else(|_| rollout_cwd.to_path_buf());
                        if rollout_canon != target_canon {
                            continue;
                        }
                        let modified = file
                            .metadata()
                            .and_then(|m| m.modified())
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
                        out.push(DiskSession {
                            id: meta.thread_id,
                            modified,
                            size,
                            summary: meta.summary,
                        });
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

struct CodexRolloutMeta {
    thread_id: String,
    cwd: String,
    summary: String,
}

/// Read just enough of a rollout JSONL to recover the thread id, cwd, and
/// the first real user prompt (skipping injected developer/permissions/env
/// blocks). Stops as soon as it finds a usable summary.
fn peek_codex_rollout(path: &std::path::Path) -> Option<CodexRolloutMeta> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut thread_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut summary: Option<String> = None;
    for line in reader.lines().map_while(Result::ok).take(200) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let etype = envelope.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if etype == "session_meta" {
            if let Some(payload) = envelope.get("payload") {
                if let Some(id) = payload.get("id").and_then(|v| v.as_str()) {
                    thread_id = Some(id.to_string());
                }
                if let Some(c) = payload.get("cwd").and_then(|v| v.as_str()) {
                    cwd = Some(c.to_string());
                }
            }
        } else if etype == "response_item" && summary.is_none() {
            if let Some(payload) = envelope.get("payload") {
                let ptype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if ptype == "message" && role == "user" {
                    if let Some(arr) = payload.get("content").and_then(|v| v.as_array()) {
                        for block in arr {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                if !is_codex_system_injected_user_text(text) {
                                    let trimmed: String = text.chars().take(120).collect();
                                    summary = Some(trimmed);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        if thread_id.is_some() && cwd.is_some() && summary.is_some() {
            break;
        }
    }
    Some(CodexRolloutMeta {
        thread_id: thread_id?,
        cwd: cwd.unwrap_or_default(),
        summary: summary.unwrap_or_default(),
    })
}

// ── Rollout truncation (rewind) ──────────────────────────────────
//
// `codex exec resume <thread_id>` re-reads the entire rollout JSONL as
// conversation memory. There is no `--resume-at` flag, so the only way to
// rewind is to physically truncate the rollout file on a turn boundary.
//
// A "turn" is the run between an `event_msg{type:"task_started"}` and the
// matching `event_msg{type:"task_complete"}`. Mid-turn truncation leaves an
// orphan `task_started`, an unpaired `function_call`, or stranded
// `agent_reasoning`, which Codex's own state machine refuses on resume —
// so we always cut immediately AFTER a `task_complete` line.
//
// Line 0 is `session_meta` (id, cwd, cli_version, base_instructions, git);
// it is preserved verbatim — Codex needs it to anchor the resume.

/// Truncate a Codex rollout to drop the last `num_turns` completed turns.
///
/// Returns the number of turns actually removed (capped at the total turn
/// count present in the rollout). Errors only on missing rollout / corrupt
/// `session_meta` / IO failure.
pub fn truncate_codex_rollout_by_turns(thread_id: &str, num_turns: u32) -> Result<u32, String> {
    if num_turns == 0 {
        return Ok(0);
    }
    let path = find_codex_rollout(thread_id)
        .ok_or_else(|| format!("rollout for thread {} not found", thread_id))?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    if content.is_empty() {
        return Ok(0);
    }
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    if lines.is_empty() {
        return Ok(0);
    }
    // Validate line 0 is `session_meta` so we don't accidentally clobber a
    // file with a different schema.
    let first_trim = lines[0].trim();
    let first_envelope: serde_json::Value =
        serde_json::from_str(first_trim).map_err(|e| format!("parse session_meta line: {}", e))?;
    if first_envelope.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return Err("first line is not session_meta — refusing to truncate".to_string());
    }

    // Walk the file once, recording the index of every `task_complete` event.
    let mut task_complete_indices: Vec<usize> = Vec::new();
    for (i, raw) in lines.iter().enumerate() {
        let s = raw.trim();
        if s.is_empty() {
            continue;
        }
        let Ok(env) = serde_json::from_str::<serde_json::Value>(s) else {
            continue;
        };
        if env.get("type").and_then(|v| v.as_str()) == Some("event_msg") {
            if let Some(p) = env.get("payload") {
                if p.get("type").and_then(|v| v.as_str()) == Some("task_complete") {
                    task_complete_indices.push(i);
                }
            }
        }
    }
    let total_turns = task_complete_indices.len();
    if total_turns == 0 {
        // No completed turns — nothing safe to truncate.
        return Ok(0);
    }
    let drop = (num_turns as usize).min(total_turns);
    let keep_turns = total_turns - drop;
    // If we keep N turns, cut after the Nth `task_complete`. Keeping zero
    // turns means we drop everything past line 0 (`session_meta`).
    let truncate_after_idx = if keep_turns == 0 {
        0
    } else {
        task_complete_indices[keep_turns - 1]
    };
    let keep_count = truncate_after_idx + 1;
    let truncated: String = lines.iter().take(keep_count).copied().collect();

    // Atomic write: stage to sibling tmp, fsync, rename, fsync parent dir.
    let parent = path.parent().ok_or("rollout path has no parent")?;
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
        f.write_all(truncated.as_bytes())
            .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
        if let Err(e) = f.sync_all() {
            safe_eprintln!("[codex truncate] sync_all {}: {}", tmp.display(), e);
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename {} -> {}: {}", tmp.display(), path.display(), e)
    })?;
    #[cfg(unix)]
    {
        if let Err(e) = std::fs::File::open(parent).and_then(|d| d.sync_all()) {
            safe_eprintln!(
                "[codex truncate] parent sync_all {}: {}",
                parent.display(),
                e
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
    }

    Ok(drop as u32)
}
