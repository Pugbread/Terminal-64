import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { ChatMessage, ToolCall, McpTool, HookEvent } from "../lib/types";
import { loadSessionHistory, mapHistoryMessages, statSessionJsonl } from "../lib/tauriApi";

export const STORAGE_KEY = "terminal64-claude-sessions";

// localStorage now stores only lightweight UI/metadata. Messages and token/cost
// counters are derived from the JSONL files in ~/.claude/projects/... — they are
// the authoritative source of truth. Wiping localStorage must never lose chat
// history; dropping this metadata costs only a draft prompt and a friendly name.
export interface PersistedSessionMeta {
  sessionId: string;
  name: string;
  cwd: string;
  draftPrompt: string;
  lastSeenAt: number;
  schemaVersion: number;
}

// Bump when the shape of PersistedSessionMeta changes. Older clients that
// encounter a higher version refuse to overwrite — see downgradeLockActive.
const CURRENT_SCHEMA_VERSION = 1;

// Flips true once we see persisted data written by a newer schema than we
// understand. While active, saveToStorage is a no-op so a downgraded client
// can't clobber data the next rollforward relies on.
let downgradeLockActive = false;

export interface ClaudeTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PendingQuestions {
  toolUseId: string;
  items: PendingQuestionItem[];
  currentIndex: number;
  answers: string[];
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  timestamp: number;
}

export interface McpServerStatus {
  name: string;
  status: string;
  error?: string;
  transport?: string;
  scope?: string;
  tools?: McpTool[];
  toolCount?: number;
}

export interface ClaudeSession {
  sessionId: string;
  messages: ChatMessage[];
  tasks: ClaudeTask[];
  isStreaming: boolean;
  streamingText: string;
  streamingStartedAt: number | null;
  lastEventAt: number | null;
  model: string;
  totalCost: number;
  totalTokens: number;
  contextUsed: number;
  contextMax: number;
  error: string | null;
  promptCount: number;
  planModeActive: boolean;
  pendingQuestions: PendingQuestions | null;
  pendingPermission: PendingPermission | null;
  name: string;
  cwd: string;
  promptQueue: QueuedPrompt[];
  hasBeenStarted: boolean;
  draftPrompt: string;
  activeLoop: ActiveLoop | null;
  ephemeral: boolean;
  mcpServers: McpServerStatus[];
  modifiedFiles: string[];
  autoCompactStatus: "idle" | "compacting" | "done";
  autoCompactStartedAt: number | null;
  resumeAtUuid: string | null;
  forkParentSessionId: string | null;
  skipOpenwolf: boolean;
  toolUsageStats: Record<string, number>;
  compactionCount: number;
  subagentIds: string[];
  hookEventLog: HookEvent[];
  // True once the JSONL on disk has been loaded (or load attempted and failed).
  // UI uses this to know when it's safe to claim "no messages" vs "still loading".
  jsonlLoaded: boolean;
}

export interface ActiveLoop {
  prompt: string;
  intervalMs: number;
  lastFiredAt: number | null;
  iteration: number;
}

interface ClaudeState {
  sessions: Record<string, ClaudeSession>;

