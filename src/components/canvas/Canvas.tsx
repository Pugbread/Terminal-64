import { useCallback, useRef, useEffect } from "react";
import { useCanvasStore } from "../../stores/canvasStore";
import { useShallow } from "zustand/react/shallow";
import FloatingTerminal from "./FloatingTerminal";
import { PartyEqualizer } from "../party/PartyOverlay";
import "./Canvas.css";

export default function Canvas() {
  const { terminals, panX, panY, zoom, snapGuides } = useCanvasStore(useShallow((s) => ({
    terminals: s.terminals,
    panX: s.panX,
    panY: s.panY,
    zoom: s.zoom,
    snapGuides: s.snapGuides,
  })));
  // Actions are stable refs — no need for shallow comparison
  const pan = useCanvasStore((s) => s.pan);
  const addTerminal = useCanvasStore((s) => s.addTerminal);

  const canvasRef = useRef<HTMLDivElement>(null);

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
    const onGestureStart = (e: any) => {
      e.preventDefault();
      if ((e.target as HTMLElement)?.closest?.(".floating-terminal")) return;
      gesturing = true;
      gestureStartZoom = useCanvasStore.getState().zoom;
    };
    const onGestureChange = (e: any) => {
      e.preventDefault();
      if (!gesturing) return;
      const rect = el.getBoundingClientRect();
      const cx = (e.clientX ?? rect.width / 2) - rect.left;
      const cy = (e.clientY ?? rect.height / 2) - rect.top;
      const newZoom = Math.max(0.1, Math.min(5, gestureStartZoom * e.scale));
      useCanvasStore.getState().zoomAtPoint(newZoom, cx, cy);
    };
    const onGestureEnd = (e: any) => {
      e.preventDefault();
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

    el.addEventListener("gesturestart", onGestureStart, { passive: false } as any);
    el.addEventListener("gesturechange", onGestureChange, { passive: false } as any);
    el.addEventListener("gestureend", onGestureEnd, { passive: false } as any);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div
      ref={canvasRef}
      className="canvas"
      onMouseDown={handleMouseDown}
      style={{
        backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
        backgroundPosition: `${panX % (24 * zoom)}px ${panY % (24 * zoom)}px`,
      }}
    >
      <div
        className="canvas-content"
        style={{
          transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
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
          Double-click to create a terminal
        </div>
      )}

      {/* Zoom indicator */}
      {zoom !== 1 && (
        <div className="canvas-zoom-badge">
          {Math.round(zoom * 100)}%
        </div>
      )}

    </div>
  );
}
