import { useEffect } from "react";
import { useClaudeStore } from "../stores/claudeStore";
import { useDelegationStore } from "../stores/delegationStore";
import { useCanvasStore } from "../stores/canvasStore";
import { cancelClaude, sendClaudePrompt, cleanupDelegationGroup, clearT64DelegationEnv } from "../lib/tauriApi";

const FORWARDING_PREFIX = "[Update from";
const MAX_SUMMARY_LENGTH = 800;
const idleTurnCounts = new Map<string, number>();

function closeSharedChatPanel(groupId: string) {
  const canvas = useCanvasStore.getState();
  const panelId = `shared-chat-${groupId}`;
  const panel = canvas.terminals.find((t) => t.terminalId === panelId);
  if (panel) {
    canvas.removeTerminal(panel.id);
  }
}

export function useDelegationOrchestrator() {
  useEffect(() => {
    const unsub = useClaudeStore.subscribe((state, prev) => {
      for (const [sid, session] of Object.entries(state.sessions)) {
        const prevSession = prev.sessions[sid];
        const was = prevSession?.isStreaming ?? false;
        const now = session.isStreaming;

        // Track last tool call action for delegation children
        const delStore = useDelegationStore.getState();
        const group = delStore.getGroupForSession(sid);
        if (group) {
          const task = group.tasks.find((t) => t.sessionId === sid);
          if (task) {
            // Detect new tool calls
            const prevMsgCount = prevSession?.messages.length ?? 0;
            if (session.messages.length > prevMsgCount) {
              const newMsgs = session.messages.slice(prevMsgCount);
              for (const msg of newMsgs) {
                if (msg.role === "assistant" && msg.toolCalls?.length) {
                  const lastTc = msg.toolCalls[msg.toolCalls.length - 1];
                  const detail = lastTc.input?.file_path || lastTc.input?.command || lastTc.input?.pattern || "";
                  const action = `${lastTc.name}${detail ? ` ${String(detail).split(/[/\\]/).pop()?.slice(0, 40)}` : ""}`;
                  delStore.setTaskAction(group.id, task.id, action);
                }
              }
            }
          }
        }

        // Only act on streaming → not-streaming transitions
        if (was && !now) {
          handleTurnComplete(sid);
        }
      }
    });

    return () => {
      unsub();
    };
  }, []);
}

function handleTurnComplete(sessionId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.getGroupForSession(sessionId);
  if (!group || group.status !== "active") return;

  const claudeState = useClaudeStore.getState();
  const session = claudeState.sessions[sessionId];
  // Session may have been removed by rewind/cancel — bail out
  if (!session) return;

  const task = group.tasks.find((t) => t.sessionId === sessionId);
  if (!task || task.status !== "running") return;

  // Re-check group status after accessing task — rewind may have cancelled between the two reads
  const freshGroup = delStore.groups[group.id];
  if (!freshGroup || freshGroup.status !== "active") return;

  const msgs = session.messages;

  // Check if agent called report_done — that's the strongest completion signal.
  // Scan recent messages for a report_done tool call.
  const reportDoneSummary = extractReportDone(msgs);

  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant && !reportDoneSummary) return;

  if (lastAssistant) {
    if (task.lastForwardedMessageId === lastAssistant.id && !reportDoneSummary) return;
    if (lastAssistant.content.startsWith(FORWARDING_PREFIX)) return;
    delStore.setTaskForwarded(group.id, task.id, lastAssistant.id);
  }

  // Determine result — prefer report_done summary, fall back to last message content
  const resultText = reportDoneSummary
    || lastAssistant?.content
    || summarizeToolCalls(lastAssistant)
    || "";

  const isDone = reportDoneSummary || detectCompletion(resultText);

  if (isDone) {
    const resultSummary = resultText.slice(0, MAX_SUMMARY_LENGTH * 2);
    delStore.updateTaskStatus(group.id, task.id, "completed", resultSummary);
    delStore.setTaskAction(group.id, task.id, "Done");
    idleTurnCounts.delete(sessionId);
  } else {
    // Track consecutive idle turns (no tool calls, no completion phrase)
    const hasToolCalls = lastAssistant?.toolCalls && lastAssistant.toolCalls.length > 0;
    if (!hasToolCalls) {
      const count = (idleTurnCounts.get(sessionId) || 0) + 1;
      idleTurnCounts.set(sessionId, count);
      if (count >= MAX_IDLE_TURNS) {
        const resultSummary = resultText.slice(0, MAX_SUMMARY_LENGTH * 2) || "(agent stopped without explicit summary)";
        delStore.updateTaskStatus(group.id, task.id, "completed", resultSummary);
        delStore.setTaskAction(group.id, task.id, "Done");
        idleTurnCounts.delete(sessionId);
      }
    } else {
      idleTurnCounts.set(sessionId, 0);
    }
  }

  // Check if all tasks are complete → merge
  checkAndMerge(group.id);
}

