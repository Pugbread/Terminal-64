import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useClaudeStore } from "../stores/claudeStore";
import { useDelegationStore } from "../stores/delegationStore";
import { useCanvasStore } from "../stores/canvasStore";
import { cancelClaude, sendClaudePrompt, cleanupDelegationGroup, clearT64DelegationEnv, deleteSessionJsonl, closeClaudeSession } from "../lib/tauriApi";
import type { ChatMessage, ToolCall, HookEventPayload } from "../lib/types";

const FORWARDING_PREFIX = "[Update from";
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

/**
 * Tear down every child session for a delegation group. Delegation children
 * are ephemeral by contract — they must leave no trace in localStorage, in
 * memory, or in ~/.claude/projects/... JSONL. Called on both successful merge
 * and on cancel.
 */
function purgeDelegationChildren(groupId: string) {
  const delStore = useDelegationStore.getState();
  const group = delStore.groups[groupId];
  if (!group) return;

  const claudeStore = useClaudeStore.getState();
  const parentSession = claudeStore.sessions[group.parentSessionId];
  const parentCwd = parentSession?.cwd || "";

  for (const task of group.tasks) {
    const childId = task.sessionId;
    if (!childId) continue;
    clearIdleTimer(childId);
    // Kill the CLI subprocess if still alive
    cancelClaude(childId).catch(() => {});
    closeClaudeSession(childId).catch(() => {});
    // Drop from the store (ephemeral sessions are already skipped by
    // saveToStorage — this just frees memory and removes the canvas-less entry)
    claudeStore.removeSession(childId);
    // Delete the JSONL from disk. The CLI is spawned with
    // --no-session-persistence so usually nothing is written; when it IS
    // written (older CLI, interrupted flag parsing, etc.) we still want a
    // clean slate.
    if (parentCwd) {
      deleteSessionJsonl(childId, parentCwd).catch(() => {});
    }
  }
}

export function useDelegationOrchestrator() {
  useEffect(() => {
    let cancelled = false;
    const hookUnlistens: (() => void)[] = [];

    const unsub = useClaudeStore.subscribe((state, prev) => {
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
                  const detail = lastTc.input?.file_path || lastTc.input?.command || lastTc.input?.pattern || "";
                  const action = `${lastTc.name}${detail ? ` ${String(detail).split(/[/\\]/).pop()?.slice(0, 40)}` : ""}`;
                  delStore.setTaskAction(group.id, task.id, action);
                }
              }
            }
          }
        }

        // Cancel idle timer if agent started streaming again
        if (!was && now) {
          clearIdleTimer(sid);
        }

        // Only act on streaming → not-streaming transitions
        if (was && !now) {
          handleTurnComplete(sid);
        }
      }
    });

    // Use SubagentStop hook events as an additional completion signal for delegation children.
    // When a delegation child's last subagent stops, treat it as a turn-complete hint.
    (async () => {
      const fnStop = await listen<HookEventPayload>("claude-hook-SubagentStop", (event) => {
        if (cancelled) return;
        const { session_id } = event.payload;
        const delStore = useDelegationStore.getState();
        const group = delStore.getGroupForSession(session_id);
        if (!group || group.status !== "active") return;

        // If this child has no more active subagents and isn't streaming, check for completion
        const session = useClaudeStore.getState().sessions[session_id];
        if (session && !session.isStreaming && session.subagentIds.length === 0) {
          handleTurnComplete(session_id);
        }
      });
      if (cancelled) { fnStop(); return; }
      hookUnlistens.push(fnStop);

      // SubagentStart: cancel idle timers — child is spawning subagents, don't time it out
      const fnStart = await listen<HookEventPayload>("claude-hook-SubagentStart", (event) => {
        if (cancelled) return;
        const { session_id } = event.payload;
        const delStore = useDelegationStore.getState();
        if (delStore.getGroupForSession(session_id)) {
          clearIdleTimer(session_id);
        }
      });
      if (cancelled) { fnStart(); return; }
      hookUnlistens.push(fnStart);
    })();

    return () => {
      cancelled = true;
      unsub();
      for (const u of hookUnlistens) u();
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
    || (lastAssistant ? summarizeToolCalls(lastAssistant) : "")
    || "";

  // report_done is the ONLY hard completion signal — no text-based phrase guessing.
  // Text matching caused too many false positives (e.g. "I've completed step 1" → killed).
  if (reportDoneSummary) {
    const resultSummary = resultText.slice(0, MAX_SUMMARY_LENGTH * 2);
    markComplete(group.id, task.id, sessionId, resultSummary);
  } else {
    // Agent's process exited without calling report_done. In --print mode with
    // bypass_all, this usually means the agent finished its work. Start a timer:
    // if the agent doesn't start streaming again within IDLE_TIMEOUT_MS, mark done.
    scheduleIdleCompletion(sessionId, group.id, task.id, resultText);
  }

  checkAndMerge(group.id);
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
    const session = useClaudeStore.getState().sessions[sessionId];
    if (session?.isStreaming) return; // Still working — don't interrupt
    if (session?.subagentIds.length) return; // Has active subagents — wait for them

    // Agent has been idle for IDLE_TIMEOUT_MS — mark as complete
    const summary = fallbackText.slice(0, MAX_SUMMARY_LENGTH * 2) || "(agent completed without explicit summary)";
    markComplete(groupId, taskId, sessionId, summary);
    checkAndMerge(groupId);
  }, IDLE_TIMEOUT_MS);

  idleTimers.set(sessionId, timer);
}

/** Scan messages for a report_done tool call and extract its summary arg.
 *  MCP tools are prefixed: mcp__terminal-64__report_done */
function extractReportDone(msgs: ChatMessage[]): string | null {
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 5); i--) {
    const msg = msgs[i];
    if (msg && msg.role === "assistant" && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if ((tc.name === "report_done" || tc.name.endsWith("__report_done")) && tc.input?.summary) {
          return String(tc.input.summary);
        }
      }
    }
  }
  return null;
}

/** Build a summary from tool calls when there's no text content. */
function summarizeToolCalls(msg: ChatMessage): string {
  if (!msg?.toolCalls?.length) return "";
  const actions = msg.toolCalls.map((tc: ToolCall) => {
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
    delStore.setGroupStatus(groupId, "active");
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
      }, parentSession.skipOpenwolf);
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
    cleanupDelegationGroup(groupId).catch(() => {});
    const parentSession = useClaudeStore.getState().sessions[group.parentSessionId];
    if (parentSession?.cwd) clearT64DelegationEnv(parentSession.cwd);
    purgeDelegationChildren(groupId);
  }
}
