import { useCallback, useRef, useEffect, useMemo, useState } from "react";
import { useCanvasStore } from "../../stores/canvasStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useShallow } from "zustand/react/shallow";
import { readFileBase64 } from "../../lib/tauriApi";
import FloatingTerminal from "./FloatingTerminal";
import { PartyEqualizer } from "../party/PartyOverlay";
import VoiceStatusBadge from "../claude/VoiceStatusBadge";
import VoiceLivePanel from "../claude/VoiceLivePanel";
import VoiceMascot from "../claude/VoiceMascot";
import "./Canvas.css";

/** Safari/WebKit gesture events (non-standard, not in lib.dom.d.ts) */
interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/** Compute the point on a rect's border closest to a target point. */
function edgePoint(
  rect: { x: number; y: number; width: number; height: number },
  tx: number, ty: number,
): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = (rect.width / 2) / Math.abs(dx);
  const sy = (rect.height / 2) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export default function Canvas() {
  const { terminals, snapGuides } = useCanvasStore(useShallow((s) => ({
    terminals: s.terminals,
    snapGuides: s.snapGuides,
  })));
  // Read zoom for non-transform uses (badge); pan/zoom for transforms are applied via direct DOM writes below
  const zoom = useCanvasStore((s) => s.zoom);
  // Only extract cwds to avoid re-rendering on every message/streaming update
  const claudeCwds = useClaudeStore(useShallow((s) => {
    const out: Record<string, string> = {};
    for (const [id, sess] of Object.entries(s.sessions)) {
      if (sess.cwd) out[id] = sess.cwd;
    }
    return out;
  }));
  // Actions are stable refs — no need for shallow comparison
  const pan = useCanvasStore((s) => s.pan);

  const canvasRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const backgroundImage = useSettingsStore((s) => s.backgroundImage);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundOpacity);
  const showGrid = useSettingsStore((s) => s.showGrid);
  const [bgDataUrl, setBgDataUrl] = useState<string | null>(null);

  // Load background image as data URL when path changes
  useEffect(() => {
    if (!backgroundImage) { setBgDataUrl(null); return; }
    let cancelled = false;
    const ext = backgroundImage.split(".").pop()?.toLowerCase() || "png";
    const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
    readFileBase64(backgroundImage).then((b64) => {
      if (!cancelled) setBgDataUrl(`data:${mimeMap[ext] || "image/png"};base64,${b64}`);
    }).catch(() => { if (!cancelled) setBgDataUrl(null); });
    return () => { cancelled = true; };
  }, [backgroundImage]);

  // Direct DOM writes for pan/zoom — avoids React reconciliation jitter
  useEffect(() => {
    const apply = (panX: number, panY: number, z: number) => {
      const canvas = canvasRef.current;
      const content = contentRef.current;
      if (!canvas || !content) return;
      if (showGrid) {
        const gridSize = Math.round(24 * z);
        canvas.style.backgroundImage = "";
        canvas.style.backgroundSize = `${gridSize}px ${gridSize}px`;
        canvas.style.backgroundPosition = `${Math.round(panX % gridSize)}px ${Math.round(panY % gridSize)}px`;
      } else {
        canvas.style.backgroundImage = "none";
      }
      content.style.transform = `translate(${panX}px, ${panY}px) scale(${z})`;
      // Exposed for descendants that need to neutralize the canvas scale.
      // XTerminal uses it to counter-scale itself so xterm's selection math
      // (which mixes visual clientX with layout cellWidth) stays correct at
      // any zoom.
      content.style.setProperty("--canvas-zoom", String(z));
    };
    // Apply initial state
    const { panX, panY, zoom: z } = useCanvasStore.getState();
    apply(panX, panY, z);
    // Subscribe to store changes — fires synchronously on every set()
    return useCanvasStore.subscribe((s) => apply(s.panX, s.panY, s.zoom));
  }, [showGrid]);

  // Dynamically compute widget↔chat links by matching cwd to widget folder
  const linkLines = useMemo(() => {
    const widgets = terminals.filter((t) => t.panelType === "widget" && t.widgetId && !t.poppedOut);
    if (widgets.length === 0) return [];

    const claudes = terminals.filter((t) => t.panelType === "claude" && !t.poppedOut);
    const lines: { x: number; y: number; length: number; angle: number; key: string }[] = [];

    for (const w of widgets) {
      // Match any claude panel whose cwd contains this widget's folder
      const widgetPath = `/.terminal64/widgets/${w.widgetId}`;
      for (const c of claudes) {
        const cwd = claudeCwds[c.terminalId] || c.cwd;
        if (!cwd || !cwd.replace(/\\/g, "/").includes(widgetPath)) continue;

        const fc = { x: w.x + w.width / 2, y: w.y + w.height / 2 };
        const tc = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
        const p1 = edgePoint(w, tc.x, tc.y);
        const p2 = edgePoint(c, fc.x, fc.y);
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        lines.push({ x: p1.x, y: p1.y, length, angle, key: `${w.id}-${c.id}` });
      }
    }
    return lines;
  }, [terminals, claudeCwds]);

  // Center view on terminals on first mount
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    useCanvasStore.getState().centerView(rect.width, rect.height);
  }, []);

  // Pan canvas by dragging on empty space
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== canvasRef.current) return;
      if (e.button !== 0) return;
      e.preventDefault();

      let lastX = e.clientX;
      let lastY = e.clientY;

      const onMove = (ev: MouseEvent) => {
        pan(ev.clientX - lastX, ev.clientY - lastY);
        lastX = ev.clientX;
        lastY = ev.clientY;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [pan]
  );

  // Smooth zoom + pan with trackpad/mouse
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    // Track whether a native gesture is active so the wheel handler
    // doesn't double-process pinch events (WebKit fires both)
    let gesturing = false;
    let gestureStartZoom = 1;

    // --- macOS WebKit gesture events (pinch-to-zoom on trackpad) ---
    let gestureTimeout: ReturnType<typeof setTimeout> | null = null;
    const resetGestureTimeout = () => {
      if (gestureTimeout !== null) clearTimeout(gestureTimeout);
      gestureTimeout = setTimeout(() => { gesturing = false; }, 500);
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      if ((e.target as HTMLElement)?.closest?.(".floating-terminal")) return;
      gesturing = true;
      gestureStartZoom = useCanvasStore.getState().zoom;
      resetGestureTimeout();
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (!gesturing) return;
      resetGestureTimeout();
      const ge = e as GestureEvent;
      const rect = el.getBoundingClientRect();
      const cx = (ge.clientX ?? rect.width / 2) - rect.left;
      const cy = (ge.clientY ?? rect.height / 2) - rect.top;
      const newZoom = Math.max(0.1, Math.min(5, gestureStartZoom * ge.scale));
      useCanvasStore.getState().zoomAtPoint(newZoom, cx, cy);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      if (gestureTimeout !== null) clearTimeout(gestureTimeout);
      gesturing = false;
    };

    // --- Wheel events (ctrl+scroll on mouse, two-finger pan on trackpad) ---
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".floating-terminal")) return;
      e.preventDefault();

      // Skip zoom from wheel if gesture handler is already processing it
      if (gesturing) return;

      const s = useCanvasStore.getState();

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+scroll (mouse wheel) or fallback pinch-to-zoom
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const clampedDelta = Math.max(-10, Math.min(10, e.deltaY));
        const newZoom = Math.max(0.1, Math.min(5, s.zoom * Math.exp(-clampedDelta * 0.01)));
        s.zoomAtPoint(newZoom, cx, cy);
      } else {
        // Two-finger scroll — pan
        s.pan(-e.deltaX, -e.deltaY);
      }
    };

    el.addEventListener("gesturestart", onGestureStart, { passive: false });
    el.addEventListener("gesturechange", onGestureChange, { passive: false });
    el.addEventListener("gestureend", onGestureEnd, { passive: false });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (gestureTimeout !== null) clearTimeout(gestureTimeout);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div
      ref={canvasRef}
      className={`canvas ${showGrid ? "" : "canvas--no-grid"}`}
      onMouseDown={handleMouseDown}
    >
      {bgDataUrl && (
        <div
          className="canvas-bg-image"
          style={{
            backgroundImage: `url(${bgDataUrl})`,
            opacity: backgroundOpacity,
          }}
        />
      )}
      <div
        ref={contentRef}
        className="canvas-content"
        style={{ transformOrigin: "0 0" }}
      >
        {/* Animated dotted lines between linked panels (CSS divs, not SVG — WebKit clips SVG) */}
        {linkLines.map((l) => (
          <div
            key={l.key}
            className="canvas-link-line"
            style={{
              left: l.x,
              top: l.y,
              width: l.length,
              transform: `rotate(${l.angle}deg)`,
            }}
          />
        ))}

        {terminals.map((term) => (
          <FloatingTerminal key={term.id} term={term} />
        ))}
        {snapGuides.map((g, i) => (
          <div
            key={i}
            className={`snap-guide snap-guide--${g.orientation}`}
            style={g.orientation === "vertical" ? {
              left: g.position,
              top: g.start,
              height: g.end - g.start,
            } : {
              left: g.start,
              top: g.position,
              width: g.end - g.start,
            }}
          />
        ))}
      </div>

      <PartyEqualizer />

      {terminals.length === 0 && (
        <div className="canvas-empty">
          Click + to create a terminal
        </div>
      )}

      {/* Bottom-right status cluster: mascot + state on left, mic + zoom stacked on right */}
      <div className="canvas-status-cluster">
        <div className="cc-voice-stack">
          <VoiceMascot />
          <VoiceLivePanel />
        </div>
        <div className="canvas-right-col">
          <VoiceStatusBadge />
          {zoom !== 1 && (
            <div className="canvas-zoom-badge">
              {Math.round(zoom * 100)}%
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
