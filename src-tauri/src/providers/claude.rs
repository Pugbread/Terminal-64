//! `ClaudeAdapter` — the Claude-CLI-backed implementation of `ProviderAdapter`.
//!
//! The CLI spawning / JSONL streaming / cancel / close code moved here from
//! the former `ClaudeManager` (`claude_manager.rs`) so Claude participates in
//! the same provider registry as Codex while preserving the existing
//! `claude-event` / `claude-done` stream shape.
//!
//! The provider registry calls this adapter through the same backend
//! create/send/cancel/close/history contract used by the other providers, so
//! the public IPC surface remains provider-neutral.
//!
//! Shared helpers (`shim_command`, `cap_event_size`,
//! `sanitize_dangling_tool_uses`) live in [`crate::providers::util`].

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::providers::snapshots::{
    snapshot_from_descriptor, SnapshotControlDescriptor, SnapshotDescriptor,
    SnapshotDisplayDescriptor, SnapshotInstallDescriptor, SnapshotOptionDescriptor,
};
use crate::providers::traits::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderAdapterError, ProviderCommandContext,
    ProviderCommandLifecycle, ProviderCreateSessionRequest, ProviderHistoryCapabilities,
    ProviderHistoryRequest, ProviderHistoryResponse, ProviderKind, ProviderOpenWolfOptions,
    ProviderPreparedCommand, ProviderSendPromptRequest, ProviderSessionModelSwitchMode,
};
use crate::providers::util::{
    cap_event_size, expanded_tool_path, find_existing_claude_session_jsonl,
    sanitize_dangling_tool_uses, shim_command, terminate_child_process,
};
use crate::providers::{
    emit_provider_event, emit_provider_runtime_event, ProviderRuntimeEvent,
    ProviderRuntimeEventType,
};
use crate::types::{
    ClaudeDone, ClaudeEvent, CreateClaudeRequest, ProviderSnapshot, SendClaudePromptRequest,
};

const ANTHROPIC_MODEL_OPTIONS: &[SnapshotOptionDescriptor] = &[
    SnapshotOptionDescriptor::basic("sonnet", "Sonnet"),
    SnapshotOptionDescriptor::basic("opus", "Opus"),
    SnapshotOptionDescriptor::basic("haiku", "Haiku"),
    SnapshotOptionDescriptor::basic("opusplan", "Opus Plan"),
    SnapshotOptionDescriptor::basic("claude-opus-4-7", "Opus 4.7"),
    SnapshotOptionDescriptor::basic("sonnet[1m]", "Sonnet 1M"),
    SnapshotOptionDescriptor::basic("opus[1m]", "Opus 1M"),
    SnapshotOptionDescriptor::basic("claude-opus-4-7[1m]", "Opus 4.7 1M"),
];

const ANTHROPIC_EFFORT_OPTIONS: &[SnapshotOptionDescriptor] = &[
    SnapshotOptionDescriptor::basic("low", "Low"),
    SnapshotOptionDescriptor::basic("medium", "Med"),
    SnapshotOptionDescriptor::basic("high", "High"),
    SnapshotOptionDescriptor::basic("max", "Max"),
    SnapshotOptionDescriptor::basic("xhigh", "X-High"),
];

const ANTHROPIC_PERMISSION_OPTIONS: &[SnapshotOptionDescriptor] = &[
    SnapshotOptionDescriptor::described(
        "default",
        "Default",
        "Ask before every tool",
        "#89b4fa",
        Some("ask permissions"),
    ),
    SnapshotOptionDescriptor::described(
        "plan",
        "Plan",
        "Read-only, no edits",
        "#94e2d5",
        Some("plan mode"),
    ),
    SnapshotOptionDescriptor::described(
        "auto",
        "Auto",
        "Auto-approve safe ops",
        "#a6e3a1",
        Some("auto-approve"),
    ),
    SnapshotOptionDescriptor::described(
        "accept_edits",
        "Edits",
        "Auto-approve all edits",
        "#cba6f7",
        Some("auto-accept edits"),
    ),
    SnapshotOptionDescriptor::described(
        "bypass_all",
        "YOLO",
        "Skip ALL permissions",
        "#f38ba8",
        Some("bypass permissions"),
    ),
];

const ANTHROPIC_CONTROLS: &[SnapshotControlDescriptor] = &[
    SnapshotControlDescriptor::select(
        "model",
        "Model",
        "sonnet",
        "topbar",
        ANTHROPIC_MODEL_OPTIONS,
        None,
        Some("model"),
    ),
    SnapshotControlDescriptor::select(
        "effort",
        "Effort",
        "high",
        "topbar",
        ANTHROPIC_EFFORT_OPTIONS,
        None,
        Some("effort"),
    ),
    SnapshotControlDescriptor::select(
        "tool-permission",
        "Permissions",
        "default",
        "composer",
        ANTHROPIC_PERMISSION_OPTIONS,
        Some("on"),
        Some("permission"),
    ),
];

const ANTHROPIC_SNAPSHOT_DESCRIPTOR: SnapshotDescriptor = SnapshotDescriptor {
    id: "anthropic",
    display: SnapshotDisplayDescriptor {
        label: "Anthropic",
        short_label: "Claude",
        brand_title: "Anthropic Claude",
        empty_state_label: "Claude Code",
        default_session_name: "Claude",
    },
    auth_label: "Claude CLI",
    install: SnapshotInstallDescriptor {
        command: "claude",
        status_label: "Claude",
    },
    controls: ANTHROPIC_CONTROLS,
};

// ── Binary discovery ───────────────────────────────────────

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
    #[cfg(target_os = "windows")]
    return "claude.cmd".to_string();
    #[cfg(not(target_os = "windows"))]
    return "claude".to_string();
}

// ── Session state + command builder ────────────────────────