/** Scan messages for a report_done tool call and extract its summary arg. */
function extractReportDone(msgs: any[]): string | null {
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 5); i--) {
    const msg = msgs[i];
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.name === "report_done" && tc.input?.summary) {
          return String(tc.input.summary);
        }
      }
    }
  }
  return null;
}

/** Build a summary from tool calls when there's no text content. */
function summarizeToolCalls(msg: any): string {
  if (!msg?.toolCalls?.length) return "";
  const actions = msg.toolCalls.map((tc: any) => {
    const detail = tc.input?.file_path || tc.input?.command || tc.input?.pattern || "";
    return `${tc.name}${detail ? ` ${String(detail).split(/[/\\]/).pop()?.slice(0, 50)}` : ""}`;
  });
  return `Completed actions: ${actions.join(", ")}`;
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

  const sections = group.tasks.map((t) => {
    const statusLabel = t.status === "completed" ? "Completed" : t.status === "failed" ? "Failed" : "Cancelled";
    const result = t.result || "(no result captured)";
    return `## ${t.description} [${statusLabel}]\n${result}`;
  });

  const mergePrompt = `All delegated tasks have finished. Here are the results:\n\n${sections.join("\n\n---\n\n")}\n\nPlease review these results, summarize what was accomplished, and continue if needed.`;

  const parentSession = useClaudeStore.getState().sessions[group.parentSessionId];
  if (!parentSession) {
    delStore.setGroupStatus(groupId, "merged");
    return;
  }

  let mergeSucceeded = false;
  if (parentSession.isStreaming) {
    useClaudeStore.getState().enqueuePrompt(group.parentSessionId, mergePrompt);
    mergeSucceeded = true; // queued — will send when streaming finishes
  } else {
    useClaudeStore.getState().addUserMessage(group.parentSessionId, mergePrompt);
    try {
      await sendClaudePrompt({
        session_id: group.parentSessionId,
        cwd: parentSession.cwd || ".",
        prompt: mergePrompt,
        permission_mode: group.parentPermissionMode || "auto",
      });
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
    if (parentSession?.cwd) clearT64DelegationEnv(parentSession.cwd);
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

  // Cancel all running children and clean up idle tracking
  for (const task of group.tasks) {
    if (task.sessionId) idleTurnCounts.delete(task.sessionId);
    if (task.status === "running" || task.status === "pending") {
      delStore.updateTaskStatus(groupId, task.id, "cancelled");
      if (task.sessionId) {
        cancelClaude(task.sessionId).catch(() => {});
        // Clean up ephemeral session
        useClaudeStore.getState().removeSession(task.sessionId);
      }
    }
  }

  // If any completed and we're not force-cancelling, merge results first
  const hasResults = !forceCancel && group.tasks.some((t) => t.status === "completed" && t.result);
  if (hasResults) {
    performMerge(groupId);
  } else {
    delStore.setGroupStatus(groupId, "cancelled");
    closeSharedChatPanel(groupId);
    cleanupDelegationGroup(groupId).catch(() => {});
    const parentSession = useClaudeStore.getState().sessions[group.parentSessionId];
    if (parentSession?.cwd) clearT64DelegationEnv(parentSession.cwd);
  }
}

function detectCompletion(content: string): boolean {
  const lower = content.toLowerCase();
  const completionPhrases = [
    "task complete", "task is complete", "i've completed", "i have completed",
    "all done", "finished implementing", "implementation is complete",
    "work is done", "changes are complete", "successfully completed",
    "i'm done", "that's everything", "everything is set up",
    "completed all", "all changes have been", "all tasks", "finished all",
    "that completes", "this completes", "everything has been",
  ];
  return completionPhrases.some((phrase) => lower.includes(phrase));
}

// If a child session stops streaming without requesting more input and hasn't
// been marked complete by phrase detection, treat it as complete after this
// many consecutive "turn complete without user input" events.
const MAX_IDLE_TURNS = 2;
