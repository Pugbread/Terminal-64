import { useCallback, useRef, useEffect } from "react";
import { useCanvasStore } from "../../stores/canvasStore";
import { useShallow } from "zustand/react/shallow";
import FloatingTerminal from "./FloatingTerminal";
import LeftPanelContainer from "../panels/LeftPanelContainer";
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

  // Zoom with scroll wheel (non-passive so preventDefault works)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const s = useCanvasStore.getState();
        const oldZoom = s.zoom;
        const delta = e.deltaY > 0 ? -0.08 : 0.08;
        const newZoom = Math.max(0.3, Math.min(2, oldZoom + delta));
        // Adjust pan so the center stays fixed
        const scale = newZoom / oldZoom;
        const newPanX = cx - scale * (cx - s.panX);
        const newPanY = cy - scale * (cy - s.panY);
        s.setZoom(newZoom);
        s.pan(newPanX - s.panX, newPanY - s.panY);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Double-click to spawn terminal at cursor
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target !== canvasRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const z = useCanvasStore.getState().zoom;
      const px = useCanvasStore.getState().panX;
      const py = useCanvasStore.getState().panY;
      const x = (e.clientX - rect.left - px) / z - 350;
      const y = (e.clientY - rect.top - py) / z - 225;
      addTerminal(x, y);
    },
    [addTerminal]
  );

  return (
    <div
      ref={canvasRef}
      className="canvas"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      style={{
        backgroundSize: "24px 24px",
        backgroundPosition: `${panX % 24}px ${panY % 24}px`,
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
        <LeftPanelContainer />
      </div>

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
