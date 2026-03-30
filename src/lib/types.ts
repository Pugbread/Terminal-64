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

// Layout types

export type PaneNode =
  | { type: "terminal"; id: string; terminalId: string }
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      children: PaneNode[];
      sizes: number[];
    }
  | {
      type: "grid";
      id: string;
      cols: number;
      rows: number;
      cells: (string | null)[][];
    };

export interface Tab {
  id: string;
  label: string;
  root: PaneNode;
}

export interface TerminalInfo {
  id: string;
  title: string;
  shell?: string;
  cwd?: string;
  isAlive: boolean;
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

// Config types

export interface ConfigData {
  theme?: string;
  fontSize?: number;
  fontFamily?: string;
  defaultShell?: string;
  keybindings?: Keybinding[];
}

// Session types

export interface SessionData {
  name: string;
  layout: unknown;
  createdAt: string;
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
}

export interface SendClaudePromptRequest {
  session_id: string;
  cwd: string;
  prompt: string;
  permission_mode: PermissionMode;
  model?: string;
  effort?: string;
  disallowed_tools?: string;
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
  scope: string; // "user" | "project"
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}
