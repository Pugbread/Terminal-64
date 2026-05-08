import type { ChatMessage, PermissionMode, ToolCall } from "./types";
import { getProviderDelegationPolicy, type ProviderId } from "./providers";

export interface DelegationPlanTask {
  description: string;
  agentName?: string;
}

export interface DelegationStartPlan {
  context: string;
  tasks: DelegationPlanTask[];
}

export interface DelegationPlanPromptInput {
  userGoal: string;
  startToolName: string;
  fallbackTagName: string;
}

export interface DelegationWorkflowRuntimeHooks {
  buildPlannerPrompt?: (input: DelegationPlanPromptInput) => string;
}

export interface DelegationPlanRequest {
  displayText: string;
  providerPrompt: string;
  command: {
    kind: "delegate-plan";
    name: "delegate";
    originalText: string;
  };
  permissionOverride?: PermissionMode | undefined;
}

export interface BuildDelegationPlanRequestOptions {
  provider: ProviderId;
  userGoal: string;
  permissionOverride?: PermissionMode | undefined;
  runtimeHooks?: DelegationWorkflowRuntimeHooks | undefined;
}

export interface DelegationChildSpawnPlan {
  agentLabel: string;
  childName: string;
  initialPrompt: string;
}

export interface BuildDelegationChildSpawnPlanOptions {
  sharedContext: string;
  taskDescription: string;
  agentName?: string | undefined;
  taskIndex: number;
  taskCount: number;
  teamChatEnabled: boolean;
}

export const START_DELEGATION_TOOL_NAME = "StartDelegation";
export const START_DELEGATION_FALLBACK_TAG = "T64_START_DELEGATION";

export function parseDelegateCommand(text: string): string | null {
  const match = text.match(/^\/delegate\s+([\s\S]+)/i);
  const goal = match?.[1]?.trim() ?? "";
  return goal ? goal : null;
}

export function resolveDelegationPlannerPermissionOverride(
  provider: ProviderId,
  requestedOverride?: PermissionMode | undefined,
): PermissionMode | undefined {
  if (requestedOverride !== undefined) return requestedOverride;

  const policy = getProviderDelegationPolicy(provider).planner.permissionOverride;
  return policy === "inherit" ? undefined : policy;
}

function defaultDelegationPlannerPrompt({
  userGoal,
  startToolName,
  fallbackTagName,
}: DelegationPlanPromptInput): string {
  return `You are orchestrating a Terminal 64 delegation. The user wants to split work across multiple parallel coding agents.

USER'S GOAL: ${userGoal}

Your job: analyze this goal and decide how many parallel agents are needed (minimum 2, maximum 8). Use your judgment - simple tasks may only need 2 agents, complex multi-part tasks may need 5+. Do not over-parallelize; only create agents for truly independent work.

Use the terminal-64 MCP tool ${startToolName}. Do not write a delegation block manually.

Call ${startToolName} with:
- context: one paragraph of shared context all agents need
- tasks: an array of 2-8 objects, each with a description field and optional agentName field

If ${startToolName} is not immediately callable, not available in your tool registry, deferred, or shown with an unloaded schema, output exactly this fallback shape and no other text:
<${fallbackTagName}>
{"context":"one paragraph of shared context","tasks":[{"agentName":"Builder","description":"specific independent task 1"},{"agentName":"Verifier","description":"specific independent task 2"}]}
</${fallbackTagName}>

Rules:
- Each task must be independently completable - no task should depend on another's output
- Keep task descriptions specific and actionable
- The context should include project info, constraints, and the overall goal
- Fewer focused agents > many tiny agents. If two things are tightly coupled, keep them in one task
- Do not try to load deferred tool schemas, use ToolSearch, or explain that a tool is unavailable
- Call ${startToolName} immediately if available; otherwise use the fallback JSON tag immediately.`;
}

