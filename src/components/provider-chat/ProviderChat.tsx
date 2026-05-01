import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  queuedPromptDisplayText,
  queuedPromptProviderPrompt,
  getProviderPermissionId,
  getProviderSessionRuntimeMetadata,
  getProviderSelectedControlValues,
  resolveSessionProviderState,
  selectSessionProvider,
  useProviderSessionStore,
  type ProviderControlValueMap,
  type ProviderSession,
  type QueuedPromptCommandMetadata,
  type QueuedPromptInput,
} from "../../stores/providerSessionStore";
import { useShallow } from "zustand/react/shallow";
import {
  getDefaultAvailableProvider,
  isProviderAvailable,
  useSettingsStore,
} from "../../stores/settingsStore";
import { listSlashCommands, resolvePermission, readFile, writeFile, listMcpServers, restoreCheckpoint, cleanupCheckpoints, deleteFiles, shellExec, filterUntrackedFiles, setT64DelegationEnv, getDelegationPort, getDelegationSecret, getAppDir, createMcpConfigFile, resolveSkillPrompt } from "../../lib/tauriApi";
import type { SlashCommand, PermissionMode, McpServer, HookEvent } from "../../lib/types";
import {
  getProviderControl,
  isProviderControlValue,
  listProviderControls,
  providerSupports,
  type ProviderControlId,
  type ProviderControlMetadata,
  type ProviderControlValue,
  type ProviderId,
} from "../../lib/providers";
import {
  buildDelegationPlanRequest,
  parseDelegateCommand,
  parseDelegationStartFromMessage,
} from "../../lib/delegationWorkflow";
import { subscribeProviderDelegationRequests } from "../../lib/providerEventSemantics";
import { rewritePromptStream } from "../../lib/ai";
import { toolHeader } from "./toolPresentation";
import FileTree from "./FileTree";
import { fontStack } from "../../lib/fonts";
import { CLAUDE_BUILTIN_COMMANDS } from "../../lib/claudeSlashCommands";
import ChatInput from "./ChatInput";
import ProviderControls, { buildProviderPermissionInputProps } from "./ProviderControls";
import ChatEditOverlay, { useChatEditOverlay } from "./ChatEditOverlay";
import ChatMessageList from "./ChatMessageList";
import { findPromptVisualRowIndex, useChatRows } from "./useChatRows";
import { PlanFinishedActions, PlanViewer } from "./PlanViewer";
import { parseCodexPlanCommand, useChatPlanMode } from "./useChatPlanMode";
import { registerChatInputVoiceActions, unregisterChatInputVoiceActions, useVoiceStore, type ChatInputVoiceActions } from "../../stores/voiceStore";
import { useDelegationStore } from "../../stores/delegationStore";
import { endDelegation } from "../../hooks/useDelegationOrchestrator";
import { useChatSend } from "../../hooks/useChatSend";
import { useChatFork } from "../../hooks/useChatFork";
import { useChatRewind } from "../../hooks/useChatRewind";
import { useDelegationSpawn } from "../../hooks/useDelegationSpawn";
import { useChatAttachments } from "../../hooks/useChatAttachments";
import { useProviderPermissionControls } from "../../hooks/useProviderPermissionControls";
import { useCanvasStore } from "../../stores/canvasStore";
import { v4 as uuidv4 } from "uuid";
import { baseName, dirName } from "../../lib/platform";
import "./ProviderChat.css";
import "../ui/DropdownMenu.css";
import { cancelProviderSession, closeProviderSession, providerHistorySupports, runProviderTurn } from "../../lib/providerRuntime";
import type { ProviderTurnInput, ProviderTurnResult } from "../../contracts/providerRuntime";

// Provider lookup. `provider` is non-optional on ProviderSession but the
// fallback covers the brief window between mount and createSession.
function sessionProviderFor(sessionId: string): ProviderId {
  return selectSessionProvider(sessionId);
}

type ProviderChatSessionView = Omit<ProviderSession, "streamingText">;
type HandleSendOptions = {
  fromDiscord?: boolean;
  codexCollaborationMode?: "plan" | "default";
};
const EMPTY_PROVIDER_CONTROL_VALUES: ProviderControlValueMap = Object.freeze({});
const EMPTY_HOOK_EVENTS: HookEvent[] = [];
const EMPTY_TOOL_USAGE_STATS: Record<string, number> = Object.freeze({});

function canPickProviderBeforeStart(session: ProviderChatSessionView, hasStreamingText: boolean): boolean {
  const providerState = resolveSessionProviderState(session);
  const resumeId = getProviderSessionRuntimeMetadata(providerState, providerState.provider)?.resume.id ?? null;
  return session.providerLocked === false
    && !hasStreamingText
    && !session.hasBeenStarted
    && session.promptCount === 0
    && session.messages.length === 0
    && session.promptQueue.length === 0
    && !session.isStreaming
    && !session.pendingPermission
    && !session.pendingQuestions
    && !providerState.seedTranscript
    && !session.resumeAtUuid
    && !session.forkParentSessionId
    && !resumeId;
}

function legacySettingsDefaultForControl(
  provider: ProviderId,
  control: ProviderControlMetadata,
  globalModel: string,
  globalEffort: string,
): string | null {
  if (control.legacySlot === "model" && isProviderControlValue(provider, control.id, globalModel)) {
    return globalModel;
  }
  if (control.legacySlot === "effort" && isProviderControlValue(provider, control.id, globalEffort)) {
    return globalEffort;
  }
  return null;
}

