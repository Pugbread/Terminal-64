import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  CreateTerminalRequest,
  TerminalOutput,
  TerminalExit,
  CreateClaudeRequest,
  SendClaudePromptRequest,
  ClaudeEvent,
  ClaudeDone,
  SlashCommand,
  DirEntry,
  McpServer,
} from "./types";

// PTY terminal commands

export async function createTerminal(req: CreateTerminalRequest): Promise<void> {
  return invoke("create_terminal", { req });
}

export async function writeTerminal(id: string, data: string): Promise<void> {
  return invoke("write_terminal", { id, data });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_terminal", { id, cols, rows });
}

export async function closeTerminal(id: string): Promise<void> {
  return invoke("close_terminal", { id });
}

export function onTerminalOutput(callback: (payload: TerminalOutput) => void): Promise<UnlistenFn> {
  return listen<TerminalOutput>("terminal-output", (event) => callback(event.payload));
}

export function onTerminalExit(callback: (payload: TerminalExit) => void): Promise<UnlistenFn> {
  return listen<TerminalExit>("terminal-exit", (event) => callback(event.payload));
}

// Claude session commands

export async function createClaudeSession(req: CreateClaudeRequest): Promise<void> {
  return invoke("create_claude_session", { req });
}

export async function sendClaudePrompt(req: SendClaudePromptRequest): Promise<void> {
  return invoke("send_claude_prompt", { req });
}

export async function cancelClaude(sessionId: string): Promise<void> {
  return invoke("cancel_claude", { sessionId });
}

export async function closeClaudeSession(sessionId: string): Promise<void> {
  return invoke("close_claude_session", { sessionId });
}

export function onClaudeEvent(callback: (payload: ClaudeEvent) => void): Promise<UnlistenFn> {
  return listen<ClaudeEvent>("claude-event", (event) => callback(event.payload));
}

export function onClaudeDone(callback: (payload: ClaudeDone) => void): Promise<UnlistenFn> {
  return listen<ClaudeDone>("claude-done", (event) => callback(event.payload));
}

export async function listSlashCommands(): Promise<SlashCommand[]> {
  return invoke("list_slash_commands");
}

export async function resolvePermission(requestId: string, allow: boolean): Promise<void> {
  return invoke("resolve_permission", { requestId, allow });
}

export async function searchFiles(cwd: string, query: string): Promise<string[]> {
  return invoke("search_files", { cwd, query });
}

export interface DiskSession {
  id: string;
  modified: number;
  size: number;
  summary: string;
}

export async function listDiskSessions(cwd: string): Promise<DiskSession[]> {
  return invoke("list_disk_sessions", { cwd });
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

export async function loadSessionHistory(sessionId: string, cwd: string): Promise<HistoryMessage[]> {
  return invoke("load_session_history", { sessionId, cwd });
}

/** Map Rust HistoryMessage[] (snake_case) to frontend ChatMessage format (camelCase) */
export function mapHistoryMessages(history: HistoryMessage[]) {
  return history.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    timestamp: m.timestamp,
    toolCalls: m.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
      result: tc.result,
      isError: tc.is_error,
    })),
  }));
}

export async function truncateSessionJsonl(sessionId: string, cwd: string, keepTurns: number): Promise<void> {
  return invoke("truncate_session_jsonl", { sessionId, cwd, keepTurns });
}

export async function truncateSessionJsonlAfterUuid(sessionId: string, cwd: string, lastUuid: string): Promise<void> {
  return invoke("truncate_session_jsonl_after_uuid", { sessionId, cwd, lastUuid });
}

export async function forkSessionJsonl(parentSessionId: string, newSessionId: string, cwd: string, keepTurns: number): Promise<void> {
  return invoke("fork_session_jsonl", { parentSessionId, newSessionId, cwd, keepTurns });
}

// Discord bot commands

export async function startDiscordBot(token: string, guildId: string): Promise<void> {
  return invoke("start_discord_bot", { token, guildId });
}

export async function stopDiscordBot(): Promise<void> {
  return invoke("stop_discord_bot");
}

export async function discordBotStatus(): Promise<boolean> {
  return invoke("discord_bot_status");
}

export async function linkSessionToDiscord(sessionId: string, sessionName: string, cwd: string = ""): Promise<void> {
  return invoke("link_session_to_discord", { sessionId, sessionName, cwd });
}

export async function renameDiscordSession(sessionId: string, sessionName: string, cwd: string = ""): Promise<void> {
  return invoke("rename_discord_session", { sessionId, sessionName, cwd });
}