  createSession: (
    sessionId: string,
    initialName?: string,
    ephemeral?: boolean,
    skipOpenwolf?: boolean,
    cwd?: string,
  ) => void;
  removeSession: (sessionId: string) => void;
  addUserMessage: (sessionId: string, text: string) => void;
  appendStreamingText: (sessionId: string, text: string) => void;
  clearStreamingText: (sessionId: string) => void;
  finalizeAssistantMessage: (sessionId: string, text: string, toolCalls?: ToolCall[]) => void;
  updateToolResult: (sessionId: string, toolUseId: string, result: string, isError: boolean) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  touchLastEvent: (sessionId: string) => void;
  setModel: (sessionId: string, model: string) => void;
  addCost: (sessionId: string, cost: number) => void;
  addTokens: (sessionId: string, tokens: number) => void;
  setContextUsage: (sessionId: string, used: number, max: number) => void;
  setError: (sessionId: string, error: string | null) => void;
  incrementPromptCount: (sessionId: string) => void;
  addTask: (sessionId: string, task: ClaudeTask) => void;
  updateTask: (sessionId: string, taskId: string, update: Partial<ClaudeTask>) => void;
  setPlanMode: (sessionId: string, active: boolean) => void;
  setPendingQuestions: (sessionId: string, questions: PendingQuestions | null) => void;
  setPendingPermission: (sessionId: string, permission: PendingPermission | null) => void;
  answerQuestion: (sessionId: string, answer: string) => void;
  setName: (sessionId: string, name: string) => void;
  setCwd: (sessionId: string, cwd: string) => void;
  setMcpServers: (sessionId: string, servers: McpServerStatus[]) => void;
  enqueuePrompt: (sessionId: string, text: string) => void;
  dequeuePrompt: (sessionId: string) => QueuedPrompt | undefined;
  removeQueuedPrompt: (sessionId: string, promptId: string) => void;
  clearQueue: (sessionId: string) => void;
  loadFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  mergeFromDisk: (sessionId: string, messages: ChatMessage[]) => void;
  setDraftPrompt: (sessionId: string, text: string) => void;
  setLoop: (sessionId: string, loop: ActiveLoop | null) => void;
  tickLoop: (sessionId: string) => void;
  addModifiedFiles: (sessionId: string, paths: string[]) => void;
  resetModifiedFiles: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  setAutoCompactStatus: (sessionId: string, status: "idle" | "compacting" | "done") => void;
  setResumeAtUuid: (sessionId: string, uuid: string | null) => void;
  setForkParentSessionId: (sessionId: string, parentId: string | null) => void;
  truncateFromMessage: (sessionId: string, messageId: string) => void;
  addHookEvent: (sessionId: string, event: HookEvent) => void;
  recordToolUsage: (sessionId: string, toolName: string) => void;
  incrementCompactionCount: (sessionId: string) => void;
  addSubagent: (sessionId: string, subagentId: string) => void;
  removeSubagent: (sessionId: string, subagentId: string) => void;
}

function updateSession(
  sessions: Record<string, ClaudeSession>,
  sessionId: string,
  update: Partial<ClaudeSession>
): Record<string, ClaudeSession> {
  const session = sessions[sessionId];
  if (!session) return sessions;
  return { ...sessions, [sessionId]: { ...session, ...update } };
}

function readPersistedMeta(): Record<string, PersistedSessionMeta> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const data = parsed as Record<string, PersistedSessionMeta>;
    // Forward-compat guard: if any entry was written by a newer schema, flip
    // the read-only flag so we don't silently downgrade it on the next write.
    if (!downgradeLockActive) {
      for (const entry of Object.values(data)) {
        const v = (entry as { schemaVersion?: number })?.schemaVersion ?? 0;
        if (v > CURRENT_SCHEMA_VERSION) {
          console.warn(
            `[claudeStore] Persisted metadata schemaVersion ${v} exceeds supported ${CURRENT_SCHEMA_VERSION}. ` +
              "Entering read-only mode to avoid downgrading newer data.",
          );
          downgradeLockActive = true;
          break;
        }
      }
    }
    return data;
  } catch (e) {
    // Parse failure: back up the raw bytes so a corrupted blob is still
    // recoverable (names, drafts). Then return empty so the app keeps working.
    if (raw) {
      try {
        const backup = { savedAt: new Date().toISOString(), raw };
        localStorage.setItem(`${STORAGE_KEY}.bak`, JSON.stringify(backup));
        console.warn(
          `[claudeStore] Corrupt metadata in localStorage — raw bytes backed up to "${STORAGE_KEY}.bak" before recovery.`,
          e,
        );
      } catch (backupErr) {
        console.warn("[claudeStore] Failed to back up corrupt metadata:", backupErr);
      }
    } else {
      console.warn("[claudeStore] Failed to parse persisted metadata:", e);
    }
    return {};
  }
}

function loadMetadata(sessionId: string): PersistedSessionMeta | null {
  const data = readPersistedMeta();
  const entry = data[sessionId];
  if (!entry) return null;
  return {
    sessionId: entry.sessionId || sessionId,
    name: entry.name || "",
    cwd: entry.cwd || "",
    draftPrompt: entry.draftPrompt || "",
    lastSeenAt: entry.lastSeenAt || 0,
    schemaVersion: (entry as { schemaVersion?: number }).schemaVersion ?? 0,
  };
}

