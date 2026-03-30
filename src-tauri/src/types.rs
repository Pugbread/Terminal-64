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
}
