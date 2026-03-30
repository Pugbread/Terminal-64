import { useEffect, useRef, useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useClaudeStore } from "../../stores/claudeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { createClaudeSession, sendClaudePrompt, cancelClaude, listSlashCommands, resolvePermission, readFile, writeFile, listMcpServers } from "../../lib/tauriApi";
import type { McpServer } from "../../lib/types";
import { SlashCommand, PermissionMode } from "../../lib/types";
import { rewritePromptStream } from "../../lib/ai";
import ChatMessage, { toolHeader, renderContent, ReadGroupCard } from "./ChatMessage";
import Editor from "@monaco-editor/react";
import FileTree from "./FileTree";
import { fontStack } from "../../lib/fonts";
import ChatInput from "./ChatInput";
import "./ClaudeChat.css";

function guessLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    rs: "rust", py: "python", go: "go", java: "java", json: "json",
    css: "css", scss: "scss", html: "html", md: "markdown", yaml: "yaml",
    yml: "yaml", toml: "toml", sh: "shell", bash: "shell", zsh: "shell",
    sql: "sql", xml: "xml", swift: "swift", kt: "kotlin", rb: "ruby",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  };
  return map[ext] || "plaintext";
}

const MODELS = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Med" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

const PERMISSION_MODES: { id: PermissionMode; label: string; color: string; desc: string }[] = [
  { id: "default", label: "Default", color: "#89b4fa", desc: "Ask before every tool" },
  { id: "plan", label: "Plan", color: "#94e2d5", desc: "Read-only, no edits" },
  { id: "auto", label: "Auto", color: "#a6e3a1", desc: "Auto-approve safe ops" },
  { id: "accept_edits", label: "Edits", color: "#cba6f7", desc: "Auto-approve all edits" },
  { id: "bypass_all", label: "YOLO", color: "#f38ba8", desc: "Skip ALL permissions" },
];

interface ClaudeChatProps {
  sessionId: string;
  cwd: string;
  skipPermissions: boolean;
  isActive: boolean;
}

