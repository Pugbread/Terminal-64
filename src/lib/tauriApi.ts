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
  McpServer,
  DirEntry,
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
