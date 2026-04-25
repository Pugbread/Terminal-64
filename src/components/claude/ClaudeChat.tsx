import { useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { open } from "@tauri-apps/plugin-dialog";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useClaudeStore } from "../../stores/claudeStore";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "../../stores/settingsStore";
import { useThemeStore } from "../../stores/themeStore";
import { createClaudeSession, sendClaudePrompt, cancelClaude, closeClaudeSession, createCodexSession, sendCodexPrompt, cancelCodex, closeCodexSession, loadCodexSessionHistory, listSlashCommands, resolvePermission, readFile, readFileBase64, writeFile, loadSessionHistoryTail, mapHistoryMessages, findRewindUuid, truncateSessionJsonlByMessages, truncateCodexRollout, forkSessionJsonl, listMcpServers, createCheckpoint, restoreCheckpoint, cleanupCheckpoints, deleteFiles, shellExec, filterUntrackedFiles, ensureT64Mcp, ensureCodexMcp, ensureCodexSkills, setT64DelegationEnv, getDelegationPort, getDelegationSecret, getAppDir, createMcpConfigFile, savePastedImage, resolveSkillPrompt } from "../../lib/tauriApi";
import type { SlashCommand, PermissionMode, McpServer, HookEvent, ChatMessage as ChatMessageData, ToolCall, CreateCodexRequest, SendCodexPromptRequest } from "../../lib/types";
import { decodeCodexPermission, type ProviderId } from "../../lib/providers";
import type { McpServerStatus } from "../../stores/claudeStore";
import { rewritePromptStream } from "../../lib/ai";
import ChatMessage, { toolHeader, renderContent, ToolGroupCard, GROUPABLE_TOOLS } from "./ChatMessage";
import Editor from "@monaco-editor/react";
import FileTree from "./FileTree";
import { fontStack } from "../../lib/fonts";
import { CLAUDE_BUILTIN_COMMANDS } from "../../lib/claudeSlashCommands";
import ChatInput from "./ChatInput";
import PromptIsland from "./PromptIsland";
import { registerChatInputVoiceActions, unregisterChatInputVoiceActions, useVoiceStore, type ChatInputVoiceActions } from "../../stores/voiceStore";
import { useDelegationStore } from "../../stores/delegationStore";
import { endDelegation } from "../../hooks/useDelegationOrchestrator";
import { useChatSend } from "../../hooks/useChatSend";
import { useChatFork } from "../../hooks/useChatFork";
import { useChatRewind } from "../../hooks/useChatRewind";
import { useDelegationSpawn } from "../../hooks/useDelegationSpawn";
import { useCanvasStore } from "../../stores/canvasStore";
import { v4 as uuidv4 } from "uuid";
import { formatDuration } from "../../lib/constants";
import { baseName, dirName, isAbsolutePath, joinPath } from "../../lib/platform";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/DropdownMenu";
import "./ClaudeChat.css";
import "../ui/DropdownMenu.css";
import { cancelProviderSession, closeProviderSession } from "../../lib/providerRuntime";

// Provider lookup. `provider` is non-optional on ClaudeSession but the
// fallback covers the brief window between mount and createSession.
function sessionProviderFor(sessionId: string): ProviderId {
  return useClaudeStore.getState().sessions[sessionId]?.provider ?? "anthropic";
}

async function cancelByProvider(sessionId: string, provider: ProviderId): Promise<void> {
  return cancelProviderSession(sessionId, provider);
}

async function closeByProvider(sessionId: string, provider: ProviderId): Promise<void> {
  return closeProviderSession(sessionId, provider);
}

let monacoThemeForBg = "";

const REWIND_ACTION_META: Record<string, { label: string; color: string }> = {
  M: { label: "M", color: "#f9e2af" },
  A: { label: "A", color: "#a6e3a1" },
  D: { label: "D", color: "#f38ba8" },
  U: { label: "U", color: "#89b4fa" },
};
const REWIND_ACTION_FALLBACK = { label: "?", color: "#89b4fa" };

function toolLayoutSignature(toolCalls: ToolCall[] | undefined): string {
  if (!toolCalls?.length) return "0";
  return toolCalls
    .map((tc) => {
      const resultLen = typeof tc.result === "string" ? tc.result.length : 0;
      const inputLen = JSON.stringify(tc.input ?? {}).length;
      return `${tc.id}:${tc.name}:${resultLen}:${inputLen}:${tc.isError ? 1 : 0}`;
    })
    .join("|");
}

function messageLayoutKey(msg: ChatMessageData): string {
  if (msg.role === "assistant" && msg.toolCalls?.length) {
    return `${msg.id}:${msg.content?.length ?? 0}:${toolLayoutSignature(msg.toolCalls)}`;
  }
  return msg.id;
}

interface AffectedFile {
  path: string;
  action: "M" | "A" | "D" | "U";
  insertions: number;
  deletions: number;
}