export default function ClaudeChat({ sessionId, cwd, skipPermissions, isActive }: ClaudeChatProps) {
  const session = useClaudeStore((s) => s.sessions[sessionId]);
  const createSession = useClaudeStore((s) => s.createSession);
  const addUserMessage = useClaudeStore((s) => s.addUserMessage);
  const incrementPromptCount = useClaudeStore((s) => s.incrementPromptCount);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [configMcpServers, setConfigMcpServers] = useState<McpServer[]>([]);
  const [showMcpDrop, setShowMcpDrop] = useState(false);
  const [showFileTree, setShowFileTree] = useState(false);
  const liveMcp = useClaudeStore((s) => s.sessions[sessionId]?.mcpServers);
  // Live status from session init takes priority; fall back to config-file list
  const mcpServers = (liveMcp && liveMcp.length > 0) ? liveMcp : configMcpServers;
  const [selectedModel, setSelectedModel] = useState(
    () => useSettingsStore.getState().claudeModel || "sonnet"
  );
  const [selectedEffort, setSelectedEffort] = useState(
    () => useSettingsStore.getState().claudeEffort || "high"
  );
  const [permModeIdx, setPermModeIdx] = useState(() => {
    if (skipPermissions) return 4; // YOLO when skipPermissions is set
    const stored = useSettingsStore.getState().claudePermMode;
    if (stored) {
      const idx = PERMISSION_MODES.findIndex((m) => m.id === stored);
      if (idx >= 0) return idx;
    }
    return 0; // default: Default (ask for everything)
  });
  const [showModelDrop, setShowModelDrop] = useState(false);
  const [showEffortDrop, setShowEffortDrop] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [planFinished, setPlanFinished] = useState(false);
  const [showPlanViewer, setShowPlanViewer] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [rewindText, setRewindText] = useState<string | null>(null);
  const [editOverlay, setEditOverlay] = useState<{ tcId: string; filePath: string; fullContent: string; changedLines: Set<number> } | null>(null);
  const editOverrides = useRef<Record<string, string>>({});
  const savedScrollTop = useRef<number>(0);
  const modifiedEditorRef = useRef<any>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const editorSavedContent = useRef<string>("");

  const permMode = PERMISSION_MODES[permModeIdx];

  useEffect(() => {
    createSession(sessionId);
    // Save CWD for session persistence
    if (cwd && cwd !== ".") {
      useClaudeStore.getState().setCwd(sessionId, cwd);
    }
  }, [sessionId, createSession, cwd]);
  useEffect(() => { listSlashCommands().then(setSlashCommands).catch(() => {}); }, []);
  useEffect(() => { listMcpServers(cwd).then(setConfigMcpServers).catch(() => {}); }, [cwd]);
  // Apply persisted font on mount (once per app, harmless if called multiple times)
  useEffect(() => {
    document.documentElement.style.setProperty("--claude-font", fontStack(useSettingsStore.getState().claudeFont || "system"));
  }, []);
  // Track whether user is at the bottom so we only auto-scroll when appropriate
  const wasAtBottom = useRef(true);
  useEffect(() => {
    const el = messagesEndRef.current?.parentElement;
    if (!el) return;
    const handler = () => {
      wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);
  // Scroll on new messages (only if at bottom)
  useEffect(() => {
    if (!wasAtBottom.current) return;
    const el = messagesEndRef.current?.parentElement;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [session?.messages]);
  // For streaming, scroll instantly (only if at bottom)
  useEffect(() => {
    if (!session?.streamingText || !wasAtBottom.current) return;
    const el = messagesEndRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.streamingText]);
  useEffect(() => {
    const handler = () => { setShowModelDrop(false); setShowEffortDrop(false); setShowMcpDrop(false); };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  // Shift+Tab cycles permission mode
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        setPermModeIdx((i) => { const next = (i + 1) % PERMISSION_MODES.length; useSettingsStore.getState().set({ claudePermMode: PERMISSION_MODES[next].id }); return next; });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive]);

  // React to plan mode changes from EnterPlanMode/ExitPlanMode
  const wasPlanMode = useRef(false);
  useEffect(() => {
    if (!session) return;
    if (session.planModeActive) {
      wasPlanMode.current = true;
      setPermModeIdx(1); // Plan is index 1
    } else if (wasPlanMode.current) {
      wasPlanMode.current = false;
      setPlanFinished(true);
      setPermModeIdx(0);
    }
  }, [session?.planModeActive]);

  // Detect plan files from tool calls
  useEffect(() => {
    if (!session) return;
    const msgs = session.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if ((tc.name === "Write" || tc.name === "Edit" || tc.name === "Read") && tc.input.file_path) {
            const fp = String(tc.input.file_path);
            if (fp.includes(".claude/plans/") || fp.includes(".claude\\plans\\")) {
              // Found a plan file — show its content from the tool result
              if (tc.name === "Read" && tc.result) {
                setPlanContent(tc.result);
              } else if ((tc.name === "Write" || tc.name === "Edit") && tc.input.content) {
                setPlanContent(String(tc.input.content));
              }
              return;
            }
          }
        }
      }
    }
  }, [session?.messages]);

  // Tauri native drag-drop — only the active session handles drops
  useEffect(() => {
    if (!isActive) return;
    let unlisten: (() => void) | null = null;
    const appWindow = getCurrentWebviewWindow();
    appWindow.onDragDropEvent((event: any) => {
      if (event.payload.type === "over") {
        setIsDragOver(true);
      } else if (event.payload.type === "leave" || event.payload.type === "cancel") {
        setIsDragOver(false);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        const paths: string[] = event.payload.paths || [];
        if (paths.length) setAttachedFiles((prev) => [...prev, ...paths]);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [isActive]);

  // Resolve CWD: use prop, fall back to stored session CWD
  const effectiveCwd = (cwd && cwd !== ".") ? cwd : (session?.cwd || ".");

  const handleSend = useCallback(
    async (text: string, permissionOverride?: PermissionMode) => {
      let prompt = text;
      if (attachedFiles.length > 0) {
        const fileList = attachedFiles.map((f) => `[Attached file: ${f}]`).join("\n");
        prompt = fileList + "\n\n" + text;
        setAttachedFiles([]);
      }
      addUserMessage(sessionId, prompt);
      // Forward to Discord so it shows in the channel
      emit("gui-message", { session_id: sessionId, content: prompt }).catch(() => {});
      const promptCount = session?.promptCount ?? 0;
      try {
        const req = {
          session_id: sessionId, cwd: effectiveCwd, prompt,
          permission_mode: permissionOverride || permMode.id,
          model: selectedModel || undefined,
          effort: selectedEffort || undefined,
        };
        if (promptCount === 0 && (!effectiveCwd || effectiveCwd === ".")) {
          useClaudeStore.getState().setError(sessionId, "No working directory set. Create a new session.");
          return;
        }
        // Try resume first (works if session exists on disk), fall back to create
        if (promptCount > 0) {
          await sendClaudePrompt({ ...req, cwd: effectiveCwd });
        } else {
          try {
            await createClaudeSession(req);
          } catch {
            // Session might already exist from Discord — try resume
            await sendClaudePrompt({ ...req, cwd: effectiveCwd });
          }
        }
        incrementPromptCount(sessionId);
      } catch (err) {
        useClaudeStore.getState().setError(sessionId, String(err));
      }
    },
    [sessionId, effectiveCwd, permMode, selectedModel, selectedEffort, attachedFiles, session?.promptCount, addUserMessage, incrementPromptCount]
  );

  const handleCancel = useCallback(() => { cancelClaude(sessionId).catch(() => {}); }, [sessionId]);

  const handleRewrite = useCallback(async (text: string, setText: (t: string) => void) => {
    setIsRewriting(true);
    try {
      let rewritten = "";
      await rewritePromptStream(text, (chunk) => {
        rewritten += chunk;
        setText(rewritten);
      });
    } catch (err) {
      useClaudeStore.getState().setError(sessionId, `Rewrite failed: ${err}`);
    } finally {
      setIsRewriting(false);
    }
  }, [sessionId]);
  const handleRewind = useCallback((messageId: string, content: string) => {
    // Cancel any running process
    cancelClaude(sessionId).catch(() => {});
    // Truncate conversation from this message
    useClaudeStore.getState().truncateFromMessage(sessionId, messageId);
    // Pre-fill the input with the old message text for editing
    setRewindText(content);
  }, [sessionId]);

  const handleEditClick = useCallback(async (tcId: string, filePath: string, _oldStr: string, newStr: string) => {
    // Save scroll position before opening overlay
    const el = messagesEndRef.current?.parentElement;
    if (el) savedScrollTop.current = el.scrollTop;
    // Use persisted full-file content if available
    if (editOverrides.current[tcId]) {
      const cached = editOverrides.current[tcId];
      const idx = cached.indexOf(newStr);
      const changed = new Set<number>();
      if (idx >= 0) {
        const startLine = cached.substring(0, idx).split("\n").length;
        const numLines = newStr.split("\n").length;
        for (let i = 0; i < numLines; i++) changed.add(startLine + i);
      }
      setEditOverlay({ tcId, filePath, fullContent: cached, changedLines: changed });
      return;
    }
    // Read full file from disk
    try {
      const content = await readFile(filePath);
      const idx = content.indexOf(newStr);
      const changed = new Set<number>();
      if (idx >= 0) {
        const startLine = content.substring(0, idx).split("\n").length;
        const numLines = newStr.split("\n").length;
        for (let i = 0; i < numLines; i++) changed.add(startLine + i);
      }
      setEditOverlay({ tcId, filePath, fullContent: content, changedLines: changed });
    } catch {
      // Fallback: show just the new string with all lines marked changed
      const lines = newStr.split("\n");
      const changed = new Set(lines.map((_, i) => i + 1));
      setEditOverlay({ tcId, filePath, fullContent: newStr, changedLines: changed });
    }
  }, []);

  const handleFileTreeOpen = useCallback(async (filePath: string) => {
    const el = messagesEndRef.current?.parentElement;
    if (el) savedScrollTop.current = el.scrollTop;
    try {
      const content = await readFile(filePath);
      setEditOverlay({ tcId: `file:${filePath}`, filePath, fullContent: content, changedLines: new Set() });
    } catch {}
  }, []);

  const handleAttach = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, title: "Attach files" });
      if (selected) setAttachedFiles((prev) => [...prev, ...(Array.isArray(selected) ? selected : [selected])]);
    } catch {}
  }, []);

  const hasPlan = planContent !== null;
  const hasTasks = (session?.tasks.length ?? 0) > 0;
  const hasSideContent = hasPlan || hasTasks;

  // Auto-open side panel when content appears (must be before any early return)
  useEffect(() => {
    if (hasSideContent && !sidePanelOpen) setSidePanelOpen(true);
  }, [hasSideContent]);

  if (!session) return <div className="cc-container cc-loading">Initializing...</div>;

  const hasMessages = session.messages.length > 0 || session.streamingText;
  const currentModel = MODELS.find((m) => m.id === selectedModel) || MODELS[0];
  const currentEffort = EFFORTS.find((e) => e.id === selectedEffort) || EFFORTS[2];

  return (
    <div
      className={`cc-container ${isDragOver ? "cc-container--dragover" : ""}`}
      ref={containerRef}
    >
      {/* Topbar */}
      <div className="cc-topbar">
        <button className={`cc-filetree-toggle ${showFileTree ? "cc-filetree-toggle--open" : ""}`} onClick={() => setShowFileTree((v) => !v)} title="Toggle file browser">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1L7 5L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <div className="cc-topbar-left">
          {/* MCP servers */}
          <div className="cc-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
            <button className={`cc-dropdown-trigger cc-mcp-btn ${mcpServers.length > 0 ? "cc-mcp-btn--active" : ""} ${mcpServers.some((s: any) => s.status === "failed" || s.status === "error") ? "cc-mcp-btn--error" : ""}`} onClick={() => { setShowMcpDrop((v) => !v); setShowModelDrop(false); setShowEffortDrop(false); }}>
              MCP{mcpServers.length > 0 ? ` (${mcpServers.length})` : ""}<span className="cc-chevron">▾</span>
            </button>
            {showMcpDrop && (
              <div className="cc-dropdown cc-mcp-dropdown">
                {mcpServers.length === 0 ? (
                  <div className="cc-mcp-empty">No MCP servers configured</div>
                ) : (
                  mcpServers.map((s: any) => {
                    const status = s.status || "configured";
                    const isError = status === "failed" || status === "error";
                    const isConnected = status === "connected";
                    return (
                      <div key={s.name} className="cc-mcp-item">
                        <span className={`cc-mcp-dot ${isError ? "cc-mcp-dot--error" : isConnected ? "cc-mcp-dot--ok" : "cc-mcp-dot--idle"}`} />
                        <div className="cc-mcp-info">
                          <span className="cc-mcp-name">{s.name}</span>
                          <span className="cc-mcp-meta">{status}{s.transport ? ` · ${s.transport}` : ""}{s.scope ? ` · ${s.scope}` : ""}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Model dropdown */}
          <div className="cc-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="cc-dropdown-trigger" onClick={() => { setShowModelDrop((v) => !v); setShowEffortDrop(false); setShowMcpDrop(false); }}>
              {currentModel.label}<span className="cc-chevron">▾</span>
            </button>
            {showModelDrop && (
              <div className="cc-dropdown">
                {MODELS.map((m) => (
                  <button key={m.id} className={`cc-dropdown-item ${m.id === selectedModel ? "cc-dropdown-item--active" : ""}`}
                    onClick={() => { setSelectedModel(m.id); useSettingsStore.getState().set({ claudeModel: m.id }); setShowModelDrop(false); }}>{m.label}</button>
                ))}
              </div>
            )}
          </div>

          {/* Effort dropdown */}
          <div className="cc-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="cc-dropdown-trigger" onClick={() => { setShowEffortDrop((v) => !v); setShowModelDrop(false); setShowMcpDrop(false); }}>
              {currentEffort.label}<span className="cc-chevron">▾</span>
            </button>
            {showEffortDrop && (
              <div className="cc-dropdown">
                {EFFORTS.map((e) => (
                  <button key={e.id} className={`cc-dropdown-item ${e.id === selectedEffort ? "cc-dropdown-item--active" : ""}`}
                    onClick={() => { setSelectedEffort(e.id); useSettingsStore.getState().set({ claudeEffort: e.id }); setShowEffortDrop(false); }}>{e.label}</button>
                ))}
              </div>
            )}
          </div>

        </div>

        <div className="cc-topbar-right">
          {session.totalTokens > 0 && (
            <span className="cc-topbar-cost">{session.totalTokens >= 1000 ? `${(session.totalTokens / 1000).toFixed(1)}k` : session.totalTokens} tk</span>
          )}
          {hasSideContent && (
            <button
              className={`cc-panel-toggle ${sidePanelOpen ? "cc-panel-toggle--active" : ""}`}
              onClick={() => setSidePanelOpen((v) => !v)}
              title="Toggle side panel"
            >
              ☰
            </button>
          )}
        </div>
      </div>

      {isDragOver && <div className="cc-drag-overlay"><span>Drop files to attach</span></div>}

      {/* File tree sidebar */}
      {showFileTree && (
        <FileTree cwd={effectiveCwd} onFileClick={handleFileTreeOpen} onClose={() => setShowFileTree(false)} />
      )}

      {/* Main area */}
      <div className="cc-main">
        <div className="cc-chat-col">
          {editOverlay ? (
            <div className="cc-messages cc-edit-overlay">
              <div className="cc-edit-overlay-header">
                <span className="cc-edit-overlay-path">{editOverlay.filePath}</span>
                <div className="cc-edit-overlay-actions">
                  <span className={`cc-edit-overlay-tag ${editorDirty ? "cc-edit-overlay-tag--unsaved" : "cc-edit-overlay-tag--saved"}`}>{editorDirty ? "Unsaved" : "Saved"}</span>
                  <button className="cc-edit-overlay-btn cc-edit-overlay-save" onClick={() => {
                    if (modifiedEditorRef.current && editorDirty) {
                      const content = modifiedEditorRef.current.getValue();
                      writeFile(editOverlay.filePath, content).catch(() => {});
                      editOverrides.current[editOverlay.tcId] = content;
                      editorSavedContent.current = content;
                      setEditorDirty(false);
                    }
                  }}><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M12.5 2H3.5C2.67 2 2 2.67 2 3.5V12.5C2 13.33 2.67 14 3.5 14H12.5C13.33 14 14 13.33 14 12.5V3.5C14 2.67 13.33 2 12.5 2ZM8 12C6.9 12 6 11.1 6 10S6.9 8 8 8S10 8.9 10 10S9.1 12 8 12ZM11 6H4V3H11V6Z" fill="currentColor"/></svg></button>
                  <button className="cc-edit-overlay-btn cc-edit-overlay-close" onClick={() => {
                    if (modifiedEditorRef.current) {
                      editOverrides.current[editOverlay.tcId] = modifiedEditorRef.current.getValue();
                    }
                    setEditOverlay(null);
                    requestAnimationFrame(() => {
                      const el = messagesEndRef.current?.parentElement;
                      if (el) el.scrollTop = savedScrollTop.current;
                    });
                  }}>Close</button>
                </div>
              </div>
              <div className="cc-edit-overlay-editor">
                <Editor
                  value={editOverlay.fullContent}
                  language={guessLanguage(editOverlay.filePath)}
                  theme="terminal64"
                  beforeMount={(monaco) => {
                    const ui = useThemeStore.getState().currentTheme.ui;
                    monaco.editor.defineTheme("terminal64", {
                      base: "vs-dark",
                      inherit: true,
                      rules: [],
                      colors: {
                        "editor.background": ui.bg,
                        "editor.foreground": ui.fg,
                        "editorLineNumber.foreground": ui.fgMuted,
                        "editor.selectionBackground": ui.accent + "44",
                        "editor.lineHighlightBackground": ui.bgSecondary,
                        "editorWidget.background": ui.bgSecondary,
                        "editorWidget.border": ui.border,
                      },
                    });
                  }}
                  onMount={(editor, monaco) => {
                    modifiedEditorRef.current = editor;
                    editorSavedContent.current = editOverlay!.fullContent;
                    setEditorDirty(false);
                    const changed = editOverlay!.changedLines;
                    // Green decorations on changed lines
                    if (changed.size > 0) {
                      editor.createDecorationsCollection(
                        [...changed].map((line) => ({
                          range: new monaco.Range(line, 1, line, 1),
                          options: {
                            isWholeLine: true,
                            className: "cc-editor-changed-line",
                            glyphMarginClassName: "cc-editor-changed-gutter",
                          },
                        }))
                      );
                      // Auto-scroll to center of changed region
                      const sorted = [...changed].sort((a, b) => a - b);
                      const mid = sorted[Math.floor(sorted.length / 2)];
                      editor.revealLineInCenter(mid);
                    }
                    // Track dirty state
                    editor.onDidChangeModelContent(() => {
                      const current = editor.getValue();
                      setEditorDirty(current !== editorSavedContent.current);
                    });
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    fontFamily: "'Cascadia Code', Consolas, monospace",
                    scrollBeyondLastLine: false,
                    lineNumbers: "on",
                    wordWrap: "on",
                    glyphMargin: true,
                    folding: false,
                    lineDecorationsWidth: 0,
                    renderLineHighlight: "none",
                    padding: { top: 8, bottom: 8 },
                  }}
                />
              </div>
            </div>
          ) : showPlanViewer && planContent ? (
            <div className="cc-messages cc-plan-viewer">
              <div className="cc-bubble cc-bubble--assistant">
                {renderContent(planContent)}
              </div>
            </div>
          ) : (
          <div className="cc-messages">
            {!hasMessages && (
              <div className="cc-empty">
                <div className="cc-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                    <path d="M5 24L13 8L21 18L27 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <span className="cc-empty-text">Claude Code</span>
                <span className="cc-empty-sub">Send a message, type / for commands, or drop files</span>
              </div>
            )}
            {(() => {
              const elements: React.ReactNode[] = [];
              const msgs = session.messages;
              let i = 0;
              while (i < msgs.length) {
                const msg = msgs[i];
                // Check for consecutive Read-only assistant messages
                if (msg.role === "assistant" && !msg.content && msg.toolCalls?.length && msg.toolCalls.every((tc) => tc.name === "Read")) {
                  const readTcs = [...msg.toolCalls];
                  let j = i + 1;
                  while (j < msgs.length) {
                    const next = msgs[j];
                    if (next.role === "assistant" && !next.content && next.toolCalls?.length && next.toolCalls.every((tc) => tc.name === "Read")) {
                      readTcs.push(...next.toolCalls);
                      j++;
                    } else break;
                  }
                  if (j > i + 1) {
                    elements.push(<div key={`rg-${i}`} className="cc-message cc-message--assistant"><div className="cc-tc-list"><ReadGroupCard tcs={readTcs} /></div></div>);
                    i = j;
                    continue;
                  }
                }
                elements.push(<ChatMessage key={msg.id} message={msg} onRewind={handleRewind} onEditClick={handleEditClick} />);
                i++;
              }
              return elements;
            })()}
            {session.streamingText && (
              <div className="cc-message cc-message--assistant">
                <div className="cc-bubble cc-bubble--assistant cc-bubble--streaming">
                  {session.streamingText}
                  <span className="cc-cursor" />
                </div>
              </div>
            )}
            {/* Pending questions from AskUserQuestion — yields until all answered */}
            {session.pendingQuestions && (() => {
              const pq = session.pendingQuestions;
              const current = pq.items[pq.currentIndex];
              if (!current) return null;
              const progress = pq.items.length > 1 ? `(${pq.currentIndex + 1}/${pq.items.length})` : "";

              const submitAnswer = (answer: string) => {
                const store = useClaudeStore.getState();
                store.answerQuestion(sessionId, answer);
                const updated = useClaudeStore.getState().sessions[sessionId];
                if (!updated?.pendingQuestions) {
                  // All questions answered — format and send as follow-up prompt
                  const allAnswers = [...pq.answers, answer];
                  const formatted = pq.items.map((item, idx) =>
                    `${item.header || item.question}: ${allAnswers[idx]}`
                  ).join("\n");

                  // Update the tool call card with the answers
                  store.updateToolResult(sessionId, pq.toolUseId, formatted, false);

                  // Show "Answered questions" as a user message
                  addUserMessage(sessionId, `Answered questions:\n${formatted}`);

                  // Resume with answers — disallow AskUserQuestion to prevent retry loop
                  sendClaudePrompt({
                    session_id: sessionId, cwd: effectiveCwd,
                    prompt: `Here are my answers to your questions:\n${formatted}\n\nProceed based on these choices. Do not ask the same questions again.`,
                    permission_mode: permMode.id, model: selectedModel, effort: selectedEffort,
                    disallowed_tools: "AskUserQuestion",
                  }).then(() => incrementPromptCount(sessionId))
                    .catch((err) => store.setError(sessionId, String(err)));
                }
              };

              return (
                <div className="cc-question">
                  <div className="cc-question-header">
                    {current.header && <span className="cc-question-badge">{current.header}</span>}
                    <span className="cc-question-progress">{progress}</span>
                  </div>
                  <div className="cc-question-text">{current.question}</div>
                  <div className="cc-question-options">
                    {current.options.map((opt, i) => (
                      <button key={i} className="cc-question-btn" onClick={() => submitAnswer(opt.label)}>
                        <span className="cc-question-label">{opt.label}</span>
                        {opt.description && <span className="cc-question-desc">{opt.description}</span>}
                      </button>
                    ))}
                    <div className="cc-question-custom">
                      <input
                        className="cc-question-input"
                        placeholder="Or type a custom answer..."
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                            submitAnswer((e.target as HTMLInputElement).value.trim());
                            (e.target as HTMLInputElement).value = "";
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })()}
            {session.error && (
              <div className="cc-message cc-message--error">
                <div className="cc-error">{session.error}</div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          )}

          <div className="cc-footer">
            {planFinished && !session.isStreaming && (
              <div className="cc-plan-finished">
                <span className="cc-plan-finished-text">Plan complete</span>
                <div className="cc-plan-finished-actions">
                  <button className="cc-plan-finished-btn cc-plan-finished-btn--accept" onClick={() => {
                    setPlanFinished(false);
                    setShowPlanViewer(false);
                    handleSend("/compact Keep the plan file and key decisions only. Discard everything else.", "bypass_all");
                    setTimeout(() => {
                      setPermModeIdx(4); // YOLO
                      handleSend("Build the plan now. Execute every step. Do not skip anything. Do not re-read files you already know about.", "bypass_all");
                    }, 2000);
                  }}>Compact &amp; Build</button>
                  <button className="cc-plan-finished-btn cc-plan-finished-btn--compact" onClick={() => {
                    setPlanFinished(false);
                    setShowPlanViewer(false);
                    setPermModeIdx(4); // YOLO
                    handleSend(
                      "Build the plan now. Execute every step. Do not skip anything. Do not re-read files you already know about.",
                      "bypass_all"
                    );
                  }}>Build Now</button>
                  {planContent && (
                    <button className="cc-plan-finished-btn cc-plan-finished-btn--view" onClick={() => setShowPlanViewer((v) => !v)}>
                      {showPlanViewer ? "Close Plan" : "View Plan"}
                    </button>
                  )}
                  <button className="cc-plan-finished-btn cc-plan-finished-btn--dismiss" onClick={() => { setPlanFinished(false); setShowPlanViewer(false); }}>Dismiss</button>
                </div>
              </div>
            )}
            {session.pendingPermission ? (() => {
              const perm = session.pendingPermission;
              const hdr = toolHeader({ id: "", name: perm.toolName, input: perm.toolInput });
              return (
                <div className="cc-permission">
                  <div className="cc-permission-header">
                    <span className="cc-permission-title">Permission Required</span>
                  </div>
                  <div className="cc-permission-tool">
                    <span className="cc-tc-icon">{hdr.icon}</span>
                    <span className="cc-tc-name">{hdr.title}</span>
                    <span className="cc-tc-detail">{hdr.detail}</span>
                  </div>
                  <div className="cc-permission-actions">
                    <button className="cc-permission-allow" onClick={() => {
                      resolvePermission(perm.requestId, true).catch(() => {});
                      useClaudeStore.getState().setPendingPermission(sessionId, null);
                    }}>Allow</button>
                    <button className="cc-permission-deny" onClick={() => {
                      resolvePermission(perm.requestId, false).catch(() => {});
                      useClaudeStore.getState().setPendingPermission(sessionId, null);
                    }}>Deny</button>
                  </div>
                </div>
              );
            })() : (
              <>
                {attachedFiles.length > 0 && (
                  <div className="cc-attached-files">
                    {attachedFiles.map((f, i) => (
                      <div key={i} className="cc-file-chip">
                        <span className="cc-file-name">{f.split(/[/\\]/).pop()}</span>
                        <button className="cc-file-remove" onClick={() => setAttachedFiles((p) => p.filter((_, j) => j !== i))}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <ChatInput
                  onSend={handleSend}
                  onCancel={handleCancel}
                  onAttach={handleAttach}
                  onRewrite={handleRewrite}
                  isRewriting={isRewriting}
                  isStreaming={session.isStreaming}
                  slashCommands={slashCommands}
                  initialText={rewindText}
                  onInitialTextConsumed={() => setRewindText(null)}
                  permLabel={`${permMode.id === "default" ? "ask permissions" : permMode.id === "bypass_all" ? "bypass permissions" : permMode.id === "accept_edits" ? "auto-accept edits" : permMode.id === "auto" ? "auto-approve" : "plan mode"} on`}
                  permColor={permMode.color}
                  onCyclePerm={() => setPermModeIdx((i) => { const next = (i + 1) % PERMISSION_MODES.length; useSettingsStore.getState().set({ claudePermMode: PERMISSION_MODES[next].id }); return next; })}
                  sessionName={session.name || undefined}
                  cwd={effectiveCwd}
                />
              </>
            )}
          </div>
        </div>

      </div>

      {/* Side panel — extends outside the container to the right */}
      {sidePanelOpen && hasSideContent && (
        <div className="cc-side-ext">
            {/* Tasks section */}
            {hasTasks && (
              <div className="cc-tasks-section">
                <div className="cc-side-header">
                  <span>Tasks</span>
                  <span className="cc-tasks-count">
                    {session.tasks.filter((t) => t.status === "completed").length}/{session.tasks.filter((t) => t.status !== "deleted").length}
                  </span>
                </div>
                <div className="cc-tasks-list">
                  {session.tasks.filter((t) => t.status !== "deleted").map((task) => (
                    <div key={task.id} className={`cc-task cc-task--${task.status}`}>
                      <span className="cc-task-check">
                        {task.status === "completed" ? "✓" : task.status === "in_progress" ? "●" : "○"}
                      </span>
                      <span className="cc-task-subject">{task.subject}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Plan section */}
            {hasPlan && (
              <div className="cc-plan-section">
                <div className="cc-side-header">
                  <span>Plan</span>
                  <div className="cc-plan-actions">
                    <button
                      className="cc-plan-build"
                      onClick={() => {
                        setPermModeIdx(3);
                        handleSend(
                          "Plan mode is over. You have full permissions now. Build the plan — execute every step described in the plan file. Do not skip anything.",
                          "bypass_all"
                        );
                      }}
                      disabled={session.isStreaming}
                    >
                      Build
                    </button>
                    <button className="cc-plan-close" onClick={() => setPlanContent(null)}>×</button>
                  </div>
                </div>
                <div className="cc-plan-body">
                  <pre className="cc-plan-content">{planContent}</pre>
                </div>
              </div>
            )}
            <button className="cc-side-close" onClick={() => setSidePanelOpen(false)}>×</button>
          </div>
        )}
    </div>
  );
}
