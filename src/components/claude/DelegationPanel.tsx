import { useDelegationStore } from "../../stores/delegationStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { performMerge, endDelegation } from "../../hooks/useDelegationOrchestrator";
import type { DelegateTask } from "../../lib/types";
import "./Delegation.css";

interface DelegationPanelProps {
  sessionId: string;
}

const STATUS_ICONS: Record<string, string> = {
  pending: "\u25CB",    // ○
  running: "\u25CF",    // ●
  completed: "\u2713",  // ✓
  failed: "\u2717",     // ✗
  cancelled: "\u2014",  // —
};

export default function DelegationPanel({ sessionId }: DelegationPanelProps) {
  const group = useDelegationStore((s) => s.getGroupByParent(sessionId));

  if (!group) return null;

  const completedCount = group.tasks.filter((t) => t.status === "completed").length;
  const failedCount = group.tasks.filter((t) => t.status === "failed").length;
  const allDone = group.tasks.every((t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled");

  const jumpToTask = (task: DelegateTask) => {
    if (!task.sessionId) return;
    const canvas = useCanvasStore.getState();
    const term = canvas.terminals.find((t) => t.terminalId === task.sessionId);
    if (term) canvas.bringToFront(term.id);
  };

  const cancelAll = () => endDelegation(group.id);

  const handleMerge = () => {
    performMerge(group.id);
  };

  const handleDismiss = () => {
    useDelegationStore.getState().removeGroup(group.id);
  };

  return (
    <div className="del-panel">
      <div className="del-panel-header">
        <span className="del-panel-title">Delegation</span>
        <span className={`del-panel-status del-panel-status--${group.status}`}>{group.status}</span>
      </div>

      <div className="del-panel-tasks">
        {group.tasks.map((task) => (
          <div key={task.id} className={`del-panel-task del-panel-task--${task.status}`}>
            <span className="del-panel-task-icon">{STATUS_ICONS[task.status] || "?"}</span>
            <span className="del-panel-task-desc">{task.description}</span>
            {task.sessionId && (
              <button className="del-panel-task-jump" onClick={() => jumpToTask(task)} title="Jump to session">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M1 9L9 1M9 1H3M9 1V7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="del-panel-summary">
        {completedCount}/{group.tasks.length} completed
        {failedCount > 0 && <span className="del-panel-failed"> · {failedCount} failed</span>}
      </div>

      <div className="del-panel-actions">
        {group.status === "active" && allDone && group.mergeStrategy === "manual" && (
          <button className="del-panel-btn del-panel-btn--merge" onClick={handleMerge}>Merge Now</button>
        )}
        {group.status === "active" && !allDone && (
          <button className="del-panel-btn del-panel-btn--cancel" onClick={cancelAll}>Cancel All</button>
        )}
        {(group.status === "merged" || group.status === "cancelled") && (
          <button className="del-panel-btn del-panel-btn--dismiss" onClick={handleDismiss}>Dismiss</button>
        )}
      </div>
    </div>
  );
}
