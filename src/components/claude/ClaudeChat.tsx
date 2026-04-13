import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useClaudeStore } from "../../stores/claudeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { createClaudeSession, sendClaudePrompt, cancelClaude, closeClaudeSession, listSlashCommands, resolvePermission, readFile, writeFile, loadSessionHistory, mapHistoryMessages, truncateSessionJsonl, truncateSessionJsonlByMessages, forkSessionJsonl, listMcpServers, createCheckpoint, restoreCheckpoint, cleanupCheckpoints, revertFilesGit, deleteFiles, shellExec, ensureT64Mcp, setT64DelegationEnv, getDelegationPort, getDelegationSecret, getAppDir, createMcpConfigFile } from "../../lib/tauriApi";
import { SlashCommand, PermissionMode, McpServer } from "../../lib/types";
import { rewritePromptStream } from "../../lib/ai";
import ChatMessage, { toolHeader, renderContent, ToolGroupCard, GROUPABLE_TOOLS } from "./ChatMessage";
import Editor from "@monaco-editor/react";
import FileTree from "./FileTree";
import { fontStack } from "../../lib/fonts";
import ChatInput from "./ChatInput";
import { useDelegationStore } from "../../stores/delegationStore";
import { endDelegation } from "../../hooks/useDelegationOrchestrator";
import { useCanvasStore } from "../../stores/canvasStore";
import { v4 as uuidv4 } from "uuid";
import "./ClaudeChat.css";

