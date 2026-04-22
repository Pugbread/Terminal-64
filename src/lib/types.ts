export interface CreateTerminalRequest {
  id: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalOutput {
  id: string;
  data: string;
}

export interface TerminalExit {
  id: string;
  code?: number;
}

// Theme types

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface UiTheme {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  fg: string;
  fgSecondary: string;
  fgMuted: string;
  border: string;
  accent: string;
  accentHover: string;
  tabActiveBg: string;
  tabInactiveBg: string;
  tabActiveFg: string;
  tabInactiveFg: string;
  tabHoverBg: string;
  scrollbar: string;
  scrollbarHover: string;
}

export interface ThemeDefinition {
  name: string;
  ui: UiTheme;
  terminal: TerminalTheme;
}

// Keybinding types

export interface KeyCombo {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface Keybinding {
  combo: KeyCombo;
  command: string;
  args?: Record<string, unknown>;
}

// Command types

export interface Command {
  id: string;
  label: string;
  category?: string;
  execute: (...args: unknown[]) => void;
}

// Claude session types

export type PermissionMode = "default" | "accept_edits" | "bypass_all" | "plan" | "auto";

export interface CreateClaudeRequest {
  session_id: string;
  cwd: string;
  prompt: string;
  permission_mode: PermissionMode;
  model?: string;
  effort?: string;
  channel_server?: string;
  mcp_config?: string;
  max_turns?: number;
  max_budget_usd?: number;
  no_session_persistence?: boolean;
}

export interface SendClaudePromptRequest {
  session_id: string;
  cwd: string;
  prompt: string;
  permission_mode: PermissionMode;
  model?: string;
  effort?: string;
  disallowed_tools?: string;
  channel_server?: string;
  resume_session_at?: string;
  max_turns?: number;
  max_budget_usd?: number;
  no_session_persistence?: boolean;
  fork_session?: string;
}

export interface ClaudeEvent {
  session_id: string;
  data: string;
}

export interface ClaudeDone {
  session_id: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  source: string;
  usage?: string;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export interface McpServer {
  name: string;
  transport: string;
  command: string;
  scope: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  parentToolUseId?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

// Delegation types

export type DelegateTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface DelegateTask {
  id: string;
  description: string;
  sessionId: string;
  status: DelegateTaskStatus;
  result?: string;
  startedAt?: number;
  completedAt?: number;
  lastForwardedMessageId?: string;
  lastAction?: string; // most recent tool call or action description
  lastActionAt?: number;
}

export type DelegationStatus = "active" | "merging" | "merged" | "cancelled";

export interface DelegationGroup {
  id: string;
  parentSessionId: string;
  tasks: DelegateTask[];
  mergeStrategy: "auto" | "manual";
  status: DelegationStatus;
  createdAt: number;
  sharedContext?: string;
  collaborationEnabled: boolean;
  parentPermissionMode?: PermissionMode;
}

// Session history types (snake_case — matches Rust/JSONL serialization)

export interface DiskSession {
  id: string;
  modified: number;
  size: number;
  summary: string;
}

export interface HistoryToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  is_error?: boolean;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  tool_calls?: HistoryToolCall[];
}

// Delegation message type (snake_case — matches Rust serialization)

export interface DelegationMsg {
  group_id: string;
  agent: string;
  message: string;
  timestamp: number;
  msg_type: string;
}

// Widget types

export interface WidgetInfo {
  widget_id: string;
  has_index: boolean;
  modified: number;
}

// Skill types

export interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
  has_skill_md: boolean;
  modified: number;
  created?: number;
  imported_from?: string;
  pending_backfill?: boolean;
}

export interface ResolvedSkill {
  name: string;
  body: string;
  allowed_tools: string[];
  skill_dir: string;
}

// Proxy fetch types

export interface ProxyFetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  is_base64: boolean;
}

// Party mode types

export interface SpectrumData {
  bands: number[];
  peak: number;
  bass: number;
  mid: number;
  treble: number;
}

// Hook event types — lifecycle events emitted by Claude CLI hooks

export type HookEventType =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification"
  | "PreCompact"
  | "PostCompact"
  | "SessionStart"
  | "SessionEnd";

export interface HookEvent {
  type: HookEventType;
  sessionId: string;
  timestamp: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  subagentId?: string;
  message?: string;
  reason?: string;
}

/** Tauri event payload for claude-hook-* events */
export interface HookEventPayload {
  session_id: string;
  hook_type: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
  subagent_id?: string;
  message?: string;
  reason?: string;
}
