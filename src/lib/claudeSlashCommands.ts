import type { SlashCommand } from "./types";

/**
 * Known Claude Code built-in slash commands.
 * These are always available in any Claude session and supplement
 * dynamically-discovered commands from the CLI.
 */
export const CLAUDE_BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "compact",
    description: "Compact conversation context to reduce token usage",
    usage: "/compact [instructions] — summarize the conversation, optionally with custom focus instructions.",
    source: "built-in",
  },
  {
    name: "cost",
    description: "Show session cost and token usage statistics",
    usage: "/cost — display total cost, token counts, and context utilization.",
    source: "built-in",
  },
  {
    name: "context",
    description: "Show current context window usage",
    usage: "/context — display how much of the context window is being used.",
    source: "built-in",
  },
  {
    name: "model",
    description: "Switch the AI model for this session",
    usage: "/model <model-name> — switch to a different model (e.g. sonnet, opus, haiku).",
    source: "built-in",
  },
  {
    name: "export",
    description: "Export the current conversation to a file",
    usage: "/export [format] — export conversation as markdown or JSON.",
    source: "built-in",
  },
  {
    name: "diff",
    description: "Show all file changes made in this session",
    usage: "/diff — display a unified diff of all modifications.",
    source: "built-in",
  },
  {
    name: "review",
    description: "Review a pull request or code changes",
    usage: "/review — request a review of recent changes or a PR.",
    source: "built-in",
  },
  {
    name: "permissions",
    description: "Show and manage tool permissions",
    usage: "/permissions — display current permission settings and allowed tools.",
    source: "built-in",
  },
  {
    name: "clear",
    description: "Clear the conversation history and start fresh",
    usage: "/clear — reset the conversation while keeping the session alive.",
    source: "built-in",
  },
  {
    name: "help",
    description: "Show available commands and help information",
    usage: "/help — list all available slash commands.",
    source: "built-in",
  },
  {
    name: "config",
    description: "View or modify Claude Code configuration",
    usage: "/config — show or update configuration settings.",
    source: "built-in",
  },
  {
    name: "memory",
    description: "Manage Claude's project memory (CLAUDE.md)",
    usage: "/memory — view, add, or edit project memory entries.",
    source: "built-in",
  },
  {
    name: "mcp",
    description: "Manage MCP server connections",
    usage: "/mcp — show MCP server status, connect, or disconnect servers.",
    source: "built-in",
  },
  {
    name: "vim",
    description: "Toggle vim keybindings mode",
    usage: "/vim — enable or disable vim-style key bindings in the editor.",
    source: "built-in",
  },
  {
    name: "terminal-setup",
    description: "Configure terminal appearance and behavior",
    usage: "/terminal-setup — customize terminal settings.",
    source: "built-in",
  },
  {
    name: "hooks",
    description: "View and manage event hooks",
    usage: "/hooks — list, add, or remove hooks that run on events.",
    source: "built-in",
  },
];
