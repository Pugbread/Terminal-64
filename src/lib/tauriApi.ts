import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { CreateTerminalRequest, TerminalOutput, TerminalExit } from "./types";

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

export async function getClaudeSessionId(projectDir: string): Promise<string> {
  return invoke("get_claude_session_id", { projectDir });
}

export function onTerminalExit(callback: (payload: TerminalExit) => void): Promise<UnlistenFn> {
  return listen<TerminalExit>("terminal-exit", (event) => callback(event.payload));
}