// Write only lightweight metadata. Messages live in JSONL and are reloaded on
// demand, so this payload stays small and cannot exhaust the storage quota.
function saveToStorage(sessions: Record<string, ClaudeSession>) {
  if (downgradeLockActive) return;
  try {
    const existing = readPersistedMeta();
    // readPersistedMeta may have flipped the lock on a newer-schema read.
    if (downgradeLockActive) return;

    // Clean up delegation children that have left memory. Named non-ephemeral
    // sessions are kept so they can be reopened by the dialog later.
    for (const id of Object.keys(existing)) {
      const row = existing[id];
      if (!sessions[id] && row?.name?.startsWith("[D] ")) {
        delete existing[id];
      }
    }

    const now = Date.now();
    for (const [id, s] of Object.entries(sessions)) {
      if (s.ephemeral) continue;
      existing[id] = {
        sessionId: s.sessionId,
        name: s.name,
        cwd: s.cwd,
        draftPrompt: s.draftPrompt || "",
        lastSeenAt: now,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch (e) {
    console.error("[claudeStore] Failed to save session metadata:", e);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToStorage(useClaudeStore.getState().sessions), 1000);
}

function patchSession(sessionId: string, patch: Partial<ClaudeSession>) {
  useClaudeStore.setState((s) => ({ sessions: updateSession(s.sessions, sessionId, patch) }));
}

// In-memory hydration cache keyed by {mtime_ms, size}. Reloading the same
// session within one app session is common (switching chat tabs, re-opening a
// dialog) — if the JSONL hasn't changed, reuse the parsed messages instead of
// streaming 10k records over IPC + reparsing in Rust. Not persisted: a process
// restart will always do a fresh parse.
interface HydrationCacheEntry {
  mtimeMs: number;
  size: number;
  messages: ChatMessage[];
}
const hydrationCache = new Map<string, HydrationCacheEntry>();

// Async JSONL hydration. Fire-and-forget — errors are logged but non-fatal so
// the user can still interact with a session whose history hasn't loaded yet.
function hydrateFromJsonl(sessionId: string, cwd: string) {
  statSessionJsonl(sessionId, cwd)
    .then((stat) => {
      if (stat) {
        const cached = hydrationCache.get(sessionId);
        if (cached && cached.mtimeMs === stat.mtime_ms && cached.size === stat.size) {
          useClaudeStore.getState().loadFromDisk(sessionId, cached.messages);
          return;
        }
      } else {
        // File missing — nothing on disk. Drop any stale cache and mark loaded.
        hydrationCache.delete(sessionId);
        patchSession(sessionId, { jsonlLoaded: true });
        return;
      }
      return loadSessionHistory(sessionId, cwd).then((history) => {
        if (history.length > 0) {
          const messages = mapHistoryMessages(history);
          if (stat) {
            hydrationCache.set(sessionId, {
              mtimeMs: stat.mtime_ms,
              size: stat.size,
              messages,
            });
          }
          useClaudeStore.getState().loadFromDisk(sessionId, messages);
        } else {
          // Fresh session — no JSONL yet. Still flip the flag so UI stops waiting.
          patchSession(sessionId, { jsonlLoaded: true });
        }
      });
    })
    .catch((err) => {
      console.warn("[claudeStore] JSONL hydrate failed:", sessionId, err);
      patchSession(sessionId, { jsonlLoaded: true });
    });
}


export const useClaudeStore = create<ClaudeState>((set, get) => ({
  sessions: {},

  createSession: (sessionId, initialName, ephemeral, skipOpenwolf, cwd) => {
    const existing = get().sessions[sessionId];
    if (existing) {
      if (initialName && !existing.name) {
        set((s) => {
          const updated = updateSession(s.sessions, sessionId, { name: initialName });
          if (!existing.ephemeral) saveToStorage(updated);
          return { sessions: updated };
        });
      }
      // If caller supplied a cwd and we didn't have one, adopt it and hydrate.
      if (cwd && !existing.cwd && !existing.ephemeral) {
        set((s) => ({ sessions: updateSession(s.sessions, sessionId, { cwd }) }));
        if (!existing.jsonlLoaded) hydrateFromJsonl(sessionId, cwd);
      }
      return;
    }

    const meta = ephemeral ? null : loadMetadata(sessionId);
    const seededName = initialName ?? meta?.name ?? "";
    const seededCwd = cwd ?? meta?.cwd ?? "";
    const seededDraft = meta?.draftPrompt ?? "";

    set((s) => {
      const sessions = {
        ...s.sessions,
        [sessionId]: {
          sessionId,
          messages: [],
          tasks: [],
          isStreaming: false,
          streamingText: "",
          streamingStartedAt: null,
          lastEventAt: null,
          model: "",
          totalCost: 0,
          totalTokens: 0,
          contextUsed: 0,
          contextMax: 0,
          error: null,
          promptCount: 0,
          planModeActive: false,
          pendingQuestions: null,
          pendingPermission: null,
          name: seededName,
          cwd: seededCwd,
          promptQueue: [],
          hasBeenStarted: false,
          draftPrompt: seededDraft,
          activeLoop: null,
          ephemeral: !!ephemeral,
          mcpServers: [],
          modifiedFiles: [],
          autoCompactStatus: "idle" as const,
          autoCompactStartedAt: null,
          resumeAtUuid: null,
          forkParentSessionId: null,
          skipOpenwolf: !!skipOpenwolf,
          toolUsageStats: {},
          compactionCount: 0,
          subagentIds: [],
          hookEventLog: [],
          jsonlLoaded: !!ephemeral, // ephemeral sessions never load from disk
        },
      };
      if (!ephemeral) debouncedSave();
      return { sessions };
    });

    // Kick off JSONL hydration when we know where to look. Ephemeral and
    // cwd-less sessions skip this; ClaudeChat calls createSession again with
    // a cwd (or calls setCwd) once the panel mounts with its working dir.
    if (!ephemeral && seededCwd) {
      hydrateFromJsonl(sessionId, seededCwd);
    }
  },

  removeSession: (sessionId) => {
    set((s) => {
      const removed = s.sessions[sessionId];
      const { [sessionId]: _, ...rest } = s.sessions;
      // Only unnamed or ephemeral sessions get purged from disk. Named sessions
      // remain in metadata so the Claude dialog can reopen them with history
      // pulled back from JSONL.
      if (!removed?.name || removed?.ephemeral) {
        try {
          const data = readPersistedMeta();
          if (data[sessionId]) {
            delete data[sessionId];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
          }
        } catch (e) {
          console.warn("[claudeStore] Failed to prune metadata on remove:", e);
        }
      }
      return { sessions: rest };
    });
  },

  addUserMessage: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const msg: ChatMessage = { id: uuidv4(), role: "user", content: text, timestamp: Date.now() };
      return { sessions: updateSession(s.sessions, sessionId, { messages: [...session.messages, msg], error: null }) };
    });
  },

  appendStreamingText: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { streamingText: session.streamingText + text }) };
    });
  },

  clearStreamingText: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.streamingText === "") return s;
      return { sessions: updateSession(s.sessions, sessionId, { streamingText: "" }) };
    });
  },

  finalizeAssistantMessage: (sessionId, text, toolCalls) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const msg: ChatMessage = {
        id: uuidv4(),
        role: "assistant",
        content: text,
        timestamp: Date.now(),
        ...(toolCalls !== undefined && { toolCalls }),
      };
      return { sessions: updateSession(s.sessions, sessionId, { messages: [...session.messages, msg], streamingText: "" }) };
    });
  },

  updateToolResult: (sessionId, toolUseId, result, isError) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg && msg.role === "assistant" && msg.toolCalls) {
          const tcIdx = msg.toolCalls.findIndex((t) => t.id === toolUseId);
          if (tcIdx >= 0) {
            const updatedToolCalls = msg.toolCalls.slice();
            const existing = updatedToolCalls[tcIdx]!;
            updatedToolCalls[tcIdx] = { ...existing, result, isError };
            const messages = msgs.slice();
            messages[i] = { ...msg, toolCalls: updatedToolCalls };
            return { sessions: updateSession(s.sessions, sessionId, { messages }) };
          }
        }
      }
      return s;
    });
  },

  setStreaming: (sessionId, streaming) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.isStreaming === streaming) return s;
      return { sessions: updateSession(s.sessions, sessionId, {
        isStreaming: streaming,
        streamingStartedAt: streaming ? Date.now() : null,
        lastEventAt: streaming ? Date.now() : null,
      }) };
    });
  },

  touchLastEvent: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { lastEventAt: Date.now() }) };
    });
  },

  setModel: (sessionId, model) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { model }) }));
  },

  addCost: (sessionId, cost) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { totalCost: session.totalCost + cost }) };
    });
  },

  addTokens: (sessionId, tokens) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { totalTokens: session.totalTokens + tokens }) };
    });
  },

  setContextUsage: (sessionId, used, max) => {
    const sess = get().sessions[sessionId];
    if (sess && sess.contextUsed === used && sess.contextMax === max) return;
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { contextUsed: used, contextMax: max }) }));
  },

  setError: (sessionId, error) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { error }) }));
  },

  incrementPromptCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { promptCount: session.promptCount + 1, hasBeenStarted: true }) };
    });
  },

  addTask: (sessionId, task) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (session.tasks.some((t) => t.id === task.id)) return s;
      return { sessions: updateSession(s.sessions, sessionId, { tasks: [...session.tasks, task] }) };
    });
  },

  updateTask: (sessionId, taskId, update) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const tasks = session.tasks.map((t) => t.id === taskId ? { ...t, ...update } : t);
      return { sessions: updateSession(s.sessions, sessionId, { tasks }) };
    });
  },

  setPlanMode: (sessionId, active) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { planModeActive: active }) }));
  },

  setPendingQuestions: (sessionId, questions) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { pendingQuestions: questions }) }));
  },

  setPendingPermission: (sessionId, permission) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { pendingPermission: permission }) }));
  },

  answerQuestion: (sessionId, answer) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || !session.pendingQuestions) return s;
      const pq = session.pendingQuestions;
      const newAnswers = [...pq.answers, answer];
      const nextIdx = pq.currentIndex + 1;
      if (nextIdx >= pq.items.length) {
        return { sessions: updateSession(s.sessions, sessionId, { pendingQuestions: null }) };
      }
      return {
        sessions: updateSession(s.sessions, sessionId, {
          pendingQuestions: { ...pq, currentIndex: nextIdx, answers: newAnswers },
        }),
      };
    });
  },

  setName: (sessionId, name) => {
    set((s) => {
      const updated = updateSession(s.sessions, sessionId, { name });
      const session = s.sessions[sessionId];
      if (session && !session.ephemeral) saveToStorage(updated);
      return { sessions: updated };
    });
  },

  setCwd: (sessionId, cwd) => {
    const prev = get().sessions[sessionId];
    set((s) => {
      const updated = updateSession(s.sessions, sessionId, { cwd });
      debouncedSave();
      return { sessions: updated };
    });
    // Hydrate from JSONL the first time we learn the cwd for a non-ephemeral
    // session that hasn't been loaded yet.
    if (prev && !prev.ephemeral && !prev.jsonlLoaded && cwd && cwd !== prev.cwd) {
      hydrateFromJsonl(sessionId, cwd);
    }
  },

  setMcpServers: (sessionId, servers) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { mcpServers: servers }) }));
  },

  enqueuePrompt: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const item: QueuedPrompt = { id: uuidv4(), text, timestamp: Date.now() };
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: [...session.promptQueue, item] }) };
    });
  },

  dequeuePrompt: (sessionId) => {
    let dequeued: QueuedPrompt | undefined;
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.promptQueue.length === 0) return s;
      const [first, ...rest] = session.promptQueue;
      dequeued = first;
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: rest }) };
    });
    return dequeued;
  },

  removeQueuedPrompt: (sessionId, promptId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { promptQueue: session.promptQueue.filter((p) => p.id !== promptId) }) };
    });
  },

  clearQueue: (sessionId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { promptQueue: [] }) }));
  },

  // Hydrate an empty/shorter session from the authoritative JSONL snapshot.
  // Refuses to shrink existing history so a stale load can't clobber a live
  // session that has already accumulated turns.
  loadFromDisk: (sessionId, messages) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (session.messages.length >= messages.length) {
        // Still flip the loaded flag — callers rely on it to stop "loading" UI.
        return { sessions: updateSession(s.sessions, sessionId, { jsonlLoaded: true }) };
      }
      const promptCount = messages.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages,
        promptCount,
        hasBeenStarted: promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  mergeFromDisk: (sessionId, incoming) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      if (incoming.length === 0) return s;
      const existingIds = new Set(session.messages.map((m) => m.id));
      const toAppend = incoming.filter((m) => !existingIds.has(m.id));
      if (toAppend.length === 0) return s;
      const merged = [...session.messages, ...toAppend];
      const promptCount = merged.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages: merged,
        promptCount,
        hasBeenStarted: promptCount > 0,
        jsonlLoaded: true,
      }) };
    });
  },

  setDraftPrompt: (sessionId, text) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.draftPrompt === text) return s;
      debouncedSave();
      return { sessions: updateSession(s.sessions, sessionId, { draftPrompt: text }) };
    });
  },

  setLoop: (sessionId, loop) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { activeLoop: loop }) }));
  },

  tickLoop: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session?.activeLoop) return s;
      return { sessions: updateSession(s.sessions, sessionId, {
        activeLoop: { ...session.activeLoop, lastFiredAt: Date.now(), iteration: session.activeLoop.iteration + 1 },
      }) };
    });
  },

  addModifiedFiles: (sessionId, paths) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const existing = new Set(session.modifiedFiles);
      const newPaths = paths.filter((p) => !existing.has(p));
      if (newPaths.length === 0) return s;
      return { sessions: updateSession(s.sessions, sessionId, { modifiedFiles: [...session.modifiedFiles, ...newPaths] }) };
    });
  },

  resetModifiedFiles: (sessionId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { modifiedFiles: [] }) }));
  },

  deleteSession: (sessionId) => {
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions;
      try {
        const data = readPersistedMeta();
        if (data[sessionId]) {
          delete data[sessionId];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        }
      } catch (e) {
        console.warn("[claudeStore] Failed to delete metadata:", e);
      }
      return { sessions: rest };
    });
  },

  setAutoCompactStatus: (sessionId, status) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, {
      autoCompactStatus: status,
      autoCompactStartedAt: status === "compacting" ? Date.now() : s.sessions[sessionId]?.autoCompactStartedAt ?? null,
    }) }));
  },

  setResumeAtUuid: (sessionId, uuid) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { resumeAtUuid: uuid }) }));
  },

  setForkParentSessionId: (sessionId, parentId) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { forkParentSessionId: parentId }) }));
  },

  truncateFromMessage: (sessionId, messageId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const idx = session.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return s;
      const messages = session.messages.slice(0, idx);
      const promptCount = messages.filter((m) => m.role === "user").length;
      return { sessions: updateSession(s.sessions, sessionId, {
        messages, promptCount, streamingText: "", isStreaming: false, error: null,
        pendingPermission: null, pendingQuestions: null, activeLoop: null, promptQueue: [],
      }) };
    });
  },

  addHookEvent: (sessionId, event) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const log = session.hookEventLog.length >= 500
        ? [...session.hookEventLog.slice(-499), event]
        : [...session.hookEventLog, event];
      return { sessions: updateSession(s.sessions, sessionId, { hookEventLog: log }) };
    });
  },

  recordToolUsage: (sessionId, toolName) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const stats = { ...session.toolUsageStats };
      stats[toolName] = (stats[toolName] || 0) + 1;
      return { sessions: updateSession(s.sessions, sessionId, { toolUsageStats: stats }) };
    });
  },

  incrementCompactionCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { compactionCount: session.compactionCount + 1 }) };
    });
  },

  addSubagent: (sessionId, subagentId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session || session.subagentIds.includes(subagentId)) return s;
      return { sessions: updateSession(s.sessions, sessionId, { subagentIds: [...session.subagentIds, subagentId] }) };
    });
  },

  removeSubagent: (sessionId, subagentId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const filtered = session.subagentIds.filter((id) => id !== subagentId);
      if (filtered.length === session.subagentIds.length) return s;
      return { sessions: updateSession(s.sessions, sessionId, { subagentIds: filtered }) };
    });
  },
}));

// Lightweight selector for voice/fuzzy session matching.
export function getSessionsForVoiceMatch(): { id: string; name: string }[] {
  const sessions = useClaudeStore.getState().sessions;
  const out: { id: string; name: string }[] = [];
  for (const s of Object.values(sessions)) {
    if (s.name && s.name.trim()) out.push({ id: s.sessionId, name: s.name });
  }
  return out;
}

// Emergency metadata flush on tab hide / close. Cheap now that the payload is
// just a handful of strings per session.
export function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveToStorage(useClaudeStore.getState().sessions);
}

const visibilityHandler = () => { if (document.visibilityState === "hidden") flushSave(); };
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("beforeunload", flushSave);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("beforeunload", flushSave);
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    });
  }
}
