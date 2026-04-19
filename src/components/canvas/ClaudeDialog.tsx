import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../stores/settingsStore";
import { useClaudeStore, STORAGE_KEY } from "../../stores/claudeStore";
import { listDiskSessions } from "../../lib/tauriApi";
import { useSemanticSearch } from "../../hooks/useSemanticSearch";
import type { DiskSession } from "../../lib/types";
import { formatRelativeTime } from "../../lib/constants";
import "./ClaudeDialog.css";

interface ClaudeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (cwd: string, skipPermissions: boolean, sessionName?: string) => void;
  onReopen: (sessionId: string, cwd: string) => void;
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
  const [searchMode, setSearchMode] = useState<"keyword" | "semantic">("keyword");
  const semantic = useSemanticSearch("sessions", 10);
  const recentDirs = useSettingsStore((s) => s.recentDirs);
  const addRecentDir = useSettingsStore((s) => s.addRecentDir);
  const sessions = useClaudeStore((s) => s.sessions);
  const inputRef = useRef<HTMLInputElement>(null);

  const namedSessions = getNamedSessions(sessions, dir);

  useEffect(() => {
    if (isOpen) {
      setDir("");
      setName("");
      setDiskSessions([]);
      setSearchMode("keyword");
      semantic.clear();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!dir.trim()) { setDiskSessions([]); return; }
    setLoading(true);
    listDiskSessions(dir.trim()).then((s) => {
      setDiskSessions(s);
      setLoading(false);
    }).catch(() => { setDiskSessions([]); setLoading(false); });
  }, [dir]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

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
    onReopen(sessionId, dir.trim());
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
              {/* Search mode toggle */}
              <div className="vs-mode-toggle">
                <button
                  className={`vs-mode-btn ${searchMode === "keyword" ? "vs-mode-btn--active" : ""}`}
                  onClick={() => { setSearchMode("keyword"); semantic.clear(); }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                  </svg>
                  Keyword
                </button>
                <button
                  className={`vs-mode-btn ${searchMode === "semantic" ? "vs-mode-btn--active" : ""}`}
                  onClick={() => setSearchMode("semantic")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/>
                    <path d="M8 6a4 4 0 0 1 8 0"/>
                    <path d="M5.2 11.2a8 8 0 0 1 13.6 0"/>
                    <path d="M2 16.8a12 12 0 0 1 20 0"/>
                  </svg>
                  Semantic
                </button>
              </div>

              {/* Semantic search mode */}
              {searchMode === "semantic" && (
                <div className="vs-search-section">
                  <div className="vs-search-bar">
                    <svg className="vs-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/>
                      <path d="M8 6a4 4 0 0 1 8 0"/>
                      <path d="M5.2 11.2a8 8 0 0 1 13.6 0"/>
                      <path d="M2 16.8a12 12 0 0 1 20 0"/>
                    </svg>
                    <input
                      className="vs-search-input"
                      value={semantic.query}
                      onChange={(e) => semantic.search(e.target.value)}
                      placeholder="Describe what you're looking for..."
                      autoFocus
                    />
                    {semantic.searching && <span className="vs-search-spinner" />}
                  </div>

                  {semantic.results.length > 0 && (
                    <div className="vs-results">
                      <label className="claude-dialog-label">
                        Semantic Matches
                        <span className="claude-dialog-count">{semantic.results.length}</span>
                      </label>
                      <div className="vs-results-list">
                        {semantic.results.map((r) => (
                          <button
                            key={r.id}
                            className="vs-result-item"
                            onClick={() => handleOpenSession(r.id)}
                          >
                            <div className="vs-result-top">
                              <span className="vs-result-text">{r.title || r.id}</span>
                              <span className="vs-result-score">{Math.max(0, (1 - r.distance) * 100).toFixed(0)}%</span>
                            </div>
                            {r.content_preview && (
                              <span className="vs-result-meta">{r.content_preview}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {!semantic.searching && semantic.query.trim() && semantic.results.length === 0 && (
                    <div className="vs-empty">No semantic matches found</div>
                  )}
                </div>
              )}

              {/* Keyword mode: original session browser */}
              {searchMode === "keyword" && (
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
                            <span className="claude-dialog-session-meta">{formatRelativeTime(s.modified * 1000)}</span>
                            <span className="claude-dialog-session-size">{formatSize(s.size)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {loading && searchMode === "keyword" && (
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

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function cwdMatch(a: string | undefined, b: string): boolean {
  if (!a || !b) return true;
  return normPath(a) === normPath(b);
}

function getNamedSessions(liveSessions: Record<string, any>, cwd: string): { id: string; name: string; messageCount: number }[] {
  const results: { id: string; name: string; messageCount: number }[] = [];
  const seen = new Set<string>();

  // Live sessions
  for (const [id, s] of Object.entries(liveSessions)) {
    if (s.name && cwdMatch(s.cwd, cwd)) {
      results.push({ id, name: s.name, messageCount: s.messages?.length || 0 });
      seen.add(id);
    }
  }

  // Persisted sessions
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      for (const [id, session] of Object.entries(data as Record<string, any>)) {
        if (session.name && !seen.has(id) && cwdMatch(session.cwd, cwd)) {
          results.push({ id, name: session.name, messageCount: session.messages?.length || 0 });
        }
      }
    }
  } catch (e) {
    console.warn("[claude-dialog] Failed to load persisted sessions:", e);
  }

  return results;
}
