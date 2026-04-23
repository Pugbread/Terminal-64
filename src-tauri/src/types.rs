use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTerminalRequest {
    pub id: String,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutput {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalExit {
    pub id: String,
    pub code: Option<u32>,
}

// Claude session types

// "default" | "accept_edits" | "bypass_all" | "plan"
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateClaudeRequest {
    pub session_id: String,
    pub cwd: String,
    pub prompt: String,
    pub permission_mode: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub channel_server: Option<String>,
    pub mcp_config: Option<String>,
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub no_session_persistence: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendClaudePromptRequest {
    pub session_id: String,
    pub cwd: String,
    pub prompt: String,
    pub permission_mode: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub disallowed_tools: Option<String>,
    pub channel_server: Option<String>,
    pub resume_session_at: Option<String>,
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub no_session_persistence: Option<bool>,
    pub fork_session: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeDone {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

// Party Mode audio types

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectrumData {
    pub bands: Vec<f32>, // 64 frequency band magnitudes, normalized 0.0-1.0
    pub peak: f32,       // overall peak amplitude
    pub bass: f32,       // average of low bands (sub-bass + bass)
    pub mid: f32,        // average of mid bands
    pub treble: f32,     // average of high bands
}

// Session history types (used by list_disk_sessions / load_session_history commands)

#[derive(Serialize)]
pub struct DiskSession {
    pub id: String,
    pub modified: u64,
    pub size: u64,
    pub summary: String,
}

#[derive(Serialize)]
pub struct HistoryToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Serialize)]
pub struct HistoryMessage {
    pub id: String,
    pub role: String, // "user" or "assistant"
    pub content: String,
    pub timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<HistoryToolCall>>,
}

/// Lightweight stat for a session JSONL. Used by the frontend hydration cache
/// to skip reparsing when mtime+size are unchanged.
#[derive(Serialize)]
pub struct SessionJsonlStat {
    pub mtime_ms: i64,
    pub size: u64,
}

/// Lightweight session summary derived from JSONL without loading every message.
/// Used by the session browser so the frontend doesn't need a localStorage cache
/// to render a "recent sessions" list.
#[derive(Serialize, Default)]
pub struct SessionMetadata {
    pub session_id: String,
    pub exists: bool,
    pub msg_count: usize,
    pub last_timestamp: f64,
    pub first_user_prompt: String,
    pub last_assistant_preview: String,
}

// Skill resolution type (used by resolve_skill_prompt command)

#[derive(Serialize)]
pub struct ResolvedSkill {
    pub name: String,
    pub body: String,
    pub allowed_tools: Vec<String>,
    pub skill_dir: String,
}

// Proxy fetch type (used by proxy_fetch command)

#[derive(Serialize)]
pub struct ProxyFetchResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    pub is_base64: bool,
}

// Checkpoint type (used by create_checkpoint command)

#[derive(Deserialize)]
pub struct FileSnapshot {
    pub path: String,
    pub content: String,
}

// Hook lifecycle event types (emitted to frontend via Tauri events)

/// Generic hook event wrapper — emitted for all non-PermissionRequest hook events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEvent {
    pub session_id: String,
    pub event_name: String,
    pub payload: serde_json::Value,
}

// Voice control types (JARVIS-style wake word + STT pipeline).
// Shape is locked to the frontend contract in src/stores/voiceStore.ts and
// src/lib/voiceApi.ts (Agent 3): snake_case state enum, PascalCase intent
// kind, flat {kind, payload?} intent, plain {message} error payload.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceState {
    Idle,
    Listening,
    Dictating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VoiceIntentKind {
    Send,
    Exit,
    Rewrite,
    Dictation,
    SelectSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceIntent {
    pub kind: VoiceIntentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
}

impl VoiceIntent {
    pub fn send() -> Self {
        Self {
            kind: VoiceIntentKind::Send,
            payload: None,
        }
    }
    pub fn exit() -> Self {
        Self {
            kind: VoiceIntentKind::Exit,
            payload: None,
        }
    }
    pub fn rewrite() -> Self {
        Self {
            kind: VoiceIntentKind::Rewrite,
            payload: None,
        }
    }
    pub fn dictation(text: impl Into<String>) -> Self {
        Self {
            kind: VoiceIntentKind::Dictation,
            payload: Some(text.into()),
        }
    }
    pub fn select_session(query: impl Into<String>) -> Self {
        Self {
            kind: VoiceIntentKind::SelectSession,
            payload: Some(query.into()),
        }
    }
}

/// Per-kind model download state, flat booleans to match the frontend
/// `VoiceModelsDownloaded` TS type exactly.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct VoiceModelsStatus {
    pub wake: bool,
    pub command: bool,
    pub dictation: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceDownloadProgress {
    /// "wake" | "command" | "dictation"
    pub kind: String,
    /// 0.0..=1.0
    pub progress: f32,
}
