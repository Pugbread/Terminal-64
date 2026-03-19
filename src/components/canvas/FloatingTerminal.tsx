import { useCallback, useRef, useState, useEffect } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCanvasStore, CanvasTerminal } from "../../stores/canvasStore";
import { closeTerminal, writeTerminal, getClaudeSessionId } from "../../lib/tauriApi";
import { BORDER_COLORS, ACTIVITY_TIMEOUT_MS } from "../../lib/constants";
import XTerminal from "../terminal/XTerminal";
import TextEditor from "./TextEditor";
import "./FloatingTerminal.css";

function buildClaudeCommand(term: CanvasTerminal): string {
  let cmd = "claude";
  if (term.claudeSessionId && term.claudeSessionId !== "active") {
    cmd += ` --resume ${term.claudeSessionId}`;
  }
  if (term.claudeSkipPermissions) {
    cmd += " --dangerously-skip-permissions";
  }
  return cmd;
}

interface FloatingTerminalProps {
  term: CanvasTerminal;
}

export default function FloatingTerminal({ term }: FloatingTerminalProps) {
  const moveTerminal = useCanvasStore((s) => s.moveTerminal);
  const resizeTerminal = useCanvasStore((s) => s.resizeTerminal);
  const removeTerminal = useCanvasStore((s) => s.removeTerminal);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const setActive = useCanvasStore((s) => s.setActive);
  const setBorderColor = useCanvasStore((s) => s.setBorderColor);
  const activeTerminalId = useCanvasStore((s) => s.activeTerminalId);
  const zoom = useCanvasStore((s) => s.zoom);

  const isActive = term.terminalId === activeTerminalId;
  const [showColors, setShowColors] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const workTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0 });

  const handleActivity = useCallback(() => {
    setIsWorking(true);
    if (workTimer.current) clearTimeout(workTimer.current);
    workTimer.current = setTimeout(() => setIsWorking(false), ACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (workTimer.current) clearTimeout(workTimer.current);
    };
  }, []);

  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".ft-btn")) return;
      e.preventDefault();
      e.stopPropagation();
      bringToFront(term.id);
      setShowColors(false);

      const d = dragRef.current;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origX = term.x;
      d.origY = term.y;

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - d.startX) / zoom;
        const dy = (ev.clientY - d.startY) / zoom;
        moveTerminal(term.id, d.origX + dx, d.origY + dy);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [term.id, term.x, term.y, zoom, moveTerminal, bringToFront]
  );

  const startEdgeResize = useCallback(
    (e: React.MouseEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      bringToFront(term.id);

      const startX = e.clientX;
      const startY = e.clientY;
      const origX = term.x;
      const origY = term.y;
      const origW = term.width;
      const origH = term.height;

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;

        let newX = origX, newY = origY, newW = origW, newH = origH;

        if (edge.includes("e")) newW = origW + dx;
        if (edge.includes("s")) newH = origH + dy;
        if (edge.includes("w")) { newW = origW - dx; newX = origX + dx; }
        if (edge === "n" || edge === "nw" || edge === "ne") { newH = origH - dy; newY = origY + dy; }

        newW = Math.max(300, newW);
        newH = Math.max(200, newH);
        // Clamp position if size hit minimum
        if (newW === 300 && edge.includes("w")) newX = origX + origW - 300;
        if (newH === 200 && (edge === "n" || edge === "nw" || edge === "ne")) newY = origY + origH - 200;

        resizeTerminal(term.id, newW, newH);
        moveTerminal(term.id, newX, newY);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [term.id, term.x, term.y, term.width, term.height, zoom, resizeTerminal, moveTerminal, bringToFront]
  );

  const handleClose = useCallback(() => {
    closeTerminal(term.terminalId).catch(() => {});
    removeTerminal(term.id);
  }, [term.id, term.terminalId, removeTerminal]);

  const popOut = useCanvasStore((s) => s.popOut);

  const handlePopOut = useCallback(() => {
    const label = `popout-${Date.now()}`;
    const params = new URLSearchParams({
      popout: "true",
      terminalId: term.terminalId,
      title: term.title,
      borderColor: term.borderColor,
    });
    new WebviewWindow(label, {
      url: `${window.location.origin}?${params}`,
      width: term.width,
      height: term.height,
      title: term.title || "Terminal 64",
      decorations: false,
      transparent: true,
      center: true,
      resizable: true,
      minWidth: 400,
      minHeight: 300,
    });
    popOut(term.id);
  }, [term, popOut]);

  const handleFocus = useCallback(() => {
    bringToFront(term.id);
    setActive(term.terminalId);
  }, [term.id, term.terminalId, bringToFront, setActive]);

  return (
    <div
      className={`floating-terminal ${isWorking ? "floating-terminal--working" : ""}`}
      style={{
        left: term.x,
        top: term.y,
        width: term.width,
        height: term.height,
        zIndex: term.zIndex,
        "--ft-border": term.borderColor,
      } as React.CSSProperties}
      onMouseDown={handleFocus}
    >
      {/* Header */}
      <div className="ft-header" onMouseDown={handleHeaderMouseDown}>
        <span className="ft-title">{term.title}</span>
        <button
          className="ft-btn"
          onClick={(e) => { e.stopPropagation(); handlePopOut(); }}
          title="Pop out to new window"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M4 1H1V9H9V6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 1H9V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 1L5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
        <button
          className="ft-btn ft-btn--settings"
          onClick={(e) => {
            e.stopPropagation();
            setShowColors((v) => !v);
          }}
          title="Border color"
        >
          <div
            className="ft-color-dot"
            style={{ background: term.borderColor }}
          />
        </button>
        <button className="ft-btn" onClick={handleClose} title="Close">
          <svg width="9" height="9" viewBox="0 0 9 9">
            <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Color picker popover */}
      {showColors && (
        <div className="ft-colors" onClick={(e) => e.stopPropagation()}>
          {BORDER_COLORS.map((c) => (
            <button
              key={c}
              className={`ft-color-swatch ${c === term.borderColor ? "ft-color-swatch--active" : ""}`}
              style={{ background: c }}
              onClick={() => {
                setBorderColor(term.id, c);
                setShowColors(false);
              }}
            />
          ))}
        </div>
      )}

      {/* Terminal body or ghost */}
      {term.poppedOut ? (
        <div className="ft-ghost">
          <svg width="20" height="20" viewBox="0 0 10 10" fill="none" opacity="0.3">
            <path d="M4 1H1V9H9V6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 1H9V4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 1L5 5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
          <span>POPPED OUT</span>
        </div>
      ) : (
        <div className="ft-body">
          <XTerminal
            terminalId={term.terminalId}
            isActive={isActive}
            cwd={term.cwd || undefined}
            autoCommand={
              term.isClaudeSession
                ? buildClaudeCommand(term)
                : undefined
            }
            onFocus={() => handleFocus()}
            onActivity={() => {
              handleActivity();
              // Fetch real session ID from Claude's local files
              if (term.isClaudeSession && !term.claudeSessionId && term.cwd) {
                getClaudeSessionId(term.cwd)
                  .then((sid) => {
                    if (sid) useCanvasStore.getState().setClaudeSessionId(term.id, sid);
                  })
                  .catch(() => {});
              }
            }}
            onTitleChange={(_, title) => {
              useCanvasStore.getState().setTitle(term.id, title);
              if (/^[A-Z]:\\/.test(title)) {
                useCanvasStore.getState().setCwd(term.id, title);
              }
            }}
            onCwdChange={(_, dir) =>
              useCanvasStore.getState().setCwd(term.id, dir)
            }
            onSessionId={(_, sid) =>
              useCanvasStore.getState().setClaudeSessionId(term.id, sid)
            }
            onExit={() => handleClose()}
          />
          {/* Text editor overlay — sits on top of terminal at the bottom */}
          {editorOpen && (
            <TextEditor
              onSend={(text) => {
                writeTerminal(term.terminalId, text).catch(() => {});
              }}
              onClose={() => setEditorOpen(false)}
            />
          )}
          {/* Editor toggle button */}
          <button
            className="ft-editor-toggle"
            onClick={() => setEditorOpen((v) => !v)}
            title="Text Editor (compose & paste)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 10L1 11L1.5 11.5L11 2L9.5 0.5L0 10L2 10Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
              <path d="M8.5 1.5L10 3" stroke="currentColor" strokeWidth="1"/>
            </svg>
          </button>
        </div>
      )}

      {/* Resize handles — all edges and corners */}
      <div className="ft-resize ft-resize--n" onMouseDown={(e) => startEdgeResize(e, "n")} />
      <div className="ft-resize ft-resize--s" onMouseDown={(e) => startEdgeResize(e, "s")} />
      <div className="ft-resize ft-resize--w" onMouseDown={(e) => startEdgeResize(e, "w")} />
      <div className="ft-resize ft-resize--e" onMouseDown={(e) => startEdgeResize(e, "e")} />
      <div className="ft-resize ft-resize--nw" onMouseDown={(e) => startEdgeResize(e, "nw")} />
      <div className="ft-resize ft-resize--ne" onMouseDown={(e) => startEdgeResize(e, "ne")} />
      <div className="ft-resize ft-resize--sw" onMouseDown={(e) => startEdgeResize(e, "sw")} />
      <div className="ft-resize ft-resize--se" onMouseDown={(e) => startEdgeResize(e, "se")} />
    </div>
  );
}
