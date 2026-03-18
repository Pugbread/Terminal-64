import { useState, useEffect, useRef, useCallback } from "react";
import { useSettingsStore, QuickPaste } from "../../stores/settingsStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { writeTerminal } from "../../lib/tauriApi";
import "./CommandPalette.css";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const quickPastes = useSettingsStore((s) => s.quickPastes);
  const touchQuickPaste = useSettingsStore((s) => s.touchQuickPaste);
  const activeTerminalId = useCanvasStore((s) => s.activeTerminalId);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sort by recently used, then filter by query
  const sorted = [...quickPastes].sort((a, b) => b.lastUsed - a.lastUsed);
  const filtered = query
    ? sorted.filter((q) =>
        q.command.toLowerCase().includes(query.toLowerCase())
      )
    : sorted;

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const execute = useCallback(
    (qp: QuickPaste) => {
      if (!activeTerminalId) return;
      touchQuickPaste(qp.id);
      writeTerminal(activeTerminalId, qp.command).catch(() => {});
      onClose();
    },
    [activeTerminalId, touchQuickPaste, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) execute(filtered[selectedIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Search quick pastes..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-results">
          {filtered.map((qp, i) => (
            <div
              key={qp.id}
              className={`command-palette-item ${i === selectedIndex ? "selected" : ""}`}
              onClick={() => execute(qp)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <div className="qp-command">{qp.command}</div>
            </div>
          ))}
          {filtered.length === 0 && quickPastes.length === 0 && (
            <div className="command-palette-empty">
              No quick pastes yet. Add them in Settings.
            </div>
          )}
          {filtered.length === 0 && quickPastes.length > 0 && (
            <div className="command-palette-empty">No matches</div>
          )}
        </div>
      </div>
    </div>
  );
}