let monacoThemeForBg = "";

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
  const setDraftPrompt = useClaudeStore((s) => s.setDraftPrompt);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const loopTimerRef = useRef<number | null>(null);
  const INITIAL_VISIBLE = 40;
  const LOAD_MORE_BATCH = 30;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [configMcpServers, setConfigMcpServers] = useState<McpServer[]>([]);
  const [showMcpDrop, setShowMcpDrop] = useState(false);
  const liveMcp = useClaudeStore((s) => s.sessions[sessionId]?.mcpServers);
  const mcpServers = (liveMcp && liveMcp.length > 0) ? liveMcp : configMcpServers;
  const [showFileTree, setShowFileTree] = useState(false);
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
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [editOverlay, setEditOverlay] = useState<{ tcId: string; filePath: string; fullContent: string; changedLines: Set<number> } | null>(null);
  const editOverrides = useRef<Record<string, string>>({});
  const savedScrollTop = useRef<number>(0);
  const modifiedEditorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const editorSavedVersionId = useRef<number>(0);

  const permMode = PERMISSION_MODES[permModeIdx];

  useEffect(() => {
    createSession(sessionId);
    if (cwd && cwd !== ".") {
      useClaudeStore.getState().setCwd(sessionId, cwd);
    }
  }, [sessionId, createSession, cwd]);
  useEffect(() => {
    const t64Commands: SlashCommand[] = [
      { name: "loop", description: "Run a prompt on a loop (e.g. /loop 5m improve the code)", usage: "/loop [interval] <prompt> — default 10m. /loop stop to cancel.", source: "Terminal 64" },
      { name: "delegate", description: "Split work into parallel sub-sessions", usage: "/delegate <prompt> — Claude plans the task split, spawns agents with MCP team chat.", source: "Terminal 64" },
    ];
    listSlashCommands().then((cmds) => setSlashCommands([...t64Commands, ...cmds])).catch(() => setSlashCommands(t64Commands));
    listMcpServers(cwd).then(setConfigMcpServers).catch(() => {});
  }, []);
  // Apply persisted font on mount (once per app, harmless if called multiple times)
  useEffect(() => {
    document.documentElement.style.setProperty("--claude-font", fontStack(useSettingsStore.getState().claudeFont || "system"));
  }, []);
  // Reset visible messages when switching sessions
  useEffect(() => { setVisibleCount(INITIAL_VISIBLE); }, [sessionId]);

  // Track whether user is at the bottom so we only auto-scroll when appropriate
  const wasAtBottom = useRef(true);
  // Use refs so the scroll handler doesn't need to be reattached on every message/visibleCount change
  const visibleCountRef = useRef(visibleCount);
  visibleCountRef.current = visibleCount;
  const messageLenRef = useRef(session?.messages?.length ?? 0);
  messageLenRef.current = session?.messages?.length ?? 0;

  useEffect(() => {
    const el = messagesEndRef.current?.parentElement;
    if (!el) return;
    const handler = () => {
      wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      // Load more messages when scrolled to top
      if (el.scrollTop < 80 && visibleCountRef.current < messageLenRef.current) {
        const prevHeight = el.scrollHeight;
        setVisibleCount((v) => Math.min(v + LOAD_MORE_BATCH, messageLenRef.current));
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - prevHeight;
        });
      }
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, [sessionId]); // Only reattach when session changes
  // Scroll on new messages (only if at bottom — check position directly)
  useEffect(() => {
    const el = messagesEndRef.current?.parentElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [session?.messages?.length]);
  // For streaming, scroll instantly (only if at bottom — check position directly to avoid stale ref)
  useEffect(() => {
    if (!session?.streamingText) return;
    const el = messagesEndRef.current?.parentElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom) el.scrollTop = el.scrollHeight;
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

  // If streaming ends while plan mode is still active, Claude didn't call ExitPlanMode —
  // treat this as plan completion so the action bar appears.
  // Also trigger planFinished if a plan file was written/detected during the turn.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (!session) return;
    if (session.isStreaming) {
      wasStreaming.current = true;
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      if (session.planModeActive) {
        // Auto-exit plan mode since the turn ended
        useClaudeStore.getState().setPlanMode(sessionId, false);
      } else if (planContent && !planFinished) {
        // Plan file was written but EnterPlanMode/ExitPlanMode were never called —
        // still show the action bar so user can build/delegate
        setPlanFinished(true);
      }
    }
  }, [session?.isStreaming, session?.planModeActive, sessionId, planContent, planFinished]);

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
    }).then((fn) => { unlisten = fn; }).catch((err) => console.warn('[drag-drop]', err));
    return () => { if (unlisten) unlisten(); };
  }, [isActive]);

  // Resolve CWD: use prop, fall back to stored session CWD
  const effectiveCwd = (cwd && cwd !== ".") ? cwd : (session?.cwd || ".");

  // Safety: if streaming has been stuck for >5 min, force-reset it
  useEffect(() => {
    if (!session?.isStreaming || !session?.streamingStartedAt) return;
    const timer = setInterval(() => {
      const s = useClaudeStore.getState().sessions[sessionId];
      if (s?.isStreaming && s.streamingStartedAt && Date.now() - s.streamingStartedAt > 5 * 60 * 1000) {
        console.warn(`[queue-safety] Streaming stuck for ${sessionId}, force-resetting`);
        useClaudeStore.getState().setStreaming(sessionId, false);
        useClaudeStore.getState().clearStreamingText(sessionId);
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [session?.isStreaming, sessionId]);

  // Auto-drain queue: when streaming stops, send next queued prompt
  const prevStreaming = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreaming.current;
    const nowStreaming = session?.isStreaming ?? false;
    prevStreaming.current = nowStreaming;
    if (wasStreaming && !nowStreaming) {
      // Streaming just ended — check queue first
      const next = useClaudeStore.getState().dequeuePrompt(sessionId);
      if (next) {
        addUserMessage(sessionId, next.text);
        emit("gui-message", { session_id: sessionId, content: next.text }).catch(() => {});
        setTimeout(() => {
          actualSend(next.text).catch((err) => useClaudeStore.getState().setError(sessionId, String(err)));
        }, 500);
        return;
      }
      // No queue — check loop timer
      const s = useClaudeStore.getState().sessions[sessionId];
      if (s?.activeLoop) {
        const { prompt: loopPrompt, intervalMs, lastFiredAt } = s.activeLoop;
        const elapsed = lastFiredAt ? Date.now() - lastFiredAt : Infinity;
        const delay = Math.max(0, intervalMs - elapsed);
        loopTimerRef.current = window.setTimeout(() => {
          const curr = useClaudeStore.getState().sessions[sessionId];
          if (!curr?.activeLoop || curr.isStreaming) return; // loop cancelled or session busy
          addUserMessage(sessionId, loopPrompt);
          emit("gui-message", { session_id: sessionId, content: loopPrompt }).catch(() => {});
          useClaudeStore.getState().tickLoop(sessionId);
          actualSend(loopPrompt).catch((err) => useClaudeStore.getState().setError(sessionId, String(err)));
        }, delay);
      }
    }
  }, [session?.isStreaming]);

  // Clear loop timer when loop is cancelled or component unmounts
  useEffect(() => {
    if (!session?.activeLoop && loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    return () => {
      if (loopTimerRef.current) { clearTimeout(loopTimerRef.current); loopTimerRef.current = null; }
    };
  }, [session?.activeLoop]);

  const actualSend = useCallback(
    async (prompt: string, permissionOverride?: PermissionMode) => {
      const sess = useClaudeStore.getState().sessions[sessionId];
      const started = sess?.hasBeenStarted ?? false;
      try {
        if (sess && sess.modifiedFiles.length > 0) {
          const results = await Promise.allSettled(
            sess.modifiedFiles.map(async (fp) => {
              try { return { path: fp, content: await readFile(fp) }; }
              catch { return { path: fp, content: "" }; }
            })
          );
          const snapshots = results.map((r) => (r as PromiseFulfilledResult<{ path: string; content: string }>).value);
          createCheckpoint(sessionId, sess.promptCount + 1, snapshots).catch(() => {});
        }

        const req = {
          session_id: sessionId, cwd: effectiveCwd, prompt,
          permission_mode: permissionOverride || permMode.id,
          model: selectedModel || undefined,
          effort: selectedEffort || undefined,
        };
        if (!started && (!effectiveCwd || effectiveCwd === ".")) {
          useClaudeStore.getState().setError(sessionId, "No working directory set. Create a new session.");
          return;
        }
        // Ensure T64 MCP server is in .mcp.json before first session creation
        if (!started) {
          await ensureT64Mcp(effectiveCwd).catch(() => {});
        }
        // Ensure CWD is always stored on the session for rewind/fork
        if (effectiveCwd && effectiveCwd !== "." && (!sess?.cwd || sess.cwd !== effectiveCwd)) {
          useClaudeStore.getState().setCwd(sessionId, effectiveCwd);
        }
        // Use --resume if session was ever started (survives rewind/cancel),
        // otherwise create new. Falls back to the other on failure.
        console.log("[send] Sending prompt:", { started, sessionId, cwd: effectiveCwd, promptPreview: prompt.slice(0, 80) });
        if (started) {
          try {
            await sendClaudePrompt({ ...req, cwd: effectiveCwd });
            console.log("[send] sendClaudePrompt (--resume) succeeded");
          } catch (resumeErr) {
            console.log("[send] sendClaudePrompt failed, falling back to createClaudeSession:", resumeErr);
            // Session file might not exist yet (edge case) — try create
            await createClaudeSession(req);
          }
        } else {
          try {
            await createClaudeSession(req);
          } catch {
            // Session might already exist from disk — try resume
            await sendClaudePrompt({ ...req, cwd: effectiveCwd });
          }
        }
        incrementPromptCount(sessionId);
      } catch (err) {
        useClaudeStore.getState().setError(sessionId, String(err));
      }
    },
    [sessionId, effectiveCwd, permMode, selectedModel, selectedEffort, incrementPromptCount]
  );

  const handleSend = useCallback(
    async (text: string, permissionOverride?: PermissionMode) => {
      // Handle /loop command locally
      const loopMatch = text.match(/^\/loop\s*(.*)/i);
      if (loopMatch) {
        const args = loopMatch[1].trim();
        if (!args || args === "stop" || args === "cancel" || args === "off") {
          useClaudeStore.getState().setLoop(sessionId, null);
          return;
        }
        // Parse: [interval] <prompt>
        const parts = args.match(/^(\d+[smhd]?)\s+([\s\S]+)$/);
        let intervalMs = 10 * 60 * 1000; // default 10m
        let loopPrompt = args;
        if (parts) {
          const raw = parts[1];
          const num = parseInt(raw);
          const unit = raw.replace(/\d+/, "") || "m";
          if (unit === "s") intervalMs = num * 1000;
          else if (unit === "m") intervalMs = num * 60 * 1000;
          else if (unit === "h") intervalMs = num * 60 * 60 * 1000;
          else if (unit === "d") intervalMs = num * 24 * 60 * 60 * 1000;
          loopPrompt = parts[2];
        }
        useClaudeStore.getState().setLoop(sessionId, {
          prompt: loopPrompt,
          intervalMs,
          lastFiredAt: null,
          iteration: 0,
        });
        // Fire the first iteration immediately
        addUserMessage(sessionId, loopPrompt);
        emit("gui-message", { session_id: sessionId, content: loopPrompt }).catch(() => {});
        useClaudeStore.getState().tickLoop(sessionId);
        await actualSend(loopPrompt, permissionOverride);
        return;
      }

      // Handle /delegate command — inject skill context so Claude plans the split
      const delegateMatch = text.match(/^\/delegate\s+([\s\S]+)/i);
      if (delegateMatch) {
        const userGoal = delegateMatch[1].trim();
        if (!userGoal) return;

        const skillPrompt = `You are orchestrating a delegation. The user wants to split work across multiple parallel Claude agents.

USER'S GOAL: ${userGoal}

Your job: analyze this goal and decide how many parallel agents are needed (minimum 2, maximum 8). Use your judgment — simple tasks may only need 2 agents, complex multi-part tasks may need 5+. Don't over-parallelize; only create agents for truly independent work.

Output ONLY a delegation plan in this EXACT format (no other text before or after):

[DELEGATION_START]
[CONTEXT] <one paragraph of shared context all agents need>
[TASK] <concise description of task 1>
[TASK] <concise description of task 2>
...as many [TASK] lines as needed...
[DELEGATION_END]

Rules:
- Each [TASK] must be independently completable — no task should depend on another's output
- Keep task descriptions specific and actionable
- The [CONTEXT] should include project info, constraints, and the overall goal
- Fewer focused agents > many tiny agents. If two things are tightly coupled, keep them in one task
- Output the delegation block IMMEDIATELY, nothing else`;

        delegateRequested.current = true;
        addUserMessage(sessionId, `/delegate ${userGoal}`);
        await actualSend(skillPrompt, permissionOverride);
        return;
      }

      // Clear plan-finished banner whenever the user sends anything
      if (planFinished) {
        setPlanFinished(false);
        setShowPlanViewer(false);
      }

      let prompt = text;
      if (attachedFiles.length > 0) {
        const fileList = attachedFiles.map((f) => `[Attached file: ${f}]`).join("\n");
        prompt = fileList + "\n\n" + text;
        setAttachedFiles([]);
      }

      const isCurrentlyStreaming = useClaudeStore.getState().sessions[sessionId]?.isStreaming;
      if (isCurrentlyStreaming) {
        // Queue the prompt instead of sending mid-thinking
        useClaudeStore.getState().enqueuePrompt(sessionId, prompt);
        setQueueExpanded(true);
        return;
      }

      addUserMessage(sessionId, prompt);
      emit("gui-message", { session_id: sessionId, content: prompt }).catch(() => {});
      await actualSend(prompt, permissionOverride);
    },
    [sessionId, attachedFiles, addUserMessage, actualSend]
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
  const handleRewind = useCallback(async (messageId: string, content: string) => {
    console.log("[rewind] === REWIND START ===", { sessionId, messageId, content: content.slice(0, 80) });

    // Kill the CLI process first and wait for it to die before touching the JSONL
    try {
      await cancelClaude(sessionId);
      console.log("[rewind] cancelClaude completed");
    } catch (e) {
      console.log("[rewind] cancelClaude error (may be expected if process already exited):", e);
    }

    // Also explicitly close the session to ensure the instance is fully removed
    try {
      await closeClaudeSession(sessionId);
      console.log("[rewind] closeClaudeSession completed");
    } catch (e) {
      console.log("[rewind] closeClaudeSession error (expected):", e);
    }

    const store = useClaudeStore.getState();
    store.setStreaming(sessionId, false);
    store.setError(sessionId, null);
    store.clearStreamingText(sessionId);

    const preTruncateCount = store.sessions[sessionId]?.messages.length ?? 0;
    store.truncateFromMessage(sessionId, messageId);

    const sess = useClaudeStore.getState().sessions[sessionId];
    console.log("[rewind] Store truncated:", { preTruncateCount, postTruncateCount: sess?.messages.length });

    if (sess) {
      let rewindContent = content;
      const lastMsg = sess.messages[sess.messages.length - 1];

      // If the last remaining message is an unpaired user message (we removed its assistant response),
      // also remove it — the user gets its content prefilled so they can resend.
      if (lastMsg?.role === "user") {
        rewindContent = lastMsg.content;
        store.truncateFromMessage(sessionId, lastMsg.id);
        console.log("[rewind] Removed trailing user message, prefilling:", rewindContent.slice(0, 80));
      }

      const updatedSess = useClaudeStore.getState().sessions[sessionId];
      const keepMessages = updatedSess ? updatedSess.messages.length : 0;
      const keepTurns = updatedSess ? updatedSess.messages.filter(m => m.role === "user").length : 0;

      // Resolve CWD for JSONL path — prefer session's stored CWD, fall back to effectiveCwd
      const rewindCwd = updatedSess?.cwd || effectiveCwd;

      console.log("[rewind] JSONL truncation params:", {
        sessionId, rewindCwd, keepMessages, keepTurns,
        sessionCwd: updatedSess?.cwd, effectiveCwd,
        lastKeptMsg: updatedSess?.messages[updatedSess.messages.length - 1]?.content?.slice(0, 80),
      });

      // Truncate JSONL by exact message count (matches load_session_history's visible message counting)
      try {
        const result = await truncateSessionJsonlByMessages(sessionId, rewindCwd, keepMessages);
        console.log("[rewind] JSONL truncation SUCCESS:", result);

        // Verify: if the truncation didn't actually remove anything, warn loudly
        if (result.original_bytes === result.new_bytes) {
          console.warn("[rewind] WARNING: JSONL file size unchanged! Truncation may not have removed anything.", result);
        }
      } catch (err) {
        console.error("[rewind] JSONL truncation FAILED:", err, { sessionId, rewindCwd, keepMessages });
        // Fallback: try turn-based truncation
        try {
          await truncateSessionJsonl(sessionId, rewindCwd, keepTurns);
          console.log("[rewind] Fallback turn-based truncation succeeded");
        } catch (err2) {
          console.error("[rewind] Fallback truncation also FAILED:", err2);
        }
      }

      // Force-cancel any active delegation group FIRST — rewind must not trigger a merge
      const delState = useDelegationStore.getState();
      const delGroupId = delState.parentToGroup[sessionId];
      const delGroup = delGroupId ? delState.groups[delGroupId] : undefined;
      let childModifiedFiles: string[] = [];
      if (delGroup) {
        const claudeState = useClaudeStore.getState();
        for (const task of delGroup.tasks) {
          if (task.sessionId) {
            const childSess = claudeState.sessions[task.sessionId];
            if (childSess?.modifiedFiles?.length) {
              childModifiedFiles.push(...childSess.modifiedFiles);
            }
          }
        }
        if (delGroup.status === "active") {
          endDelegation(delGroup.id, true);
        }
      }

      // Restore parent's own modified files from checkpoint
      const restoredSet = new Set<string>();
      try {
        const restored = await restoreCheckpoint(sessionId, keepTurns + 1);
        restored.forEach((f) => restoredSet.add(f));
        if (restored.length > 0) console.log("[rewind] Restored files from checkpoint:", restored);
      } catch (err) {
        console.warn("[rewind] No checkpoint to restore:", err);
      }

      // Delete files that were CREATED by Claude (not in git) and weren't restored from checkpoint
      const allModified = sess.modifiedFiles || [];
      if (allModified.length > 0) {
        try {
          // git ls-files returns relative paths; compare by resolving to absolute
          const { stdout } = await shellExec(
            `git ls-files -- ${allModified.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ")}`,
            rewindCwd,
          );
          const trackedRelative = new Set(stdout.trim().split("\n").filter(Boolean));
          // Build set of tracked absolute paths for comparison
          const cwdPrefix = rewindCwd.endsWith("/") ? rewindCwd : rewindCwd + "/";
          const trackedAbsolute = new Set([...trackedRelative].map((rel) => cwdPrefix + rel));
          const createdFiles = allModified.filter((f) => !trackedAbsolute.has(f) && !restoredSet.has(f));
          if (createdFiles.length > 0) {
            const deleted = await deleteFiles(createdFiles);
            console.log("[rewind] Deleted newly-created files:", deleted);
          }
        } catch (err) {
          console.warn("[rewind] Failed to check/delete created files:", err);
        }
      }

      // Revert ALL files modified by delegation children using git
      if (childModifiedFiles.length > 0) {
        const uniqueFiles = [...new Set(childModifiedFiles)];
        revertFilesGit(rewindCwd, uniqueFiles)
          .then((reverted) => { if (reverted.length > 0) console.log("[rewind] Git-reverted delegation files:", reverted); })
          .catch((err) => console.warn("[rewind] Failed to git-revert delegation files:", err));
      }

      cleanupCheckpoints(sessionId, keepTurns)
        .catch((err) => console.warn("[rewind] Checkpoint cleanup:", err));
      store.resetModifiedFiles(sessionId);

      setRewindText(rewindContent);
      console.log("[rewind] === REWIND COMPLETE ===", {
        sessionId,
        finalMessageCount: useClaudeStore.getState().sessions[sessionId]?.messages.length,
        rewindContent: rewindContent?.slice(0, 80),
      });
    }
  }, [sessionId, effectiveCwd]);

  const handleFork = useCallback((messageId: string) => {
    const store = useClaudeStore.getState();
    const sess = store.sessions[sessionId];
    if (!sess) return;

    // Get messages up to (not including) the selected message
    const msgIdx = sess.messages.findIndex(m => m.id === messageId);
    if (msgIdx < 0) return;
    const forkedMessages = sess.messages.slice(0, msgIdx);

    const canvas = useCanvasStore.getState();
    const parentPanel = canvas.terminals.find(t => t.terminalId === sessionId);
    const x = parentPanel?.x ?? 80;
    const y = (parentPanel?.y ?? 80) - (parentPanel?.height ?? 400) - 20;
    const w = parentPanel?.width;
    const h = parentPanel?.height;

    const newPanel = canvas.addClaudeTerminalAt(
      effectiveCwd, false, undefined, undefined, x, y, w, h,
    );

    store.createSession(newPanel.terminalId);
    if (forkedMessages.length > 0) {
      store.loadFromDisk(newPanel.terminalId, forkedMessages);
      // Copy parent JSONL (truncated to fork point) so --resume works with full context
      const keepTurns = forkedMessages.filter(m => m.role === "user").length;
      forkSessionJsonl(sessionId, newPanel.terminalId, effectiveCwd, keepTurns)
        .catch((err) => console.warn("[fork] Failed to copy JSONL:", err));
    }
    store.setCwd(newPanel.terminalId, effectiveCwd);
  }, [sessionId, effectiveCwd]);

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

  const spawnDelegation = useCallback(
    async (tasks: { description: string }[], sharedContext: string) => {
      const delStore = useDelegationStore.getState();
      const group = delStore.createGroup(sessionId, tasks, "auto", sharedContext || undefined);

      // Spawn shared chat panel below the parent
      const canvas = useCanvasStore.getState();
      const parentPanel = canvas.terminals.find((t) => t.terminalId === sessionId);
      const parentW = parentPanel?.width || 600;
      const parentH = parentPanel?.height || 400;
      canvas.addSharedChatPanel(
        group.id,
        parentPanel?.x || 80,
        (parentPanel?.y || 80) + parentH + 20,
        parentW,
        Math.min(300, parentH * 0.6),
      );

      // Get delegation port + secret
      let delegationPort = 0;
      let delegationSecret = "";
      try {
        delegationPort = await getDelegationPort();
        delegationSecret = await getDelegationSecret();
      } catch (err) {
        console.warn("[delegation] Failed to get port/secret:", err);
      }

      // Resolve a real CWD — never use "." which resolves to process CWD (/ in production)
      const sessCwd = useClaudeStore.getState().sessions[sessionId]?.cwd;
      const appDir = (effectiveCwd && effectiveCwd !== "." && effectiveCwd !== "/")
        ? effectiveCwd
        : (sessCwd && sessCwd !== "." && sessCwd !== "/")
          ? sessCwd
          : "";

      // Create a temp MCP config file for delegation child sessions
      let mcpConfigPath = "";
      if (delegationPort > 0 && delegationSecret) {
        try {
          mcpConfigPath = await createMcpConfigFile(delegationPort, delegationSecret, group.id, "Agent");
        } catch (err) {
          console.warn("[delegation] Failed to create MCP config:", err);
        }
      }

      // Spawn headless child sessions — no canvas panels, ephemeral
      group.tasks.forEach((task, i) => {
        const childSessionId = uuidv4();
        const childName = `[D] ${task.description.slice(0, 30)}`;

        delStore.setTaskSessionId(group.id, task.id, childSessionId);
        delStore.updateTaskStatus(group.id, task.id, "running");

        const channelNote = delegationPort > 0
          ? `\n\nIMPORTANT — Team Coordination via terminal-64 MCP:
You are part of a team of ${tasks.length} agents working in the same codebase. You MUST use the team chat to coordinate:

1. send_to_team — Post a message to the shared team chat. Do this:
   • At the START of your work (announce what you're about to do)
   • Before modifying any shared files (to avoid conflicts)
   • After completing major milestones
   • If you encounter issues or blockers
2. read_team — Check what other agents have posted. Do this BEFORE starting work and periodically during long tasks to stay aware of what others are doing.
3. report_done — When your task is fully complete, call this with a summary of what you did and what files you changed.

Coordinate actively. If another agent is working on a file you need, mention it in team chat and work around it. Communication prevents conflicts.`
          : "";

        const initialPrompt = `Context: ${sharedContext}\n\nYour task: ${task.description}\n\nYou are agent "Agent ${i + 1}" — one of ${tasks.length} parallel agents. Focus on YOUR specific task only.${channelNote}\n\nWhen done, call report_done (if available) or state your task is complete.`;

        // Create ephemeral session in store (not saved to localStorage)
        useClaudeStore.getState().createSession(childSessionId, childName, true);
        addUserMessage(childSessionId, initialPrompt);

        setTimeout(() => {
          createClaudeSession({
            session_id: childSessionId,
            cwd: appDir,
            prompt: initialPrompt,
            permission_mode: "bypass_all",
            mcp_config: mcpConfigPath || undefined,
          }).catch((err) => {
            console.warn(`[delegation] Failed to start child ${childSessionId}:`, err);
            delStore.updateTaskStatus(group.id, task.id, "failed", String(err));
          });
        }, i * 500);
      });
    },
    [sessionId, effectiveCwd, addUserMessage],
  );

  // Detect delegation blocks in assistant messages and auto-spawn (only when /delegate was used)
  const delegateRequested = useRef(false);
  const lastDelegationParsed = useRef<string | null>(null);
  useEffect(() => {
    if (!session || !delegateRequested.current) return;
    const msgs = session.messages;
    const last = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!last || last.id === lastDelegationParsed.current) return;
    const text = last.content;
    const startIdx = text.indexOf("[DELEGATION_START]");
    const endIdx = text.indexOf("[DELEGATION_END]");
    if (startIdx === -1 || endIdx === -1) return;
    lastDelegationParsed.current = last.id;
    delegateRequested.current = false;
    const block = text.slice(startIdx, endIdx + "[DELEGATION_END]".length);
    const contextMatch = block.match(/\[CONTEXT\]\s*(.*)/);
    const taskMatches = [...block.matchAll(/\[TASK\]\s*(.*)/g)];
    if (taskMatches.length === 0) return;
    const context = contextMatch?.[1]?.trim() || "";
    const tasks = taskMatches.map((m) => ({ description: m[1].trim() }));
    spawnDelegation(tasks, context);
  }, [session?.messages, spawnDelegation]);

  const activeTasks = useMemo(() => session?.tasks?.filter(t => t.status !== "deleted") ?? [], [session?.tasks]);
  const completedTasks = useMemo(() => activeTasks.filter(t => t.status === "completed"), [activeTasks]);

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
          {/* MCP servers — t64 built-in excluded from count but shown in dropdown */}
          <div className="cc-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const userMcp = mcpServers.filter((s: any) => s.name !== "terminal-64");
              const hasError = mcpServers.some((s: any) => s.status === "failed" || s.status === "error");
              return (
                <button className={`cc-dropdown-trigger cc-mcp-btn ${userMcp.length > 0 ? "cc-mcp-btn--active" : ""} ${hasError ? "cc-mcp-btn--error" : ""}`} onClick={() => { setShowMcpDrop((v) => !v); setShowModelDrop(false); setShowEffortDrop(false); }}>
                  MCP{userMcp.length > 0 ? ` (${userMcp.length})` : ""}<span className="cc-chevron">▾</span>
                </button>
              );
            })()}
            {showMcpDrop && (
              <div className="cc-dropdown cc-mcp-dropdown">
                {mcpServers.length === 0 ? (
                  <div className="cc-mcp-empty">No MCP servers configured</div>
                ) : (
                  mcpServers.map((s: any) => {
                    const status = s.status || "configured";
                    const isError = status === "failed" || status === "error";
                    const isConnected = status === "connected";
                    const isBuiltIn = s.name === "terminal-64";
                    return (
                      <div key={s.name} className={`cc-mcp-item ${isBuiltIn ? "cc-mcp-item--builtin" : ""}`}>
                        <span className={`cc-mcp-dot ${isError ? "cc-mcp-dot--error" : isConnected ? "cc-mcp-dot--ok" : "cc-mcp-dot--idle"}`} />
                        <div className="cc-mcp-info">
                          <span className="cc-mcp-name">{isBuiltIn ? "T64" : s.name}</span>
                          <span className="cc-mcp-meta">{status}{isBuiltIn ? " · built-in" : ""}{s.transport ? ` · ${s.transport}` : ""}{s.scope ? ` · ${s.scope}` : ""}</span>
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
            <button className="cc-dropdown-trigger" onClick={() => { setShowEffortDrop((v) => !v); setShowModelDrop(false); }}>
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
          <button
            className="cc-refresh-btn"
            onClick={() => {
              // Cancel running process and reset UI state, keeping conversation history
              cancelClaude(sessionId).catch(() => {});
              closeClaudeSession(sessionId).catch(() => {});
              const store = useClaudeStore.getState();
              store.setStreaming(sessionId, false);
              store.setError(sessionId, null);
              store.clearStreamingText(sessionId);
              // Reload messages from JSONL to ensure sync with Claude CLI
              if (effectiveCwd) {
                loadSessionHistory(sessionId, effectiveCwd).then((history) => {
                  if (history?.length) {
                    store.loadFromDisk(sessionId, mapHistoryMessages(history));
                  }
                }).catch(() => {});
              }
            }}
            title="Refresh chat (reset state, reload history)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1.5 6A4.5 4.5 0 0 1 10 3.5M10.5 6A4.5 4.5 0 0 1 2 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M10 1v3h-3M2 11V8h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
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
                      editorSavedVersionId.current = modifiedEditorRef.current.getModel()!.getAlternativeVersionId();
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
                    if (monacoThemeForBg !== ui.bg) {
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
                      monacoThemeForBg = ui.bg;
                    }
                  }}
                  onMount={(editor, monaco) => {
                    modifiedEditorRef.current = editor;
                    editorSavedVersionId.current = editor.getModel()!.getAlternativeVersionId();
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
                      setEditorDirty(editor.getModel()!.getAlternativeVersionId() !== editorSavedVersionId.current);
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
              const allMsgs = session.messages;
              const startIdx = Math.max(0, allMsgs.length - visibleCount);
              const msgs = allMsgs.slice(startIdx);
              if (startIdx > 0) {
                elements.push(
                  <div key="load-more" className="cc-load-more" onClick={() => setVisibleCount((v) => Math.min(v + LOAD_MORE_BATCH, allMsgs.length))}>
                    ▲ {startIdx} older message{startIdx !== 1 ? "s" : ""} — click or scroll up to load
                  </div>
                );
              }
              let i = 0;
              while (i < msgs.length) {
                const msg = msgs[i];
                // Check for consecutive Read-only assistant messages
                if (msg.role === "assistant" && !msg.content && msg.toolCalls?.length && msg.toolCalls.every((tc) => GROUPABLE_TOOLS.has(tc.name))) {
                  const groupTcs = [...msg.toolCalls];
                  let j = i + 1;
                  while (j < msgs.length) {
                    const next = msgs[j];
                    if (next.role === "assistant" && !next.content && next.toolCalls?.length && next.toolCalls.every((tc) => GROUPABLE_TOOLS.has(tc.name))) {
                      groupTcs.push(...next.toolCalls);
                      j++;
                    } else break;
                  }
                  if (j > i + 1) {
                    elements.push(<div key={`rg-${i}`} className="cc-message cc-message--assistant"><div className="cc-tc-list"><ToolGroupCard tcs={groupTcs} /></div></div>);
                    i = j;
                    continue;
                  }
                }
                elements.push(<ChatMessage key={msg.id} message={msg} onRewind={handleRewind} onFork={handleFork} onEditClick={handleEditClick} />);
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
                      <button key={opt.label || i} className="cc-question-btn" onClick={() => submitAnswer(opt.label)}>
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
            {/* Prompt queue overlay — absolutely positioned upward from footer */}
            {session.promptQueue.length > 0 && (
              <div className={`cc-queue ${queueExpanded ? "cc-queue--expanded" : ""}`}>
                <button className="cc-queue-header" onClick={() => setQueueExpanded((v) => !v)}>
                  <span className="cc-queue-chevron">{queueExpanded ? "▾" : "▸"}</span>
                  <span className="cc-queue-title">{session.promptQueue.length} queued prompt{session.promptQueue.length > 1 ? "s" : ""}</span>
                  <button className="cc-queue-clear" onClick={(e) => { e.stopPropagation(); useClaudeStore.getState().clearQueue(sessionId); }}>Clear</button>
                </button>
                {queueExpanded && (
                  <div className="cc-queue-list">
                    {session.promptQueue.map((qp) => (
                      <div key={qp.id} className="cc-queue-item">
                        <span className="cc-queue-text">{qp.text}</span>
                        <button className="cc-queue-remove" onClick={() => useClaudeStore.getState().removeQueuedPrompt(sessionId, qp.id)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {planFinished && !session.isStreaming && (() => {
              const ctxPct = session.contextMax > 0 ? Math.min(100, Math.round((session.contextUsed / session.contextMax) * 100)) : 0;
              return (
              <div className="cc-plan-finished">
                <span className="cc-plan-finished-text">Plan complete</span>
                {ctxPct > 0 && <span className={`cc-plan-ctx ${ctxPct >= 80 ? "cc-plan-ctx--warn" : ""}`}>{ctxPct}% context</span>}
                <div className="cc-plan-finished-actions">
                  <button className="cc-plan-finished-btn cc-plan-finished-btn--accept" onClick={() => {
                    setPlanFinished(false);
                    setShowPlanViewer(false);
                    setPlanContent(null);
                    setPermModeIdx(4); // YOLO
                    // Queue the build prompt so it fires automatically after /compact finishes
                    useClaudeStore.getState().enqueuePrompt(sessionId,
                      "Build the plan now. Execute every step. Do not skip anything. Do not re-read files you already know about."
                    );
                    handleSend("/compact Keep the plan file and key decisions only. Discard everything else.", "bypass_all");
                  }}>Compact &amp; Build</button>
                  <button className="cc-plan-finished-btn cc-plan-finished-btn--compact" onClick={() => {
                    setPlanFinished(false);
                    setShowPlanViewer(false);
                    setPlanContent(null);
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
                  <button className="cc-plan-finished-btn cc-plan-finished-btn--delegate" onClick={() => {
                    setPlanFinished(false);
                    setShowPlanViewer(false);
                    const delegatePrompt = planContent
                      ? `Based on this plan, break it into parallel tasks for delegation. Analyze the plan and output a delegation block:\n\n${planContent}`
                      : "Break the plan you just created into parallel tasks for delegation.";
                    setPlanContent(null);
                    handleSend(`/delegate ${delegatePrompt}`, "bypass_all");
                  }}>Delegate</button>
                  <button className="cc-plan-finished-btn cc-plan-finished-btn--dismiss" onClick={() => { setPlanFinished(false); setShowPlanViewer(false); setPlanContent(null); }}>Dismiss</button>
                </div>
              </div>
              );
            })()}
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
                      <div key={f} className="cc-file-chip">
                        <span className="cc-file-name">{f.split(/[/\\]/).pop()}</span>
                        <button className="cc-file-remove" onClick={() => setAttachedFiles((p) => p.filter((_, j) => j !== i))}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                {/* Loop indicator */}
                {session.activeLoop && (
                  <div className="cc-loop-banner">
                    <span className="cc-loop-icon">⟳</span>
                    <span className="cc-loop-text">
                      Loop active — iteration #{session.activeLoop.iteration} · every {
                        session.activeLoop.intervalMs >= 3600000 ? `${session.activeLoop.intervalMs / 3600000}h` :
                        session.activeLoop.intervalMs >= 60000 ? `${session.activeLoop.intervalMs / 60000}m` :
                        `${session.activeLoop.intervalMs / 1000}s`
                      }
                    </span>
                    <span className="cc-loop-prompt" title={session.activeLoop.prompt}>
                      {session.activeLoop.prompt.length > 40 ? session.activeLoop.prompt.slice(0, 40) + "…" : session.activeLoop.prompt}
                    </span>
                    <button className="cc-loop-stop" onClick={() => useClaudeStore.getState().setLoop(sessionId, null)}>Stop</button>
                  </div>
                )}
                <ChatInput
                  onSend={handleSend}
                  onCancel={handleCancel}
                  onAttach={handleAttach}
                  onRewrite={handleRewrite}
                  isRewriting={isRewriting}
                  isStreaming={session.isStreaming}
                  streamingStartedAt={session.streamingStartedAt}
                  slashCommands={slashCommands}
                  initialText={rewindText}
                  onInitialTextConsumed={() => setRewindText(null)}
                  permLabel={`${permMode.id === "default" ? "ask permissions" : permMode.id === "bypass_all" ? "bypass permissions" : permMode.id === "accept_edits" ? "auto-accept edits" : permMode.id === "auto" ? "auto-approve" : "plan mode"} on`}
                  permColor={permMode.color}
                  onCyclePerm={() => setPermModeIdx((i) => { const next = (i + 1) % PERMISSION_MODES.length; useSettingsStore.getState().set({ claudePermMode: PERMISSION_MODES[next].id }); return next; })}
                  sessionName={session.name || undefined}
                  cwd={effectiveCwd}
                  queueCount={session.promptQueue.length}
                  draftPrompt={session.draftPrompt}
                  onDraftChange={(t) => setDraftPrompt(sessionId, t)}
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
                    {completedTasks.length}/{activeTasks.length}
                  </span>
                </div>
                <div className="cc-tasks-list">
                  {activeTasks.map((task) => (
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
