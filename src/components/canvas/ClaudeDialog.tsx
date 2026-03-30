import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../stores/settingsStore";
import { useClaudeStore } from "../../stores/claudeStore";
import { listDiskSessions, DiskSession } from "../../lib/tauriApi";
import "./ClaudeDialog.css";

interface ClaudeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (cwd: string, skipPermissions: boolean, sessionName?: string) => void;
  onReopen: (sessionId: string) => void;
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

export default function ClaudeDialog({ isOpen, onClose, onConfirm, onReopen }: ClaudeDialogProps) {
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
  const [diskSessions, setDiskSessions] = useState<DiskSession[]>([]);
  const [loading, setLoading] = useState(false);
  const recentDirs = useSettingsStore((s) => s.recentDirs);
  const addRecentDir = useSettingsStore((s) => s.addRecentDir);
  const sessions = useClaudeStore((s) => s.sessions);
  const inputRef = useRef<HTMLInputElement>(null);

  // Get named sessions that match the selected directory
  const namedSessions = getNamedSessions(sessions, dir);

  useEffect(() => {
    if (isOpen) {
      setDir("");
      setName("");
      setDiskSessions([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Load disk sessions when directory changes
  useEffect(() => {
    if (!dir.trim()) { setDiskSessions([]); return; }
    setLoading(true);
    listDiskSessions(dir.trim()).then((s) => {
      setDiskSessions(s);
      setLoading(false);
    }).catch(() => { setDiskSessions([]); setLoading(false); });
  }, [dir]);

  if (!isOpen) return null;

  const handleBrowse = async () => {
    const selected = await open({ directory: true, title: "Select project folder" });
    if (selected) setDir(selected as string);
  };

  const handleNewSession = () => {
    if (!dir.trim()) return;
    addRecentDir(dir.trim());
    onConfirm(dir.trim(), false, name.trim() || undefined);
    onClose();
  };

  const handleOpenSession = (sessionId: string) => {
    if (dir.trim()) addRecentDir(dir.trim());
    onReopen(sessionId);
    onClose();
  };

  const handleQuickDir = (d: string) => {
    setDir(d);
  };

  const hasDir = dir.trim().length > 0;
  // Named sessions (from our store) pinned at top
  const namedIds = new Set(namedSessions.map((s) => s.id));
  // Disk sessions that aren't already named
  const otherDiskSessions = diskSessions.filter((s) => !namedIds.has(s.id));

  return (
    <div className="claude-dialog-overlay" onClick={onClose}>
      <div className="claude-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="claude-dialog-header">
          <span className="claude-dialog-title">&gt;_ Claude Session</span>
          <button className="claude-dialog-close" onClick={onClose}>
            <svg width="9" height="9" viewBox="0 0 9 9">
              <path d="M1 1L8 8M8 1L1 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="claude-dialog-body">
          {/* Step 1: Directory */}
          <label className="claude-dialog-label">Project Directory</label>
          <div className="claude-dialog-dir-row">
            <input
              ref={inputRef}
              className="claude-dialog-input"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="Select or type a project path"
              onKeyDown={(e) => e.key === "Enter" && hasDir && handleNewSession()}
            />
            <button className="claude-dialog-browse" onClick={handleBrowse}>Browse</button>
          </div>

          {/* Recent dirs as chips */}
          {recentDirs.length > 0 && !hasDir && (
            <div className="claude-dialog-chips">
              {recentDirs.map((d) => (
                <button key={d} className="claude-dialog-chip" onClick={() => handleQuickDir(d)}>
                  {d.split(/[/\\]/).slice(-2).join("/")}
                </button>
              ))}
            </div>
          )}

          {/* Step 2: Sessions (shown after directory is selected) */}
          {hasDir && (
            <>
              {/* Named/saved sessions pinned at top */}
              {namedSessions.length > 0 && (
                <div className="claude-dialog-section">
                  <label className="claude-dialog-label">Saved Sessions</label>
                  {namedSessions.map((s) => (
                    <div key={s.id} className="claude-dialog-session-row">
                      <button className="claude-dialog-session claude-dialog-session--named" onClick={() => handleOpenSession(s.id)}>
                        <span className="claude-dialog-session-pin">&#9733;</span>
                        <span className="claude-dialog-session-name">{s.name}</span>
                        <span className="claude-dialog-session-meta">{s.messageCount} msgs</span>
                      </button>
                      <button
                        className="claude-dialog-session-delete"
                        onClick={() => useClaudeStore.getState().deleteSession(s.id)}
                        title="Delete session"
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10">
                          <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* All disk sessions */}
              {otherDiskSessions.length > 0 && (
                <div className="claude-dialog-section">
                  <label className="claude-dialog-label">
                    Previous Sessions
                    <span className="claude-dialog-count">{otherDiskSessions.length}</span>
                  </label>
                  <div className="claude-dialog-session-list">
                    {otherDiskSessions.map((s) => (
                      <button key={s.id} className="claude-dialog-session" onClick={() => handleOpenSession(s.id)}>
                        <span className="claude-dialog-session-id">{s.summary || s.id.slice(0, 8)}</span>
                        <span className="claude-dialog-session-meta">{timeAgo(s.modified)}</span>
                        <span className="claude-dialog-session-size">{formatSize(s.size)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {loading && (
                <div className="claude-dialog-loading">Scanning sessions...</div>
              )}

              {/* New session */}
              <div className="claude-dialog-section">
                <label className="claude-dialog-label">New Session</label>
                <input
                  className="claude-dialog-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Session name (optional — saves it)"
                  onKeyDown={(e) => e.key === "Enter" && handleNewSession()}
                />
              </div>
            </>
          )}
        </div>

        <div className="claude-dialog-footer">
          <button className="claude-dialog-cancel" onClick={onClose}>Cancel</button>
          <button
            className="claude-dialog-confirm"
            onClick={handleNewSession}
            disabled={!hasDir}
          >
            New Session
          </button>
        </div>
      </div>
    </div>
  );
}

function getNamedSessions(liveSessions: Record<string, any>, cwd: string): { id: string; name: string; messageCount: number }[] {
  const results: { id: string; name: string; messageCount: number }[] = [];
  const seen = new Set<string>();

  // Live sessions
  for (const [id, s] of Object.entries(liveSessions)) {
    if (s.name && (!cwd || !s.cwd || s.cwd === cwd)) {
      results.push({ id, name: s.name, messageCount: s.messages?.length || 0 });
      seen.add(id);
    }
  }

  // Persisted sessions
  try {
    const raw = localStorage.getItem("terminal64-claude-sessions");
    if (raw) {
      const data = JSON.parse(raw);
      for (const [id, session] of Object.entries(data as Record<string, any>)) {
        if (session.name && !seen.has(id) && (!cwd || !session.cwd || session.cwd === cwd)) {
          results.push({ id, name: session.name, messageCount: session.messages?.length || 0 });
        }
      }
    }
  } catch {}

  return results;
}
