import { memo, useEffect } from "react";

export interface IslandPrompt {
  id: string;
  idx: number;
  content: string;
  timestamp: number;
  isCmd: boolean;
}

interface PromptIslandProps {
  prompts: IslandPrompt[];
  isScrolledUp: boolean;
  progress: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

const RING_R = 5.5;
const RING_CIRC = 2 * Math.PI * RING_R;

function PromptIslandImpl({ prompts, isScrolledUp, progress, open, onOpen, onClose, onJump }: PromptIslandProps) {
  const hasPrompts = prompts.length > 0;
  const visible = hasPrompts && (isScrolledUp || open);

  useEffect(() => {
    if (open && !hasPrompts) onClose();
  }, [open, hasPrompts, onClose]);

  // When there are no prompts at all, nothing to render — no fade transition
  // needed because we've never shown anything in the first place.
  if (!hasPrompts) return null;

  const clamped = Math.max(0, Math.min(1, progress));
  const dashOffset = (1 - clamped) * RING_CIRC;

  return (
    <>
      <div
        className={`cc-island-backdrop${open ? " cc-island-backdrop--open" : ""}`}
        onClick={onClose}
      />
      <div className={`cc-island${open ? " cc-island--open" : ""}${visible ? "" : " cc-island--hidden"}`}>
        <button className="cc-island-pill" onClick={onOpen} aria-label="Open prompt history">
          <span className="cc-island-progress" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14">
              <circle cx="7" cy="7" r={RING_R} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
              <circle
                cx="7"
                cy="7"
                r={RING_R}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={RING_CIRC}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 7 7)"
              />
            </svg>
          </span>
          <span className="cc-island-label">
            {prompts.length} prompt{prompts.length === 1 ? "" : "s"}
          </span>
        </button>
        <div className="cc-island-box">
          <div className="cc-island-header">
            <span>Prompts · {prompts.length}</span>
            <button className="cc-island-close" onClick={onClose} aria-label="Close">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="cc-island-list">
            {[...prompts].reverse().map((p) => {
              const preview = p.content.replace(/\s+/g, " ").trim();
              const time = new Date(p.timestamp);
              const hh = String(time.getHours()).padStart(2, "0");
              const mm = String(time.getMinutes()).padStart(2, "0");
              return (
                <button
                  key={p.id}
                  className={`cc-island-item${p.isCmd ? " cc-island-item--cmd" : ""}`}
                  onClick={() => onJump(p.id)}
                  title={preview}
                >
                  <span className="cc-island-item-idx">{p.isCmd ? "/" : "#"}{p.idx}</span>
                  <span className="cc-island-item-text">{preview}</span>
                  <span className="cc-island-item-time">{hh}:{mm}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

const PromptIsland = memo(PromptIslandImpl);
export default PromptIsland;