struct ClaudeInstance {
    child: Child,
    generation: u64,
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const ANTHROPIC_PROVIDER_ID: &str = "anthropic";

#[derive(Debug)]
struct PendingClaudeToolUse {
    id: String,
    name: String,
    input_json: String,
    parent_tool_use_id: Option<String>,
}

#[derive(Debug, Default)]
struct ClaudeRuntimeEventMapper {
    pending_blocks: Vec<PendingClaudeToolUse>,
    assistant_finalized: bool,
}

fn claude_context_window_for_model(model: &str) -> u64 {
    let lower = model.to_ascii_lowercase();
    if lower.contains("-1m") || lower.contains(":1m") || lower.contains("[1m]") {
        1_000_000
    } else {
        200_000
    }
}

fn claude_native_type(event: &Value) -> String {
    let base = event.get("type").and_then(Value::as_str).unwrap_or("");
    let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("");
    if subtype.is_empty() {
        base.to_string()
    } else {
        format!("{base}:{subtype}")
    }
}

fn claude_runtime_event(
    event_type: ProviderRuntimeEventType,
    session_id: &str,
    phase: &str,
    native_type: &str,
) -> ProviderRuntimeEvent {
    ProviderRuntimeEvent::new(event_type, ANTHROPIC_PROVIDER_ID, session_id)
        .with_payload("phase", json!(phase))
        .with_native_type(native_type)
}

fn json_object_or_empty(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_object)
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| json!({}))
}

fn stringify_claude_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn claude_tool_call_value(block: &Value, parent_tool_use_id: Option<&str>) -> Option<Value> {
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return None;
    }
    let id = block.get("id").and_then(Value::as_str)?;
    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
    if id.trim().is_empty() || name.trim().is_empty() {
        return None;
    }
    let mut tool_call = json!({
        "id": id,
        "name": name,
        "input": json_object_or_empty(block.get("input")),
    });
    if let Some(parent_tool_use_id) = parent_tool_use_id.filter(|id| !id.trim().is_empty()) {
        tool_call["parentToolUseId"] = json!(parent_tool_use_id);
    }
    Some(tool_call)
}

