import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../stores/settingsStore";
import "./ClaudeDialog.css";

interface ClaudeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (cwd: string, skipPermissions: boolean) => void;
}

export default function ClaudeDialog({ isOpen, onClose, onConfirm }: ClaudeDialogProps) {
  const [dir, setDir] = useState("");
  const [skip, setSkip] = useState(false);
  const recentDirs = useSettingsStore((s) => s.recentDirs);
  const addRecentDir = useSettingsStore((s) => s.addRecentDir);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setDir("");
      setSkip(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBrowse = async () => {
    const selected = await open({ directory: true, title: "Select project folder" });
    if (selected) setDir(selected as string);
  };

  const handleConfirm = () => {
    if (!dir.trim()) return;
    addRecentDir(dir.trim());
    onConfirm(dir.trim(), skip);
    onClose();
  };

  const handleQuickSelect = (d: string) => {
    addRecentDir(d);
    onConfirm(d, skip);
    onClose();
  };

  return (
    <div className="claude-dialog-overlay" onClick={onClose}>
      <div className="claude-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="claude-dialog-header">
          <span className="claude-dialog-title">&gt;_ New Claude Session</span>
          <button className="claude-dialog-close" onClick={onClose}>
            <svg width="9" height="9" viewBox="0 0 9 9">
              <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="claude-dialog-body">
          {/* Recent directories */}
          {recentDirs.length > 0 && (
            <div className="claude-dialog-recent">
              <label className="claude-dialog-label">Recent</label>
              {recentDirs.map((d) => (
                <button
                  key={d}
                  className="claude-dialog-recent-item"
                  onClick={() => handleQuickSelect(d)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M1 3L5 1H11V11H1V3Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
                  </svg>
                  <span>{d.split(/[/\\]/).slice(-2).join("/")}</span>
                  <span className="claude-dialog-recent-full">{d}</span>
                </button>
              ))}
            </div>
          )}

          <label className="claude-dialog-label">Project Directory</label>
          <div className="claude-dialog-dir-row">
            <input
              ref={inputRef}
              className="claude-dialog-input"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="C:\Users\you\project"
              onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
            />
            <button className="claude-dialog-browse" onClick={handleBrowse}>
              Browse
            </button>
          </div>

          <label
            className="claude-dialog-checkbox"
            onClick={() => setSkip((v) => !v)}
          >
            <div className={`claude-dialog-check ${skip ? "checked" : ""}`}>
              {skip && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
            <span>--dangerously-skip-permissions</span>
          </label>
        </div>

        <div className="claude-dialog-footer">
          <button className="claude-dialog-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            className="claude-dialog-confirm"
            onClick={handleConfirm}
            disabled={!dir.trim()}
          >
            Launch Claude
          </button>
        </div>
      </div>
    </div>
  );
}
