import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CreateTerminalRequest,
  TerminalOutput,
  TerminalExit,
  CreateClaudeRequest,
  SendClaudePromptRequest,
  ClaudeEvent,
  ClaudeDone,
  CreateCodexRequest,
  SendCodexPromptRequest,
  CodexEvent,
  CodexDone,
  SlashCommand,
  DirEntry,
  McpServer,
  DiskSession,
  HistoryMessage,
  SessionMetadata,
  SessionJsonlStat,
  DelegationMsg,
  WidgetInfo,
  SkillInfo,
  ResolvedSkill,
  ProxyFetchResponse,
  SpectrumData,
  ChatMessage,
  ToolCall,
} from "./types";
import { joinPath } from "./platform";
import { decodeCodexPermission, PROVIDER_CONFIG, type ProviderId } from "./providers";

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

/** Read OpenWolf settings from persisted store (avoids circular imports). */
function getOpenwolfSettings(): { enabled: boolean; autoInit: boolean; designQc: boolean } {
  try {
    const raw = localStorage.getItem("terminal64-settings");
    if (raw) {
      const s = JSON.parse(raw);
      return {
        enabled: !!s.openwolfEnabled,
        autoInit: s.openwolfAutoInit !== false,
        designQc: !!s.openwolfDesignQC,
      };
    }
  } catch { /* ignore */ }
  return { enabled: false, autoInit: true, designQc: false };
}

const OW_DISABLED = { enabled: false, autoInit: false, designQc: false } as const;

function resolveOpenwolf(skipOpenwolf?: boolean) {
  return skipOpenwolf ? OW_DISABLED : getOpenwolfSettings();
}

/// Returns the backend-resolved session UUID. When the caller supplies a
/// non-empty `req.session_id`, that same value is echoed back; when it's
/// empty, the backend mints a fresh uuid before spawning the CLI so the
/// JSONL path is known immediately — no wait on the first `system/init`
/// stream event.
export async function createClaudeSession(req: CreateClaudeRequest, skipOpenwolf?: boolean): Promise<string> {
  const ow = resolveOpenwolf(skipOpenwolf);
  return invoke<string>("create_claude_session", {
    req,
    openwolfEnabled: ow.enabled,
    openwolfAutoInit: ow.autoInit,
    openwolfDesignQc: ow.designQc,
  });
}