export async function unlinkSessionFromDiscord(sessionId: string): Promise<void> {
  return invoke("unlink_session_from_discord", { sessionId });
}

export async function discordCleanupOrphaned(): Promise<void> {
  return invoke("discord_cleanup_orphaned");
}

export async function shellExec(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return invoke("shell_exec", { command, cwd });
}

export async function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function listMcpServers(cwd: string): Promise<McpServer[]> {
  return invoke("list_mcp_servers", { cwd });
}

export async function listDirectory(path: string): Promise<DirEntry[]> {
  return invoke("list_directory", { path });
}

// Delegation
export async function getDelegationPort(): Promise<number> {
  return invoke("get_delegation_port");
}

export async function getDelegationSecret(): Promise<string> {
  return invoke("get_delegation_secret");
}

export interface DelegationMsg {
  group_id: string;
  agent: string;
  message: string;
  timestamp: number;
  msg_type: string;
}

export async function getDelegationMessages(groupId: string): Promise<DelegationMsg[]> {
  return invoke("get_delegation_messages", { groupId });
}

export async function cleanupDelegationGroup(groupId: string): Promise<void> {
  return invoke("cleanup_delegation_group", { groupId });
}

export async function getAppDir(): Promise<string> {
  return invoke("get_app_dir");
}

/** Ensure the T64 MCP server entry exists in .mcp.json for the given cwd. */
export async function ensureT64Mcp(cwd: string): Promise<void> {
  const appDir = await getAppDir();
  const scriptPath = `${appDir}/mcp/t64-server.mjs`;
  const mcpPath = `${cwd}/.mcp.json`;

  const config: Record<string, any> = {};
  try {
    Object.assign(config, JSON.parse(await readFile(mcpPath)));
  } catch {}
  if (!config.mcpServers) config.mcpServers = {};

  // Only write if missing or command changed
  const existing = config.mcpServers["terminal-64"];
  if (existing?.args?.[0] === scriptPath) return;

  config.mcpServers["terminal-64"] = { command: "node", args: [scriptPath] };
  await writeFile(mcpPath, JSON.stringify(config, null, 2));
}

/**
 * Update the T64 MCP server entry in .mcp.json with delegation env vars.
 * Adds T64_DELEGATION_PORT, T64_DELEGATION_SECRET, T64_GROUP_ID, T64_AGENT_LABEL
 * so the MCP server exposes delegation tools for child sessions.
 */
export async function setT64DelegationEnv(
  cwd: string,
  delegationPort: number,
  delegationSecret: string,
  groupId: string,
  agentLabel = "Agent",
): Promise<void> {
  const appDir = await getAppDir();
  const scriptPath = `${appDir}/mcp/t64-server.mjs`;
  const mcpPath = `${cwd}/.mcp.json`;

  const config: Record<string, any> = {};
  try {
    Object.assign(config, JSON.parse(await readFile(mcpPath)));
  } catch {}
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers["terminal-64"] = {
    command: "node",
    args: [scriptPath],
    env: {
      T64_DELEGATION_PORT: String(delegationPort),
      T64_DELEGATION_SECRET: delegationSecret,
      T64_GROUP_ID: groupId,
      T64_AGENT_LABEL: agentLabel,
    },
  };
  await writeFile(mcpPath, JSON.stringify(config, null, 2));
}

/**
 * Remove delegation env vars from the T64 MCP entry, keeping the server itself.
 */
export async function clearT64DelegationEnv(cwd: string): Promise<void> {
  const appDir = await getAppDir();
  const scriptPath = `${appDir}/mcp/t64-server.mjs`;
  const mcpPath = `${cwd}/.mcp.json`;

  const config: Record<string, any> = {};
  try {
    Object.assign(config, JSON.parse(await readFile(mcpPath)));
  } catch { return; }

  const entry = config.mcpServers?.["terminal-64"];
  if (!entry?.env) return;

  // Reset to base config (no env)
  config.mcpServers["terminal-64"] = { command: "node", args: [scriptPath] };
  await writeFile(mcpPath, JSON.stringify(config, null, 2));
}

// Widget commands

export interface WidgetInfo {
  widget_id: string;
  has_index: boolean;
  modified: number;
}

export async function createWidgetFolder(widgetId: string): Promise<string> {
  return invoke("create_widget_folder", { widgetId });
}

export async function readWidgetHtml(widgetId: string): Promise<string> {
  return invoke("read_widget_html", { widgetId });
}

