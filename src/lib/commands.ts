import type { Command } from "./types";

const commandRegistry = new Map<string, Command>();

export function registerCommand(command: Command) {
  commandRegistry.set(command.id, command);
}

export function executeCommand(id: string, ...args: unknown[]) {
  const cmd = commandRegistry.get(id);
  if (cmd) {
    cmd.execute(...args);
  }
}

function getAllCommands(): Command[] {
  return Array.from(commandRegistry.values());
}
