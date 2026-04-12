import { useCallback, useRef, useState, useEffect, useMemo } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCanvasStore, CanvasTerminal } from "../../stores/canvasStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { closeTerminal, writeTerminal, closeClaudeSession, renameDiscordSession, closeBrowser } from "../../lib/tauriApi";
import { BORDER_COLORS, ACTIVITY_TIMEOUT_MS } from "../../lib/constants";
import { computeDragSnap, computeResizeSnap } from "../../lib/snapUtils";
import { useSettingsStore } from "../../stores/settingsStore";
import XTerminal from "../terminal/XTerminal";
import ClaudeChat from "../claude/ClaudeChat";
import SharedChat from "../claude/SharedChat";
import WidgetPanel from "../widget/WidgetPanel";
import BrowserPanel from "../widget/BrowserPanel";
import TextEditor from "./TextEditor";
import "./FloatingTerminal.css";

/** Block iframes from stealing mouse events during drag/resize */
function blockIframes() {
  document.body.classList.add("ft-dragging");
}
function unblockIframes() {
  document.body.classList.remove("ft-dragging");
}

interface FloatingTerminalProps {
  term: CanvasTerminal;
}

export default function FloatingTerminal({ term }: FloatingTerminalProps) {
  // Reactive state — only re-render when these change
  const isActive = useCanvasStore((s) => s.activeTerminalId === term.terminalId);
  // Stable action refs — won't cause re-renders
  const moveTerminal = useCanvasStore((s) => s.moveTerminal);
  const resizeTerminal = useCanvasStore((s) => s.resizeTerminal);
  const removeTerminal = useCanvasStore((s) => s.removeTerminal);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const setActive = useCanvasStore((s) => s.setActive);
  const setBorderColor = useCanvasStore((s) => s.setBorderColor);
  const [showColors, setShowColors] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const workTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef({ startX: 0, startY: 0, origX: 0, origY: 0 });
  // Track active drag/resize cleanup so we can tear down on unmount
  const cleanupRef = useRef<(() => void) | null>(null);
  // Keep a live ref to term so drag/resize callbacks don't need term.x/y/w/h in deps
  const termRef = useRef(term);
  termRef.current = term;

  const handleActivity = useCallback(() => {
    setIsWorking(true);
    if (workTimer.current) clearTimeout(workTimer.current);
    workTimer.current = setTimeout(() => setIsWorking(false), ACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (workTimer.current) clearTimeout(workTimer.current);
      // Clean up any lingering drag/resize window listeners on unmount
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  // Close color picker on outside click
  useEffect(() => {
    if (!showColors) return;
    const handler = () => setShowColors(false);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [showColors]);

  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest(".ft-btn")) return;
      if ((e.target as HTMLElement).closest(".ft-title--editing")) return;
      e.preventDefault();
      e.stopPropagation();
      bringToFront(term.id);
      setShowColors(false);

      const t = termRef.current;
      const curZoom = useCanvasStore.getState().zoom;
      const d = dragRef.current;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origX = t.x;
      d.origY = t.y;

      blockIframes();
      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - d.startX) / curZoom;
        const dy = (ev.clientY - d.startY) / curZoom;
        const rawX = d.origX + dx;
        const rawY = d.origY + dy;

        if (!useSettingsStore.getState().snapToGrid) {
          moveTerminal(term.id, rawX, rawY);
          return;
        }

        const state = useCanvasStore.getState();
        const self = state.terminals.find((s) => s.id === term.id);
        const dragW = self?.width ?? t.width;
        const dragH = self?.height ?? t.height;

        const others = state.terminals
          .filter((s) => s.id !== term.id && !s.poppedOut)
          .map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }));

        const snap = computeDragSnap({ x: rawX, y: rawY, width: dragW, height: dragH }, others);
        moveTerminal(term.id, snap.x, snap.y);
        useCanvasStore.getState().setSnapGuides(snap.guides);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        unblockIframes();
        useCanvasStore.getState().clearSnapGuides();
        cleanupRef.current = null;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      cleanupRef.current = onUp;
    },
    [term.id, moveTerminal, bringToFront]
  );

  const startEdgeResize = useCallback(
    (e: React.MouseEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      bringToFront(term.id);

      const t = termRef.current;
      const curZoom = useCanvasStore.getState().zoom;
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = t.x;
      const origY = t.y;
      const origW = t.width;
      const origH = t.height;

      blockIframes();
      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / curZoom;
        const dy = (ev.clientY - startY) / curZoom;

        let newX = origX, newY = origY, newW = origW, newH = origH;

        if (edge.includes("e")) newW = origW + dx;
        if (edge.includes("s")) newH = origH + dy;
        if (edge.includes("w")) { newW = origW - dx; newX = origX + dx; }
        if (edge.includes("n")) { newH = origH - dy; newY = origY + dy; }

        if (!useSettingsStore.getState().snapToGrid) {
          newW = Math.max(300, newW);
          newH = Math.max(200, newH);
          if (newW === 300 && edge.includes("w")) newX = origX + origW - 300;
          if (newH === 200 && edge.includes("n")) newY = origY + origH - 200;
          resizeTerminal(term.id, newW, newH);
          moveTerminal(term.id, newX, newY);
          return;
        }

        const others = useCanvasStore.getState().terminals
          .filter((s) => s.id !== term.id && !s.poppedOut)
          .map((s) => ({ x: s.x, y: s.y, width: s.width, height: s.height }));

        const snap = computeResizeSnap({ x: newX, y: newY, width: newW, height: newH }, edge, others);

        snap.width = Math.max(300, snap.width);
        snap.height = Math.max(200, snap.height);
        if (snap.width === 300 && edge.includes("w")) snap.x = origX + origW - 300;
        if (snap.height === 200 && edge.includes("n")) snap.y = origY + origH - 200;

        resizeTerminal(term.id, snap.width, snap.height);
        moveTerminal(term.id, snap.x, snap.y);
        useCanvasStore.getState().setSnapGuides(snap.guides);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        unblockIframes();
        useCanvasStore.getState().clearSnapGuides();
        cleanupRef.current = null;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      cleanupRef.current = onUp;
    },
    [term.id, resizeTerminal, moveTerminal, bringToFront]
  );

  const handleClose = useCallback(() => {
    if (term.panelType === "claude") {
      closeClaudeSession(term.terminalId).catch(() => {});
    } else if (term.panelType === "browser") {
      closeBrowser(term.terminalId).catch(() => {});
    } else if (term.panelType !== "widget" && term.panelType !== "shared-chat") {
      closeTerminal(term.terminalId).catch(() => {});
    }
    removeTerminal(term.id);
  }, [term.id, term.terminalId, term.panelType, removeTerminal]);

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

  const handleTitleChange = useCallback((_: string, title: string) => {
    useCanvasStore.getState().setTitle(term.id, title);
    if (/^[A-Z]:\\/.test(title)) {
      useCanvasStore.getState().setCwd(term.id, title);
    }
  }, [term.id]);

  const handleCwdChange = useCallback((_: string, dir: string) => {
    useCanvasStore.getState().setCwd(term.id, dir);
  }, [term.id]);

  const isClaude = term.panelType === "claude";
  const isSharedChat = term.panelType === "shared-chat";
  const isWidget = term.panelType === "widget";
  const isBrowser = term.panelType === "browser";
  const claudeSessionName = useClaudeStore((s) => isClaude ? s.sessions[term.terminalId]?.name : undefined);
  const claudeCwd = useClaudeStore((s) => isClaude ? s.sessions[term.terminalId]?.cwd : undefined);

  const claudeTitle = (() => {
    const name = claudeSessionName || "Unnamed Session";
    if (!claudeCwd) return name;
    const parts = claudeCwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    const short = parts.slice(-2).join("/");
    return short ? `${short}: ${name}` : name;
  })();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className={`floating-terminal ${isWorking ? "floating-terminal--working" : ""} ${isWidget ? "floating-terminal--widget" : ""}`}
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
      {/* Header — widgets wrap in hover zone */}
      {isWidget && <div className="ft-widget-hover-zone" />}
      <div className={`ft-header ${isWidget ? "ft-header--widget" : ""}`} onMouseDown={handleHeaderMouseDown}>
        {isClaude ? (
          editingName ? (
            <>
              <input
                ref={nameInputRef}
                className="ft-title ft-title--editing"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const name = nameDraft.trim();
                    useClaudeStore.getState().setName(term.terminalId, name);
                    setEditingName(false);
                    const cwd = useClaudeStore.getState().sessions[term.terminalId]?.cwd || "";
                    renameDiscordSession(term.terminalId, name, cwd).catch(() => {});
                  } else if (e.key === "Escape") {
                    setEditingName(false);
                  }
                }}
                onMouseDown={(e) => e.stopPropagation()}
                spellCheck={false}
                autoFocus
              />
              <button className="ft-btn ft-btn--accept" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => {
                e.stopPropagation();
                const name = nameDraft.trim();
                useClaudeStore.getState().setName(term.terminalId, name);
                setEditingName(false);
                const cwd = useClaudeStore.getState().sessions[term.terminalId]?.cwd || "";
                renameDiscordSession(term.terminalId, name, cwd).catch(() => {});
              }} title="Save">
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <button className="ft-btn ft-btn--cancel" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => {
                e.stopPropagation();
                setEditingName(false);
              }} title="Cancel">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 1L7 7M7 1L1 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </button>
            </>
          ) : (
            <>
              <span className="ft-title">{claudeTitle}</span>
              <button className="ft-btn ft-btn--edit" onClick={(e) => {
                e.stopPropagation();
                setNameDraft(claudeSessionName || "");
                setEditingName(true);
              }} title="Rename">
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none"><path d="M5.5 1.5L7.5 3.5M1 8L1.5 6L6.5 1L8 2.5L3 7.5L1 8Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/></svg>
              </button>
            </>
          )
        ) : (
          <span className="ft-title">{term.title}</span>
        )}
        {!isClaude && !isSharedChat && !isWidget && !isBrowser && (
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
        )}
        {!isSharedChat && !isWidget && (
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
        )}
        {!isSharedChat && (
          <button className="ft-btn" onClick={handleClose} title="Close">
            <svg width="9" height="9" viewBox="0 0 9 9">
              <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
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

      {/* Body */}
      {term.poppedOut ? (
        <div className="ft-ghost">
          <svg width="20" height="20" viewBox="0 0 10 10" fill="none" opacity="0.3">
            <path d="M4 1H1V9H9V6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M6 1H9V4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 1L5 5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
          </svg>
          <span>POPPED OUT</span>
        </div>
      ) : isBrowser ? (
        <div className="ft-body ft-body--claude">
          <BrowserPanel browserId={term.terminalId} initialUrl={term.browserUrl || "https://google.com"} />
        </div>
      ) : isWidget && term.widgetId ? (
        <div className="ft-body ft-body--claude">
          <WidgetPanel widgetId={term.widgetId} />
        </div>
      ) : isSharedChat ? (
        <div className="ft-body ft-body--claude">
          <SharedChat groupId={term.terminalId.replace("shared-chat-", "")} />
        </div>
      ) : isClaude ? (
        <div className="ft-body ft-body--claude">
          <ClaudeChat
            sessionId={term.terminalId}
            cwd={term.cwd}
            skipPermissions={term.claudeSkipPermissions}
            isActive={isActive}
          />
        </div>
      ) : (
        <div className="ft-body">
          <XTerminal
            terminalId={term.terminalId}
            isActive={isActive}
            cwd={term.cwd || undefined}
            onFocus={handleFocus}
            onActivity={handleActivity}
            onTitleChange={handleTitleChange}
            onCwdChange={handleCwdChange}
            onExit={handleClose}
          />
          {/* Text editor overlay */}
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

      {/* Resize handles */}
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