fn claude_tool_result_text(block: &Value) -> String {
    let Some(content) = block.get("content") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(items) = content.as_array() {
        return items
            .iter()
            .map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    item.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                } else {
                    stringify_claude_value(Some(item))
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    stringify_claude_value(Some(content))
}

fn claude_content_message_event(
    session_id: &str,
    native_type: &str,
    text: String,
    tool_calls: Vec<Value>,
    use_buffered_text: bool,
) -> ProviderRuntimeEvent {
    let mut event = claude_runtime_event(
        ProviderRuntimeEventType::Content,
        session_id,
        "message",
        native_type,
    )
    .with_payload("role", json!("assistant"))
    .with_payload("text", json!(text));
    if !tool_calls.is_empty() {
        event = event.with_payload("toolCalls", Value::Array(tool_calls));
    }
    if use_buffered_text {
        event = event.with_payload("useBufferedText", json!(true));
    }
    event
}

fn total_claude_input_tokens(usage: Option<&Value>) -> u64 {
    let Some(usage) = usage else {
        return 0;
    };
    [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .filter_map(|field| usage.get(*field).and_then(Value::as_u64))
    .sum()
}

fn claude_context_window_from_model_usage(event: &Value) -> Option<u64> {
    event
        .get("modelUsage")
        .and_then(Value::as_object)?
        .values()
        .find_map(|model_data| {
            model_data
                .get("contextWindow")
                .and_then(Value::as_u64)
                .filter(|window| *window > 0)
        })
}

impl ClaudeRuntimeEventMapper {
    fn reset(&mut self) {
        self.pending_blocks.clear();
        self.assistant_finalized = false;
    }

    fn pending_tool_calls(&self) -> Vec<Value> {
        self.pending_blocks
            .iter()
            .filter_map(|block| {
                let input = serde_json::from_str::<Value>(&block.input_json)
                    .ok()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({}));
                let mut value = json!({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": input,
                });
                if let Some(parent_tool_use_id) = &block.parent_tool_use_id {
                    value["parentToolUseId"] = json!(parent_tool_use_id);
                }
                claude_tool_call_value(&value, block.parent_tool_use_id.as_deref())
            })
            .collect()
    }

    fn content_array_to_event(
        &self,
        session_id: &str,
        native_type: &str,
        content: &[Value],
    ) -> ProviderRuntimeEvent {
        let mut text = String::new();
        let mut tool_calls = Vec::new();
        for block in content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(block_text) = block.get("text").and_then(Value::as_str) {
                        text.push_str(block_text);
                    }
                }
                Some("tool_use") => {
                    let parent_tool_use_id = block
                        .get("parentToolUseId")
                        .and_then(Value::as_str)
                        .or_else(|| block.get("parent_tool_use_id").and_then(Value::as_str));
                    if let Some(tool_call) = claude_tool_call_value(block, parent_tool_use_id) {
                        tool_calls.push(tool_call);
                    }
                }
                _ => {}
            }
        }
        claude_content_message_event(
            session_id,
            native_type,
            text.trim().to_string(),
            tool_calls,
            false,
        )
    }

    fn runtime_events_from_data(
        &mut self,
        session_id: &str,
        data: &str,
    ) -> Option<Vec<ProviderRuntimeEvent>> {
        let mut event = serde_json::from_str::<Value>(data).ok()?;
        let mut stream_parent_tool_use_id = None;
        if event.get("type").and_then(Value::as_str) == Some("stream_event") {
            stream_parent_tool_use_id = event
                .get("parent_tool_use_id")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            event = event.get("event")?.clone();
        }

        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        let native_type = claude_native_type(&event);
        match event_type {
            "system" if event.get("subtype").and_then(Value::as_str) == Some("init") => {
                let model = event.get("model").and_then(Value::as_str).unwrap_or("");
                let mut session = claude_runtime_event(
                    ProviderRuntimeEventType::Session,
                    session_id,
                    "started",
                    &native_type,
                )
                .with_payload("model", json!(model))
                .with_payload("contextMax", json!(claude_context_window_for_model(model)));
                if let Some(native_session_id) = event.get("session_id").and_then(Value::as_str) {
                    session = session.with_thread_id(native_session_id);
                }

                let mut events = vec![session];
                if let Some(servers) = event.get("mcp_servers").and_then(Value::as_array) {
                    events.push(
                        claude_runtime_event(
                            ProviderRuntimeEventType::Mcp,
                            session_id,
                            "status",
                            &native_type,
                        )
                        .with_payload("servers", Value::Array(servers.clone())),
                    );
                }
                Some(events)
            }
            "stream_request_start" => {
                self.reset();
                Some(vec![claude_runtime_event(
                    ProviderRuntimeEventType::Turn,
                    session_id,
                    "started",
                    &native_type,
                )])
            }
            "message_start" => {
                self.reset();
                Some(vec![claude_runtime_event(
                    ProviderRuntimeEventType::Turn,
                    session_id,
                    "started",
                    &native_type,
                )
                .with_payload("resetStreamingText", json!(true))])
            }
            "content_block_start" => {
                let content_block = event.get("content_block");
                if content_block
                    .and_then(|block| block.get("type"))
                    .and_then(Value::as_str)
                    == Some("tool_use")
                {
                    if let (Some(id), Some(name)) = (
                        content_block
                            .and_then(|block| block.get("id"))
                            .and_then(Value::as_str),
                        content_block
                            .and_then(|block| block.get("name"))
                            .and_then(Value::as_str),
                    ) {
                        self.pending_blocks.push(PendingClaudeToolUse {
                            id: id.to_string(),
                            name: name.to_string(),
                            input_json: String::new(),
                            parent_tool_use_id: stream_parent_tool_use_id,
                        });
                    }
                }
                Some(Vec::new())
            }
            "content_block_delta" => {
                let delta = event.get("delta");
                match delta
                    .and_then(|delta| delta.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("text_delta") => {
                        let text = delta
                            .and_then(|delta| delta.get("text"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if text.is_empty() {
                            Some(Vec::new())
                        } else {
                            Some(vec![claude_runtime_event(
                                ProviderRuntimeEventType::Content,
                                session_id,
                                "delta",
                                &native_type,
                            )
                            .with_payload("role", json!("assistant"))
                            .with_payload("text", json!(text))])
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial_json) = delta
                            .and_then(|delta| delta.get("partial_json"))
                            .and_then(Value::as_str)
                        {
                            if let Some(last) = self.pending_blocks.last_mut() {
                                last.input_json.push_str(partial_json);
                            }
                        }
                        Some(Vec::new())
                    }
                    _ => Some(Vec::new()),
                }
            }
            "assistant" => {
                let content = event
                    .pointer("/message/content")
                    .or_else(|| event.get("content"))
                    .and_then(Value::as_array)?;
                let content_event = self.content_array_to_event(session_id, &native_type, content);
                self.assistant_finalized = true;
                self.pending_blocks.clear();
                Some(vec![content_event])
            }
            "message_stop" => {
                if self.assistant_finalized {
                    self.reset();
                    return Some(Vec::new());
                }
                let tool_calls = self.pending_tool_calls();
                self.reset();
                Some(vec![claude_content_message_event(
                    session_id,
                    &native_type,
                    String::new(),
                    tool_calls,
                    true,
                )])
            }
            "message_delta" => {
                let stop_reason = event
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match stop_reason {
                    "refusal" => Some(vec![claude_runtime_event(
                        ProviderRuntimeEventType::Error,
                        session_id,
                        "warning",
                        &native_type,
                    )
                    .with_payload(
                        "message",
                        json!("Claude declined to continue (policy refusal)."),
                    )
                    .with_payload("terminal", json!(false))]),
                    "max_tokens" => Some(vec![claude_runtime_event(
                        ProviderRuntimeEventType::Error,
                        session_id,
                        "warning",
                        &native_type,
                    )
                    .with_payload(
                        "message",
                        json!("Response cut off - hit max_tokens. Ask Claude to continue."),
                    )
                    .with_payload("terminal", json!(false))]),
                    _ => Some(Vec::new()),
                }
            }
            "user" => {
                let content = event
                    .pointer("/message/content")
                    .or_else(|| event.get("content"))
                    .and_then(Value::as_array);
                let Some(content) = content else {
                    self.reset();
                    return Some(Vec::new());
                };
                let events = content
                    .iter()
                    .filter_map(|block| {
                        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                            return None;
                        }
                        let id = block.get("tool_use_id").and_then(Value::as_str)?;
                        Some(
                            claude_runtime_event(
                                ProviderRuntimeEventType::Tool,
                                session_id,
                                "completed",
                                &native_type,
                            )
                            .with_item_id(id)
                            .with_payload("id", json!(id))
                            .with_payload("result", json!(claude_tool_result_text(block)))
                            .with_payload(
                                "isError",
                                json!(block
                                    .get("is_error")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false)),
                            ),
                        )
                    })
                    .collect();
                self.reset();
                Some(events)
            }
            "result" => {
                let usage = event.get("usage");
                let input_tokens = total_claude_input_tokens(usage);
                let output_tokens = usage
                    .and_then(|usage| usage.get("output_tokens"))
                    .and_then(Value::as_u64)
                    .or_else(|| event.get("output_tokens").and_then(Value::as_u64))
                    .unwrap_or(0);
                let total_tokens = input_tokens + output_tokens;
                let is_error = event
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let mut turn = claude_runtime_event(
                    ProviderRuntimeEventType::Turn,
                    session_id,
                    "completed",
                    &native_type,
                )
                .with_payload(
                    "usage",
                    json!({
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "total_tokens": total_tokens,
                    }),
                )
                .with_payload("inputTokens", json!(input_tokens))
                .with_payload("outputTokens", json!(output_tokens))
                .with_payload("totalTokens", json!(total_tokens))
                .with_payload("isError", json!(is_error));
                if let Some(cost) = event.get("total_cost_usd").and_then(Value::as_f64) {
                    turn = turn.with_payload("costUsd", json!(cost));
                }
                if let Some(context_max) = claude_context_window_from_model_usage(&event) {
                    turn = turn.with_payload("contextMax", json!(context_max));
                }
                if is_error {
                    if let Some(result) = event.get("result") {
                        turn = turn.with_payload("error", result.clone());
                    }
                }
                self.reset();
                Some(vec![turn])
            }
            "error" => {
                let message = match event.get("error") {
                    Some(Value::String(message)) => message.clone(),
                    Some(Value::Object(error)) => error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Claude reported an error.")
                        .to_string(),
                    _ => event
                        .get("result")
                        .or_else(|| event.get("message_text"))
                        .and_then(Value::as_str)
                        .unwrap_or("Claude reported an error.")
                        .to_string(),
                };
                self.reset();
                Some(vec![claude_runtime_event(
                    ProviderRuntimeEventType::Error,
                    session_id,
                    "error",
                    &native_type,
                )
                .with_payload("message", json!(message))])
            }
            _ => None,
        }
    }
}

