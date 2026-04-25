import { useDelegationStore } from "../../stores/delegationStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { createCodexSession, sendClaudePrompt, sendCodexPrompt } from "../../lib/tauriApi";
import { decodeCodexPermission } from "../../lib/providers";
import "./Delegation.css";

interface DelegationBadgeProps {
  sessionId: string;
}

export default function DelegationBadge({ sessionId }: DelegationBadgeProps) {
  const group = useDelegationStore((s) => s.getGroupForSession(sessionId));
  const parentSession = useClaudeStore((s) =>
    group ? s.sessions[group.parentSessionId] : undefined
  );

  if (!group) return null;

  const task = group.tasks.find((t) => t.sessionId === sessionId);
  if (!task) return null;

  const parentName = parentSession?.name || "Parent";

  const jumpToParent = () => {
    const canvas = useCanvasStore.getState();
    const term = canvas.terminals.find((t) => t.terminalId === group.parentSessionId);
    if (term) canvas.bringToFront(term.id);
  };

  const sendToSiblings = () => {
    const session = useClaudeStore.getState().sessions[sessionId];
    if (!session) return;
    const msgs = session.messages;
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const siblings = useDelegationStore.getState().getSiblingSessionIds(sessionId);
    const summary = lastAssistant.content.length > 800
      ? lastAssistant.content.slice(0, 800) + "..."
      : lastAssistant.content;
    const forwardMsg = `[Update from "${task.description}"]: ${summary}`;

    for (const sibId of siblings) {
      const sibSession = useClaudeStore.getState().sessions[sibId];
      if (!sibSession) continue;
      if (sibSession.isStreaming) {
        useClaudeStore.getState().enqueuePrompt(sibId, forwardMsg);
      } else {
        if (sibSession.provider === "openai") {
          const baseReq = {
            session_id: sibId,
            cwd: sibSession.cwd || ".",
            prompt: forwardMsg,
            ...(sibSession.selectedModel ? { model: sibSession.selectedModel } : {}),
            ...(sibSession.selectedEffort ? { effort: sibSession.selectedEffort } : {}),
            ...decodeCodexPermission("yolo"),
          };
          const req = sibSession.codexThreadId
            ? { ...baseReq, thread_id: sibSession.codexThreadId }
            : baseReq;
          const op = sibSession.codexThreadId ? sendCodexPrompt(req) : createCodexSession(baseReq);
          op.catch((err) => console.warn(`[delegation] Manual Codex forward failed:`, err));
        } else {
          sendClaudePrompt({
            session_id: sibId,
            cwd: sibSession.cwd || ".",
            prompt: forwardMsg,
            permission_mode: "bypass_all",
          }, sibSession.skipOpenwolf).catch((err) => console.warn(`[delegation] Manual forward failed:`, err));
        }
      }
    }
  };

  return (
    <div className="del-badge">
      <span className={`del-badge-dot del-badge-dot--${task.status}`} />
      <span className="del-badge-task" title={task.description}>
        {task.description.length > 30 ? task.description.slice(0, 30) + "..." : task.description}
      </span>
      <button className="del-badge-parent" onClick={jumpToParent} title={`Jump to ${parentName}`}>
        {parentName}
      </button>
      <button className="del-badge-forward" onClick={sendToSiblings} title="Send last response to siblings">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1 5H7M7 5L4 2M7 5L4 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </div>
  );
}
