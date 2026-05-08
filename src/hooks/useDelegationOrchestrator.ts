import { useEffect } from "react";
import {
  getProviderPermissionId,
  getProviderSessionRuntimeMetadata,
  resolveSessionProviderState,
  useProviderSessionStore,
  type ClaudeSession,
} from "../stores/providerSessionStore";
import { useDelegationStore } from "../stores/delegationStore";
import { useCanvasStore } from "../stores/canvasStore";
import {
  cleanupDelegationGroup,
  clearT64DelegationEnv,
  getDelegationMessages,
  writeFile,
} from "../lib/tauriApi";
import { cancelProviderSession, closeProviderSession, deleteProviderHistory, runProviderTurn } from "../lib/providerRuntime";
import {
  describeDelegationToolAction,
  evaluateDelegationCompletion,
  startProviderLifecycleCompletionSource,
} from "../lib/delegationCompletion";
import { isProviderId, type ProviderId } from "../lib/providers";
import { getDelegationMcpTransport } from "../lib/delegationChildRuntime";
import { joinPath } from "../lib/platform";
import type { DelegationGroup, DelegationMsg, PermissionMode } from "../lib/types";
import type { ProviderTurnInput, ProviderTurnResult } from "../contracts/providerRuntime";

const MAX_SUMMARY_LENGTH = 800;
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

// After a delegation child's process exits without calling report_done,
// wait this long before marking it complete. Gives time for any follow-up
// prompts (e.g. from DelegationBadge forwarding) to restart streaming.
const IDLE_TIMEOUT_MS = 15_000;

function clearIdleTimer(sessionId: string) {
  const timer = idleTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(sessionId);
  }
}

function closeSharedChatPanel(groupId: string) {
  const canvas = useCanvasStore.getState();
  const panelId = `shared-chat-${groupId}`;
  const panel = canvas.terminals.find((t) => t.terminalId === panelId);
  if (panel) {
    canvas.removeTerminal(panel.id);
  }
}

function providerIdFromRuntimeMetadata(providerId: string | undefined): ProviderId | null {
  return isProviderId(providerId) ? providerId : null;
}

function shouldClearDelegationEnv(provider: ProviderId): boolean {
  return getDelegationMcpTransport(provider) === "temp-config";
}

function formatLogTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function markdownCell(value: string): string {
  return value
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function delegationLogFilename(group: DelegationGroup): string {
  const created = new Date(group.createdAt).toISOString().replace(/[:.]/g, "-");
  return `terminal64-delegation-${created}-${group.id.slice(0, 8)}.md`;
}

function delegationLogPath(cwd: string, group: DelegationGroup): string {
  return joinPath(cwd, ".t64", delegationLogFilename(group));
}

function renderDelegationChatLog(group: DelegationGroup, messages: DelegationMsg[]): string {
  const lines = [
    "# Terminal 64 Delegation Team Chat",
    "",
    `- Group: ${group.id}`,
    `- Parent session: ${group.parentSessionId}`,
    `- Created: ${formatLogTimestamp(group.createdAt)}`,
    "",
    "## Agents",
    "",
    ...group.tasks.map((task, index) => {
      const name = task.agentName || `Agent ${index + 1}`;
      return `- ${name}: ${task.description}`;
    }),
    "",
    "## Messages",
    "",
  ];

  if (messages.length === 0) {
    lines.push("_No team chat messages were recorded._");
    return `${lines.join("\n")}\n`;
  }

  lines.push("| Timestamp | AgentName | Type | Message |");
  lines.push("| --- | --- | --- | --- |");
  for (const message of messages) {
    lines.push(
      `| ${markdownCell(formatLogTimestamp(message.timestamp))} | ${markdownCell(message.agent)} | ${markdownCell(message.msg_type)} | ${markdownCell(message.message)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function exportDelegationChatLog(group: DelegationGroup, cwd: string): Promise<{ path: string; markdown: string } | null> {
  if (!cwd || cwd === ".") return null;
  const messages = await getDelegationMessages(group.id);
  const markdown = renderDelegationChatLog(group, messages);
  const path = delegationLogPath(cwd, group);
  await writeFile(path, markdown);
  useDelegationStore.getState().setGroupTeamChatLogPath(group.id, path);
  return { path, markdown };
}

function providerTurnForSession({
  sessionId,
  session,
  prompt,
  permissionMode,
  permissionOverride,
  defaultCodexPermission = "full-auto",
}: {
  sessionId: string;
  session: ClaudeSession;
  prompt: string;
  permissionMode: PermissionMode;
  permissionOverride?: PermissionMode;
  defaultCodexPermission?: string;
  }): ProviderTurnInput {
    const providerState = resolveSessionProviderState(session);
    const input: ProviderTurnInput = {
      provider: providerState.provider,
    sessionId,
      cwd: session.cwd || ".",
      prompt,
      started: session.hasBeenStarted,
      runtimeMetadata: getProviderSessionRuntimeMetadata(providerState, providerState.provider),
      selectedControls: providerState.selectedControls[providerState.provider] ?? {},
      providerPermissionId: providerState.providerPermissions[providerState.provider]
        ?? defaultCodexPermission
        ?? getProviderPermissionId(providerState, providerState.provider),
    permissionMode,
    skipOpenwolf: session.skipOpenwolf,
    seedTranscript: providerState.seedTranscript,
    resumeAtUuid: session.resumeAtUuid ?? null,
    forkParentSessionId: session.forkParentSessionId ?? null,
  };
  if (permissionOverride !== undefined) {
    input.permissionOverride = permissionOverride;
  }
  return input;
}

function applyProviderTurnResult(sessionId: string, result: ProviderTurnResult) {
  const store = useProviderSessionStore.getState();
  if (result.clearSeedTranscript) store.clearSeedTranscript(sessionId);
  if (result.clearResumeAtUuid) store.setResumeAtUuid(sessionId, null);
  if (result.clearForkParentSessionId) store.setForkParentSessionId(sessionId, null);
}

/**
 * Tear down every child session for a delegation group. Delegation children
 * are ephemeral by contract — they must leave no trace in localStorage, in
 * memory, or in provider-owned child history. Called on both successful merge
 * and on cancel.
 */
function purgeDelegationChildren(groupId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group) return;

  const providerSessionStore = useProviderSessionStore.getState();
  const parentSession = providerSessionStore.sessions[group.parentSessionId];
  const parentCwd = parentSession?.cwd || "";

  for (const task of group.tasks) {
    const childId = task.sessionId;
    if (!childId) continue;
    clearIdleTimer(childId);
    // Kill the CLI subprocess if still alive
    const childSession = providerSessionStore.sessions[childId];
    const childProviderState = childSession ? resolveSessionProviderState(childSession) : null;
    const fallbackProviderState = resolveSessionProviderState(parentSession);
    const childProvider = childProviderState?.provider
      ?? providerIdFromRuntimeMetadata(task.childRuntime?.providerId)
      ?? fallbackProviderState.provider;
    delStore.setTaskCleanupState(groupId, task.id, "closing");
    cancelProviderSession(childId, childProvider).catch(() => {});
    const closePromise = closeProviderSession(childId, childProvider).catch(() => {});
    const cleanupCwd = childSession?.cwd || task.childRuntime?.cwd || parentCwd;
    if (cleanupCwd) {
      delStore.setTaskCleanupState(groupId, task.id, "history_cleanup_requested");
      deleteProviderHistory({
        provider: childProvider,
        sessionId: childId,
        cwd: cleanupCwd,
      })
        .finally(() => delStore.setTaskCleanupState(groupId, task.id, "purged"))
        .catch(() => {});
    } else {
      closePromise.finally(() => delStore.setTaskCleanupState(groupId, task.id, "purged"));
    }
    // Drop from the store (ephemeral sessions are already skipped by
    // saveToStorage — this just frees memory and removes the canvas-less entry)
    providerSessionStore.removeSession(childId);
  }
}

export function useDelegationOrchestrator() {
  useEffect(() => {
    let cancelled = false;
    const lifecycleUnlistens: (() => void)[] = [];

    const unsub = useProviderSessionStore.subscribe((state, prev) => {
      for (const [sid, session] of Object.entries(state.sessions)) {
        const prevSession = prev.sessions[sid];
        const was = prevSession?.isStreaming ?? false;
        const now = session.isStreaming;
        const prevMsgCount = prevSession?.messages.length ?? 0;

        // Skip sessions where nothing relevant changed
        if (was === now && session.messages.length === prevMsgCount) continue;

        // Track last tool call action for delegation children
        const delStore = useDelegationStore.getState();
        const group = delStore.getGroupForSession(sid);
        if (group) {
          const task = group.tasks.find((t) => t.sessionId === sid);
          if (task && session.messages.length > prevMsgCount) {
            const newMsgs = session.messages.slice(prevMsgCount);
            for (const msg of newMsgs) {
              if (msg.role === "assistant" && msg.toolCalls?.length) {
                const lastTc = msg.toolCalls[msg.toolCalls.length - 1];
                if (lastTc) {
                  delStore.setTaskAction(group.id, task.id, describeDelegationToolAction(lastTc));
                }
              }
            }
          }
        }
      }
    });

    (async () => {
      const dispose = await startProviderLifecycleCompletionSource({
        isDelegationChildActive: (sessionId) => {
          const group = useDelegationStore.getState().getGroupForSession(sessionId);
          return Boolean(group && group.status === "active");
        },
        isSessionQuiescent: (sessionId) => {
          const session = useProviderSessionStore.getState().sessions[sessionId];
          return Boolean(session && !session.isStreaming && session.subagentIds.length === 0);
        },
        onCompletionHint: handleTurnComplete,
        onActivity: clearIdleTimer,
      });
      if (cancelled) { dispose(); return; }
      lifecycleUnlistens.push(dispose);
    })();

    return () => {
      cancelled = true;
      unsub();
      for (const u of lifecycleUnlistens) u();
      // Clean up timers on unmount
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
    };
  }, []);
}

function handleTurnComplete(sessionId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.getGroupForSession(sessionId);
  if (!group || group.status !== "active") return;

  const claudeState = useProviderSessionStore.getState();
  const session = claudeState.sessions[sessionId];
  // Session may have been removed by rewind/cancel — bail out
  if (!session) return;

  const task = group.tasks.find((t) => t.sessionId === sessionId);
  if (!task || task.status !== "running") return;

  // Re-check group status after accessing task — rewind may have cancelled between the two reads
  const freshGroup = delStore.groups[group.id];
  if (!freshGroup || freshGroup.status !== "active") return;

  const completion = evaluateDelegationCompletion({
    messages: session.messages,
    ...(task.lastForwardedMessageId !== undefined ? { lastForwardedMessageId: task.lastForwardedMessageId } : {}),
  });
  if (completion.kind === "none") return;

  if (completion.messageId) {
    delStore.setTaskForwarded(group.id, task.id, completion.messageId);
  }

  if (completion.kind === "report_done") {
    const resultSummary = completion.summary.slice(0, MAX_SUMMARY_LENGTH * 2);
    markComplete(group.id, task.id, sessionId, resultSummary);
    checkAndMerge(group.id);
  } else {
    // Agent's process exited without calling report_done. In --print mode with
    // bypass_all, this usually means the agent finished its work. Start a timer:
    // if the agent doesn't start streaming again within IDLE_TIMEOUT_MS, mark done.
    scheduleIdleCompletion(sessionId, group.id, task.id, completion.summary);
  }
}

function markComplete(groupId: string, taskId: string, sessionId: string, summary: string) {
  const delStore = useDelegationStore.getState();
  delStore.updateTaskStatus(groupId, taskId, "completed", summary);
  delStore.setTaskAction(groupId, taskId, "Done");
  clearIdleTimer(sessionId);
}

function scheduleIdleCompletion(sessionId: string, groupId: string, taskId: string, fallbackText: string) {
  const existing = idleTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    idleTimers.delete(sessionId);
    const delStore = useDelegationStore.getState();
    const group = delStore.groups[groupId];
    if (!group || group.status !== "active") return;

    const task = group.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== "running") return;

    // Check if agent restarted streaming or has active subagents
    const session = useProviderSessionStore.getState().sessions[sessionId];
    if (session?.isStreaming) return; // Still working — don't interrupt
    if (session?.subagentIds.length) return; // Has active subagents — wait for them

    // Agent has been idle for IDLE_TIMEOUT_MS — mark as complete
    const summary = fallbackText.slice(0, MAX_SUMMARY_LENGTH * 2) || "(agent completed without explicit summary)";
    markComplete(groupId, taskId, sessionId, summary);
    checkAndMerge(groupId);
  }, IDLE_TIMEOUT_MS);

  idleTimers.set(sessionId, timer);
}

function checkAndMerge(groupId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group || group.status !== "active") return;

  const allDone = group.tasks.every(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
  );
  if (!allDone) return;

  if (group.mergeStrategy === "manual") return;
  performMerge(groupId);
}

export async function performMerge(groupId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group) return;

  delStore.setGroupStatus(groupId, "merging");

  const parentSession = useProviderSessionStore.getState().sessions[group.parentSessionId];
  if (!parentSession) {
    delStore.setGroupStatus(groupId, "active");
    return;
  }

  let chatLog: { path: string; markdown: string } | null = null;
  try {
    chatLog = await exportDelegationChatLog(group, parentSession.cwd || "");
  } catch (err) {
    console.warn("[delegation] Failed to export team chat log:", err);
  }

  const sections = group.tasks.map((t) => {
    const statusLabel = t.status === "completed" ? "Completed" : t.status === "failed" ? "Failed" : "Cancelled";
    const result = t.result || "(no result captured)";
    const agentName = t.agentName ? `${t.agentName} - ` : "";
    return `## ${agentName}${t.description} [${statusLabel}]\n${result}`;
  });

  const chatLogSection = chatLog
    ? `\n\n---\n\n## Team Chat Log\nSaved to: ${chatLog.path}\n\n${chatLog.markdown}`
    : "";
  const mergePrompt = `All delegated tasks have finished. Here are the results:\n\n${sections.join("\n\n---\n\n")}${chatLogSection}\n\nPlease review these results, summarize what was accomplished, and continue if needed.`;

  let mergeSucceeded = false;
  if (parentSession.isStreaming) {
    useProviderSessionStore.getState().enqueuePrompt(group.parentSessionId, {
      displayText: mergePrompt,
      providerPrompt: mergePrompt,
      permissionOverride: group.parentPermissionMode || "auto",
      command: { kind: "delegation-merge", groupId, originalText: mergePrompt },
    });
    mergeSucceeded = true; // queued — will send when streaming finishes
  } else {
    useProviderSessionStore.getState().addUserMessage(group.parentSessionId, mergePrompt);
    try {
      const result = await runProviderTurn(providerTurnForSession({
        sessionId: group.parentSessionId,
        session: parentSession,
        prompt: mergePrompt,
        permissionMode: group.parentPermissionMode || "auto",
        defaultCodexPermission: "full-auto",
      }));
      applyProviderTurnResult(group.parentSessionId, result);
      mergeSucceeded = true;
    } catch (err) {
      console.warn("[delegation] Failed to merge to parent:", err);
      // Revert to active so user can retry or manually handle
      delStore.setGroupStatus(groupId, "active");
    }
  }

  if (mergeSucceeded) {
    delStore.setGroupStatus(groupId, "merged");
    closeSharedChatPanel(groupId);
    cleanupDelegationGroup(groupId).catch(() => {});
    if (parentSession?.cwd && shouldClearDelegationEnv(resolveSessionProviderState(parentSession).provider)) {
      clearT64DelegationEnv(parentSession.cwd);
    }
    purgeDelegationChildren(groupId);
  }
}

/**
 * End a delegation group. If `forceCancel` is true (e.g. during rewind),
 * skip merging results and just tear everything down immediately.
 */
export function endDelegation(groupId: string, forceCancel = false) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group) return;

  // Mark running/pending tasks as cancelled so the merge path skips them
  for (const task of group.tasks) {
    if (task.status === "running" || task.status === "pending") {
      delStore.updateTaskStatus(groupId, task.id, "cancelled");
    }
  }

  // If any completed and we're not force-cancelling, merge results first.
  // performMerge calls purgeDelegationChildren itself on success.
  const hasResults = !forceCancel && group.tasks.some((t) => t.status === "completed" && t.result);
  if (hasResults) {
    performMerge(groupId);
  } else {
    delStore.setGroupStatus(groupId, "cancelled");
    closeSharedChatPanel(groupId);
    const parentSession = useProviderSessionStore.getState().sessions[group.parentSessionId];
    exportDelegationChatLog(group, parentSession?.cwd || "")
      .catch((err) => console.warn("[delegation] Failed to export team chat log:", err))
      .finally(() => cleanupDelegationGroup(groupId).catch(() => {}));
    if (parentSession?.cwd && shouldClearDelegationEnv(resolveSessionProviderState(parentSession).provider)) {
      clearT64DelegationEnv(parentSession.cwd);
    }
    purgeDelegationChildren(groupId);
  }
}