fn emit_claude_provider_event(
    handle: &AppHandle,
    mapper: &mut ClaudeRuntimeEventMapper,
    session_id: &str,
    data: &str,
) {
    if let Some(events) = mapper.runtime_events_from_data(session_id, data) {
        for event in events {
            emit_provider_runtime_event(handle, event);
        }
    } else {
        emit_provider_event(handle, ANTHROPIC_PROVIDER_ID, session_id, data);
    }
}

// Claude CLI invocation needs every flag threaded through as a distinct argument; bundling
// these would just introduce an internal struct that maps 1:1 to parameters, with no real gain.
#[allow(clippy::too_many_arguments)]
fn build_command(
    session_flag: &str,
    session_value: &str,
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
    // ScheduleWakeup is globally disabled: the scheduler pathway doesn't work
    // for either normal chats or delegated agents, and leaving it enabled lets
    // the model schedule no-op wakeups. Always append to the disallow list.
    const ALWAYS_DISALLOWED: &str = "ScheduleWakeup";
    let merged_disallow: String = match disallowed_tools {
        Some(dt) if !dt.is_empty() => {
            if dt.split(',').any(|t| t.trim() == ALWAYS_DISALLOWED) {
                dt.clone()
            } else {
                format!("{},{}", dt, ALWAYS_DISALLOWED)
            }
        }
        _ => ALWAYS_DISALLOWED.to_string(),
    };
    cmd.arg("--disallowed-tools").arg(&merged_disallow);
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
    // only documented escape hatch.
    let primary_config_has_approver = mcp_config
        .as_deref()
        .is_some_and(|path| mcp_config_has_server(path, "t64"));
    if let Some(amc) = approver_mcp_config {
        if !amc.is_empty() {
            if !primary_config_has_approver {
                cmd.arg("--mcp-config").arg(amc);
            }
            cmd.arg("--permission-prompt-tool").arg("mcp__t64__approve");
        }
    }

    if let Some(uuid) = resume_session_at {
        if !uuid.is_empty() {
            cmd.arg("--resume-session-at").arg(uuid);
        }
    }

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
    // prompts.
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::piped());
    cmd.env("PATH", expanded_tool_path());

    cmd
}

/// Resolve a session UUID up-front: use the caller-provided value if it
/// looks non-empty, otherwise mint a fresh `uuid::Uuid::new_v4()`.
fn resolve_session_id(provided: &str) -> String {
    let trimmed = provided.trim();
    if trimmed.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        trimmed.to_string()
    }
}

fn provider_payload_string_field<'a>(
    payload: &'a serde_json::Value,
    field: &str,
) -> Option<&'a str> {
    payload.get(field).and_then(serde_json::Value::as_str)
}

fn provider_payload_cwd(payload: &serde_json::Value) -> Option<&str> {
    provider_payload_string_field(payload, "cwd").filter(|cwd| !cwd.trim().is_empty())
}

fn write_provider_payload_string_field(
    payload: &mut serde_json::Value,
    field: &str,
    value: String,
) -> Result<(), String> {
    let Some(object) = payload.as_object_mut() else {
        return Err("provider request payload must be a JSON object".to_string());
    };
    object.insert(field.to_string(), serde_json::Value::String(value));
    Ok(())
}

fn mcp_config_has_server(path: &str, server_name: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
        .and_then(|config| {
            config
                .get("mcpServers")
                .and_then(serde_json::Value::as_object)
                .map(|servers| servers.contains_key(server_name))
        })
        .unwrap_or(false)
}