export async function sendClaudePrompt(req: SendClaudePromptRequest, skipOpenwolf?: boolean): Promise<void> {
  const ow = resolveOpenwolf(skipOpenwolf);
  return invoke("send_claude_prompt", {
    req,
    openwolfEnabled: ow.enabled,
    openwolfAutoInit: ow.autoInit,
    openwolfDesignQc: ow.designQc,
  });
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

// ── Codex (OpenAI Codex CLI) ──────────────────────────────

export async function createCodexSession(req: CreateCodexRequest, skipOpenwolf?: boolean): Promise<string> {
  const ow = resolveOpenwolf(skipOpenwolf);
  return invoke<string>("create_codex_session", {
    req,
    openwolfEnabled: ow.enabled,
    openwolfAutoInit: ow.autoInit,
    openwolfDesignQc: ow.designQc,
  });
}

export async function sendCodexPrompt(req: SendCodexPromptRequest, skipOpenwolf?: boolean): Promise<void> {
  const ow = resolveOpenwolf(skipOpenwolf);
  return invoke("send_codex_prompt", {
    req,
    openwolfEnabled: ow.enabled,
    openwolfAutoInit: ow.autoInit,
    openwolfDesignQc: ow.designQc,
  });
}

export async function cancelCodex(sessionId: string): Promise<void> {
  return invoke("cancel_codex", { sessionId });
}

export async function closeCodexSession(sessionId: string): Promise<void> {
  return invoke("close_codex_session", { sessionId });
}

export async function rollbackCodexThread(threadId: string, cwd: string, numTurns: number): Promise<void> {
  return invoke("rollback_codex_thread", { threadId, cwd, numTurns });
}

export async function forkCodexThread(threadId: string, cwd: string, dropTurns: number): Promise<string> {
  return invoke<string>("fork_codex_thread", { threadId, cwd, dropTurns });
}

/// Hydrate a Codex chat from its on-disk rollout JSONL. `threadId` is the
/// Codex-assigned thread id captured from `thread.started`. Returns messages
/// in the same shape `loadSessionHistory` returns for Claude, so callers can
/// pipe through `mapHistoryMessages` unchanged.
export async function loadCodexSessionHistory(threadId: string): Promise<HistoryMessage[]> {
  return invoke<HistoryMessage[]>("load_codex_session_history", { threadId });
}

/// List on-disk Codex sessions whose original `cwd` matches `cwd`. Same shape
/// as `listDiskSessions` (Claude). Used by the new-session dialog when the
/// user has OpenAI selected.
export async function listCodexDiskSessions(cwd: string): Promise<DiskSession[]> {
  return invoke<DiskSession[]>("list_codex_disk_sessions", { cwd });
}

/// Truncate a Codex rollout by dropping the last `numTurns` completed turns
/// (turn-boundary granularity — Codex panics on partial turns). Returns the
/// number of turns removed after truncation. Used by the rewind flow.
export async function truncateCodexRollout(threadId: string, numTurns: number): Promise<number> {
  return invoke<number>("truncate_codex_rollout", { threadId, numTurns });
}

export function onCodexEvent(callback: (payload: CodexEvent) => void): Promise<UnlistenFn> {
  return listen<CodexEvent>("codex-event", (event) => callback(event.payload));
}

export function onCodexDone(callback: (payload: CodexDone) => void): Promise<UnlistenFn> {
  return listen<CodexDone>("codex-done", (event) => callback(event.payload));
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

export async function listDiskSessions(cwd: string): Promise<DiskSession[]> {
  return invoke("list_disk_sessions", { cwd });
}

export async function loadSessionHistory(sessionId: string, cwd: string): Promise<HistoryMessage[]> {
  return invoke("load_session_history", { sessionId, cwd });
}

/** Load only the last `limit` messages from JSONL. Cheap re-sync for the
 *  refresh button — avoids pumping a full 10k-message history over IPC. */
export async function loadSessionHistoryTail(sessionId: string, cwd: string, limit: number): Promise<HistoryMessage[]> {
  return invoke("load_session_history_tail", { sessionId, cwd, limit });
}

/** Cheap stat so the hydration cache can skip re-parsing when mtime+size haven't
 *  changed. Returns null if the JSONL hasn't been written yet. */
export async function statSessionJsonl(
  sessionId: string,
  cwd: string,
): Promise<SessionJsonlStat | null> {
  return invoke("stat_session_jsonl", { sessionId, cwd });
}

/** Stream-parse the JSONL and return only the metadata the session browser needs
 *  (count, first user prompt, last assistant preview, last timestamp). The primitive
 *  used to render a session list without touching the localStorage cache. */
export async function loadSessionMetadata(sessionId: string, cwd: string): Promise<SessionMetadata> {
  return invoke("load_session_metadata", { sessionId, cwd });
}

/** Map Rust HistoryMessage[] (snake_case) to frontend ChatMessage format (camelCase).
 *  Deduplicates by message id, last-write wins: rewinds/forks can legitimately
 *  rewrite a message under the same uuid, and the latest on-disk version is the
 *  authoritative one. Using a Map keeps the FIRST occurrence's insertion order
 *  while the VALUE is overwritten by subsequent occurrences. */
export function mapHistoryMessages(history: HistoryMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of history) {
    const toolCalls: ToolCall[] | undefined = m.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
      ...(tc.result !== undefined && { result: tc.result }),
      ...(tc.is_error !== undefined && { isError: tc.is_error }),
    }));
    const msg: ChatMessage = {
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: m.timestamp,
      ...(toolCalls !== undefined && { toolCalls }),
    };
    byId.set(m.id, msg);
  }
  return Array.from(byId.values());
}

export async function findRewindUuid(sessionId: string, cwd: string, keepMessages: number): Promise<string> {
  return invoke("find_rewind_uuid", { sessionId, cwd, keepMessages });
}

export async function truncateSessionJsonlByMessages(sessionId: string, cwd: string, keepMessages: number): Promise<unknown> {
  return invoke("truncate_session_jsonl_by_messages", { sessionId, cwd, keepMessages });
}

