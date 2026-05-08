import {
  getProviderToolFilePath,
  type ProviderToolInput,
} from "../../contracts/providerEvents";
import type { ToolCall } from "../../lib/types";

export type ToolPresentationKind =
  | "shell"
  | "file-read"
  | "file-write"
  | "search"
  | "web"
  | "task"
  | "mcp"
  | "question"
  | "other";

export interface ToolHeaderPresentation {
  icon: string;
  title: string;
  detail: string;
  kind: ToolPresentationKind;
}

export interface ToolGroupPresentation {
  icon: string;
  name: string;
  details: string;
  kind: ToolPresentationKind;
  count: number;
  toolNames: string[];
}

export interface ToolGroupItemPresentation extends ToolHeaderPresentation {
  status: "done" | "error" | "pending";
  statusLabel: string;
  resultSummary: string;
}

interface ToolPresentationDefinition {
  name: string;
  icon: string;
  title: string;
  kind: ToolPresentationKind;
  groupable?: boolean;
  detail: (input: ProviderToolInput) => string;
  groupName?: (count: number) => string;
  groupDetails?: (tools: ToolCall[]) => string;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(input: ProviderToolInput, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function shortPath(fp: unknown): string {
  if (!fp) return "";
  return String(fp).split(/[/\\]/).slice(-2).join("/");
}

export function summarizeFallback(input: ProviderToolInput): string {
  const first = Object.values(input)[0];
  return typeof first === "string" ? first.slice(0, 50) : "";
}

function compactList(values: string[], max = 3, maxChars = 44): string {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  const shown = clean.slice(0, max).map((value) => (
    value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value
  ));
  const extra = clean.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
}

function resultSummary(tc: ToolCall): string {
  if (tc.result === undefined) return "Running";
  if (!tc.result) return tc.isError ? "Error" : "Done";
  const lines = tc.result.split("\n").length;
  const chars = tc.result.length;
  if (lines > 1) return `${lines} lines`;
  return `${chars} chars`;
}

function parseMcpName(name: string, input: ProviderToolInput): { server: string; tool: string } {
  const claudeStyle = name.match(/^mcp__(.+?)__(.+)$/i);
  if (claudeStyle?.[1] && claudeStyle[2]) {
    return { server: claudeStyle[1], tool: claudeStyle[2] };
  }

  const slashStyle = name.match(/^([^/]+)\/(.+)$/);
  if (slashStyle?.[1] && slashStyle[2]) {
    return { server: slashStyle[1], tool: slashStyle[2] };
  }

  const server = firstString(input, ["server", "mcp_server", "serverName"]);
  const tool = firstString(input, ["tool_name", "toolName", "name"]);
  return { server, tool: tool || name };
}

const TOOL_PRESENTATION_DEFINITIONS = [
  {
    name: "Bash",
    icon: "$",
    title: "Bash",
    kind: "shell",
    groupable: true,
    detail: (input) => stringValue(input.command).slice(0, 80),
    groupName: (count) => `Ran ${count} commands`,
    groupDetails: (tools) => compactList(tools.map((tc) => stringValue(tc.input.command)), 2, 40),
  },
  {
    name: "Read",
    icon: "◉",
    title: "Read",
    kind: "file-read",
    groupable: true,
    detail: (input) => shortPath(getProviderToolFilePath(input)),
    groupName: (count) => `Read ${count} files`,
    groupDetails: (tools) => compactList(tools.map((tc) => shortPath(getProviderToolFilePath(tc.input)))),
  },
  {
    name: "LS",
    icon: "◉",
    title: "LS",
    kind: "file-read",
    groupable: true,
    detail: (input) => shortPath(getProviderToolFilePath(input) || input.directory || input.dir),
    groupName: (count) => `Listed ${count} dirs`,
    groupDetails: (tools) => compactList(tools.map((tc) => shortPath(getProviderToolFilePath(tc.input) || tc.input.directory || tc.input.dir))),
  },
  {
    name: "Grep",
    icon: "⊛",
    title: "Grep",
    kind: "search",
    groupable: true,
    detail: (input) => `/${stringValue(input.pattern)}/`,
    groupName: (count) => `${count} searches`,
    groupDetails: (tools) => compactList(tools.map((tc) => `/${stringValue(tc.input.pattern)}/`)),
  },
  {
    name: "Glob",
    icon: "⊛",
    title: "Glob",
    kind: "search",
    groupable: true,
    detail: (input) => stringValue(input.pattern),
    groupName: (count) => `${count} globs`,
    groupDetails: (tools) => compactList(tools.map((tc) => stringValue(tc.input.pattern))),
  },
  {
    name: "WebSearch",
    icon: "⌕",
    title: "Search",
    kind: "web",
    groupable: true,
    detail: (input) => stringValue(input.query).slice(0, 60),
    groupName: (count) => `${count} web searches`,
    groupDetails: (tools) => compactList(tools.map((tc) => stringValue(tc.input.query))),
  },
  {
    name: "WebFetch",
    icon: "↓",
    title: "Fetch",
    kind: "web",
    groupable: true,
    detail: (input) => stringValue(input.url).slice(0, 60),
    groupName: (count) => `Fetched ${count} URLs`,
    groupDetails: (tools) => compactList(tools.map((tc) => stringValue(tc.input.url)), 3, 40),
  },
  {
    name: "Edit",
    icon: "✎",
    title: "Edit",
    kind: "file-write",
    detail: (input) => shortPath(getProviderToolFilePath(input)),
  },
  {
    name: "Write",
    icon: "+",
    title: "Write",
    kind: "file-write",
    detail: (input) => shortPath(getProviderToolFilePath(input)),
  },
  {
    name: "MultiEdit",
    icon: "✎",
    title: "MultiEdit",
    kind: "file-write",
    detail: (input) => shortPath(getProviderToolFilePath(input)),
  },
  {
    name: "Task",
    icon: "◈",
    title: "Task",
    kind: "task",
    detail: (input) => firstString(input, ["description", "prompt"]).slice(0, 60),
  },
  {
    name: "Agent",
    icon: "◈",
    title: "Task",
    kind: "task",
    detail: (input) => firstString(input, ["description", "prompt"]).slice(0, 60),
  },
  {
    name: "TodoWrite",
    icon: "☑",
    title: "Todo",
    kind: "task",
    detail: (input) => Array.isArray(input.todos) ? `${input.todos.length} items` : "",
  },
  {
    name: "Skill",
    icon: "/",
    title: "Skill",
    kind: "task",
    detail: (input) => stringValue(input.args),
  },
  {
    name: "NotebookEdit",
    icon: "✎",
    title: "Notebook",
    kind: "file-write",
    detail: (input) => shortPath(getProviderToolFilePath(input)),
  },
  {
    name: "AskUserQuestion",
    icon: "?",
    title: "Question",
    kind: "question",
    detail: () => "",
  },
] satisfies ToolPresentationDefinition[];

const TOOL_PRESENTATION_BY_NAME = new Map(
  TOOL_PRESENTATION_DEFINITIONS.map((definition) => [definition.name, definition]),
);

export const GROUPABLE_TOOLS = new Set(
  TOOL_PRESENTATION_DEFINITIONS
    .filter((definition) => definition.groupable)
    .map((definition) => definition.name),
);

function isMcpToolCall(tc: ToolCall): boolean {
  return Boolean(tc.name.includes("__") || tc.name.includes("/") || tc.input.server || tc.input.tool_name || tc.input.toolName);
}

export function isGroupableToolCall(tc: ToolCall): boolean {
  return GROUPABLE_TOOLS.has(tc.name) || isMcpToolCall(tc);
}

export function toolGroupKey(tc: ToolCall): string {
  const definition = TOOL_PRESENTATION_BY_NAME.get(tc.name);
  if (definition) return `tool:${definition.name}`;
  if (isMcpToolCall(tc)) {
    const { server, tool } = parseMcpName(tc.name, tc.input);
    return `mcp:${server}:${tool}`;
  }
  return `tool:${tc.name}`;
}

export function toolHeader(tc: ToolCall): ToolHeaderPresentation {
  const definition = TOOL_PRESENTATION_BY_NAME.get(tc.name);
  if (definition) {
    const title = tc.name === "Skill" && typeof tc.input.skill === "string" && tc.input.skill
      ? tc.input.skill
      : definition.title;
    return {
      icon: definition.icon,
      title,
      detail: definition.detail(tc.input),
      kind: definition.kind,
    };
  }

  if (isMcpToolCall(tc)) {
    const mcpName = parseMcpName(tc.name, tc.input);
    const args = tc.input.arguments && typeof tc.input.arguments === "object"
      ? summarizeFallback(tc.input.arguments as ProviderToolInput)
      : summarizeFallback(tc.input);
    const detail = compactList([mcpName.server ? `MCP ${mcpName.server}` : "", args], 2, 60);
    return { icon: "⊛", title: mcpName.tool, detail, kind: "mcp" };
  }

  return { icon: "⚙", title: tc.name, detail: summarizeFallback(tc.input), kind: "other" };
}

export function toolGroupLabel(tcs: ToolCall[]): ToolGroupPresentation {
  const first = tcs[0]?.name;
  const toolNames = [...new Set(tcs.map((tc) => tc.name))];
  if (first && tcs.every((tc) => tc.name === first)) {
    const definition = TOOL_PRESENTATION_BY_NAME.get(first);
    if (definition?.groupable) {
      return {
        icon: definition.icon,
        name: definition.groupName?.(tcs.length) ?? `${tcs.length} ${definition.title}`,
        details: definition.groupDetails?.(tcs) ?? "",
        kind: definition.kind,
        count: tcs.length,
        toolNames,
      };
    }
  }

  const firstTool = tcs[0];
  if (firstTool && tcs.every((tc) => toolGroupKey(tc) === toolGroupKey(firstTool))) {
    const header = toolHeader(firstTool);
    const details = compactList(tcs.map((tc) => toolHeader(tc).detail), 3, 44);
    return {
      icon: header.icon,
      name: `${header.title} x${tcs.length}`,
      details,
      kind: header.kind,
      count: tcs.length,
      toolNames,
    };
  }

  const counts = toolNames.map((name) => `${name} x${tcs.filter((tc) => tc.name === name).length}`);
  return {
    icon: "⊛",
    name: `${tcs.length} tool calls`,
    details: compactList(counts, 4, 24),
    kind: "other",
    count: tcs.length,
    toolNames,
  };
}

export function toolGroupItem(tc: ToolCall): ToolGroupItemPresentation {
  const header = toolHeader(tc);
  const status = tc.result === undefined ? "pending" : tc.isError ? "error" : "done";
  return {
    ...header,
    status,
    statusLabel: status === "pending" ? "Running" : status === "error" ? "Error" : "Done",
    resultSummary: resultSummary(tc),
  };
}