fn merge_approver_server_into_primary_mcp_config(
    primary_path: &str,
    approver_path: &str,
) -> Result<(), String> {
    if primary_path.trim().is_empty() || approver_path.trim().is_empty() {
        return Ok(());
    }

    let mut primary = std::fs::read_to_string(primary_path)
        .map_err(|e| format!("read primary MCP config {}: {}", primary_path, e))
        .and_then(|data| {
            serde_json::from_str::<serde_json::Value>(&data)
                .map_err(|e| format!("parse primary MCP config {}: {}", primary_path, e))
        })?;
    let approver = std::fs::read_to_string(approver_path)
        .map_err(|e| format!("read approver MCP config {}: {}", approver_path, e))
        .and_then(|data| {
            serde_json::from_str::<serde_json::Value>(&data)
                .map_err(|e| format!("parse approver MCP config {}: {}", approver_path, e))
        })?;
    let Some(approver_server) = approver
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .and_then(|servers| servers.get("t64"))
        .cloned()
    else {
        return Ok(());
    };

    let Some(primary_root) = primary.as_object_mut() else {
        return Err(format!(
            "primary MCP config {} root must be an object",
            primary_path
        ));
    };
    let servers_value = primary_root
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let Some(servers) = servers_value.as_object_mut() else {
        return Err(format!(
            "primary MCP config {} mcpServers must be an object",
            primary_path
        ));
    };
    servers.insert("t64".to_string(), approver_server);

    std::fs::write(
        primary_path,
        serde_json::to_string_pretty(&primary).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write primary MCP config {}: {}", primary_path, e))
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

/// Hard safety net: never init OpenWolf inside T64's own managed directories
/// (widgets, skills). Guards against stale session state or frontend bugs where
/// skipOpenwolf wasn't propagated.
fn is_t64_managed_dir(cwd: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    std::path::Path::new(cwd).starts_with(home.join(".terminal64"))
}

fn maybe_apply_openwolf(
    settings_path: &Option<String>,
    cwd: &str,
    options: ProviderOpenWolfOptions,
) {
    if !options.enabled || is_t64_managed_dir(cwd) {
        return;
    }
    crate::claude_manager::ensure_openwolf(cwd, options.auto_init);
    if let Some(sp) = settings_path {
        if let Err(e) = crate::claude_manager::merge_openwolf_hooks(sp, cwd, options.design_qc) {
            safe_eprintln!("[openwolf] Failed to merge hooks: {}", e);
        }
    }
}

fn prepare_claude_command(
    lifecycle: &ProviderCommandLifecycle<'_>,
    mut req: ProviderCreateSessionRequest,
    generate_empty_session_id: bool,
    command_label: &str,
) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
    let mut session_id = provider_payload_string_field(&req.payload, "session_id")
        .ok_or_else(|| {
            format!(
                "Invalid Anthropic {} request: missing required field 'session_id'",
                command_label
            )
        })?
        .to_string();

    if generate_empty_session_id && session_id.trim().is_empty() {
        session_id = uuid::Uuid::new_v4().to_string();
        write_provider_payload_string_field(&mut req.payload, "session_id", session_id.clone())?;
    }

    let permission_mode = provider_payload_string_field(&req.payload, "permission_mode")
        .ok_or_else(|| {
            format!(
                "Invalid Anthropic {} request: missing required field 'permission_mode'",
                command_label
            )
        })?;
    let cli_mode = cli_permission_mode(permission_mode);
    let registration = lifecycle
        .permission_server
        .register_session(&session_id, cli_mode)
        .ok();
    let settings_path = registration
        .as_ref()
        .map(|(_, s, _)| s.to_string_lossy().to_string());
    let approver_path = registration
        .as_ref()
        .map(|(_, _, m)| m.to_string_lossy().to_string());
    let cleanup_tokens = registration
        .map(|(token, _, _)| vec![token])
        .unwrap_or_default();
    let primary_mcp_config = provider_payload_string_field(&req.payload, "mcp_config")
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string);

    if let Some(cwd) = provider_payload_cwd(&req.payload) {
        if let Err(e) = crate::ensure_t64_mcp_impl(lifecycle.app_handle, cwd) {
            safe_eprintln!("[claude:mcp] setup failed before {}: {}", command_label, e);
        }
        if let Some(path) = approver_path.as_ref() {
            if let Err(e) =
                crate::merge_existing_claude_mcp_servers_into_file(cwd, std::path::Path::new(path))
            {
                safe_eprintln!(
                    "[claude:mcp] failed to merge existing MCP servers into approver config before {}: {}",
                    command_label,
                    e
                );
            }
        }
        if let (Some(primary_path), Some(approver_path)) =
            (primary_mcp_config.as_deref(), approver_path.as_deref())
        {
            if let Err(e) =
                merge_approver_server_into_primary_mcp_config(primary_path, approver_path)
            {
                safe_eprintln!(
                    "[claude:mcp] failed to merge approver MCP server into primary config before {}: {}",
                    command_label,
                    e
                );
            }
        }
        maybe_apply_openwolf(&settings_path, cwd, lifecycle.openwolf);
    }

    req.context = ProviderCommandContext {
        settings_path,
        approver_mcp_config: approver_path,
    };

    Ok(ProviderPreparedCommand {
        request: req,
        cleanup_tokens,
    })
}