export function buildDelegationPlanRequest({
  provider,
  userGoal,
  permissionOverride,
  runtimeHooks,
}: BuildDelegationPlanRequestOptions): DelegationPlanRequest {
  const displayText = `/delegate ${userGoal}`;
  const promptInput: DelegationPlanPromptInput = {
    userGoal,
    startToolName: START_DELEGATION_TOOL_NAME,
    fallbackTagName: START_DELEGATION_FALLBACK_TAG,
  };
  const providerPrompt = runtimeHooks?.buildPlannerPrompt?.(promptInput)
    ?? defaultDelegationPlannerPrompt(promptInput);
  const resolvedPermissionOverride = resolveDelegationPlannerPermissionOverride(provider, permissionOverride);
  const request: DelegationPlanRequest = {
    displayText,
    providerPrompt,
    command: { kind: "delegate-plan", name: "delegate", originalText: displayText },
  };
  if (resolvedPermissionOverride !== undefined) {
    request.permissionOverride = resolvedPermissionOverride;
  }
  return request;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordStringValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function normalizeToolName(name: string): string {
  return name
    .replace(/^mcp__[^_]+__/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export function isStartDelegationTool(toolCall: ToolCall): boolean {
  const candidates = [
    toolCall.name,
    stringValue(toolCall.input.name),
    stringValue(toolCall.input.toolName),
    stringValue(toolCall.input.tool_name),
  ];
  return candidates.some((candidate) => {
    const normalized = normalizeToolName(candidate);
    return normalized === "startdelegation" || normalized.endsWith("startdelegation");
  });
}

function delegationInputCandidates(input: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [input];
  const argumentsRecord = recordValue(input.arguments) ?? recordStringValue(input.arguments);
  if (argumentsRecord) candidates.push(argumentsRecord);

  const args = recordValue(input.args) ?? recordStringValue(input.args);
  if (args) {
    candidates.push(args);
    const nestedArgs = recordValue(args.args) ?? recordStringValue(args.args);
    if (nestedArgs) candidates.push(nestedArgs);
  }

  const inputObject = recordValue(input.input);
  if (inputObject) candidates.push(inputObject);

  return candidates;
}

function parseTasks(rawTasks: unknown): DelegationPlanTask[] {
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks
    .map((task): DelegationPlanTask | null => {
      if (typeof task === "string") {
        const description = task.trim();
        return description ? { description } : null;
      }
      const record = recordValue(task);
      if (!record) return null;
      const description = stringValue(record.description)
        || stringValue(record.task)
        || stringValue(record.goal)
        || stringValue(record.name);
      if (!description) return null;
      const agentName = stringValue(record.agentName)
        || stringValue(record.agent_name)
        || stringValue(record.agent)
        || stringValue(record.assignee)
        || stringValue(record.label);
      return agentName ? { description, agentName } : { description };
    })
    .filter((task): task is DelegationPlanTask => task != null)
    .slice(0, 8)
}

function parseStartDelegationCandidate(input: Record<string, unknown>): DelegationStartPlan | null {
  const context = stringValue(input.context)
    || stringValue(input.shared_context)
    || stringValue(input.sharedContext)
    || stringValue(input.goal);
  const rawTasks = Array.isArray(input.tasks)
    ? input.tasks
    : Array.isArray(input.agents)
      ? input.agents
      : [];
  const tasks = parseTasks(rawTasks);

  if (tasks.length < 2) return null;
  return { context, tasks };
}

export function parseStartDelegationToolInput(input: Record<string, unknown>): DelegationStartPlan | null {
  for (const candidate of delegationInputCandidates(input)) {
    const parsed = parseStartDelegationCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export function parseStartDelegationJsonText(text: string): DelegationStartPlan | null {
  const tagged = text.match(/<T64_START_DELEGATION>\s*([\s\S]*?)\s*<\/T64_START_DELEGATION>/i)?.[1];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = tagged || fenced || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    const record = recordValue(parsed);
    return record ? parseStartDelegationToolInput(record) : null;
  } catch {
    return null;
  }
}

export function parseLegacyDelegationBlock(text: string): DelegationStartPlan | null {
  const startIdx = text.indexOf("[DELEGATION_START]");
  const endIdx = text.indexOf("[DELEGATION_END]");
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;

  const block = text.slice(startIdx, endIdx + "[DELEGATION_END]".length);
  const contextMatch = block.match(/\[CONTEXT\]\s*(.*)/);
  const taskMatches = [...block.matchAll(/\[TASK\]\s*(.*)/g)];
  const tasks = taskMatches
    .map((match) => match[1]?.trim() ?? "")
    .filter((description) => description.length > 0)
    .slice(0, 8)
    .map((description) => ({ description }));

  if (tasks.length === 0) return null;
  return { context: contextMatch?.[1]?.trim() || "", tasks };
}

export function parseDelegationStartFromMessage(
  message: Pick<ChatMessage, "content" | "toolCalls">,
): DelegationStartPlan | null {
  const startDelegationTool = message.toolCalls?.find(isStartDelegationTool);
  if (startDelegationTool) {
    const parsed = parseStartDelegationToolInput(startDelegationTool.input);
    if (parsed) return parsed;
  }

  return parseStartDelegationJsonText(message.content)
    ?? parseLegacyDelegationBlock(message.content);
}

export function resolveDelegationChildCwd({
  effectiveCwd,
  sessionCwd,
}: {
  effectiveCwd: string;
  sessionCwd?: string | undefined;
}): string {
  if (effectiveCwd && effectiveCwd !== "." && effectiveCwd !== "/") return effectiveCwd;
  if (sessionCwd && sessionCwd !== "." && sessionCwd !== "/") return sessionCwd;
  return "";
}

export function buildDelegationAgentLabel(index: number): string {
  return `Agent ${index + 1}`;
}

function normalizeAgentName(agentName: string | undefined): string {
  return (agentName || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

export function resolveDelegationAgentLabel(index: number, agentName?: string | undefined): string {
  return normalizeAgentName(agentName) || buildDelegationAgentLabel(index);
}

export function buildDelegationChildName(taskDescription: string, agentLabel?: string): string {
  const prefix = agentLabel ? `${agentLabel}: ` : "";
  return `[D] ${(prefix + taskDescription).slice(0, 30)}`;
}

function buildDelegationTeamChatNote(taskCount: number): string {
  return `\n\nIMPORTANT - Team Coordination via terminal-64 MCP:
You are part of a team of ${taskCount} agents working in the same codebase. You MUST use the team chat to coordinate:

Use the Terminal 64 MCP tools directly; do not simulate these actions with shell commands or plain-text status lines. Some providers may display these as ReadTeam, SendToTeam, and ReportDone, but the underlying tools are:

1. read_team - Check what other agents have posted. Do this BEFORE starting work and periodically during long tasks to stay aware of what others are doing.
2. send_to_team - Post a message to the shared team chat. Do this:
   - At the START of your work (announce what you're about to do)
   - Before modifying any shared files (to avoid conflicts)
   - After completing major milestones
   - If you encounter issues or blockers
3. report_done - When your task is fully complete, call this with a summary of what you did and what files you changed.

Coordinate actively. If another agent is working on a file you need, mention it in team chat and work around it. Communication prevents conflicts.`;
}

export function buildDelegationChildSpawnPlan({
  sharedContext,
  taskDescription,
  agentName,
  taskIndex,
  taskCount,
  teamChatEnabled,
}: BuildDelegationChildSpawnPlanOptions): DelegationChildSpawnPlan {
  const agentLabel = resolveDelegationAgentLabel(taskIndex, agentName);
  const channelNote = teamChatEnabled ? buildDelegationTeamChatNote(taskCount) : "";
  return {
    agentLabel,
    childName: buildDelegationChildName(taskDescription, agentLabel),
    initialPrompt: `Context: ${sharedContext}\n\nYour task: ${taskDescription}\n\nYou are agent "${agentLabel}" - one of ${taskCount} parallel agents. Focus on YOUR specific task only.${channelNote}\n\nWhen done, call report_done (if available) or state your task is complete.`,
  };
}