function selectedControlValuesForUi({
  provider,
  persisted,
  settingsDefaults,
  globalModel,
  globalEffort,
}: {
  provider: ProviderId;
  persisted: ProviderControlValueMap;
  settingsDefaults: Record<string, ProviderControlValue> | undefined;
  globalModel: string;
  globalEffort: string;
}): ProviderControlValueMap {
  const values: ProviderControlValueMap = {};
  for (const control of listProviderControls(provider)) {
    const persistedValue = persisted[control.id];
    const settingsValue = settingsDefaults?.[control.id];
    values[control.id] =
      (persistedValue !== null && isProviderControlValue(provider, control.id, persistedValue) ? persistedValue : null)
      ?? (settingsValue !== null && isProviderControlValue(provider, control.id, settingsValue) ? settingsValue : null)
      ?? legacySettingsDefaultForControl(provider, control, globalModel, globalEffort)
      ?? control.defaultValue;
  }
  return values;
}

async function cancelByProvider(sessionId: string, provider: ProviderId): Promise<void> {
  return cancelProviderSession(sessionId, provider);
}

function queuedCommandMetadataForText(
  text: string,
  supportsCompact: boolean,
  isCodexPlan: boolean,
): QueuedPromptCommandMetadata {
  if (isCodexPlan) {
    return { kind: "codex-plan", name: "plan", originalText: text };
  }

  const slashMatch = text.match(/^\/([a-zA-Z0-9_:.-]+)/);
  if (slashMatch) {
    const name = slashMatch[1]!;
    return {
      kind: supportsCompact && name.toLowerCase() === "compact" ? "compact" : "slash",
      name,
      originalText: text,
    };
  }

  return { kind: "plain", originalText: text };
}

function replayQueuedCommandMetadata(sessionId: string, item: { command?: QueuedPromptCommandMetadata | undefined }) {
  if (item.command?.kind === "compact") {
    useProviderSessionStore.getState().setAutoCompactStatus(sessionId, "compacting");
  }
}

async function closeByProvider(sessionId: string, provider: ProviderId): Promise<void> {
  return closeProviderSession(sessionId, provider);
}

function providerTurnForSession({
  sessionId,
  session,
  cwd,
  prompt,
  permissionMode,
  selectedControls,
  disallowedTools,
}: {
  sessionId: string;
  session: ProviderSession;
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  selectedControls?: ProviderControlValueMap;
  disallowedTools?: string;
}): ProviderTurnInput {
  const providerState = resolveSessionProviderState(session);
  const controlValues = selectedControls ?? getProviderSelectedControlValues(providerState, providerState.provider);
  const providerOptions = providerState.provider === "anthropic" && disallowedTools !== undefined
    ? { anthropic: { disallowedTools } }
    : undefined;
  const input: ProviderTurnInput = {
    provider: providerState.provider,
    sessionId,
    cwd,
    prompt,
    started: session.hasBeenStarted,
    runtimeMetadata: getProviderSessionRuntimeMetadata(providerState, providerState.provider),
    selectedControls: controlValues,
    providerPermissionId: getProviderPermissionId(providerState, providerState.provider),
    permissionMode,
    skipOpenwolf: session.skipOpenwolf,
    seedTranscript: providerState.seedTranscript,
    resumeAtUuid: session.resumeAtUuid ?? null,
    forkParentSessionId: session.forkParentSessionId ?? null,
    ...(providerOptions ? { providerOptions } : {}),
  };
  return input;
}

function applyProviderTurnResult(sessionId: string, result: ProviderTurnResult) {
  const store = useProviderSessionStore.getState();
  if (result.clearSeedTranscript) store.clearSeedTranscript(sessionId);
  if (result.clearResumeAtUuid) store.setResumeAtUuid(sessionId, null);
  if (result.clearForkParentSessionId) store.setForkParentSessionId(sessionId, null);
}

const REWIND_ACTION_META: Record<string, { label: string; color: string }> = {
  M: { label: "M", color: "#f9e2af" },
  A: { label: "A", color: "#a6e3a1" },
  D: { label: "D", color: "#f38ba8" },
  U: { label: "U", color: "#89b4fa" },
};
const REWIND_ACTION_FALLBACK = { label: "?", color: "#89b4fa" };

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

/** Chat body footer. Lives below the last virtualized item and renders the
 *  streaming bubble + pending-question prompt + error bar + bottom spacer.
 *  Extracted from ProviderChat's render so its identity is stable across
 *  parent re-renders (the list otherwise re-measures its footer on every
 *  keystroke, which is the main source of scroll jitter during streaming).
 *  Subscribes only to the fine-grained store slices it actually needs. */