export async function forkSessionJsonl(parentSessionId: string, newSessionId: string, cwd: string, keepMessages: number): Promise<string> {
  return invoke("fork_session_jsonl", { parentSessionId, newSessionId, cwd, keepMessages });
}

/** Delete a session's JSONL file from disk. Delegation cleanup uses this so
 *  ephemeral children leave no trace; missing files are a no-op. */
export async function deleteSessionJsonl(sessionId: string, cwd: string): Promise<void> {
  return invoke("delete_session_jsonl", { sessionId, cwd });
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

export async function discordCleanupOrphaned(activeSessionIds: string[]): Promise<void> {
  return invoke("discord_cleanup_orphaned", { activeSessionIds });
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

export async function ensureCodexMcp(cwd: string): Promise<void> {
  return invoke("ensure_codex_mcp", { cwd });
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

export async function getDelegationMessages(groupId: string): Promise<DelegationMsg[]> {
  return invoke("get_delegation_messages", { groupId });
}

export async function cleanupDelegationGroup(groupId: string): Promise<void> {
  return invoke("cleanup_delegation_group", { groupId });
}

export async function getAppDir(): Promise<string> {
  return invoke("get_app_dir");
}

/** Create a temp MCP config file for delegation and return its path. */
export async function createMcpConfigFile(
  delegationPort: number,
  delegationSecret: string,
  groupId: string,
  agentLabel: string,
): Promise<string> {
  return invoke("create_mcp_config_file", {
    delegationPort,
    delegationSecret,
    groupId,
    agentLabel,
  });
}

async function getNodePath(): Promise<string> {
  return invoke("get_node_path");
}

/** Ensure the T64 MCP server entry exists in .mcp.json for the given cwd.
 *  Uses the backend's resolve_node_path() so the full node binary path is written
 *  (bare "node" fails when Claude CLI inherits Tauri's limited PATH). */
export async function ensureT64Mcp(cwd: string): Promise<void> {
  return invoke("ensure_t64_mcp", { cwd });
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
  const nodePath = await getNodePath();
  const scriptPath = joinPath(appDir, "mcp", "t64-server.mjs");
  const mcpPath = joinPath(cwd, ".mcp.json");

  console.log("[delegation] setT64DelegationEnv:", { cwd, mcpPath, scriptPath, nodePath, delegationPort, groupId });

  const config: Record<string, any> = {};
  try {
    Object.assign(config, JSON.parse(await readFile(mcpPath)));
    console.log("[delegation] Existing .mcp.json loaded");
  } catch {
    console.log("[delegation] No existing .mcp.json — creating fresh");
  }
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers["terminal-64"] = {
    command: nodePath,
    args: [scriptPath],
    env: {
      T64_DELEGATION_PORT: String(delegationPort),
      T64_DELEGATION_SECRET: delegationSecret,
      T64_GROUP_ID: groupId,
      T64_AGENT_LABEL: agentLabel,
    },
  };
  const json = JSON.stringify(config, null, 2);
  await writeFile(mcpPath, json);

  // Verify the write succeeded
  try {
    const verify = await readFile(mcpPath);
    const parsed = JSON.parse(verify);
    const env = parsed?.mcpServers?.["terminal-64"]?.env;
    if (env?.T64_DELEGATION_PORT && env?.T64_GROUP_ID) {
      console.log("[delegation] .mcp.json verified — delegation env active");
    } else {
      console.error("[delegation] .mcp.json written but delegation env missing!", verify.slice(0, 200));
    }
  } catch (err) {
    console.error("[delegation] .mcp.json verification FAILED:", err);
  }
}

/**
 * Remove delegation env vars from the T64 MCP entry, keeping the server itself.
 */
export async function clearT64DelegationEnv(cwd: string): Promise<void> {
  const appDir = await getAppDir();
  const nodePath = await getNodePath();
  const scriptPath = joinPath(appDir, "mcp", "t64-server.mjs");
  const mcpPath = joinPath(cwd, ".mcp.json");

  const config: Record<string, any> = {};
  try {
    Object.assign(config, JSON.parse(await readFile(mcpPath)));
  } catch { return; }

  const entry = config.mcpServers?.["terminal-64"];
  if (!entry?.env) return;

  config.mcpServers["terminal-64"] = { command: nodePath, args: [scriptPath] };
  await writeFile(mcpPath, JSON.stringify(config, null, 2));
}

// Widget commands

export async function createWidgetFolder(widgetId: string): Promise<string> {
  return invoke("create_widget_folder", { widgetId });
}

export async function listWidgetFolders(): Promise<WidgetInfo[]> {
  return invoke("list_widget_folders");
}

export async function installBundledWidget(widgetName: string): Promise<void> {
  return invoke("install_bundled_widget", { widgetName });
}

export async function widgetFileModified(widgetId: string): Promise<number> {
  return invoke("widget_file_modified", { widgetId });
}

export async function deleteWidgetFolder(widgetId: string): Promise<void> {
  return invoke("delete_widget_folder", { widgetId });
}

export async function installWidgetZip(zipPath: string): Promise<string> {
  return invoke("install_widget_zip", { zipPath });
}

export async function getWidgetServerPort(): Promise<number> {
  return invoke("get_widget_server_port");
}

// Plugin manifest + approval (widget.json / .approved.json)

export interface WidgetManifestEnvelope {
  raw: unknown;
  rawText: string;
  hash: string;
}

export async function readWidgetManifest(widgetId: string): Promise<WidgetManifestEnvelope | null> {
  return invoke("read_widget_manifest", { widgetId });
}

export async function readWidgetApproval(widgetId: string): Promise<unknown | null> {
  return invoke("read_widget_approval", { widgetId });
}

export async function writeWidgetApproval(widgetId: string, content: string): Promise<void> {
  return invoke("write_widget_approval", { widgetId, content });
}

// Widget persistent state

export async function widgetGetState(widgetId: string, key?: string): Promise<unknown> {
  return invoke("widget_get_state", { widgetId, key: key ?? null });
}

export async function widgetSetState(widgetId: string, key: string, value: unknown): Promise<void> {
  return invoke("widget_set_state", { widgetId, key, value });
}

export async function widgetClearState(widgetId: string): Promise<void> {
  return invoke("widget_clear_state", { widgetId });
}

// Skill library commands

export async function createSkillFolder(skillId: string): Promise<string> {
  return invoke("create_skill_folder", { skillId });
}

export async function listSkills(): Promise<SkillInfo[]> {
  return invoke("list_skills");
}

export async function syncClaudeSkills(): Promise<string[]> {
  return invoke("sync_claude_skills");
}

export async function generateSkillMetadata(skillId: string): Promise<void> {
  return invoke("generate_skill_metadata", { skillId });
}

export async function deleteSkill(skillId: string): Promise<void> {
  return invoke("delete_skill", { skillId });
}

export async function readSkillContent(skillId: string): Promise<string> {
  return invoke("read_skill_content", { skillId });
}

export async function resolveSkillPrompt(
  skillName: string,
  args: string,
  cwd?: string
): Promise<ResolvedSkill> {
  return invoke("resolve_skill_prompt", {
    skillName,
    arguments: args,
    cwd: cwd ?? null,
  });
}

export async function getSkillCreatorPath(): Promise<string> {
  return invoke("get_skill_creator_path");
}

export async function ensureSkillsPlugin(): Promise<void> {
  return invoke("ensure_skills_plugin");
}

export async function ensureCodexSkills(): Promise<void> {
  return invoke("ensure_codex_skills");
}

// Proxy fetch (CORS bypass for widgets)

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

export async function filterUntrackedFiles(cwd: string, paths: string[]): Promise<string[]> {
  return invoke("filter_untracked_files", { cwd, paths });
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

// Theme generation

export async function generateTheme(prompt: string): Promise<string> {
  return invoke("generate_theme", { prompt });
}

export function onThemeGenChunk(callback: (payload: { id: string; text: string }) => void): Promise<UnlistenFn> {
  return listen<{ id: string; text: string }>("theme-gen-chunk", (event) => callback(event.payload));
}

export function onThemeGenDone(callback: (payload: { id: string; text: string }) => void): Promise<UnlistenFn> {
  return listen<{ id: string; text: string }>("theme-gen-done", (event) => callback(event.payload));
}

// Party Mode commands

export async function startPartyMode(): Promise<void> {
  return invoke("start_party_mode");
}

export async function stopPartyMode(): Promise<void> {
  return invoke("stop_party_mode");
}

export function onPartyModeSpectrum(
  callback: (payload: SpectrumData) => void
): Promise<UnlistenFn> {
  return listen<SpectrumData>("party-mode-spectrum", (event) =>
    callback(event.payload)
  );
}

// OpenWolf daemon commands

export async function startOpenwolfDaemon(cwd: string): Promise<void> {
  return invoke("start_openwolf_daemon", { cwd });
}

export async function stopOpenwolfDaemon(cwd: string): Promise<void> {
  return invoke("stop_openwolf_daemon", { cwd });
}

export async function openwolfDaemonStatus(): Promise<boolean> {
  return invoke("openwolf_daemon_status");
}

export interface OpenWolfDaemonInfo {
  running: boolean;
  name: string | null;
  cwd: string | null;
  pid: number | null;
  uptime_ms: number | null;
  memory: number | null;
  cpu: number | null;
  restarts: number | null;
  status: string | null;
}

/** Stop all openwolf daemons and start a new one in the given cwd. */
export async function openwolfDaemonSwitch(cwd: string): Promise<void> {
  return invoke("openwolf_daemon_switch", { cwd });
}

export async function openwolfDaemonInfo(): Promise<OpenWolfDaemonInfo> {
  return invoke("openwolf_daemon_info");
}

export async function openwolfDaemonStopAll(): Promise<void> {
  return invoke("openwolf_daemon_stop_all");
}

/** Returns the project-intel widget's saved project cwd (or null). */
export async function openwolfProjectCwd(): Promise<string | null> {
  return invoke("openwolf_project_cwd");
}

// Image paste commands

export async function savePastedImage(base64Data: string, extension: string): Promise<string> {
  return invoke("save_pasted_image", { base64Data, extension });
}

export async function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

// ── Shared helpers ──────────────────────────────────

/**
 * Spawn a Claude session panel on the canvas with an initial prompt.
 * Consolidates the duplicated pattern from WidgetDialog + SkillDialog.
 *
 * @param cwd       Working directory for the Claude CLI
 * @param sessionName  Display name for the session
 * @param prompt    Initial prompt to send
 * @param getStores  Lazy getter to avoid circular imports — returns {canvasStore, claudeStore, settingsStore}
 */
export function spawnClaudeWithPrompt(
  cwd: string,
  sessionName: string,
  prompt: string,
  getStores: () => {
    canvasStore: { getState: () => any };
    claudeStore: { getState: () => any };
    settingsStore: { getState: () => any };
  },
  options?: { skipOpenwolf?: boolean; provider?: ProviderId },
): void {
  const { canvasStore, claudeStore, settingsStore } = getStores();
  const provider = options?.provider ?? "anthropic";
  canvasStore.getState().addClaudeTerminal(cwd, false, sessionName);
  const terminals = canvasStore.getState().terminals;
  const claudePanel = terminals[terminals.length - 1];
  if (!claudePanel || claudePanel.panelType !== "claude") return;

  const sid = claudePanel.terminalId;
  const skip = options?.skipOpenwolf;
  claudeStore.getState().createSession(sid, sessionName, false, skip, cwd, provider);
  claudeStore.getState().addUserMessage(sid, prompt);
  // Small delay so ClaudeChat mounts and event listeners are ready
  setTimeout(() => {
    if (provider === "openai") {
      const codexPerm = decodeCodexPermission(PROVIDER_CONFIG.openai.defaultPermission);
      Promise.allSettled([ensureCodexMcp(cwd), ensureCodexSkills()])
        .then(() => createCodexSession({
          session_id: sid,
          cwd,
          prompt,
          ...codexPerm,
        }, options?.skipOpenwolf))
        .then(() => {
          claudeStore.getState().incrementPromptCount(sid);
        })
        .catch((err: unknown) => {
          claudeStore.getState().setError(sid, String(err));
        });
    } else {
      const permMode = settingsStore.getState().claudePermMode || "default";
      createClaudeSession({
        session_id: sid,
        cwd,
        prompt,
        permission_mode: permMode,
      }, options?.skipOpenwolf).then(() => {
        claudeStore.getState().incrementPromptCount(sid);
      }).catch((err: unknown) => {
        claudeStore.getState().setError(sid, String(err));
      });
    }
  }, 300);
}