export async function listWidgetFolders(): Promise<WidgetInfo[]> {
  return invoke("list_widget_folders");
}

export async function widgetFileModified(widgetId: string): Promise<number> {
  return invoke("widget_file_modified", { widgetId });
}

export async function deleteWidgetFolder(widgetId: string): Promise<void> {
  return invoke("delete_widget_folder", { widgetId });
}

export async function getWidgetServerPort(): Promise<number> {
  return invoke("get_widget_server_port");
}

// Widget persistent state

export async function widgetGetState(widgetId: string, key?: string): Promise<any> {
  return invoke("widget_get_state", { widgetId, key: key ?? null });
}

export async function widgetSetState(widgetId: string, key: string, value: any): Promise<void> {
  return invoke("widget_set_state", { widgetId, key, value });
}

export async function widgetClearState(widgetId: string): Promise<void> {
  return invoke("widget_clear_state", { widgetId });
}

// Proxy fetch (CORS bypass for widgets)

export interface ProxyFetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  is_base64: boolean;
}

export async function proxyFetch(
  url: string,
  method?: string,
  headers?: Record<string, string>,
  body?: string,
  timeoutMs?: number,
): Promise<ProxyFetchResponse> {
  return invoke("proxy_fetch", {
    url,
    method: method ?? null,
    headers: headers ?? null,
    body: body ?? null,
    timeoutMs: timeoutMs ?? null,
  });
}

// System notification

export async function sendNotification(title: string, body?: string): Promise<void> {
  return invoke("send_notification", { title, body: body ?? null });
}

// Checkpoint commands (undo system)

export async function createCheckpoint(sessionId: string, turn: number, files: { path: string; content: string }[]): Promise<void> {
  return invoke("create_checkpoint", { sessionId, turn, files });
}

export async function restoreCheckpoint(sessionId: string, turn: number): Promise<string[]> {
  return invoke("restore_checkpoint", { sessionId, turn });
}

export async function cleanupCheckpoints(sessionId: string, keepUpToTurn: number): Promise<void> {
  return invoke("cleanup_checkpoints", { sessionId, keepUpToTurn });
}

export async function deleteFiles(paths: string[]): Promise<string[]> {
  return invoke("delete_files", { paths });
}

export async function revertFilesGit(cwd: string, paths: string[]): Promise<string[]> {
  return invoke("revert_files_git", { cwd, paths });
}

// Browser (native webview) commands

export async function createBrowser(id: string, url: string, x: number, y: number, w: number, h: number): Promise<void> {
  return invoke("create_browser", { id, url, x, y, w, h });
}

export async function navigateBrowser(id: string, url: string): Promise<void> {
  return invoke("navigate_browser", { id, url });
}

export async function setBrowserBounds(id: string, x: number, y: number, w: number, h: number): Promise<void> {
  return invoke("set_browser_bounds", { id, x, y, w, h });
}

export async function setBrowserVisible(id: string, visible: boolean): Promise<void> {
  return invoke("set_browser_visible", { id, visible });
}

export async function closeBrowser(id: string): Promise<void> {
  return invoke("close_browser", { id });
}

export async function setBrowserZoom(id: string, zoom: number): Promise<void> {
  return invoke("set_browser_zoom", { id, zoom });
}

export async function setAllBrowsersVisible(visible: boolean): Promise<void> {
  return invoke("set_all_browsers_visible", { visible });
}

export async function browserEval(id: string, js: string): Promise<void> {
  return invoke("browser_eval", { id, js });
}

export async function browserGoBack(id: string): Promise<void> {
  return invoke("browser_go_back", { id });
}

export async function browserGoForward(id: string): Promise<void> {
  return invoke("browser_go_forward", { id });
}

export async function browserReload(id: string): Promise<void> {
  return invoke("browser_reload", { id });
}

// Party Mode commands

export interface SpectrumData {
  bands: number[];
  peak: number;
  bass: number;
  mid: number;
  treble: number;
}

export async function startPartyMode(): Promise<void> {
  return invoke("start_party_mode");
}

export async function stopPartyMode(): Promise<void> {
  return invoke("stop_party_mode");
}

export async function partyModeStatus(): Promise<boolean> {
  return invoke("party_mode_status");
}

export function onPartyModeSpectrum(
  callback: (payload: SpectrumData) => void
): Promise<UnlistenFn> {
  return listen<SpectrumData>("party-mode-spectrum", (event) =>
    callback(event.payload)
  );
}