function ChatFooter({
  sessionId,
  effectiveCwd,
  permissionMode,
  selectedControls,
}: {
  sessionId: string;
  effectiveCwd: string;
  permissionMode: PermissionMode;
  selectedControls: ProviderControlValueMap;
}) {
  const pendingQuestions = useProviderSessionStore((s) => s.sessions[sessionId]?.pendingQuestions ?? null);
  const error = useProviderSessionStore((s) => s.sessions[sessionId]?.error ?? null);
  const current = pendingQuestions?.items[pendingQuestions.currentIndex];
  const progress =
    pendingQuestions && pendingQuestions.items.length > 1
      ? `(${pendingQuestions.currentIndex + 1}/${pendingQuestions.items.length})`
      : "";

  const submitAnswer = (answer: string) => {
    if (!pendingQuestions) return;
    const store = useProviderSessionStore.getState();
    store.answerQuestion(sessionId, answer);
    const updated = useProviderSessionStore.getState().sessions[sessionId];
    if (!updated?.pendingQuestions) {
      const allAnswers = [...pendingQuestions.answers, answer];
      const formatted = pendingQuestions.items
        .map((item, idx) => `${item.header || item.question}: ${allAnswers[idx]}`)
        .join("\n");
      store.updateToolResult(sessionId, pendingQuestions.toolUseId, formatted, false);
      store.addUserMessage(sessionId, `Answered questions:\n${formatted}`);
      const followupPrompt = `Here are my answers to your questions:\n${formatted}\n\nProceed based on these choices. Do not ask the same questions again.`;
      const currentSession = useProviderSessionStore.getState().sessions[sessionId];
      if (!currentSession) return;
      runProviderTurn(providerTurnForSession({
        sessionId,
        session: currentSession,
        cwd: effectiveCwd,
        prompt: followupPrompt,
        permissionMode,
        selectedControls,
        disallowedTools: "AskUserQuestion",
      }))
        .then((result) => {
          applyProviderTurnResult(sessionId, result);
          store.incrementPromptCount(sessionId);
        })
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

import { pushToast } from "../../lib/notifications";

export interface ProviderChatProps {
  sessionId: string;
  cwd: string;
  skipPermissions: boolean;
  isActive: boolean;
}

export function ProviderChat({ sessionId, cwd, skipPermissions, isActive }: ProviderChatProps) {
  // Shallow-compare selector that EXCLUDES streamingText — the streaming
  // bubble has its own fine-grained subscription, so we don't need to
  // re-render the whole ProviderChat tree (ChatInput, toolbar, Virtuoso props)
  // on every streamed token. With streamingText excluded, ProviderChat only
  // re-renders when the session gets a *new* message, changes status,
  // pending-questions, error, draftPrompt, etc — not on per-token ticks.
  const session = useProviderSessionStore(
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
  const hasStreamingText = useProviderSessionStore((s) => Boolean(s.sessions[sessionId]?.streamingText));
  const createSession = useProviderSessionStore((s) => s.createSession);
  const addUserMessage = useProviderSessionStore((s) => s.addUserMessage);
  const incrementPromptCount = useProviderSessionStore((s) => s.incrementPromptCount);
  const setDraftPrompt = useProviderSessionStore((s) => s.setDraftPrompt);
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
  // Provider dropdown — mirrors the session's persisted provider. Mid-session
  // switching is blocked with a toast; the choice is made up front via
  // ProviderSessionDialog and locked for the lifetime of the session.
  const selectedProvider = useProviderSessionStore((s) => resolveSessionProviderState(s.sessions[sessionId]).provider);
  const supportsCompact = providerSupports(selectedProvider, "compact");
  const supportsHistoryFork = providerHistorySupports(selectedProvider, "fork");
  const supportsHistoryRewind = providerHistorySupports(selectedProvider, "rewind");
  const planBuildCodexMode = selectedProvider === "openai"
    ? ({ codexCollaborationMode: "default" } as const)
    : undefined;
  const liveMcp = useProviderSessionStore((s) => s.sessions[sessionId]?.mcpServers);
  const [showFileTree, setShowFileTree] = useState(false);
  // Provider-declared control values are persisted per session. Settings keep
  // provider-owned defaults for the next new session, with legacy Claude model
  // and effort settings only used as migration fallbacks.
  const persistedControlValues = useProviderSessionStore((s) => {
    const sessionControls = s.sessions[sessionId]?.providerState?.selectedControls[selectedProvider]
      ?? s.sessions[sessionId]?.selectedControls?.[selectedProvider];
    return sessionControls ?? EMPTY_PROVIDER_CONTROL_VALUES;
  });
  const providerControlDefaults = useSettingsStore((s) => s.providerControlDefaults);
  const globalModel = useSettingsStore((s) => s.claudeModel);
  const globalEffort = useSettingsStore((s) => s.claudeEffort);
  const selectedControlValues = useMemo(
    () => selectedControlValuesForUi({
      provider: selectedProvider,
      persisted: persistedControlValues,
      settingsDefaults: providerControlDefaults[selectedProvider],
      globalModel,
      globalEffort,
    }),
    [globalEffort, globalModel, persistedControlValues, providerControlDefaults, selectedProvider],
  );
  const handleSelectControl = useCallback((controlId: ProviderControlId, value: ProviderControlValue) => {
    const control = getProviderControl(selectedProvider, controlId);
    if (!control || !isProviderControlValue(selectedProvider, controlId, value)) return;
    useProviderSessionStore.getState().setProviderControl(sessionId, selectedProvider, controlId, value);
    const nextDefaults = {
      ...useSettingsStore.getState().providerControlDefaults,
      [selectedProvider]: {
        ...(useSettingsStore.getState().providerControlDefaults[selectedProvider] ?? {}),
        [controlId]: value,
      },
    };
    const legacyPatch: { claudeModel?: string; claudeEffort?: string } = {};
    if (typeof value === "string" && control.legacySlot === "model") legacyPatch.claudeModel = value;
    if (typeof value === "string" && control.legacySlot === "effort") legacyPatch.claudeEffort = value;
    useSettingsStore.getState().set({ providerControlDefaults: nextDefaults, ...legacyPatch });
  }, [selectedProvider, sessionId]);
  const handleSelectPreStartProvider = useCallback((provider: ProviderId) => {
    if (provider === selectedProvider) return;
    if (!isProviderAvailable(provider, useSettingsStore.getState().providerAvailability)) return;
    useProviderSessionStore.getState().switchProviderBeforeStart(sessionId, provider);
  }, [selectedProvider, sessionId]);
  const {
    permissionId: selectedProviderPermissionId,
    permissionMode,
    cyclePermission,
    selectPermissionId,
  } = useProviderPermissionControls({
    sessionId,
    provider: selectedProvider,
    skipPermissions,
  });
  // Resolve CWD: use prop, fall back to stored session CWD
  const effectiveCwd = (cwd && cwd !== ".") ? cwd : (session?.cwd || ".");
  const autoCompactEnabled = useSettingsStore((s) => s.autoCompactEnabled);
  const autoCompactThreshold = useSettingsStore((s) => s.autoCompactThreshold);
  const {
    attachedFiles,
    filePreviews,
    isDragOver,
    handleAttach,
    handlePasteImage,
    removeAttachedFile,
    consumeAttachments,
  } = useChatAttachments({ sessionId, isActive });
  const {
    planContent,
    planFinished,
    showPlanViewer,
    hasPlan,
    clearPlanContent,
    resetPlan,
    togglePlanViewer,
  } = useChatPlanMode({
    sessionId,
    session,
    provider: selectedProvider,
    onPermissionModeChange: selectPermissionId,
  });
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [isRewriting, setIsRewriting] = useState(false);
  const [rewindText, setRewindText] = useState<string | null>(null);
  const [rewindPrompt, setRewindPrompt] = useState<{ messageId: string; content: string; affectedFiles: AffectedFile[] } | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const {
    editOverlay,
    openEditOverlay,
    openFileOverlay,
    rememberContent: rememberEditOverlayContent,
    closeEditOverlay,
  } = useChatEditOverlay({
    effectiveCwd,
    getScrollEl,
    readFileContent: readFile,
  });
  const [showHookLog, setShowHookLog] = useState(false);
  const panelColor = useCanvasStore((s) => s.terminals.find((t) => t.terminalId === sessionId)?.borderColor);
  const hookEventLog = useProviderSessionStore((s) => s.sessions[sessionId]?.hookEventLog ?? EMPTY_HOOK_EVENTS);
  const toolUsageStats = useProviderSessionStore((s) => s.sessions[sessionId]?.toolUsageStats ?? EMPTY_TOOL_USAGE_STATS);
  const compactionCount = useProviderSessionStore((s) => s.sessions[sessionId]?.compactionCount ?? 0);
  const totalToolCalls = useMemo(() => Object.values(toolUsageStats).reduce((a, b) => a + b, 0), [toolUsageStats]);
  const providerAvailability = useSettingsStore((s) => s.providerAvailability);
  const defaultAvailableProvider = getDefaultAvailableProvider(providerAvailability);

  useEffect(() => {
    // Passing cwd to createSession lets the store kick off JSONL hydration
    // immediately instead of waiting for a later setCwd call.
    const effectiveInitCwd = cwd && cwd !== "." ? cwd : undefined;
    createSession(sessionId, undefined, false, undefined, effectiveInitCwd, defaultAvailableProvider, false);
    if (effectiveInitCwd) {
      useProviderSessionStore.getState().setCwd(sessionId, effectiveInitCwd);
    }
  }, [sessionId, createSession, cwd, defaultAvailableProvider]);

  useEffect(() => {
    if (!session || !canPickProviderBeforeStart(session, hasStreamingText)) return;
    if (isProviderAvailable(selectedProvider, providerAvailability)) return;
    useProviderSessionStore.getState().switchProviderBeforeStart(sessionId, defaultAvailableProvider);
  }, [defaultAvailableProvider, hasStreamingText, providerAvailability, selectedProvider, session, sessionId]);

  // Stamp missing controls with the defaults this session rendered with. That
  // makes already-open unnamed sessions independent when another session later
  // updates the Settings defaults from its topbar.
  useEffect(() => {
    const currentSession = useProviderSessionStore.getState().sessions[sessionId];
    const sessionControls = currentSession?.providerState?.selectedControls[selectedProvider]
      ?? currentSession?.selectedControls?.[selectedProvider]
      ?? EMPTY_PROVIDER_CONTROL_VALUES;
    const settings = useSettingsStore.getState();
    const seedValues = selectedControlValuesForUi({
      provider: selectedProvider,
      persisted: sessionControls,
      settingsDefaults: settings.providerControlDefaults[selectedProvider],
      globalModel: settings.claudeModel,
      globalEffort: settings.claudeEffort,
    });
    for (const control of listProviderControls(selectedProvider)) {
      const persistedValue = sessionControls[control.id];
      if (isProviderControlValue(selectedProvider, control.id, persistedValue)) continue;
      const seedValue = seedValues[control.id];
      const nextValue = isProviderControlValue(selectedProvider, control.id, seedValue)
        ? seedValue
        : control.defaultValue;
      if (isProviderControlValue(selectedProvider, control.id, nextValue)) {
        useProviderSessionStore.getState().setProviderControl(
          sessionId,
          selectedProvider,
          control.id,
          nextValue,
        );
      }
    }
    // Only re-evaluate on session/provider change — selected controls are
    // user-driven and shouldn't bounce back to defaults every time they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider, sessionId]);
  const t64Commands = useRef<SlashCommand[]>([
    { name: "loop", description: "Run a prompt on a loop (e.g. /loop 5m improve the code)", usage: "/loop [interval] <prompt> — default 10m. /loop stop to cancel.", source: "Terminal 64" },
    { name: "delegate", description: "Split work into parallel sub-sessions", usage: "/delegate <prompt> — Plans the task split, spawns agents with MCP team chat.", source: "Terminal 64" },
    { name: "reload-plugins", description: "Reload slash commands, skills, and MCP servers", usage: "/reload-plugins — re-fetches all available commands and MCP configs.", source: "Terminal 64" },
  ]);
  const reloadCommands = useCallback(() => {
    const addClaudeBuiltins = providerSupports(selectedProvider, "nativeSlashCommands");
    const applyCommands = (cmds: SlashCommand[]) => {
      const providerCommands = addClaudeBuiltins
        ? cmds
        : cmds.filter((cmd) => cmd.source !== "built-in" && cmd.source !== "builtin");
      const merged = [...t64Commands.current, ...providerCommands];
      const seen = new Set(merged.map((c) => c.name));
      if (addClaudeBuiltins) {
        for (const bc of CLAUDE_BUILTIN_COMMANDS) {
          if (!seen.has(bc.name)) merged.push(bc);
        }
      }
      setSlashCommands(merged);
    };
    listSlashCommands().then(applyCommands).catch(() => applyCommands([]));
    if (providerSupports(selectedProvider, "mcp")) {
      listMcpServers(cwd).then(setConfigMcpServers).catch(() => {});
    } else {
      setConfigMcpServers([]);
    }
  }, [cwd, selectedProvider]);
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

  // Shift+Tab cycles the active provider's manifest-owned permission preset.
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        cyclePermission();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cyclePermission, isActive]);

  // Auto-drain queue: when streaming stops, send next queued prompt
  const prevStreaming = useRef(false);
  useEffect(() => {
    const wasStreaming = prevStreaming.current;
    const nowStreaming = session?.isStreaming ?? false;
    prevStreaming.current = nowStreaming;
    if (wasStreaming && !nowStreaming) {
      // Streaming just ended — check queue first
      const next = useProviderSessionStore.getState().dequeuePrompt(sessionId);
      if (next) {
        const displayText = queuedPromptDisplayText(next);
        const providerPrompt = queuedPromptProviderPrompt(next);
        replayQueuedCommandMetadata(sessionId, next);
        addUserMessage(sessionId, displayText);
        emit("gui-message", { session_id: sessionId, content: displayText }).catch(() => {});
        if (next.command?.kind === "delegate-plan") {
          delegateRequested.current = true;
        }
        if (next.command?.kind === "loop") {
          useProviderSessionStore.getState().tickLoop(sessionId);
        }
        setTimeout(() => {
          const opts = next.codexCollaborationMode !== undefined
            ? { codexCollaborationMode: next.codexCollaborationMode }
            : undefined;
          actualSend(providerPrompt, next.permissionOverride, opts)
            .then(() => {
              if (next.command?.kind === "reload") {
                setTimeout(reloadCommands, 3000);
              }
            })
            .catch((err) => useProviderSessionStore.getState().setError(sessionId, String(err)));
        }, 500);
        return;
      }
      // No queue — check loop timer
      const s = useProviderSessionStore.getState().sessions[sessionId];
      if (s?.activeLoop) {
        const { prompt: loopPrompt, intervalMs, lastFiredAt } = s.activeLoop;
        const elapsed = lastFiredAt ? Date.now() - lastFiredAt : Infinity;
        const delay = Math.max(0, intervalMs - elapsed);
        loopTimerRef.current = window.setTimeout(() => {
          const curr = useProviderSessionStore.getState().sessions[sessionId];
          if (!curr?.activeLoop || curr.isStreaming) return; // loop cancelled or session busy
          addUserMessage(sessionId, loopPrompt);
          emit("gui-message", { session_id: sessionId, content: loopPrompt }).catch(() => {});
          useProviderSessionStore.getState().tickLoop(sessionId);
          actualSend(loopPrompt).catch((err) => useProviderSessionStore.getState().setError(sessionId, String(err)));
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
  const handleSendRef = useRef<((text: string, permissionOverride?: PermissionMode, opts?: HandleSendOptions) => Promise<void>) | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; username: string; prompt: string }>(
      "discord-prompt",
      (event) => {
        if (event.payload.session_id !== sessionId) return;
        const { username, prompt } = event.payload;
        const displayText = `[${username}]: ${prompt}`;
        if (handleSendRef.current) {
          handleSendRef.current(displayText, undefined, { fromDiscord: true }).catch((err) =>
            useProviderSessionStore.getState().setError(sessionId, String(err))
          );
        }
      }
    ).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [sessionId]);

  const actualSend = useChatSend({
    sessionId,
    effectiveCwd,
    permissionMode,
    selectedControls: selectedControlValues,
    selectedProviderPermissionId,
    incrementPromptCount,
  });
  const rewindHistory = useChatRewind();

  const handleSend = useCallback(
    async (text: string, permissionOverride?: PermissionMode, opts?: HandleSendOptions) => {
      const fromDiscord = opts?.fromDiscord ?? false;
      // Re-arm sticky so the user sees their own message + response.
      // MutationObserver will catch the DOM growth and do the actual
      // scroll after the new message is appended.
      stickyRef.current = true;

      const loopMatch = text.match(/^\/loop\s*(.*)/i);
      if (loopMatch) {
        const args = loopMatch[1]!.trim();
        if (!args || args === "stop" || args === "cancel" || args === "off") {
          useProviderSessionStore.getState().setLoop(sessionId, null);
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
        useProviderSessionStore.getState().setLoop(sessionId, {
          prompt: loopPrompt,
          intervalMs,
          lastFiredAt: null,
          iteration: 0,
        });
        if (useProviderSessionStore.getState().sessions[sessionId]?.isStreaming) {
          useProviderSessionStore.getState().enqueuePrompt(sessionId, {
            displayText: loopPrompt,
            providerPrompt: loopPrompt,
            ...(permissionOverride !== undefined ? { permissionOverride } : {}),
            command: { kind: "loop", originalText: loopPrompt },
          });
          setQueueExpanded(true);
          return;
        }
        // Fire the first iteration immediately
        addUserMessage(sessionId, loopPrompt);
        if (!fromDiscord) emit("gui-message", { session_id: sessionId, content: loopPrompt }).catch(() => {});
        useProviderSessionStore.getState().tickLoop(sessionId);
        await actualSend(loopPrompt, permissionOverride);
        return;
      }

      if (/^\/reload-plugins\b/i.test(text)) {
        if (useProviderSessionStore.getState().sessions[sessionId]?.isStreaming) {
          useProviderSessionStore.getState().enqueuePrompt(sessionId, {
            displayText: text,
            providerPrompt: text,
            ...(permissionOverride !== undefined ? { permissionOverride } : {}),
            command: { kind: "reload", name: "reload-plugins", originalText: text },
          });
          setQueueExpanded(true);
          return;
        }
        reloadCommands();
        addUserMessage(sessionId, text);
        await actualSend(text, permissionOverride);
        // Re-fetch after CLI has had time to reload
        setTimeout(reloadCommands, 3000);
        return;
      }

      const delegateGoal = parseDelegateCommand(text);
      if (delegateGoal) {
        const delegationPlan = buildDelegationPlanRequest({
          provider: selectedProvider,
          userGoal: delegateGoal,
          permissionOverride,
        });
        if (useProviderSessionStore.getState().sessions[sessionId]?.isStreaming) {
          useProviderSessionStore.getState().enqueuePrompt(sessionId, {
            displayText: delegationPlan.displayText,
            providerPrompt: delegationPlan.providerPrompt,
            ...(delegationPlan.permissionOverride !== undefined ? { permissionOverride: delegationPlan.permissionOverride } : {}),
            command: delegationPlan.command,
          });
          setQueueExpanded(true);
          return;
        }
        delegateRequested.current = true;
        addUserMessage(sessionId, delegationPlan.displayText);
        await actualSend(delegationPlan.providerPrompt, delegationPlan.permissionOverride);
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
            if (useProviderSessionStore.getState().sessions[sessionId]?.isStreaming) {
              useProviderSessionStore.getState().enqueuePrompt(sessionId, {
                displayText: text,
                providerPrompt: injectedPrompt,
                ...(permissionOverride !== undefined ? { permissionOverride } : {}),
                command: { kind: "skill", name: resolved.name, originalText: text },
              });
              setQueueExpanded(true);
              return;
            }
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
        resetPlan();
      }

      let prompt = text;
      let displayPrompt = text;
      let codexCollaborationMode = opts?.codexCollaborationMode;
      const codexPlan = parseCodexPlanCommand(text, selectedProvider);
      if (codexPlan) {
        codexCollaborationMode = codexPlan.collaborationMode;
        prompt = codexPlan.prompt;
      }
      const consumed = consumeAttachments(prompt, displayPrompt);
      prompt = consumed.prompt;
      displayPrompt = consumed.displayPrompt;

      const isCurrentlyStreaming = useProviderSessionStore.getState().sessions[sessionId]?.isStreaming;
      if (isCurrentlyStreaming) {
        // Queue the prompt instead of sending mid-thinking
        const queuedPrompt: QueuedPromptInput = {
          displayText: displayPrompt,
          providerPrompt: prompt,
          command: queuedCommandMetadataForText(text, supportsCompact, !!codexPlan),
          ...(permissionOverride !== undefined ? { permissionOverride } : {}),
          ...(codexCollaborationMode !== undefined ? { codexCollaborationMode } : {}),
          ...(consumed.attachmentState !== undefined ? { attachmentState: consumed.attachmentState } : {}),
        };
        useProviderSessionStore.getState().enqueuePrompt(sessionId, queuedPrompt);
        setQueueExpanded(true);
        return;
      }

      if (supportsCompact && /^\/compact\b/i.test(prompt)) {
        useProviderSessionStore.getState().setAutoCompactStatus(sessionId, "compacting");
      }

      addUserMessage(sessionId, displayPrompt);
      if (!fromDiscord) emit("gui-message", { session_id: sessionId, content: displayPrompt }).catch(() => {});
      await actualSend(prompt, permissionOverride, codexCollaborationMode ? { codexCollaborationMode } : undefined);
    },
    [sessionId, consumeAttachments, addUserMessage, actualSend, reloadCommands, slashCommands, effectiveCwd, planFinished, planContent, resetPlan, selectedProvider, supportsCompact]
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
      useProviderSessionStore.getState().setError(sessionId, `Rewrite failed: ${err}`);
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
    const sess = useProviderSessionStore.getState().sessions[sessionId];
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
    const sess = useProviderSessionStore.getState().sessions[sessionId];
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

    const preStore = useProviderSessionStore.getState();
    const preSess = preStore.sessions[sessionId];
    const preMsgs = preSess?.messages ?? [];

    // Detect "undo send": rewinding to the last user message with no assistant
    // response after it. The provider never modified files, so skip file
    // operations and just remove the message + prefill input.
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
      const store = useProviderSessionStore.getState();
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
        useProviderSessionStore.getState().setError(sessionId, `Rewind failed: ${err}`);
        return;
      }
      // Mutate the store immediately so the UI reflects the undo-send after
      // the on-disk JSONL has been truncated.
      useProviderSessionStore.getState().truncateFromMessage(sessionId, messageId);
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

    const store = useProviderSessionStore.getState();
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
        useProviderSessionStore.getState().setError(sessionId, `Rewind failed: ${err}`);
        return;
      }

      // Disk is now authoritative — mirror the truncation into the store
      // immediately so the UI reflects the rewind.
      store.truncateFromMessage(sessionId, messageId);
      if (trailingUser) {
        store.truncateFromMessage(sessionId, trailingUser.id);
        console.log("[rewind] Removed trailing user message, prefilling:", rewindContent.slice(0, 80));
      }
      const sess = preSess;

      // The JSONL has already been physically truncated, so the next send uses
      // normal session resume. Passing --resume-session-at here is fragile after
      // rewriting the file because the provider's internal index can reject the
      // kept UUID even though the truncated history reloads correctly.
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
        const providerSessionState = useProviderSessionStore.getState();
        for (const group of parentGroups) {
          for (const task of group.tasks) {
            if (task.sessionId) {
              const childSess = providerSessionState.sessions[task.sessionId];
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

        // Delete files that were created by the provider (not in git) and
        // weren't restored from checkpoint.
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
        finalMessageCount: useProviderSessionStore.getState().sessions[sessionId]?.messages.length,
        rewindContent: rewindContent?.slice(0, 80),
      });
    }
  }, [sessionId, effectiveCwd, rewindHistory]);

  const handleFork = useChatFork({ sessionId, effectiveCwd });
  const handleEditClick = openEditOverlay;
  const handleFileTreeOpen = openFileOverlay;

  const hasTasks = (session?.tasks.length ?? 0) > 0;
  const hasSideContent = hasPlan || hasTasks;

  const spawnDelegation = useDelegationSpawn({
    sessionId,
    effectiveCwd,
    selectedProvider,
    permissionMode,
    selectedControls: selectedControlValues,
    selectedProviderPermissionId,
    addUserMessage,
  });

  // Detect delegation blocks in assistant messages and auto-spawn (only when /delegate was used)
  const delegateRequested = useRef(false);
  const lastDelegationParsed = useRef<string | null>(null);
  useEffect(() => {
    return subscribeProviderDelegationRequests((event) => {
      if (event.sessionId !== sessionId || !delegateRequested.current) return;
      const eventKey = event.toolId ?? `${event.source}:${event.request.tasks.map((task) => task.description).join("|")}`;
      if (lastDelegationParsed.current === eventKey) return;
      lastDelegationParsed.current = eventKey;
      delegateRequested.current = false;
      spawnDelegation(event.request.tasks, event.request.context);
    });
  }, [sessionId, spawnDelegation]);

  // Compatibility fallback for already-finalized assistant messages and older
  // providers that do not pass through the semantic event projection.
  useEffect(() => {
    if (!session || !delegateRequested.current) return;
    const msgs = session.messages;
    const last = [...msgs].reverse().find((m) => m.role === "assistant");
    if (!last || last.id === lastDelegationParsed.current) return;
    const parsed = parseDelegationStartFromMessage(last);
    if (!parsed) return;
    lastDelegationParsed.current = last.id;
    delegateRequested.current = false;
    spawnDelegation(parsed.tasks, parsed.context);
  }, [session?.messages, spawnDelegation]);

  const activeTasks = useMemo(() => session?.tasks?.filter(t => t.status !== "deleted") ?? [], [session?.tasks]);
  const completedTasks = useMemo(() => activeTasks.filter(t => t.status === "completed"), [activeTasks]);
  const { visualRows, visualLayoutSignature, userPrompts } = useChatRows(session, hasStreamingText, supportsCompact);

  // Auto-open side panel when content appears (must be before any early return)
  useEffect(() => {
    if (hasSideContent && !sidePanelOpen) setSidePanelOpen(true);
  }, [hasSideContent]);

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
  }, [sessionId, visualLayoutSignature, isRawNearBottom]);
  const legendFooter = useMemo(
    () => (
      <>
        <ChatFooter
          sessionId={sessionId}
          effectiveCwd={effectiveCwd}
          permissionMode={permissionMode}
          selectedControls={selectedControlValues}
        />
        {/* 50px breathing room below last row — equivalent of t3code's
            ListFooterComponent={<div className="h-3 sm:h-4" />}. Kept
            generous since the panel height varies with canvas zoom. */}
        <div style={{ height: 50 }} aria-hidden="true" />
      </>
    ),
    [sessionId, effectiveCwd, permissionMode, selectedControlValues],
  );

  const jumpToPrompt = useCallback(
    (msgId: string) => {
      // Find the visual row index for this message. LegendList scrolls by row,
      // not by message id — the row kinds are a superset of messages.
      const rowIdx = findPromptVisualRowIndex(visualRows, msgId);
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
  const providerPickerUnlocked = !hasMessages && canPickProviderBeforeStart(session, hasStreamingText);
  const providerPermissionInputProps = buildProviderPermissionInputProps({
    provider: selectedProvider,
    permissionId: selectedProviderPermissionId,
    onCyclePermission: cyclePermission,
  });

  return (
    <div
      className={`cc-container ${isDragOver ? "cc-container--dragover" : ""}`}
      ref={containerRef}
      data-session-id={sessionId}
    >
      {/* Topbar */}
      <div className="cc-topbar">
        <button className={`cc-filetree-toggle ${showFileTree ? "cc-filetree-toggle--open" : ""}`} onClick={() => setShowFileTree((v) => !v)} title="Toggle file browser">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1L7 5L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <div className="cc-topbar-center">
          <ProviderControls
            configuredMcpServers={configMcpServers}
            liveMcpServers={liveMcp}
            provider={selectedProvider}
            selectedControls={selectedControlValues}
            onSelectControl={handleSelectControl}
            onMcpOpen={() => {
              if (effectiveCwd) listMcpServers(effectiveCwd).then(setConfigMcpServers).catch(() => {});
            }}
          />
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
          {providerSupports(selectedProvider, "hookLog") && (
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
              // Cancel running process + reset UI state, then reload the
              // active provider's persisted transcript.
              {
                const rp = sessionProviderFor(sessionId);
                cancelByProvider(sessionId, rp).catch(() => {});
                closeByProvider(sessionId, rp).catch(() => {});
              }
              const store = useProviderSessionStore.getState();
              store.setStreaming(sessionId, false);
              store.setError(sessionId, null);
              store.clearStreamingText(sessionId);
              if (!store.sessions[sessionId] || !effectiveCwd) return;
              store.refreshFromHistory(sessionId, effectiveCwd).catch(() => {});
            }}
            title="Refresh chat (cancel in-flight request, reload provider history)"
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
            <ChatEditOverlay
              overlay={editOverlay}
              saveFileContent={writeFile}
              rememberContent={rememberEditOverlayContent}
              onClose={closeEditOverlay}
            />
          ) : showPlanViewer && planContent ? (
            <PlanViewer content={planContent} variant="main" />
          ) : (
            <ChatMessageList
              listRef={virtuosoRef}
              rows={visualRows}
              footer={legendFooter}
              sessionId={sessionId}
              provider={selectedProvider}
              hasMessages={hasMessages}
              providerPickerUnlocked={providerPickerUnlocked}
              {...(providerPickerUnlocked ? { onSelectProvider: handleSelectPreStartProvider } : {})}
              prompts={userPrompts}
              isScrolledUp={isScrolledUp}
              scrollProgress={scrollProgress}
              islandOpen={islandOpen}
              onIslandOpen={() => setIslandOpen(true)}
              onIslandClose={() => setIslandOpen(false)}
              onJumpToPrompt={jumpToPrompt}
              onScrollToBottom={scrollToBottom}
              onLegendScroll={onLegendScroll}
              onWheel={handleUserWheel}
              onTouchStart={handleUserTouchStart}
              onTouchMove={handleUserTouchMove}
              onKeyDown={handleListKeyDown}
              onPointerDown={handleListPointerDown}
              onStreamUpdate={followStreamingToBottom}
              {...(supportsHistoryRewind ? { onRewind: onRewindClick } : {})}
              {...(supportsHistoryFork ? { onFork: handleFork } : {})}
              onEditClick={handleEditClick}
            />
          )}

          <div className="cc-footer">
            {/* Prompt queue overlay — absolutely positioned upward from footer */}
            {session.promptQueue.length > 0 && (
              <div className={`cc-queue ${queueExpanded ? "cc-queue--expanded" : ""}`}>
                <button className="cc-queue-header" onClick={() => setQueueExpanded((v) => !v)}>
                  <span className="cc-queue-chevron">{queueExpanded ? "▾" : "▸"}</span>
                  <span className="cc-queue-title">{session.promptQueue.length} queued prompt{session.promptQueue.length > 1 ? "s" : ""}</span>
                  <button className="cc-queue-clear" onClick={(e) => { e.stopPropagation(); useProviderSessionStore.getState().clearQueue(sessionId); }}>Clear</button>
                </button>
                {queueExpanded && (
                  <div className="cc-queue-list">
                    {session.promptQueue.map((qp) => (
                      <div key={qp.id} className="cc-queue-item">
                        <span className="cc-queue-text">{queuedPromptDisplayText(qp)}</span>
                        <button className="cc-queue-remove" onClick={() => useProviderSessionStore.getState().removeQueuedPrompt(sessionId, qp.id)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {planFinished && !session.isStreaming && (() => {
              const ctxPct = session.contextMax > 0 ? Math.min(100, Math.round((session.contextUsed / session.contextMax) * 100)) : 0;
              return (
                <PlanFinishedActions
                  content={planContent}
                  contextPercent={ctxPct}
                  showViewer={showPlanViewer}
                  {...(supportsCompact ? {
                    onCompactBuild: () => {
                      resetPlan();
                      selectPermissionId("bypass_all");
                      // Queue the build prompt so it fires automatically after /compact finishes
                      const buildPrompt = "Build the plan now. Execute every step. Do not skip anything. Do not re-read files you already know about.";
                      useProviderSessionStore.getState().enqueuePrompt(sessionId, {
                        displayText: buildPrompt,
                        providerPrompt: buildPrompt,
                        permissionOverride: "bypass_all",
                        ...(planBuildCodexMode ? { codexCollaborationMode: planBuildCodexMode.codexCollaborationMode } : {}),
                        command: { kind: "plan-build", originalText: buildPrompt },
                      });
                      handleSend("/compact Keep the plan file and key decisions only. Discard everything else.", "bypass_all");
                    },
                  } : {})}
                  onBuildNow={() => {
                    resetPlan();
                    selectPermissionId("bypass_all");
                    handleSend(
                      "Build the plan now. Execute every step. Do not skip anything. Do not re-read files you already know about.",
                      "bypass_all",
                      planBuildCodexMode,
                    );
                  }}
                  onToggleViewer={togglePlanViewer}
                  onDelegate={() => {
                    const delegatePrompt = planContent
                      ? `Based on this plan, break it into parallel tasks for delegation. Analyze the plan and output a delegation block:\n\n${planContent}`
                      : "Break the plan you just created into parallel tasks for delegation.";
                    resetPlan();
                    handleSend(`/delegate ${delegatePrompt}`, "bypass_all");
                  }}
                  onDismiss={resetPlan}
                />
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
                      useProviderSessionStore.getState().setPendingPermission(sessionId, null);
                    }}>Allow</button>
                    <button className="cc-permission-deny" onClick={() => {
                      resolvePermission(perm.requestId, false).catch(() => {});
                      useProviderSessionStore.getState().setPendingPermission(sessionId, null);
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
                      const remove = () => removeAttachedFile(i);
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
                    <button className="cc-loop-stop" onClick={() => useProviderSessionStore.getState().setLoop(sessionId, null)}>Stop</button>
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
                  {...providerPermissionInputProps}
                  {...(session.name ? { sessionName: session.name } : {})}
                  cwd={effectiveCwd}
                  queueCount={session.promptQueue.length}
                  draftPrompt={session.draftPrompt}
                  onDraftChange={(t) => setDraftPrompt(sessionId, t)}
                  onPasteImage={handlePasteImage}
                  supportsImages={providerSupports(selectedProvider, "images")}
                  contextPct={session.contextMax > 0 ? Math.min(100, Math.max(0, Math.round((session.contextUsed / session.contextMax) * 100))) : 0}
                  autoCompactAt={autoCompactEnabled && supportsCompact ? autoCompactThreshold : 0}
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
              <PlanViewer
                content={planContent ?? ""}
                variant="side"
                isStreaming={session.isStreaming}
                onBuild={() => {
                  selectPermissionId("accept_edits");
                  handleSend(
                    "Plan mode is over. You have full permissions now. Build the plan — execute every step described in the plan file. Do not skip anything.",
                    "bypass_all",
                    planBuildCodexMode,
                  );
                }}
                onClose={clearPlanContent}
              />
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

export default ProviderChat;