function RewindPromptDialog({ affectedFiles, toolSummary, onConfirm, onCancel }: {
  affectedFiles: AffectedFile[];
  toolSummary: string;
  onConfirm: (revertCode: boolean) => void;
  onCancel: () => void;
}) {
  const [filesOpen, setFilesOpen] = useState(affectedFiles.length > 0 && affectedFiles.length <= 8);
  const [description, setDescription] = useState<string | null>(null);
  const [descLoading, setDescLoading] = useState(false);
  const hasFiles = affectedFiles.length > 0;
  const totalIns = affectedFiles.reduce((s, f) => s + f.insertions, 0);
  const totalDel = affectedFiles.reduce((s, f) => s + f.deletions, 0);

  const generateDescription = useCallback(async () => {
    setDescLoading(true);
    setDescription("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      let genId: string | null = null;
      const pending: { type: string; id: string; text: string }[] = [];
      let resolveDone!: () => void;
      const doneP = new Promise<void>((r) => { resolveDone = r; });
      const unChunk = await listen<{ id: string; text: string }>("rewind-desc-chunk", (e) => {
        if (genId && e.payload.id === genId) setDescription((p) => (p || "") + e.payload.text);
        else if (!genId) pending.push({ type: "chunk", ...e.payload });
      });
      const unDone = await listen<{ id: string }>("rewind-desc-done", (e) => {
        if (genId && e.payload.id === genId) resolveDone();
        else if (!genId) pending.push({ type: "done", id: e.payload.id, text: "" });
      });
      try {
        genId = await invoke<string>("generate_rewind_summary", { summary: toolSummary });
      } catch (e) {
        unChunk(); unDone(); setDescription("Failed to generate description."); setDescLoading(false); return;
      }
      for (const evt of pending) {
        if (evt.id === genId) { if (evt.type === "done") resolveDone(); else setDescription((p) => (p || "") + evt.text); }
      }
      await Promise.race([doneP, new Promise<void>((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000))]);
      unChunk(); unDone();
    } catch { setDescription((p) => p || "Failed to generate description."); }
    setDescLoading(false);
  }, [toolSummary]);

  return (
    <div className="cc-rewind-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="cc-rewind-prompt">
        {hasFiles && (
          <div className="cc-rewind-changelist">
            <button className="cc-rewind-changelist-hdr" onClick={() => setFilesOpen(!filesOpen)}>
              <span className={`cc-rewind-chevron${filesOpen ? " cc-rewind-chevron--open" : ""}`}>&#9654;</span>
              <span className="cc-rewind-changelist-title">Changes</span>
              <span className="cc-rewind-changelist-count">{affectedFiles.length} file{affectedFiles.length !== 1 ? "s" : ""}</span>
              {(totalIns > 0 || totalDel > 0) && (
                <span className="cc-rewind-stat-total">
                  {totalIns > 0 && <span className="cc-rewind-stat-ins">+{totalIns}</span>}
                  {totalDel > 0 && <span className="cc-rewind-stat-del">-{totalDel}</span>}
                </span>
              )}
            </button>
            {filesOpen && (
              <div className="cc-rewind-changelist-rows">
                {affectedFiles.map(({ path, action, insertions, deletions }) => {
                  const fileName = baseName(path) || path;
                  const dir = dirName(path);
                  const meta = REWIND_ACTION_META[action] ?? REWIND_ACTION_FALLBACK;
                  return (
                    <div key={path} className="cc-rewind-row">
                      <span className="cc-rewind-row-name">{fileName}</span>
                      <span className="cc-rewind-row-dir">{dir}</span>
                      {(insertions > 0 || deletions > 0) && (
                        <span className="cc-rewind-row-stats">
                          {insertions > 0 && <span className="cc-rewind-stat-ins">+{insertions}</span>}
                          {deletions > 0 && <span className="cc-rewind-stat-del">-{deletions}</span>}
                        </span>
                      )}
                      <span className="cc-rewind-row-badge" style={{ color: meta.color }}>{meta.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {description !== null ? (
          <div className="cc-rewind-description">
            <span className="cc-rewind-desc-text">{description}{descLoading && <span className="cc-cursor" />}</span>
          </div>
        ) : (
          <button className="cc-rewind-gen-btn" onClick={generateDescription} disabled={descLoading}>
            {descLoading ? "generating..." : "generate description"}
          </button>
        )}

        <div className="cc-rewind-actions">
          <button className="cc-rewind-btn cc-rewind-btn--code" onClick={() => onConfirm(true)}>
            Conversation + Code
          </button>
          <button className="cc-rewind-btn cc-rewind-btn--conv" onClick={() => onConfirm(false)}>
            Conversation Only
          </button>
          <button className="cc-rewind-btn cc-rewind-btn--cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Streaming bubble body — owns its own `.cc-row` gutter so renderRow can
 *  return it directly without the standard wrapper. Rendered as a list item
 *  (not inside the Footer) so growing token text participates in row layout
 *  without constantly remeasuring the footer. */
function StreamingBubbleBody({
  sessionId,
  onStreamUpdate,
}: {
  sessionId: string;
  onStreamUpdate: () => void;
}) {
  const text = useClaudeStore((s) => s.sessions[sessionId]?.streamingText);
  useLayoutEffect(() => {
    if (text) onStreamUpdate();
  }, [text, onStreamUpdate]);
  if (!text) return null;
  return (
    <div className="cc-row">
      <div className="cc-message cc-message--assistant">
        <div className="cc-bubble cc-bubble--assistant cc-bubble--streaming">
          {text}
          <span className="cc-cursor" />
        </div>
      </div>
    </div>
  );
}

/** Chat body footer. Lives below the last virtualized item and renders the
 *  streaming bubble + pending-question prompt + error bar + bottom spacer.
 *  Extracted from ClaudeChat's render so its identity is stable across
 *  parent re-renders (the list otherwise re-measures its footer on every
 *  keystroke, which is the main source of scroll jitter during streaming).
 *  Subscribes only to the fine-grained store slices it actually needs. */
function ChatFooter({
  sessionId,
  effectiveCwd,
  permissionMode,
  model,
  effort,
}: {
  sessionId: string;
  effectiveCwd: string;
  permissionMode: PermissionMode;
  model: string;
  effort: string;
}) {
  const pendingQuestions = useClaudeStore((s) => s.sessions[sessionId]?.pendingQuestions ?? null);
  const error = useClaudeStore((s) => s.sessions[sessionId]?.error ?? null);
  const current = pendingQuestions?.items[pendingQuestions.currentIndex];
  const progress =
    pendingQuestions && pendingQuestions.items.length > 1
      ? `(${pendingQuestions.currentIndex + 1}/${pendingQuestions.items.length})`
      : "";

  const submitAnswer = (answer: string) => {
    if (!pendingQuestions) return;
    const store = useClaudeStore.getState();
    store.answerQuestion(sessionId, answer);
    const updated = useClaudeStore.getState().sessions[sessionId];
    if (!updated?.pendingQuestions) {
      const allAnswers = [...pendingQuestions.answers, answer];
      const formatted = pendingQuestions.items
        .map((item, idx) => `${item.header || item.question}: ${allAnswers[idx]}`)
        .join("\n");
      store.updateToolResult(sessionId, pendingQuestions.toolUseId, formatted, false);
      store.addUserMessage(sessionId, `Answered questions:\n${formatted}`);
      const provider = sessionProviderFor(sessionId);
      const followupPrompt = `Here are my answers to your questions:\n${formatted}\n\nProceed based on these choices. Do not ask the same questions again.`;
      const currentSession = useClaudeStore.getState().sessions[sessionId];
      const codexBase = {
        session_id: sessionId,
        cwd: effectiveCwd,
        prompt: followupPrompt,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...decodeCodexPermission(currentSession?.selectedCodexPermission || "workspace"),
      };
      const sendPromise = provider === "openai"
        ? (currentSession?.codexThreadId ? sendCodexPrompt({
            ...codexBase,
            thread_id: currentSession.codexThreadId,
          }) : createCodexSession({
            session_id: sessionId,
            cwd: effectiveCwd,
            prompt: followupPrompt,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...decodeCodexPermission(currentSession?.selectedCodexPermission || "workspace"),
          }))
        : sendClaudePrompt(
            {
              session_id: sessionId,
              cwd: effectiveCwd,
              prompt: followupPrompt,
              permission_mode: permissionMode,
              model,
              effort,
              disallowed_tools: "AskUserQuestion",
            },
            useClaudeStore.getState().sessions[sessionId]?.skipOpenwolf,
          );
      sendPromise
        .then(() => store.incrementPromptCount(sessionId))
        .catch((err) => store.setError(sessionId, String(err)));
    }
  };

  if (!current && !pendingQuestions && !error) return null;

  return (
    <>
      {current && pendingQuestions && (
        <div className="cc-row">
          <div className="cc-question">
            <div className="cc-question-header">
              {current.header && <span className="cc-question-badge">{current.header}</span>}
              <span className="cc-question-progress">{progress}</span>
            </div>
            <div className="cc-question-text">{current.question}</div>
            <div className="cc-question-options">
              {current.options.map((opt, i) => (
                <button
                  key={opt.label || i}
                  className="cc-question-btn"
                  onClick={() => submitAnswer(opt.label)}
                >
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
        </div>
      )}
      {error && (
        <div className="cc-row">
          <div className="cc-message cc-message--error">
            <div className="cc-error">{error}</div>
          </div>
        </div>
      )}
      {/* No bottom spacer here; the LegendList footer owns the breathing
          room so the list's scroll math can see it. A second footer-level
          spacer below this component would recreate the unreachable-zone bug. */}
    </>
  );
}

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

// MODELS / EFFORTS / PERMISSION_MODES are the Anthropic-provider defaults.
// When the user picks OpenAI in the provider dropdown, we swap to
// PROVIDER_CONFIG.openai's lists at render time.
import { PROVIDER_CONFIG } from "../../lib/providers";
import { pushToast } from "../../lib/notifications";

const MODELS = PROVIDER_CONFIG.anthropic.models;
const EFFORTS = PROVIDER_CONFIG.anthropic.efforts;
const PERMISSION_MODES: { id: PermissionMode; label: string; color: string; desc: string }[] =
  PROVIDER_CONFIG.anthropic.permissions.map((p) => ({
    id: p.id as PermissionMode,
    label: p.label,
    color: p.color,
    desc: p.desc,
  }));

interface ClaudeChatProps {
  sessionId: string;
  cwd: string;
  skipPermissions: boolean;
  isActive: boolean;
}

function CompactDivider({ status, startedAt }: { status: "compacting" | "done"; startedAt: number | null }) {
  const [elapsed, setElapsed] = useState("");
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed(formatDuration(Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    if (status === "compacting") {
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }
  }, [status, startedAt]);

  return (
    <div className={`cc-turn-divider cc-compact-divider ${status === "done" ? "cc-compact-divider--done" : ""}`}>
      {status === "compacting" && <span className="cc-compact-spinner" />}
      {status === "done" && <span className="cc-compact-check">&#x2713;</span>}
      <span className="cc-turn-divider-text">
        {status === "compacting" ? `Compacting context` : `Compacted`}
        {elapsed && ` · ${elapsed}`}
      </span>
    </div>
  );
}

/** Common shape for MCP servers displayed in the dropdown (union of live status and config) */
type McpDisplayServer = McpServerStatus | McpServer;

export default function ClaudeChat({ sessionId, cwd, skipPermissions, isActive }: ClaudeChatProps) {
  // Shallow-compare selector that EXCLUDES streamingText — the streaming
  // bubble has its own fine-grained subscription, so we don't need to
  // re-render the whole ClaudeChat tree (ChatInput, toolbar, Virtuoso props)
  // on every streamed token. With streamingText excluded, ClaudeChat only
  // re-renders when the session gets a *new* message, changes status,
  // pending-questions, error, draftPrompt, etc — not on per-token ticks.
  const session = useClaudeStore(
    useShallow((s) => {
      const sess = s.sessions[sessionId];
      if (!sess) return undefined;
      const { streamingText: _ignored, ...rest } = sess;
      return rest;
    }),
  );
  // Boolean-only streaming flag: flips once at start and once at end of a
  // stream, not per token. Used by visualRows to decide whether to append
  // a streaming row without re-building on every character.
  const hasStreamingText = useClaudeStore((s) => Boolean(s.sessions[sessionId]?.streamingText));
  const createSession = useClaudeStore((s) => s.createSession);
  const addUserMessage = useClaudeStore((s) => s.addUserMessage);
  const incrementPromptCount = useClaudeStore((s) => s.incrementPromptCount);
  const setDraftPrompt = useClaudeStore((s) => s.setDraftPrompt);
  // Kept around for jumpToPrompt's data-msg-id flash + edit-overlay's
  // scroll-restore. LegendList no longer feeds us a separate scroller
  // ref (the old `scrollerRef` callback was specific to Virtuoso);
  // we read the live scroll element from LegendList's API instead.
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const getScrollEl = useCallback((): HTMLDivElement | null => {
    const node = virtuosoRef.current?.getScrollableNode?.();
    return (node as HTMLDivElement | null) ?? chatBodyRef.current;
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const loopTimerRef = useRef<number | null>(null);
  // List ref — used for programmatic scrolling (scrollToBottom, jumpToPrompt).
  const virtuosoRef = useRef<LegendListRef | null>(null);
  // Prompt island: pill at top that expands into a picker of past user prompts.
  // Scroll state owned by `useChatScrollState`, which binds to the live
  // `.cc-messages` element via its React state (not a ref) so it reattaches
  // deterministically across editOverlay/showPlanViewer round-trips.
  const [islandOpen, setIslandOpen] = useState(false);
  // Scroll state is sourced from LegendList callbacks so we don't run a
  // parallel ResizeObserver/MutationObserver that fights virtualization during
  // streaming. isScrolledUp drives island/
  // jump-bottom visibility; scrollProgress drives the prompt island ring.
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [configMcpServers, setConfigMcpServers] = useState<McpServer[]>([]);
  // Single source of truth for which topbar dropdown is open — guarantees
  // only one is visible at a time without depending on Radix's internal state.
  type TopMenu = "mcp" | "model" | "effort" | null;
  const [openMenu, setOpenMenu] = useState<TopMenu>(null);
  // Provider dropdown — mirrors the session's persisted provider. Mid-session
  // switching is blocked with a toast; the choice is made up-front via
  // ClaudeDialog and locked for the lifetime of the session.
  const selectedProvider = useClaudeStore((s) => s.sessions[sessionId]?.provider ?? "anthropic");
  const liveMcp = useClaudeStore((s) => s.sessions[sessionId]?.mcpServers);
  const mcpServers: McpDisplayServer[] = (liveMcp && liveMcp.length > 0) ? liveMcp : configMcpServers;
  const [showFileTree, setShowFileTree] = useState(false);
  // Per-session model + effort persisted via the store. Falls back to the
  // settings-store global default when the session has nothing pinned yet
  // (typically a brand-new session pre-first-render). Writes go to BOTH the
  // session record (so the choice survives reloads + isolates per-chat) and
  // the global default (so the next new session inherits the user's habit).
  const persistedSelectedModel = useClaudeStore((s) => s.sessions[sessionId]?.selectedModel ?? null);
  const persistedSelectedEffort = useClaudeStore((s) => s.sessions[sessionId]?.selectedEffort ?? null);
  const providerDefaults = PROVIDER_CONFIG[selectedProvider];
  const globalModel = useSettingsStore.getState().claudeModel;
  const globalEffort = useSettingsStore.getState().claudeEffort;
  const selectedModel = persistedSelectedModel
    ?? (providerDefaults.models.some((m) => m.id === globalModel) ? globalModel : providerDefaults.defaultModel);
  const selectedEffort = persistedSelectedEffort
    ?? (providerDefaults.efforts.some((e) => e.id === globalEffort) ? globalEffort : providerDefaults.defaultEffort);
  const setSelectedModel = useCallback((id: string) => {
    useClaudeStore.getState().setSelectedModel(sessionId, id);
  }, [sessionId]);
  const setSelectedEffort = useCallback((id: string) => {
    useClaudeStore.getState().setSelectedEffort(sessionId, id);
  }, [sessionId]);
  const [permModeIdx, setPermModeIdx] = useState(() => {
    if (skipPermissions) return 4; // YOLO when skipPermissions is set
    const s = useSettingsStore.getState();
    const fixedDefault = s.claudeDefaultPermMode;
    if (fixedDefault) {
      const idx = PERMISSION_MODES.findIndex((m) => m.id === fixedDefault);
      if (idx >= 0) return idx;
    }
    const stored = s.claudePermMode;
    if (stored) {
      const idx = PERMISSION_MODES.findIndex((m) => m.id === stored);
      if (idx >= 0) return idx;
    }
    return 0; // default: Default (ask for everything)
  });
  // Codex's permission surface is a separate enum than Anthropic's. Persisted
  // per-session via the store so the chosen sandbox preset (read-only /
  // workspace / full-auto / yolo) survives reloads. Cycled via the same
  // bottom-of-input "permLabel" affordance Anthropic uses.
  const persistedCodexPermission = useClaudeStore(
    (s) => s.sessions[sessionId]?.selectedCodexPermission ?? null,
  );
  const selectedCodexPermission = persistedCodexPermission ?? PROVIDER_CONFIG.openai.defaultPermission;
  const setSelectedCodexPermission = useCallback((id: string) => {
    useClaudeStore.getState().setSelectedCodexPermission(sessionId, id);
  }, [sessionId]);
  const cycleCodexPermission = useCallback(() => {
    const list = PROVIDER_CONFIG.openai.permissions;
    const idx = list.findIndex((p) => p.id === selectedCodexPermission);
    const next = list[(idx + 1) % list.length]!;
    setSelectedCodexPermission(next.id);
  }, [selectedCodexPermission, setSelectedCodexPermission]);
  const autoCompactEnabled = useSettingsStore((s) => s.autoCompactEnabled);
  const autoCompactThreshold = useSettingsStore((s) => s.autoCompactThreshold);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [filePreviews, setFilePreviews] = useState<Record<string, string>>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [planFinished, setPlanFinished] = useState(false);
  const [showPlanViewer, setShowPlanViewer] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [rewindText, setRewindText] = useState<string | null>(null);
  const [rewindPrompt, setRewindPrompt] = useState<{ messageId: string; content: string; affectedFiles: AffectedFile[] } | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [editOverlay, setEditOverlay] = useState<{ tcId: string; filePath: string; fullContent: string; changedLines: Set<number> } | null>(null);
  const editOverrides = useRef<Record<string, string>>({});
  const savedScrollTop = useRef<number>(0);
  const modifiedEditorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const editorSavedVersionId = useRef<number>(0);
  const [showHookLog, setShowHookLog] = useState(false);
  const panelColor = useCanvasStore((s) => s.terminals.find((t) => t.terminalId === sessionId)?.borderColor);
  const hookEventLog = useClaudeStore((s) => s.sessions[sessionId]?.hookEventLog ?? []);
  const toolUsageStats = useClaudeStore((s) => s.sessions[sessionId]?.toolUsageStats ?? {});
  const compactionCount = useClaudeStore((s) => s.sessions[sessionId]?.compactionCount ?? 0);
  const totalToolCalls = useMemo(() => Object.values(toolUsageStats).reduce((a, b) => a + b, 0), [toolUsageStats]);

  const permMode = PERMISSION_MODES[permModeIdx] ?? PERMISSION_MODES[0]!;

  useEffect(() => {
    // Passing cwd to createSession lets the store kick off JSONL hydration
    // immediately instead of waiting for a later setCwd call.
    const effectiveInitCwd = cwd && cwd !== "." ? cwd : undefined;
    createSession(sessionId, undefined, false, undefined, effectiveInitCwd);
    if (effectiveInitCwd) {
      useClaudeStore.getState().setCwd(sessionId, effectiveInitCwd);
    }
  }, [sessionId, createSession, cwd]);

  // Snap selectedModel/selectedEffort onto the active provider's lists. The
  // settings store seeds with anthropic ids; for an OpenAI session those ids
  // don't resolve to anything in the codex models/efforts list and the request
  // would carry an invalid model string.
  useEffect(() => {
    const cfg = PROVIDER_CONFIG[selectedProvider];
    if (!cfg.models.find((m) => m.id === selectedModel)) {
      setSelectedModel(cfg.defaultModel);
    }
    if (!cfg.efforts.find((e) => e.id === selectedEffort)) {
      setSelectedEffort(cfg.defaultEffort);
    }
    // Only re-evaluate on provider change — selectedModel/Effort are user-driven
    // and shouldn't bounce back to defaults every time they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider]);
  const t64Commands = useRef<SlashCommand[]>([
    { name: "loop", description: "Run a prompt on a loop (e.g. /loop 5m improve the code)", usage: "/loop [interval] <prompt> — default 10m. /loop stop to cancel.", source: "Terminal 64" },
    { name: "delegate", description: "Split work into parallel sub-sessions", usage: "/delegate <prompt> — Plans the task split, spawns agents with MCP team chat.", source: "Terminal 64" },
    { name: "reload-plugins", description: "Reload slash commands, skills, and MCP servers", usage: "/reload-plugins — re-fetches all available commands and MCP configs.", source: "Terminal 64" },
  ]);
  const reloadCommands = useCallback(() => {
    listSlashCommands().then((cmds) => {
      const merged = [...t64Commands.current, ...cmds];
      const seen = new Set(merged.map((c) => c.name));
      for (const bc of CLAUDE_BUILTIN_COMMANDS) {
        if (!seen.has(bc.name)) merged.push(bc);
      }
      setSlashCommands(merged);
    }).catch(() => {
      const merged = [...t64Commands.current];
      const seen = new Set(merged.map((c) => c.name));
      for (const bc of CLAUDE_BUILTIN_COMMANDS) {
        if (!seen.has(bc.name)) merged.push(bc);
      }
      setSlashCommands(merged);
    });
    listMcpServers(cwd).then(setConfigMcpServers).catch(() => {});
  }, [cwd]);
  useEffect(() => { reloadCommands(); }, [reloadCommands]);
  // Apply persisted font on mount (once per app, harmless if called multiple times)
  useEffect(() => {
    document.documentElement.style.setProperty("--claude-font", fontStack(useSettingsStore.getState().claudeFont || "system"));
  }, []);
  // ── Scroll management ──────────────────────────────────────────────
  // LegendList handles the hard parts (anchoring during markdown/KaTeX reflow,
  // virtualization of the off-screen items, scrollTo*) internally. We only
  // track whether the user is currently pinned to the bottom so other code
  // (reveal-gates, jumpToPrompt) can branch on it, and we expose a few
  // imperative helpers that delegate to LegendList via `virtuosoRef`.
  //
  // We own the stick-to-bottom state here, not the list's derived at-end flag. LegendList's
  // atBottomStateChange flips false mid-stream every time a new item
  // grows scrollHeight past the threshold, even if the user hasn't
  // moved — which made every previous iteration of the pump abort
  // exactly when it needed to follow. stickyRef is true iff the user
  // wants to be pinned; we set it to false ONLY on a user-initiated
  // wheel-up / touch-drag-up, and back to true when the user brings
  // themselves back near the bottom.
  const stickyRef = useRef(true);
  const scrollStateRaf = useRef<number | null>(null);
  const isRawNearBottom = useCallback(() => {
    const el = getScrollEl();
    if (!el) return true;
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
    return remaining <= 24;
  }, [getScrollEl]);

  const scrollToBottom = useCallback(() => {
    // LegendList's `maintainScrollAtEnd` re-engages once we mark sticky
    // and tell it to scroll to end. The old el.scrollTop=el.scrollHeight
    // bypassed the library — here we want the
    // library's anchor logic to know we want to be at end so it stays
    // there as new content arrives.
    stickyRef.current = true;
    setIsScrolledUp(false);
    setScrollProgress(0);
    virtuosoRef.current?.scrollToEnd?.({ animated: false });
    requestAnimationFrame(() => {
      if (isRawNearBottom()) {
        stickyRef.current = true;
        setIsScrolledUp(false);
        setScrollProgress(0);
      }
    });
  }, [isRawNearBottom]);

  const followStreamingToBottom = useCallback(() => {
    if (!stickyRef.current) return;
    const list = virtuosoRef.current;
    list?.scrollToEnd?.({ animated: false });
    requestAnimationFrame(() => {
      if (!stickyRef.current) return;
      list?.scrollToEnd?.({ animated: false });
      const el = getScrollEl();
      if (el) el.scrollTop = el.scrollHeight;
      setIsScrolledUp(false);
      setScrollProgress(0);
    });
  }, [getScrollEl]);

  const handleUserWheel = useCallback((event: React.WheelEvent) => {
    if (event.deltaY < -1) {
      stickyRef.current = false;
      return;
    }
    if (event.deltaY > 1 && isRawNearBottom()) {
      stickyRef.current = true;
    }
  }, [isRawNearBottom]);

  const touchStartY = useRef<number | null>(null);
  const handleUserTouchStart = useCallback((event: React.TouchEvent) => {
    touchStartY.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleUserTouchMove = useCallback((event: React.TouchEvent) => {
    const prevY = touchStartY.current;
    const nextY = event.touches[0]?.clientY ?? null;
    if (prevY === null || nextY === null) return;
    const delta = nextY - prevY;
    touchStartY.current = nextY;
    if (delta > 1) {
      stickyRef.current = false;
    } else if (delta < -1 && isRawNearBottom()) {
      stickyRef.current = true;
    }
  }, [isRawNearBottom]);

  // Session switch → snap to bottom, close island.
  useEffect(() => {
    setIslandOpen(false);
    stickyRef.current = true;
    // Defer one frame so LegendList has the new data.
    requestAnimationFrame(() => scrollToBottom());
  }, [sessionId, scrollToBottom]);


  // Auto-close the island picker whenever an overlay takes over the chat
  // body. Without this, islandOpen can survive an overlay round-trip and
  // leave the island stuck visible when the chat comes back.
  useEffect(() => {
    if (editOverlay || showPlanViewer) setIslandOpen(false);
  }, [editOverlay, showPlanViewer]);

  // Shift+Tab cycles the active permission preset. Anthropic cycles its own
  // 5-mode list; Codex cycles its 4-preset sandbox list (read-only / workspace
  // / full-auto / yolo). Both are persisted per-session via the store.
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        if (selectedProvider === "anthropic") {
          setPermModeIdx((i) => { const next = (i + 1) % PERMISSION_MODES.length; const s = useSettingsStore.getState(); if (!s.claudeDefaultPermMode) s.set({ claudePermMode: PERMISSION_MODES[next]!.id }); return next; });
        } else {
          cycleCodexPermission();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive, selectedProvider, cycleCodexPermission]);

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
  // Also trigger planFinished if a plan file was written during THIS turn.
  const wasStreaming = useRef(false);
  const planShownThisTurn = useRef(false);
  useEffect(() => {
    if (!session) return;
    if (session.isStreaming) {
      wasStreaming.current = true;
      planShownThisTurn.current = false;
    } else if (wasStreaming.current) {
      wasStreaming.current = false;
      if (session.planModeActive) {
        // Auto-exit plan mode since the turn ended
        useClaudeStore.getState().setPlanMode(sessionId, false);
      } else if (planContent && !planFinished && !planShownThisTurn.current) {
        // Plan file was written this turn — show the action bar once
        planShownThisTurn.current = true;
        setPlanFinished(true);
      }
    }
  }, [session?.isStreaming, session?.planModeActive, sessionId, planContent, planFinished]);

  // Detect plan files from tool calls — only scan messages added since last user prompt
  const planScanFrom = useRef(0);
  useEffect(() => {
    if (!session) return;
    const msgs = session.messages;
    // Find the last user message index to know where the current turn started
    let turnStart = planScanFrom.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "user") { turnStart = i; break; }
    }
    planScanFrom.current = turnStart;
    for (let i = msgs.length - 1; i >= turnStart; i--) {
      const msg = msgs[i];
      if (msg && msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if ((tc.name === "Write" || tc.name === "Edit" || tc.name === "Read") && tc.input.file_path) {
            const fp = String(tc.input.file_path);
            if (fp.includes(".claude/plans/") || fp.includes(".claude\\plans\\")) {
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
    appWindow.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        setIsDragOver(true);
      } else if (payload.type === "leave") {
        setIsDragOver(false);
      } else if (payload.type === "drop") {
        setIsDragOver(false);
        const paths: string[] = payload.paths.filter(
          (p) => !p.toLowerCase().endsWith(".zip")
        );
        if (paths.length) {
          setAttachedFiles((prev) => [...prev, ...paths]);
          for (const p of paths) {
            if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i.test(p)) {
              readFileBase64(p).then((b64) => {
                const ext = p.split(".").pop()?.toLowerCase() || "png";
                const mime = ext === "svg" ? "image/svg+xml" : `image/${ext.replace("jpg", "jpeg")}`;
                setFilePreviews((prev) => ({ ...prev, [p]: `data:${mime};base64,${b64}` }));
              }).catch(() => {});
            }
          }
        }
      }
    }).then((fn) => { unlisten = fn; }).catch((err) => console.warn('[drag-drop]', err));
    return () => { if (unlisten) unlisten(); };
  }, [isActive]);

  // Resolve CWD: use prop, fall back to stored session CWD
  const effectiveCwd = (cwd && cwd !== ".") ? cwd : (session?.cwd || ".");

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

  useEffect(() => {
    if (!session?.activeLoop && loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    return () => {
      if (loopTimerRef.current) { clearTimeout(loopTimerRef.current); loopTimerRef.current = null; }
    };
  }, [session?.activeLoop]);

  // Listen for Discord messages routed through the frontend pipeline
  const handleSendRef = useRef<((text: string, permissionOverride?: PermissionMode, fromDiscord?: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; username: string; prompt: string }>(
      "discord-prompt",
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        const { username, prompt } = event.payload;
        const displayText = `[${username}]: ${prompt}`;
        if (handleSendRef.current) {
          handleSendRef.current(displayText, undefined, true).catch((err) =>
            useClaudeStore.getState().setError(sessionId, String(err))
          );
        }
      }
    ).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  const actualSend = useChatSend({
    sessionId,
    effectiveCwd,
    permissionMode: permMode.id,
    selectedModel,
    selectedEffort,
    selectedCodexPermission,
    incrementPromptCount,
  });
  const rewindHistory = useChatRewind();

  const handleSend = useCallback(
    async (text: string, permissionOverride?: PermissionMode, fromDiscord = false) => {
      // Re-arm sticky so the user sees their own message + response.
      // MutationObserver will catch the DOM growth and do the actual
      // scroll after the new message is appended.
      stickyRef.current = true;

      const loopMatch = text.match(/^\/loop\s*(.*)/i);
      if (loopMatch) {
        const args = loopMatch[1]!.trim();
        if (!args || args === "stop" || args === "cancel" || args === "off") {
          useClaudeStore.getState().setLoop(sessionId, null);
          return;
        }
        // Parse: [interval] <prompt>
        const parts = args.match(/^(\d+[smhd]?)\s+([\s\S]+)$/);
        let intervalMs = 10 * 60 * 1000; // default 10m
        let loopPrompt = args;
        if (parts) {
          const raw = parts[1]!;
          const num = parseInt(raw);
          const unit = raw.replace(/\d+/, "") || "m";
          if (unit === "s") intervalMs = num * 1000;
          else if (unit === "m") intervalMs = num * 60 * 1000;
          else if (unit === "h") intervalMs = num * 60 * 60 * 1000;
          else if (unit === "d") intervalMs = num * 24 * 60 * 60 * 1000;
          loopPrompt = parts[2]!;
        }
        useClaudeStore.getState().setLoop(sessionId, {
          prompt: loopPrompt,
          intervalMs,
          lastFiredAt: null,
          iteration: 0,
        });
        // Fire the first iteration immediately
        addUserMessage(sessionId, loopPrompt);
        if (!fromDiscord) emit("gui-message", { session_id: sessionId, content: loopPrompt }).catch(() => {});
        useClaudeStore.getState().tickLoop(sessionId);
        await actualSend(loopPrompt, permissionOverride);
        return;
      }

      if (/^\/reload-plugins\b/i.test(text)) {
        reloadCommands();
        addUserMessage(sessionId, text);
        await actualSend(text, permissionOverride);
        // Re-fetch after CLI has had time to reload
        setTimeout(reloadCommands, 3000);
        return;
      }

      const delegateMatch = text.match(/^\/delegate\s+([\s\S]+)/i);
      if (delegateMatch) {
        const userGoal = delegateMatch[1]!.trim();
        if (!userGoal) return;

        const skillPrompt = `You are orchestrating a delegation. The user wants to split work across multiple parallel coding agents.

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

      // Intercept skill slash commands — resolve SKILL.md and inject like Claude Code does
      // (with <command-name> tags + rendered body instead of raw /skill-name text)
      const skillMatch = text.match(/^\/([a-zA-Z0-9_:.-]+)\s*([\s\S]*)?$/);
      if (skillMatch) {
        const cmdName = skillMatch[1]!;
        const cmdArgs = (skillMatch[2] || "").trim();
        // Skills have source: "user", "project", "Terminal 64", or plugin-related.
        // Built-in commands have source: "built-in" or are in the T64 commands list.
        const t64Builtins = new Set(t64Commands.current.map((c) => c.name));
        const skillSources = new Set(["user", "project", "Terminal 64"]);
        const matchedSkill = slashCommands.find(
          (c) => c.name === cmdName && !t64Builtins.has(c.name) &&
            (skillSources.has(c.source) || (c.source !== "built-in" && c.source !== "builtin"))
        );
        if (matchedSkill) {
          try {
            const resolved = await resolveSkillPrompt(cmdName, cmdArgs, effectiveCwd || undefined);
            // Format with XML tags matching Claude Code's injection format
            const injectedPrompt = [
              `<command-message>${resolved.name}</command-message>`,
              `<command-name>/${resolved.name}</command-name>`,
              cmdArgs ? `<command-args>${cmdArgs}</command-args>` : null,
              "",
              resolved.body,
            ].filter((l) => l !== null).join("\n");
            // Show the original /command in chat history, send the resolved content
            addUserMessage(sessionId, text);
            if (!fromDiscord) emit("gui-message", { session_id: sessionId, content: text }).catch(() => {});
            await actualSend(injectedPrompt, permissionOverride);
            return;
          } catch (err) {
            // Skill resolution failed — fall through to send as raw text
            console.warn("[skill] Failed to resolve skill:", cmdName, err);
          }
        }
      }

      if (planFinished || planContent) {
        setPlanFinished(false);
        setShowPlanViewer(false);
        setPlanContent(null);
      }

      let prompt = text;
      if (attachedFiles.length > 0) {
        const fileList = attachedFiles.map((f) => `[Attached file: ${f}]`).join("\n");
        prompt = fileList + "\n\n" + text;
        setAttachedFiles([]);
        // Clean up preview URLs
        Object.values(filePreviews).forEach((url) => URL.revokeObjectURL(url));
        setFilePreviews({});
      }

      const isCurrentlyStreaming = useClaudeStore.getState().sessions[sessionId]?.isStreaming;
      if (isCurrentlyStreaming) {
        // Queue the prompt instead of sending mid-thinking
        useClaudeStore.getState().enqueuePrompt(sessionId, prompt);
        setQueueExpanded(true);
        return;
      }

      if (/^\/compact\b/i.test(prompt)) {
        useClaudeStore.getState().setAutoCompactStatus(sessionId, "compacting");
      }

      addUserMessage(sessionId, prompt);
      if (!fromDiscord) emit("gui-message", { session_id: sessionId, content: prompt }).catch(() => {});
      await actualSend(prompt, permissionOverride);
    },
    [sessionId, attachedFiles, addUserMessage, actualSend, reloadCommands, slashCommands, effectiveCwd]
  );

  // Keep ref current so the discord-prompt listener can call handleSend
  handleSendRef.current = handleSend;

  const handleCancel = useCallback(() => {
    cancelByProvider(sessionId, sessionProviderFor(sessionId)).catch(() => {});
  }, [sessionId]);

  const handleRewrite = useCallback(async (text: string, setText: (t: string) => void, opts?: { isVoice?: boolean }) => {
    setIsRewriting(true);
    try {
      let rewritten = "";
      await rewritePromptStream(text, (chunk) => {
        rewritten += chunk;
        setText(rewritten);
      }, { isVoice: opts?.isVoice ?? false });
    } catch (err) {
      useClaudeStore.getState().setError(sessionId, `Rewrite failed: ${err}`);
    } finally {
      setIsRewriting(false);
    }
  }, [sessionId]);

  // Voice control — register/unregister ChatInput actions for this session
  const handleRegisterVoiceActions = useCallback((actions: ChatInputVoiceActions | null) => {
    if (actions) {
      registerChatInputVoiceActions(sessionId, actions);
    } else {
      unregisterChatInputVoiceActions(sessionId);
    }
  }, [sessionId]);
  useEffect(() => {
    return () => { unregisterChatInputVoiceActions(sessionId); };
  }, [sessionId]);

  // Keep voiceStore's activeSessionId in sync so voice intents target this chat
  useEffect(() => {
    if (isActive) useVoiceStore.getState().setActiveSessionId(sessionId);
  }, [isActive, sessionId]);
  const extractAffectedFiles = useCallback((messageId: string): AffectedFile[] => {
    const sess = useClaudeStore.getState().sessions[sessionId];
    if (!sess) return [];
    const msgs = sess.messages;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx < 0) return [];
    const fileMap = new Map<string, { action: "M" | "A" | "D" | "U"; ins: number; del: number }>();
    const countLines = (s: unknown) => typeof s === "string" && s.length > 0 ? s.split("\n").length : 0;
    const add = (fp: string, action: "M" | "A" | "D" | "U", ins: number, del: number) => {
      const prev = fileMap.get(fp);
      if (prev) { prev.ins += ins; prev.del += del; if (action === "M" && prev.action === "A") { /* keep A */ } else prev.action = action; }
      else fileMap.set(fp, { action, ins, del });
    };
    for (let i = idx; i < msgs.length; i++) {
      const msg = msgs[i];
      if (!msg || msg.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        const inp = tc.input || {};
        const n = tc.name?.toLowerCase() || "";
        if (n === "write") {
          const fp = (inp.file_path || inp.path) as string | undefined;
          if (fp) add(fp, fileMap.has(fp) ? "M" : "A", countLines(inp.content), 0);
        } else if (n === "edit" || n === "multiedit" || n === "multi_edit" || n === "notebookedit" || n === "notebook_edit") {
          const fp = (inp.file_path || inp.path) as string | undefined;
          if (fp) add(fp, "M", countLines(inp.new_string), countLines(inp.old_string));
        } else if (n === "bash") {
          const cmd = (inp.command || inp.cmd || "") as string;
          const writeRedirect = cmd.match(/(?:>|>>)\s*["']?([^\s"'|;&]+)/g);
          if (writeRedirect) {
            for (const m of writeRedirect) {
              const fp = m.replace(/^>+\s*["']?/, "").replace(/["']$/, "").trim();
              if (fp && !fp.startsWith("/dev/")) add(fp, "U", 0, 0);
            }
          }
          const mvCp = cmd.match(/\b(?:mv|cp)\s+.*\s+["']?([^\s"'|;&]+)["']?\s*$/);
          if (mvCp?.[1]) add(mvCp[1], "U", 0, 0);
          const rm = cmd.match(/\brm\s+(?:-\w+\s+)*["']?([^\s"'|;&]+)/);
          if (rm?.[1] && !rm[1].startsWith("-")) add(rm[1], "D", 0, 0);
        }
      }
    }
    return [...fileMap.entries()]
      .map(([path, { action, ins, del }]) => ({ path, action, insertions: ins, deletions: del }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [sessionId]);

  const buildToolSummary = useCallback((messageId: string): string => {
    const sess = useClaudeStore.getState().sessions[sessionId];
    if (!sess) return "";
    const msgs = sess.messages;
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx < 0) return "";
    const parts: string[] = [];
    for (let i = idx; i < msgs.length; i++) {
      const msg = msgs[i];
      if (!msg) continue;
      if (msg.role === "user") { parts.push(`User: ${msg.content.slice(0, 200)}`); continue; }
      if (msg.role !== "assistant" || !msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        const n = tc.name || "unknown";
        const inp = tc.input || {};
        const fp = (inp.file_path || inp.path || "") as string;
        if (n.toLowerCase() === "write") parts.push(`Write ${fp} (${typeof inp.content === "string" ? inp.content.split("\n").length : "?"} lines)`);
        else if (n.toLowerCase() === "edit" || n.toLowerCase() === "multiedit") parts.push(`Edit ${fp}`);
        else if (n.toLowerCase() === "bash") parts.push(`Bash: ${((inp.command || inp.cmd || "") as string).slice(0, 120)}`);
        else parts.push(`${n} ${fp}`.trim());
      }
    }
    return parts.slice(0, 40).join("\n");
  }, [sessionId]);

  const onRewindClick = useCallback((messageId: string, content: string) => {
    const affectedFiles = extractAffectedFiles(messageId);
    setRewindPrompt({ messageId, content, affectedFiles });
  }, [extractAffectedFiles]);

  const handleRewind = useCallback(async (messageId: string, content: string, revertCode = true) => {
    console.log("[rewind] === REWIND START ===", { sessionId, messageId, content: content.slice(0, 80), revertCode });

    const preStore = useClaudeStore.getState();
    const preSess = preStore.sessions[sessionId];
    const preMsgs = preSess?.messages ?? [];

    // Detect "undo send" — rewinding to the last message which is a user message
    // with no assistant response after it. Claude never modified files, so skip all
    // file operations and just remove the message + prefill input.
    const targetIdx = preMsgs.findIndex((m) => m.id === messageId);
    const targetMsg = targetIdx >= 0 ? preMsgs[targetIdx] : null;
    const isUndoSend = targetMsg?.role === "user" && targetIdx === preMsgs.length - 1;
    const isUndoSendPair = targetMsg?.role === "user" && targetIdx === preMsgs.length - 2
      && preMsgs[preMsgs.length - 1]?.role === "assistant"
      && (!preMsgs[preMsgs.length - 1]?.toolCalls || preMsgs[preMsgs.length - 1]?.toolCalls!.length === 0)
      && (preMsgs[preMsgs.length - 1]?.content || "").length < 5;

    if (isUndoSend || isUndoSendPair) {
      console.log("[rewind] Undo-send detected — removing last user message without file revert");
      const rewindProvider = sessionProviderFor(sessionId);
      try { await cancelByProvider(sessionId, rewindProvider); } catch {}
      try { await closeByProvider(sessionId, rewindProvider); } catch {}
      const store = useClaudeStore.getState();
      store.setStreaming(sessionId, false);
      store.setError(sessionId, null);
      store.clearStreamingText(sessionId);
      const rewindCwd = preSess?.cwd || effectiveCwd;
      const keepMessages = targetIdx;
      // Disk truncate BEFORE touching the store — if the rewrite fails (disk full,
      // permission error, etc.) we surface the error and leave the UI state intact
      // so the user hasn't "lost" their conversation on a failed rewind.
      try {
        await rewindHistory({
          provider: rewindProvider,
          sessionId,
          cwd: rewindCwd,
          keepMessages,
        });
      } catch (err) {
        console.error("[rewind] Undo-send truncation failed:", err);
        useClaudeStore.getState().setError(sessionId, `Rewind failed: ${err}`);
        return;
      }
      // Mutate the store immediately so the UI reflects the undo-send
      // without blocking on findRewindUuid's whole-file parse.
      useClaudeStore.getState().truncateFromMessage(sessionId, messageId);
      setRewindText(targetMsg!.content);
      console.log("[rewind] === UNDO-SEND COMPLETE ===", { prefill: targetMsg!.content.slice(0, 80) });
      return;
    }

    // Kill the CLI process first and wait for it to die before touching the JSONL
    const rewindProvider = sessionProviderFor(sessionId);
    try {
      await cancelByProvider(sessionId, rewindProvider);
      console.log("[rewind] cancel completed");
    } catch (e) {
      console.log("[rewind] cancel error (may be expected if process already exited):", e);
    }

    // Also explicitly close the session to ensure the instance is fully removed
    try {
      await closeByProvider(sessionId, rewindProvider);
      console.log("[rewind] close completed");
    } catch (e) {
      console.log("[rewind] close error (expected):", e);
    }

    const store = useClaudeStore.getState();
    store.setStreaming(sessionId, false);
    store.setError(sessionId, null);
    store.clearStreamingText(sessionId);

    // Compute all post-rewind values from the pre-truncate snapshot so we can
    // do the on-disk truncate BEFORE mutating the store. On disk failure the UI
    // state is left intact and the user sees an error — rather than a half-done
    // rewind where the conversation view is ahead of the JSONL.
    const preTruncateCount = preMsgs.length;
    const trailingUser = targetIdx > 0 && preMsgs[targetIdx - 1]?.role === "user"
      ? preMsgs[targetIdx - 1]!
      : null;
    const keepMessages = trailingUser ? targetIdx - 1 : targetIdx;
    const keptSlice = preMsgs.slice(0, keepMessages);
    const keepTurns = keptSlice.filter((m) => m.role === "user").length;
    const rewindContent = trailingUser ? trailingUser.content : content;
    const rewindCwd = preSess?.cwd || effectiveCwd;

    console.log("[rewind] JSONL truncation params:", {
      sessionId, rewindCwd, keepMessages, keepTurns, preTruncateCount,
      sessionCwd: preSess?.cwd, effectiveCwd,
      lastKeptMsg: keptSlice[keptSlice.length - 1]?.content?.slice(0, 80),
    });

    if (preSess) {
      // Disk truncate first. If this fails we bail out without touching the
      // store — the user keeps their conversation view and sees an error toast
      // rather than a ghost conversation with a stale JSONL on disk.
      try {
        await rewindHistory({
          provider: rewindProvider,
          sessionId,
          cwd: rewindCwd,
          keepMessages,
        });
      } catch (err) {
        console.error("[rewind] truncation failed:", err);
        useClaudeStore.getState().setError(sessionId, `Rewind failed: ${err}`);
        return;
      }

      // Disk is now authoritative — mirror the truncation into the store
      // IMMEDIATELY so the UI reflects the rewind without waiting for
      // findRewindUuid (which reads + parses the entire JSONL and can take
      // multiple seconds on large sessions).
      store.truncateFromMessage(sessionId, messageId);
      if (trailingUser) {
        store.truncateFromMessage(sessionId, trailingUser.id);
        console.log("[rewind] Removed trailing user message, prefilling:", rewindContent.slice(0, 80));
      }
      const sess = preSess;

      // Find the UUID of the last message we want to keep. The next --resume
      // will pass --resume-session-at <uuid> so Claude CLI slices its own
      // parentUuid chain correctly (matching how Claude's own /rewind works:
      // append-only JSONL).
      // Force-cancel any active delegation group AND collect modifiedFiles from
      // ALL groups ever spawned by this parent — parentToGroup only tracks the
      // most recent group, so previous completed delegations' child files would
      // be orphaned without this full scan.
      const delState = useDelegationStore.getState();
      const childModifiedFiles: string[] = [];
      const parentGroups = Object.values(delState.groups).filter(
        (g) => g.parentSessionId === sessionId,
      );
      if (parentGroups.length > 0) {
        const claudeState = useClaudeStore.getState();
        for (const group of parentGroups) {
          for (const task of group.tasks) {
            if (task.sessionId) {
              const childSess = claudeState.sessions[task.sessionId];
              if (childSess?.modifiedFiles?.length) {
                childModifiedFiles.push(...childSess.modifiedFiles);
              }
            }
          }
          if (group.status === "active") {
            endDelegation(group.id, true);
          }
        }
      }

      if (revertCode) {
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
            const candidates = allModified.filter((f) => !restoredSet.has(f));
            if (candidates.length > 0) {
              const createdFiles = await filterUntrackedFiles(rewindCwd, candidates);
              if (createdFiles.length > 0) {
                const deleted = await deleteFiles(createdFiles);
                console.log("[rewind] Deleted newly-created files:", deleted);
              }
            }
          } catch (err) {
            console.warn("[rewind] Failed to check/delete created files:", err);
          }
        }

        // For delegation child files: only delete untracked (newly created) files.
        // We deliberately do NOT `git checkout HEAD --` tracked files: that restores
        // to the last commit and would wipe out unrelated uncommitted work (pre-session
        // edits, other sessions' changes). If a tracked file was modified by a child,
        // it stays modified — the user can `git diff` and decide.
        if (childModifiedFiles.length > 0) {
          const uniqueFiles = [...new Set(childModifiedFiles)].filter((f) => !restoredSet.has(f));
          if (uniqueFiles.length > 0) {
            try {
              const created = await filterUntrackedFiles(rewindCwd, uniqueFiles);
              if (created.length > 0) {
                const deleted = await deleteFiles(created);
                console.log("[rewind] Deleted delegation-created files:", deleted);
              }
              const trackedLeft = uniqueFiles.filter((f) => !created.includes(f));
              if (trackedLeft.length > 0) {
                console.log("[rewind] Tracked files modified by delegation (left alone — use git diff to review):", trackedLeft);
              }
            } catch (err) {
              console.warn("[rewind] Failed to clean delegation-created files:", err);
            }
          }
        }

        cleanupCheckpoints(sessionId, keepTurns)
          .catch((err) => console.warn("[rewind] Checkpoint cleanup:", err));
        store.resetModifiedFiles(sessionId);
      } else {
        console.log("[rewind] Conversation-only rewind — skipping file revert");
      }

      setRewindText(rewindContent);
      console.log("[rewind] === REWIND COMPLETE ===", {
        sessionId,
        finalMessageCount: useClaudeStore.getState().sessions[sessionId]?.messages.length,
        rewindContent: rewindContent?.slice(0, 80),
      });
    }
  }, [sessionId, effectiveCwd, rewindHistory]);

  const handleFork = useChatFork({ sessionId, effectiveCwd });

  const handleEditClick = useCallback(async (tcId: string, filePath: string, _oldStr: string, newStr: string) => {
    const resolvedFilePath = filePath && !isAbsolutePath(filePath) && effectiveCwd
      ? joinPath(effectiveCwd, filePath)
      : filePath;
    // Save scroll position before opening overlay
    const el = getScrollEl();
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
      setEditOverlay({ tcId, filePath: resolvedFilePath, fullContent: cached, changedLines: changed });
      return;
    }
    // Read full file from disk
    try {
      const content = await readFile(resolvedFilePath);
      const idx = content.indexOf(newStr);
      const changed = new Set<number>();
      if (idx >= 0) {
        const startLine = content.substring(0, idx).split("\n").length;
        const numLines = newStr.split("\n").length;
        for (let i = 0; i < numLines; i++) changed.add(startLine + i);
      }
      setEditOverlay({ tcId, filePath: resolvedFilePath, fullContent: content, changedLines: changed });
    } catch {
      // Fallback: show just the new string with all lines marked changed
      const lines = newStr.split("\n");
      const changed = new Set(lines.map((_, i) => i + 1));
      setEditOverlay({ tcId, filePath: resolvedFilePath, fullContent: newStr, changedLines: changed });
    }
  }, [effectiveCwd, getScrollEl]);

  const handleFileTreeOpen = useCallback(async (filePath: string) => {
    const el = getScrollEl();
    if (el) savedScrollTop.current = el.scrollTop;
    try {
      const content = await readFile(filePath);
      setEditOverlay({ tcId: `file:${filePath}`, filePath, fullContent: content, changedLines: new Set() });
    } catch (e) {
      console.warn("[claude] Failed to read file for preview:", e);
    }
  }, []);

  const handleAttach = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, title: "Attach files" });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setAttachedFiles((prev) => [...prev, ...paths]);
      // Generate previews for image files
      for (const p of paths) {
        if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i.test(p) && !filePreviews[p]) {
          readFileBase64(p).then((b64) => {
            const ext = p.split(".").pop()?.toLowerCase() || "png";
            const mime = ext === "svg" ? "image/svg+xml" : `image/${ext.replace("jpg", "jpeg")}`;
            setFilePreviews((prev) => ({ ...prev, [p]: `data:${mime};base64,${b64}` }));
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("[claude] File picker error:", e);
    }
  }, [filePreviews]);

  const handlePasteImage = useCallback(async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const base64 = btoa(binary);
      const ext = file.name.split(".").pop() || file.type.split("/")[1] || "png";
      const savedPath = await savePastedImage(base64, ext);
      setAttachedFiles((prev) => [...prev, savedPath]);
      const previewUrl = URL.createObjectURL(file);
      setFilePreviews((prev) => ({ ...prev, [savedPath]: previewUrl }));
    } catch (e) {
      console.error("Failed to paste image:", e);
    }
  }, []);

  const hasPlan = planContent !== null;
  const hasTasks = (session?.tasks.length ?? 0) > 0;
  const hasSideContent = hasPlan || hasTasks;

  const spawnDelegation = useDelegationSpawn({
    sessionId,
    effectiveCwd,
    selectedProvider,
    permissionMode: permMode.id,
    selectedModel,
    selectedEffort,
    selectedCodexPermission,
    addUserMessage,
  });

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
    const tasks = taskMatches.map((m) => ({ description: m[1]!.trim() }));
    spawnDelegation(tasks, context);
  }, [session?.messages, spawnDelegation]);

  const activeTasks = useMemo(() => session?.tasks?.filter(t => t.status !== "deleted") ?? [], [session?.tasks]);
  const completedTasks = useMemo(() => activeTasks.filter(t => t.status === "completed"), [activeTasks]);

  // Auto-open side panel when content appears (must be before any early return)
  useEffect(() => {
    if (hasSideContent && !sidePanelOpen) setSidePanelOpen(true);
  }, [hasSideContent]);

  // Flat virtualized row descriptors — one entry per rendered line. Building a
  // descriptor list (rather than pre-rendered React elements) lets LegendList
  // reach in by index, map each entry to JSX on demand, and skip rendering
  // off-screen rows entirely. Every row carries its own stable key via `kind`
  // + a message id.
  type VisualRow =
    | { kind: "turnDivider"; key: string; dur: number }
    | { kind: "group"; key: string; msgId: string; tcs: ToolCall[] }
    | { kind: "message"; key: string; msg: ChatMessageData }
    | { kind: "streaming"; key: string }
    | {
        kind: "compact";
        key: string;
        status: "compacting" | "done";
        startedAt: number | null;
      }
    | { kind: "finishedTail"; key: string; dur: number };

  const visualRows: VisualRow[] = useMemo(() => {
    if (!session) return [];
    const rows: VisualRow[] = [];
    const msgs = session.messages;
    let lastCompactUserIndex = -1;
    for (let idx = msgs.length - 1; idx >= 0; idx--) {
      const m = msgs[idx];
      if (m?.role === "user" && /^\/compact\b/i.test(m.content || "")) {
        lastCompactUserIndex = idx;
        break;
      }
    }
    let i = 0;
    let lastUserTs: number | null = null;
    while (i < msgs.length) {
      const msg = msgs[i]!;
      const prevMsg = msgs[i - 1];
      if (
        msg.role === "user" &&
        lastUserTs !== null &&
        i > 0 &&
        prevMsg &&
        prevMsg.role === "assistant"
      ) {
        const dur = prevMsg.timestamp - lastUserTs;
        if (dur > 2000) {
          rows.push({ kind: "turnDivider", key: `fin-${msg.id}`, dur });
        }
      }
      if (msg.role === "user") lastUserTs = msg.timestamp;
      if (
        msg.role === "assistant" &&
        !msg.content &&
        msg.toolCalls?.length &&
        msg.toolCalls.every((tc) => GROUPABLE_TOOLS.has(tc.name))
      ) {
        const groupTcs: ToolCall[] = [...msg.toolCalls];
        let j = i + 1;
        while (j < msgs.length) {
          const next = msgs[j];
          if (
            next &&
            next.role === "assistant" &&
            !next.content &&
            next.toolCalls?.length &&
            next.toolCalls.every((tc) => GROUPABLE_TOOLS.has(tc.name))
          ) {
            groupTcs.push(...next.toolCalls);
            j++;
          } else break;
        }
        if (j > i + 1) {
          rows.push({ kind: "group", key: `rg-${msg.id}:${toolLayoutSignature(groupTcs)}`, msgId: msg.id, tcs: groupTcs });
          i = j;
          continue;
        }
      }
      rows.push({ kind: "message", key: messageLayoutKey(msg), msg });
      if (msg.role === "user" && /^\/compact\b/i.test(msg.content || "")) {
        const isLastCompact = i === lastCompactUserIndex;
        if (isLastCompact && session.autoCompactStatus !== "idle") {
          rows.push({
            kind: "compact",
            key: `compact-${msg.id}`,
            // Narrowed by the `!== "idle"` guard above.
            status: session.autoCompactStatus as "compacting" | "done",
            startedAt: session.autoCompactStartedAt,
          });
        } else {
          rows.push({ kind: "compact", key: `compact-${msg.id}`, status: "done", startedAt: null });
        }
      }
      i++;
    }
    const lastMsg = msgs[msgs.length - 1];
    if (
      !session.isStreaming &&
      lastUserTs !== null &&
      lastMsg &&
      lastMsg.role === "assistant"
    ) {
      const dur = lastMsg.timestamp - lastUserTs;
      if (dur > 2000) {
        rows.push({ kind: "finishedTail", key: `fin-tail-${lastMsg.id}`, dur });
      }
    }
    // Streaming bubble rides as a terminal list item (not in the Footer).
    // Growing footer content can make the list shrink scrollTop to keep the
    // last item pinned — exactly the "snap up on every token" jitter users
    // see. As a regular list item, its growth follows normal list layout.
    // Keyed on `hasStreamingText` (boolean) rather than the live streamingText
    // string so visualRows doesn't reallocate per token — StreamingBubbleBody
    // subscribes to the text itself.
    if (hasStreamingText) {
      rows.push({ kind: "streaming", key: "__streaming__" });
    }
    // Bottom breathing room is now a LegendList ListFooterComponent
    // (legendFooter) — no in-list spacer row needed.
    return rows;
  }, [
    session?.messages,
    session?.autoCompactStatus,
    session?.autoCompactStartedAt,
    session?.isStreaming,
    hasStreamingText,
  ]);

  const renderRow = useCallback(
    (_idx: number, row: VisualRow) => {
      let inner: React.ReactNode;
      switch (row.kind) {
        case "turnDivider":
        case "finishedTail":
          inner = (
            <div className="cc-turn-divider">
              <span className="cc-turn-divider-text">
                Finished after {formatDuration(Math.floor(row.dur / 1000))}
              </span>
            </div>
          );
          break;
        case "group":
          inner = (
            <div data-msg-id={row.msgId} className="cc-message cc-message--assistant">
              <div className="cc-tc-list">
                <ToolGroupCard tcs={row.tcs} />
              </div>
            </div>
          );
          break;
        case "message":
          inner = (
            <ChatMessage
              message={row.msg}
              provider={selectedProvider}
              onRewind={onRewindClick}
              onFork={handleFork}
              onEditClick={handleEditClick}
            />
          );
          break;
        case "compact":
          inner = <CompactDivider status={row.status} startedAt={row.startedAt} />;
          break;
        case "streaming":
          // Streaming bubble keeps its own gutter via StreamingBubbleBody's
          // .cc-row class; returning early skips the wrapper so the margin
          // growth isn't part of the footer size measurement each tick.
          return <StreamingBubbleBody sessionId={sessionId} onStreamUpdate={followStreamingToBottom} />;
      }
      // LegendList strips our old flex gap; wrap each row so the 10px rhythm
      // can live on `.cc-row + .cc-row`.
      return <div className="cc-row">{inner}</div>;
    },
    [onRewindClick, handleFork, handleEditClick, sessionId, followStreamingToBottom],
  );

  // ── LegendList adapters ────────────────────────────────────────────
  // LegendList's API is data + keyExtractor + renderItem({item}). Forward to
  // the existing renderRow.
  const legendKey = useCallback((row: VisualRow) => row.key, []);
  const legendRenderItem = useCallback(
    ({ item, index }: { item: VisualRow; index: number }) => renderRow(index, item),
    [renderRow],
  );
  // onScroll fires on every scroll tick. Treat it as visibility telemetry
  // only: user-intent handlers own stickyRef, because LegendList can emit
  // non-user scrolls while a streaming row grows and briefly reports not-at-end.
  const onLegendScroll = useCallback(() => {
    if (scrollStateRaf.current !== null) return;
    scrollStateRaf.current = requestAnimationFrame(() => {
      scrollStateRaf.current = null;
      const rawAtEnd = isRawNearBottom();
      if (rawAtEnd) stickyRef.current = true;
      setIsScrolledUp(!rawAtEnd);
      const el = getScrollEl();
      if (!el) return;
      const maxScroll = el.scrollHeight - el.clientHeight;
      const progress = maxScroll > 1 ? Math.max(0, Math.min(1, 1 - el.scrollTop / maxScroll)) : 0;
      setScrollProgress(rawAtEnd ? 0 : progress);
    });
  }, [getScrollEl, isRawNearBottom]);

  useEffect(() => {
    return () => {
      if (scrollStateRaf.current !== null) {
        cancelAnimationFrame(scrollStateRaf.current);
        scrollStateRaf.current = null;
      }
    };
  }, []);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "PageUp" || event.key === "Home" || event.key === "ArrowUp") {
      stickyRef.current = false;
    } else if (event.key === "End") {
      stickyRef.current = true;
    }
  }, []);

  const handleListPointerDown = useCallback(() => {
    const el = getScrollEl();
    if (!el) return;
    if (!isRawNearBottom()) stickyRef.current = false;
  }, [getScrollEl, isRawNearBottom]);

  // After mount / session swap, LegendList does its initialScrollAtEnd pass
  // but never fires onScroll for the resting-at-bottom state, so isScrolledUp
  // stays at whatever a transient scroll event left it as. Re-sync once the
  // list has settled so the prompt island + jump button don't flash on
  // startup when the session is already at bottom.
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (cancelled) return;
      const atEnd = !!virtuosoRef.current?.getState?.()?.isAtEnd || isRawNearBottom();
      stickyRef.current = atEnd;
      setIsScrolledUp(!atEnd);
      if (atEnd) setScrollProgress(0);
    };
    const r1 = requestAnimationFrame(() => requestAnimationFrame(sync));
    const t = setTimeout(sync, 120);
    return () => { cancelled = true; cancelAnimationFrame(r1); clearTimeout(t); };
  }, [sessionId, visualRows.length, isRawNearBottom]);
  const legendFooter = useMemo(
    () => (
      <>
        <ChatFooter
          sessionId={sessionId}
          effectiveCwd={effectiveCwd}
          permissionMode={permMode.id}
          model={selectedModel}
          effort={selectedEffort}
        />
        {/* 50px breathing room below last row — equivalent of t3code's
            ListFooterComponent={<div className="h-3 sm:h-4" />}. Kept
            generous since the panel height varies with canvas zoom. */}
        <div style={{ height: 50 }} aria-hidden="true" />
      </>
    ),
    [sessionId, effectiveCwd, permMode.id, selectedModel, selectedEffort],
  );

  // Indexed user prompts (includes /slash commands) for the prompt-island picker.
  const userPrompts = useMemo(() => {
    const out: { id: string; idx: number; content: string; timestamp: number; isCmd: boolean }[] = [];
    const msgs = session?.messages ?? [];
    let promptIdx = 0;
    for (const m of msgs) {
      if (m.role !== "user") continue;
      if (!m.content) continue;
      if (m.content.startsWith("All delegated tasks have finished")) continue; // merge results aren't prompts
      promptIdx += 1;
      out.push({
        id: m.id,
        idx: promptIdx,
        content: m.content,
        timestamp: m.timestamp,
        isCmd: /^\//.test(m.content.trim()),
      });
    }
    return out;
  }, [session?.messages]);

  const jumpToPrompt = useCallback(
    (msgId: string) => {
      // Find the visual row index for this message. LegendList scrolls by row,
      // not by message id — the row kinds are a superset of messages.
      const rowIdx = visualRows.findIndex(
        (r) => (r.kind === "message" && r.msg.id === msgId) || (r.kind === "group" && r.msgId === msgId),
      );
      if (rowIdx < 0) return;
      setIslandOpen(false);
      stickyRef.current = false;
      virtuosoRef.current?.scrollToIndex?.({
        index: rowIdx,
        animated: true,
      });
      // Flash the target once the list has committed the scroll + mount.
      // Two rAFs give the list a chance to render the row's DOM; we then
      // query the live scroller (via LegendList's getScrollableNode) by
      // data-msg-id.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const root = getScrollEl();
          if (!root) return;
          const target = root.querySelector<HTMLElement>(
            `[data-msg-id="${CSS.escape(msgId)}"]`,
          );
          if (!target) return;
          target.setAttribute("data-jump-flash", "1");
          window.setTimeout(() => target.removeAttribute("data-jump-flash"), 1300);
        });
      });
    },
    [visualRows],
  );

  if (!session) return <div className="cc-container cc-loading">Initializing...</div>;

  const hasMessages = session.messages.length > 0 || hasStreamingText;
  // Provider-aware model/effort lists. When the provider dropdown switches
  // (e.g. anthropic → openai) the topbar swaps in OpenAI's models/efforts
  // and falls back to that provider's first option if the previously-selected
  // id doesn't exist in the new list.
  const providerCfg = PROVIDER_CONFIG[selectedProvider];
  const activeModels = providerCfg.models;
  const activeEfforts = providerCfg.efforts;
  const currentModel =
    activeModels.find((m) => m.id === selectedModel) || activeModels[0]!;
  const currentEffort =
    activeEfforts.find((e) => e.id === selectedEffort) || activeEfforts[2] || activeEfforts[0]!;

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
        <div className="cc-topbar-center">
          {/* MCP servers — t64 built-in excluded from count but shown in dropdown. */}
          {(() => {
            const userMcp = mcpServers.filter((s) => s.name !== "terminal-64");
            const hasError = mcpServers.some((s) => "status" in s && ((s as McpServerStatus).status === "failed" || (s as McpServerStatus).status === "error"));
            return (
              <DropdownMenu open={openMenu === "mcp"} onOpenChange={(o) => {
                setOpenMenu(o ? "mcp" : null);
                if (o && effectiveCwd) listMcpServers(effectiveCwd).then(setConfigMcpServers).catch(() => {});
              }}>
                <DropdownMenuTrigger asChild>
                  <button
                    className={`shadcn-trigger ${userMcp.length > 0 ? "cc-mcp-btn--active" : ""} ${hasError ? "cc-mcp-btn--error" : ""}`}
                    aria-label="MCP servers"
                  >
                    MCP{userMcp.length > 0 ? ` (${userMcp.length})` : ""}
                    <span className="shadcn-trigger-chev">▾</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="cc-mcp-menu">
                  <DropdownMenuLabel>MCP Servers</DropdownMenuLabel>
                  {mcpServers.length === 0 ? (
                    <div className="cc-mcp-empty" style={{ padding: "6px 10px", fontSize: 10, color: "var(--fg-muted, #6c7086)" }}>
                      No MCP servers configured
                    </div>
                  ) : (
                    mcpServers.map((s) => {
                      const isLive = "status" in s;
                      const status = (isLive ? (s as McpServerStatus).status : undefined) || "configured";
                      const isError = status === "failed" || status === "error";
                      const isConnected = status === "connected";
                      const isBuiltIn = s.name === "terminal-64";
                      const liveServer = isLive ? (s as McpServerStatus) : undefined;
                      const toolCount = liveServer?.toolCount ?? liveServer?.tools?.length;
                      return (
                        <DropdownMenuItem
                          key={s.name}
                          className={`shadcn-menu-item--mcp ${isBuiltIn ? "cc-mcp-item--builtin" : ""}`}
                          onSelect={(e) => e.preventDefault()}
                        >
                          <div className="shadcn-mcp-row">
                            <span className={`shadcn-mcp-dot ${isError ? "shadcn-mcp-dot--error" : isConnected ? "shadcn-mcp-dot--ok" : "shadcn-mcp-dot--idle"}`} />
                            <span className="shadcn-mcp-name">{isBuiltIn ? "T64" : s.name}</span>
                          </div>
                          <span className="shadcn-mcp-meta">
                            {status}
                            {isBuiltIn ? " · built-in" : ""}
                            {s.transport ? ` · ${s.transport}` : ""}
                            {s.scope ? ` · ${s.scope}` : ""}
                            {toolCount != null ? ` · ${toolCount} tool${toolCount !== 1 ? "s" : ""}` : ""}
                          </span>
                          {isError && liveServer?.error && (
                            <span className="shadcn-mcp-error">{liveServer.error}</span>
                          )}
                        </DropdownMenuItem>
                      );
                    })
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}

          {/* Model dropdown */}
          <DropdownMenu open={openMenu === "model"} onOpenChange={(o) => setOpenMenu(o ? "model" : null)}>
            <DropdownMenuTrigger asChild>
              <button className="shadcn-trigger" aria-label="Model">
                {currentModel.label}
                <span className="shadcn-trigger-chev">▾</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              {activeModels.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  active={m.id === selectedModel}
                  onSelect={() => {
                    setSelectedModel(m.id);
                    useSettingsStore.getState().set({ claudeModel: m.id });
                  }}
                >
                  <span className="shadcn-menu-text">{m.label}</span>
                  <span className="shadcn-menu-check">{m.id === selectedModel ? "✓" : ""}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Effort dropdown */}
          <DropdownMenu open={openMenu === "effort"} onOpenChange={(o) => setOpenMenu(o ? "effort" : null)}>
            <DropdownMenuTrigger asChild>
              <button className="shadcn-trigger" aria-label="Reasoning effort">
                {currentEffort.label}
                <span className="shadcn-trigger-chev">▾</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Effort</DropdownMenuLabel>
              {activeEfforts.map((e) => (
                <DropdownMenuItem
                  key={e.id}
                  active={e.id === selectedEffort}
                  onSelect={() => {
                    setSelectedEffort(e.id);
                    useSettingsStore.getState().set({ claudeEffort: e.id });
                  }}
                >
                  <span className="shadcn-menu-text">{e.label}</span>
                  <span className="shadcn-menu-check">{e.id === selectedEffort ? "✓" : ""}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="cc-topbar-right">
          {totalToolCalls > 0 && (
            <span className="ch-tool-badge" title={`${totalToolCalls} tool calls this session`}>
              {totalToolCalls} tools
            </span>
          )}
          {compactionCount > 0 && (
            <span className="ch-compact-badge" title={`Compacted ${compactionCount} time${compactionCount > 1 ? "s" : ""}`}>
              {compactionCount}×
            </span>
          )}
          {/* Context % moved to bottom-right status line in ChatInput */}
          {selectedProvider === "anthropic" && (
            <button
              className={`ch-log-toggle ${showHookLog ? "ch-log-toggle--active" : ""}`}
              onClick={() => setShowHookLog((v) => !v)}
              title="Toggle hook activity log"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 3h8M2 6h6M2 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              {hookEventLog.length > 0 && <span className="ch-log-count">{hookEventLog.length}</span>}
            </button>
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
              // Cancel running process + reset UI state, then pull just the
              // last slice of JSONL and merge in any new messages we missed.
              // Loading the full history on every click re-parses the entire
              // file and pumps thousands of messages over IPC; we only need
              // the tail to catch up.
              {
                const rp = sessionProviderFor(sessionId);
                cancelByProvider(sessionId, rp).catch(() => {});
                closeByProvider(sessionId, rp).catch(() => {});
              }
              const store = useClaudeStore.getState();
              store.setStreaming(sessionId, false);
              store.setError(sessionId, null);
              store.clearStreamingText(sessionId);
              if (sessionProviderFor(sessionId) === "openai") {
                const tid = useClaudeStore.getState().sessions[sessionId]?.codexThreadId;
                if (tid) {
                  loadCodexSessionHistory(tid).then((history) => {
                    if (history?.length) {
                      store.mergeFromDisk(sessionId, mapHistoryMessages(history) as ChatMessageData[]);
                    }
                  }).catch(() => {});
                }
              } else if (effectiveCwd) {
                loadSessionHistoryTail(sessionId, effectiveCwd, 50).then((history) => {
                  if (history?.length) {
                    store.mergeFromDisk(sessionId, mapHistoryMessages(history) as ChatMessageData[]);
                  }
                }).catch(() => {});
              }
            }}
            title="Refresh chat (cancel in-flight request, merge recent JSONL)"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1.5 6A4.5 4.5 0 0 1 10 3.5M10.5 6A4.5 4.5 0 0 1 2 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M10 1v3h-3M2 11V8h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      {showHookLog && (
        <div className="ch-log-panel">
          <div className="ch-log-header">
            <span className="ch-log-title">Hook Activity</span>
            <button className="ch-log-close" onClick={() => setShowHookLog(false)}>×</button>
          </div>
          <div className="ch-log-body">
            {hookEventLog.length === 0 ? (
              <div className="ch-log-empty">No hook events yet</div>
            ) : (
              [...hookEventLog].reverse().map((evt, i) => (
                <div key={`${evt.timestamp}-${i}`} className={`ch-log-entry ch-log-entry--${evt.type.toLowerCase()}`}>
                  <span className="ch-log-time">{new Date(evt.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className="ch-log-type">{evt.type}</span>
                  {evt.toolName && <span className="ch-log-detail">{evt.toolName}</span>}
                  {evt.subagentId && <span className="ch-log-detail">agent:{evt.subagentId.slice(0, 8)}</span>}
                  {evt.message && <span className="ch-log-msg">{evt.message.slice(0, 80)}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}

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
                      const el = getScrollEl();
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
                      if (mid !== undefined) editor.revealLineInCenter(mid);
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
          <div className="cc-scroll-frame">
          {!hasMessages ? (
            <div className="cc-messages">
              <div className="cc-empty">
                <div className="cc-empty-icon">
                  <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                    <path d="M5 24L13 8L21 18L27 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <span className="cc-empty-text">{selectedProvider === "openai" ? "Codex" : "Claude Code"}</span>
                <span className="cc-empty-sub">Send a message, type / for commands, or drop files</span>
              </div>
            </div>
          ) : (
          <LegendList<VisualRow>
            ref={virtuosoRef}
            className="cc-messages"
            data={visualRows}
            keyExtractor={legendKey}
            renderItem={legendRenderItem}
            recycleItems={false}
            estimatedItemSize={120}
            initialScrollAtEnd
            maintainScrollAtEnd
            maintainScrollAtEndThreshold={0.1}
            maintainVisibleContentPosition
            onScroll={onLegendScroll}
            onWheel={handleUserWheel}
            onTouchStart={handleUserTouchStart}
            onTouchMove={handleUserTouchMove}
            onKeyDown={handleListKeyDown}
            onPointerDown={handleListPointerDown}
            ListFooterComponent={legendFooter}
          />
          )}
          {/* Prompt island + jump-to-bottom live inside `.cc-scroll-frame`
              (a position:relative sibling of `.cc-messages`) so they anchor
              to the scroll viewport's rect, not the full chat column. Island
              fades in/out via the --hidden class on PromptIsland; jump
              button is vertically centered in the frame so it doesn't
              drift with scroll position. */}
          <PromptIsland
            prompts={userPrompts}
            isScrolledUp={isScrolledUp}
            progress={scrollProgress}
            open={islandOpen}
            onOpen={() => setIslandOpen(true)}
            onClose={() => setIslandOpen(false)}
            onJump={jumpToPrompt}
          />
          <button
            className={`cc-jump-bottom${isScrolledUp && userPrompts.length > 0 ? "" : " cc-jump-bottom--hidden"}`}
            onClick={() => scrollToBottom()}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 2V11M7 11L3 7M7 11L11 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
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
                    {attachedFiles.map((f, i) => {
                      const isImage = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(f);
                      const preview = filePreviews[f];
                      const remove = () => {
                        setAttachedFiles((p) => p.filter((_, j) => j !== i));
                        if (preview) { URL.revokeObjectURL(preview); setFilePreviews((p) => { const n = { ...p }; delete n[f]; return n; }); }
                      };
                      return (
                        <div key={`${i}-${f}`} className={`cc-file-chip ${isImage && preview ? "cc-file-chip--image" : ""}`} onClick={remove} title="Click to remove">
                          {isImage && preview ? (
                            <>
                              <img src={preview} alt="" className="cc-file-preview" />
                              <div className="cc-file-remove-overlay">×</div>
                            </>
                          ) : (
                            <>
                              <span className="cc-file-name">{f.split(/[/\\]/).pop()}</span>
                              <span className="cc-file-remove-x">×</span>
                            </>
                          )}
                        </div>
                      );
                    })}
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
                  {...(panelColor ? { accentColor: panelColor } : {})}
                  streamingStartedAt={session.streamingStartedAt}
                  slashCommands={slashCommands}
                  initialText={rewindText}
                  onInitialTextConsumed={() => setRewindText(null)}
                  {...(selectedProvider === "anthropic" ? {
                    permLabel: `${permMode.id === "default" ? "ask permissions" : permMode.id === "bypass_all" ? "bypass permissions" : permMode.id === "accept_edits" ? "auto-accept edits" : permMode.id === "auto" ? "auto-approve" : "plan mode"} on`,
                    permColor: permMode.color,
                    onCyclePerm: () => setPermModeIdx((i) => { const next = (i + 1) % PERMISSION_MODES.length; const s = useSettingsStore.getState(); if (!s.claudeDefaultPermMode) s.set({ claudePermMode: PERMISSION_MODES[next]!.id }); return next; }),
                  } : (() => {
                    const list = PROVIDER_CONFIG.openai.permissions;
                    const current = list.find((p) => p.id === selectedCodexPermission) ?? list[0]!;
                    return {
                      permLabel: `${current.label.toLowerCase()} sandbox`,
                      permColor: current.color,
                      onCyclePerm: cycleCodexPermission,
                    };
                  })())}
                  {...(session.name ? { sessionName: session.name } : {})}
                  cwd={effectiveCwd}
                  queueCount={session.promptQueue.length}
                  draftPrompt={session.draftPrompt}
                  onDraftChange={(t) => setDraftPrompt(sessionId, t)}
                  onPasteImage={handlePasteImage}
                  contextPct={session.contextMax > 0 ? Math.min(100, Math.max(0, Math.round((session.contextUsed / session.contextMax) * 100))) : 0}
                  autoCompactAt={autoCompactEnabled ? autoCompactThreshold : 0}
                  {...(isActive ? { onRegisterVoiceActions: handleRegisterVoiceActions } : {})}
                  sessionId={sessionId}
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

      {rewindPrompt && (
        <RewindPromptDialog
          affectedFiles={rewindPrompt.affectedFiles}
          toolSummary={buildToolSummary(rewindPrompt.messageId)}
          onConfirm={(revertCode) => {
            const { messageId, content } = rewindPrompt;
            setRewindPrompt(null);
            handleRewind(messageId, content, revertCode);
          }}
          onCancel={() => setRewindPrompt(null)}
        />
      )}

    </div>
  );
}