/// Stderr pattern for a strict CLI that doesn't recognize `--session-id`.
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
            terminate_child_process(&mut old.child);
            // Brief delay for OS to release file locks on session JSONL
            drop(inst); // release mutex before sleeping
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }

    // Resume-path safety net: stitch a cancelled tool_result for any dangling
    // tool_use the previous run left behind so Claude CLI doesn't replay it.
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
        });
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    // Capture stderr into a shared buffer so the stdout reader can surface errors.
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
        let mut runtime_mapper = ClaudeRuntimeEventMapper::default();
        for line in reader.lines() {
            match line {
                Ok(line) if line.trim().is_empty() => continue,
                Ok(line) => {
                    had_output = true;
                    let data = cap_event_size(line);
                    emit_claude_provider_event(&handle, &mut runtime_mapper, &sid, &data);
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
        // If process produced no stdout, it likely failed — surface stderr as an error.
        if !had_output {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let stderr_msg = stderr_buf.lock().map(|s| s.clone()).unwrap_or_default();
            let error_msg = if stderr_msg.is_empty() {
                "Claude process exited without output. The session may not exist or the CLI may not be installed.".to_string()
            } else if stderr_rejects_session_id_flag(&stderr_msg) {
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
            let data = serde_json::json!({
                "type": "result",
                "subtype": "error",
                "is_error": true,
                "result": error_msg
            })
            .to_string();
            emit_claude_provider_event(&handle, &mut runtime_mapper, &sid, &data);
            if let Err(e) = handle.emit(
                "claude-event",
                ClaudeEvent {
                    session_id: sid.clone(),
                    data,
                },
            ) {
                safe_eprintln!("[claude] Failed to emit error event for {}: {}", sid, e);
            }
        }
        safe_eprintln!("[claude] Reader thread ended for {} (gen {})", sid, gen);
        // Only clean up and emit claude-done if this is still the current generation.
        // A newer generation means the session was re-spawned — emitting claude-done
        // from a stale reader would incorrectly flip isStreaming to false in the
        // frontend.
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

// ── ClaudeAdapter ──────────────────────────────────────────

pub struct ClaudeAdapter {
    instances: Arc<Mutex<HashMap<String, ClaudeInstance>>>,
    capabilities: ProviderAdapterCapabilities,
}

#[derive(Deserialize)]
struct ClaudeHistoryTruncateRequest {
    session_id: String,
    cwd: String,
    keep_messages: usize,
}

#[derive(Deserialize)]
struct ClaudeHistoryForkRequest {
    parent_session_id: String,
    new_session_id: String,
    cwd: String,
    keep_messages: usize,
}

#[derive(Deserialize)]
struct ClaudeHistoryHydrateRequest {
    session_id: String,
    cwd: String,
    resume_at_uuid: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeHistoryDeleteRequest {
    session_id: String,
    cwd: String,
}

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            capabilities: ProviderAdapterCapabilities {
                session_model_switch: ProviderSessionModelSwitchMode::InSession,
                history: ProviderHistoryCapabilities::FULL,
                mcp: true,
                plan: true,
                images: true,
                hook_log: true,
                native_slash_commands: true,
                compact: true,
            },
        }
    }

    /// Spawn a new Claude CLI process for `req.session_id` (or a freshly minted
    /// UUID if empty). Returns the resolved session id so the frontend can
    /// adopt it without waiting on the `system/init` stream event.
    ///
    /// Signature preserved from the former `ClaudeManager::create_session` so
    /// the Tauri command layer (`lib.rs::create_claude_session`) stays
    /// byte-identical from the frontend's perspective.
    pub fn create_session(
        &self,
        app_handle: &AppHandle,
        req: CreateClaudeRequest,
        settings_path: Option<String>,
        approver_mcp_config: Option<String>,
        channel_server: Option<String>,
    ) -> Result<String, String> {
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
        let existing_jsonl = find_existing_claude_session_jsonl(&req.cwd, &resolved_id);
        let existing_jsonl_has_history = existing_jsonl
            .as_ref()
            .map(|_| match crate::load_session_history_impl(resolved_id.clone(), req.cwd.clone()) {
                Ok(messages) => !messages.is_empty(),
                Err(e) => {
                    safe_eprintln!(
                        "[claude] Failed to inspect existing JSONL for {}: {}; preserving resume behavior",
                        resolved_id,
                        e
                    );
                    true
                }
            })
            .unwrap_or(false);
        let session_flag = if existing_jsonl_has_history {
            "--resume"
        } else {
            "--session-id"
        };
        if let Some(path) = existing_jsonl
            .as_ref()
            .filter(|_| existing_jsonl_has_history)
        {
            safe_eprintln!(
                "[claude] Session id {} already has history at {}; using --resume for first visible turn",
                resolved_id,
                path.display()
            );
        } else if let Some(path) = existing_jsonl.as_ref() {
            safe_eprintln!(
                "[claude] Session id {} has JSONL at {} but no visible conversation; using --session-id",
                resolved_id,
                path.display()
            );
        }
        let cmd = build_command(
            session_flag,
            &resolved_id,
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

    /// Send a follow-up prompt to an existing session (uses `--resume`).
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

    /// Kill the child process for `session_id` without removing its slot —
    /// the next `spawn_and_stream` replaces it after a short delay so file
    /// locks on the session JSONL release cleanly.
    pub fn cancel(&self, session_id: &str) -> Result<(), String> {
        let mut instances = self.instances.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = instances.get_mut(session_id) {
            terminate_child_process(&mut instance.child);
            safe_eprintln!("[claude] Cancelled session {}", session_id);
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let instance = self
            .instances
            .lock()
            .map_err(|e| e.to_string())?
            .remove(session_id);
        if let Some(mut instance) = instance {
            terminate_child_process(&mut instance.child);
            safe_eprintln!("[claude] Closed session {}", session_id);
        }
        Ok(())
    }
}

impl Default for ClaudeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderAdapter for ClaudeAdapter {
    fn prepare_create_session(
        &self,
        lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderCreateSessionRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        prepare_claude_command(lifecycle, req, true, "create")
    }

    fn prepare_send_prompt(
        &self,
        lifecycle: &ProviderCommandLifecycle<'_>,
        req: ProviderSendPromptRequest,
    ) -> Result<ProviderPreparedCommand, ProviderAdapterError> {
        prepare_claude_command(lifecycle, req, false, "send")
    }

    fn create_session(
        &self,
        app_handle: &AppHandle,
        req: ProviderCreateSessionRequest,
    ) -> Result<String, ProviderAdapterError> {
        let typed_req: CreateClaudeRequest = serde_json::from_value(req.payload)
            .map_err(|e| format!("Invalid Anthropic create request: {}", e))?;
        let channel_server = typed_req.channel_server.clone();
        ClaudeAdapter::create_session(
            self,
            app_handle,
            typed_req,
            req.context.settings_path,
            req.context.approver_mcp_config,
            channel_server,
        )
    }

    fn send_prompt(
        &self,
        app_handle: &AppHandle,
        req: ProviderSendPromptRequest,
    ) -> Result<(), ProviderAdapterError> {
        let typed_req: SendClaudePromptRequest = serde_json::from_value(req.payload)
            .map_err(|e| format!("Invalid Anthropic send request: {}", e))?;
        let channel_server = typed_req.channel_server.clone();
        ClaudeAdapter::send_prompt(
            self,
            app_handle,
            typed_req,
            req.context.settings_path,
            req.context.approver_mcp_config,
            channel_server,
        )
    }

    fn cancel_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
        self.cancel(session_id)
    }

    fn close_session(&self, session_id: &str) -> Result<(), ProviderAdapterError> {
        self.close(session_id)
    }

    fn provider(&self) -> ProviderKind {
        ProviderKind::ClaudeAgent
    }

    fn capabilities(&self) -> &ProviderAdapterCapabilities {
        &self.capabilities
    }

    fn snapshot(&self) -> ProviderSnapshot {
        snapshot_from_descriptor(
            &ANTHROPIC_SNAPSHOT_DESCRIPTOR,
            self.capabilities(),
            resolve_claude_path(),
        )
    }

    fn history_truncate(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryTruncateRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history truncate request: {}", e))?;
        if req.keep_messages == 0 {
            crate::delete_session_jsonl_impl(req.session_id, req.cwd)?;
            return Ok(serde_json::json!({
                "status": "applied",
                "method": "deleted_for_empty_rewind",
                "resume_at_uuid": null,
            }));
        }

        let resume_at_uuid =
            crate::find_rewind_uuid_impl(req.session_id, req.cwd, req.keep_messages)?;
        Ok(serde_json::json!({
            "status": "applied",
            "method": "resume_session_at",
            "resume_at_uuid": resume_at_uuid,
        }))
    }

    fn history_fork(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryForkRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history fork request: {}", e))?;
        let resume_at_uuid = crate::fork_session_jsonl_impl(
            req.parent_session_id,
            req.new_session_id,
            req.cwd,
            req.keep_messages,
        )?;
        Ok(serde_json::json!({
            "status": "applied",
            "resume_at_uuid": resume_at_uuid,
        }))
    }

    fn history_hydrate(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryHydrateRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history hydrate request: {}", e))?;
        let stat = crate::stat_session_jsonl_impl(req.session_id.clone(), req.cwd.clone())?;
        let messages =
            crate::load_session_history_at_impl(req.session_id, req.cwd, req.resume_at_uuid)?;
        let status = if messages.is_empty() {
            "empty"
        } else {
            "messages"
        };
        Ok(serde_json::json!({
            "status": status,
            "messages": messages,
            "stat": stat,
        }))
    }

    fn history_delete(
        &self,
        req: ProviderHistoryRequest,
    ) -> Result<ProviderHistoryResponse, ProviderAdapterError> {
        let req: ClaudeHistoryDeleteRequest = serde_json::from_value(req)
            .map_err(|e| format!("Invalid Anthropic history delete request: {}", e))?;
        crate::delete_session_jsonl_impl(req.session_id, req.cwd)?;
        Ok(serde_json::json!({
            "status": "applied",
            "method": "deleted",
        }))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn temp_json_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "t64-claude-{}-{}.json",
            label,
            uuid::Uuid::new_v4()
        ))
    }

    fn command_args(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    fn mapped(mapper: &mut ClaudeRuntimeEventMapper, line: Value) -> Vec<Value> {
        mapper
            .runtime_events_from_data("claude-session", &line.to_string())
            .unwrap()
            .into_iter()
            .map(ProviderRuntimeEvent::into_value)
            .collect()
    }

    #[test]
    fn claude_delegation_mcp_merge_keeps_active_terminal64_server() {
        let primary = temp_json_path("primary-mcp");
        let approver = temp_json_path("approver-mcp");
        std::fs::write(
            &primary,
            json!({
                "mcpServers": {
                    "terminal-64": {
                        "command": "node",
                        "args": ["t64-server.mjs"],
                        "env": {
                            "T64_DELEGATION_PORT": "53023",
                            "T64_DELEGATION_SECRET": "secret",
                            "T64_GROUP_ID": "group-1",
                            "T64_AGENT_LABEL": "Builder"
                        }
                    },
                    "roblox-studio": { "command": "roblox-mcp" }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            &approver,
            json!({
                "mcpServers": {
                    "terminal-64": {
                        "command": "old-node",
                        "args": ["old-t64-server.mjs"]
                    },
                    "t64": {
                        "command": "terminal-64",
                        "env": { "T64_PERMISSION_SHIM": "1" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        merge_approver_server_into_primary_mcp_config(
            primary.to_str().unwrap(),
            approver.to_str().unwrap(),
        )
        .unwrap();
        let merged: Value =
            serde_json::from_str(&std::fs::read_to_string(&primary).unwrap()).unwrap();
        let _ = std::fs::remove_file(&primary);
        let _ = std::fs::remove_file(&approver);

        assert_eq!(
            merged["mcpServers"]["terminal-64"]["env"]["T64_GROUP_ID"].as_str(),
            Some("group-1")
        );
        assert_eq!(
            merged["mcpServers"]["terminal-64"]["command"].as_str(),
            Some("node")
        );
        assert_eq!(
            merged["mcpServers"]["t64"]["env"]["T64_PERMISSION_SHIM"].as_str(),
            Some("1")
        );
        assert_eq!(
            merged["mcpServers"]["roblox-studio"]["command"].as_str(),
            Some("roblox-mcp")
        );
    }

    #[test]
    fn claude_command_uses_single_mcp_config_when_primary_has_approver() {
        let primary = temp_json_path("single-config-primary");
        let approver = temp_json_path("single-config-approver");
        std::fs::write(
            &primary,
            json!({
                "mcpServers": {
                    "terminal-64": {
                        "env": {
                            "T64_DELEGATION_PORT": "53023",
                            "T64_DELEGATION_SECRET": "secret",
                            "T64_GROUP_ID": "group-1"
                        }
                    },
                    "t64": { "env": { "T64_PERMISSION_SHIM": "1" } }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            &approver,
            json!({ "mcpServers": { "t64": {} } }).to_string(),
        )
        .unwrap();

        let none_string: Option<String> = None;
        let none_u32: Option<u32> = None;
        let none_f64: Option<f64> = None;
        let none_bool: Option<bool> = None;
        let cmd = build_command(
            "--session-id",
            "session-1",
            "bypass_all",
            &none_string,
            &none_string,
            ".",
            &none_string,
            &none_string,
            &none_string,
            &Some(primary.to_string_lossy().to_string()),
            &Some(approver.to_string_lossy().to_string()),
            &none_string,
            &none_u32,
            &none_f64,
            &none_bool,
            &none_string,
        );
        let args = command_args(&cmd);
        let _ = std::fs::remove_file(&primary);
        let _ = std::fs::remove_file(&approver);

        assert_eq!(args.iter().filter(|arg| *arg == "--mcp-config").count(), 1);
        assert!(args.windows(2).any(|pair| {
            pair[0] == "--permission-prompt-tool" && pair[1] == "mcp__t64__approve"
        }));
    }

    #[test]
    fn claude_runtime_mapper_emits_session_and_mcp_envelopes() {
        let mut mapper = ClaudeRuntimeEventMapper::default();
        let events = mapped(
            &mut mapper,
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "native-claude-session",
                "model": "sonnet[1m]",
                "mcp_servers": [{ "name": "terminal-64", "status": "ready" }]
            }),
        );

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "provider.session");
        assert_eq!(events[0]["provider"], ANTHROPIC_PROVIDER_ID);
        assert_eq!(events[0]["sessionId"], "claude-session");
        assert_eq!(events[0]["threadId"], "native-claude-session");
        assert_eq!(events[0]["phase"], "started");
        assert_eq!(events[0]["model"], "sonnet[1m]");
        assert_eq!(events[0]["contextMax"], 1_000_000);
        assert_eq!(events[1]["type"], "provider.mcp");
        assert_eq!(events[1]["phase"], "status");
        assert_eq!(events[1]["servers"][0]["name"], "terminal-64");
    }

    #[test]
    fn claude_runtime_mapper_hydrates_streaming_content_tools_and_result() {
        let mut mapper = ClaudeRuntimeEventMapper::default();

        let turn_start = mapped(&mut mapper, json!({ "type": "stream_request_start" }));
        assert_eq!(turn_start[0]["type"], "provider.turn");
        assert_eq!(turn_start[0]["phase"], "started");

        let text_delta = mapped(
            &mut mapper,
            json!({
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "hello" }
            }),
        );
        assert_eq!(text_delta[0]["type"], "provider.content");
        assert_eq!(text_delta[0]["phase"], "delta");
        assert_eq!(text_delta[0]["text"], "hello");

        let no_events = mapped(
            &mut mapper,
            json!({
                "type": "content_block_start",
                "content_block": { "type": "tool_use", "id": "tool-1", "name": "Read" }
            }),
        );
        assert!(no_events.is_empty());

        let no_events = mapped(
            &mut mapper,
            json!({
                "type": "content_block_delta",
                "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"src/main.ts\"}" }
            }),
        );
        assert!(no_events.is_empty());

        let message = mapped(&mut mapper, json!({ "type": "message_stop" }));
        assert_eq!(message[0]["type"], "provider.content");
        assert_eq!(message[0]["phase"], "message");
        assert_eq!(message[0]["useBufferedText"], true);
        assert_eq!(message[0]["toolCalls"][0]["id"], "tool-1");
        assert_eq!(message[0]["toolCalls"][0]["name"], "Read");
        assert_eq!(
            message[0]["toolCalls"][0]["input"]["file_path"],
            "src/main.ts"
        );

        let tool_result = mapped(
            &mut mapper,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "tool-1",
                        "content": "done",
                        "is_error": false
                    }]
                }
            }),
        );
        assert_eq!(tool_result[0]["type"], "provider.tool");
        assert_eq!(tool_result[0]["phase"], "completed");
        assert_eq!(tool_result[0]["id"], "tool-1");
        assert_eq!(tool_result[0]["result"], "done");
        assert_eq!(tool_result[0]["isError"], false);

        let completed = mapped(
            &mut mapper,
            json!({
                "type": "result",
                "usage": {
                    "input_tokens": 10,
                    "cache_creation_input_tokens": 2,
                    "cache_read_input_tokens": 3,
                    "output_tokens": 4
                },
                "total_cost_usd": 0.12,
                "modelUsage": {
                    "claude": { "contextWindow": 200000 }
                },
                "is_error": false
            }),
        );
        assert_eq!(completed[0]["type"], "provider.turn");
        assert_eq!(completed[0]["phase"], "completed");
        assert_eq!(completed[0]["usage"]["input_tokens"], 15);
        assert_eq!(completed[0]["usage"]["output_tokens"], 4);
        assert_eq!(completed[0]["usage"]["total_tokens"], 19);
        assert_eq!(completed[0]["costUsd"], 0.12);
        assert_eq!(completed[0]["contextMax"], 200000);
    }

    #[test]
    fn claude_runtime_mapper_falls_back_for_unknown_legacy_shapes() {
        let mut mapper = ClaudeRuntimeEventMapper::default();
        assert!(mapper
            .runtime_events_from_data("claude-session", r#"{"type":"future_event"}"#)
            .is_none());
        assert!(mapper
            .runtime_events_from_data("claude-session", "not json")
            .is_none());
    }
}
