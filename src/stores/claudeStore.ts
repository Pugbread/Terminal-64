import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { ChatMessage, ToolCall, McpTool, HookEvent } from "../lib/types";

export const STORAGE_KEY = "terminal64-claude-sessions";

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
  streamingStartedAt: number | null; // timestamp when streaming began
  lastEventAt: number | null; // timestamp of most recent event from the process
  model: string;
  totalCost: number;
  totalTokens: number;
  contextUsed: number; // input tokens from latest turn (approximates context window usage)
  contextMax: number;  // max context window for the model
  error: string | null;
  promptCount: number;
  planModeActive: boolean;
  pendingQuestions: PendingQuestions | null;
  pendingPermission: PendingPermission | null;
  name: string;
  cwd: string;
  promptQueue: QueuedPrompt[];
  hasBeenStarted: boolean; // true once the first prompt was ever sent (survives rewind)
  draftPrompt: string; // unsent text in the input box, persisted across restarts
  activeLoop: ActiveLoop | null;
  ephemeral: boolean; // if true, skip localStorage persistence (delegation children)
  mcpServers: McpServerStatus[];
  modifiedFiles: string[];
  autoCompactStatus: "idle" | "compacting" | "done"; // auto-compact lifecycle
  autoCompactStartedAt: number | null; // timestamp when compacting began
  resumeAtUuid: string | null; // JSONL UUID for --resume-session-at after rewind (one-shot, cleared after use)
  forkParentSessionId: string | null; // parent session ID for --fork-session (one-shot, cleared after use)
  skipOpenwolf: boolean; // true for widget/skill sessions — prevents .wolf/ init
  // Hook event tracking
  toolUsageStats: Record<string, number>; // tool name → invocation count (from PostToolUse)
  compactionCount: number; // number of compactions (from PostCompact)
  subagentIds: string[]; // currently active subagent IDs (tracked via SubagentStart/Stop)
  hookEventLog: HookEvent[]; // chronological log of all hook events
}

export interface ActiveLoop {
  prompt: string;
  intervalMs: number;
  lastFiredAt: number | null;
  iteration: number;
}

interface ClaudeState {
  sessions: Record<string, ClaudeSession>;

  createSession: (sessionId: string, initialName?: string, ephemeral?: boolean) => void;
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
  // Hook event actions
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

let isDirty = false;

function saveToStorage(sessions: Record<string, ClaudeSession>) {
  isDirty = false;
  try {
    // Merge with existing localStorage to preserve named sessions that were removed from memory
    let existing: Record<string, any> = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) existing = JSON.parse(raw);
    } catch (e) {
      console.warn("[claudeStore] Failed to parse existing sessions:", e);
    }

    // Remove sessions that are no longer in memory if they're unnamed or delegation children
    for (const id of Object.keys(existing)) {
      if (!sessions[id] && (!existing[id]?.name || existing[id]?.name?.startsWith("[D] "))) {
        delete existing[id];
      }
    }

    for (const [id, s] of Object.entries(sessions)) {
      if (s.ephemeral) continue;
      existing[id] = {
        sessionId: s.sessionId,
        messages: s.messages,
        model: s.model,
        tasks: s.tasks,
        totalCost: s.totalCost,
        totalTokens: s.totalTokens,
        contextUsed: s.contextUsed,
        contextMax: s.contextMax,
        promptCount: s.promptCount,
        name: s.name,
        cwd: s.cwd,
        draftPrompt: s.draftPrompt || "",
      };
    }
    const json = JSON.stringify(existing);
    localStorage.setItem(STORAGE_KEY, json);
  } catch (e) {
    console.error("[claudeStore] Failed to save sessions:", e);
    // If quota exceeded, try saving just the current sessions without merging old ones
    try {
      const minimal: Record<string, any> = {};
      for (const [id, s] of Object.entries(sessions)) {
        minimal[id] = {
          sessionId: s.sessionId,
          messages: s.messages.slice(-200), // keep last 200 messages if full
          model: s.model,
          tasks: s.tasks,
          totalCost: s.totalCost,
          totalTokens: s.totalTokens,
          contextUsed: s.contextUsed,
          contextMax: s.contextMax,
          promptCount: s.promptCount,
          name: s.name,
          cwd: s.cwd,
          draftPrompt: s.draftPrompt || "",
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(minimal));
      console.warn("[claudeStore] Saved truncated session data (quota recovery)");
    } catch (e2) {
      console.error("[claudeStore] Even truncated save failed:", e2);
    }
  }
}

function loadSession(sessionId: string): ClaudeSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const saved = data[sessionId];
    if (!saved || !saved.messages) return null;
    return {
      sessionId: saved.sessionId,
      messages: saved.messages,
      tasks: saved.tasks || [],
      isStreaming: false,
      streamingText: "",
      streamingStartedAt: null,
      lastEventAt: null,
      model: saved.model || "",
      totalCost: saved.totalCost || 0,
      totalTokens: saved.totalTokens || 0,
      contextUsed: saved.contextUsed || 0,
      contextMax: saved.contextMax || 0,
      error: null,
      promptCount: saved.promptCount || saved.messages.filter((m: ChatMessage) => m.role === "user").length,
      planModeActive: false,
      pendingQuestions: null,
      pendingPermission: null,
      name: saved.name || "",
      cwd: saved.cwd || "",
      promptQueue: [],
      hasBeenStarted: (saved.promptCount || 0) > 0 || (saved.messages?.length || 0) > 0,
      draftPrompt: saved.draftPrompt || "",
      activeLoop: null, // loops don't persist across restarts
      ephemeral: false,
      mcpServers: [],
      modifiedFiles: [],
      autoCompactStatus: "idle",
      autoCompactStartedAt: null,
      resumeAtUuid: null,
      forkParentSessionId: null,
      skipOpenwolf: saved.skipOpenwolf || false,
      toolUsageStats: {},
      compactionCount: 0,
      subagentIds: [],
      hookEventLog: [],
    };
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave() {
  isDirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToStorage(useClaudeStore.getState().sessions), 1000);
}


export const useClaudeStore = create<ClaudeState>((set, get) => ({
  sessions: {},

  createSession: (sessionId: string, initialName?: string, ephemeral?: boolean) => {
    const existing = get().sessions[sessionId];
    if (existing) {
      if (initialName && !existing.name) {
        set((s) => {
          const updated = updateSession(s.sessions, sessionId, { name: initialName });
          if (!existing.ephemeral) saveToStorage(updated);
          return { sessions: updated };
        });
      }
      return;
    }
    if (!ephemeral) {
      const restored = loadSession(sessionId);
      if (restored) {
        if (initialName && !restored.name) restored.name = initialName;
        set((s) => ({ sessions: { ...s.sessions, [sessionId]: restored } }));
        return;
      }
    }
    set((s) => {
      const sessions = {
        ...s.sessions,
        [sessionId]: {
          sessionId, messages: [], tasks: [], isStreaming: false, streamingText: "", streamingStartedAt: null, lastEventAt: null,
          model: "", totalCost: 0, totalTokens: 0, contextUsed: 0, contextMax: 0, error: null, promptCount: 0, planModeActive: false,
          pendingQuestions: null, pendingPermission: null, name: initialName || "", cwd: "",
          promptQueue: [], hasBeenStarted: false, draftPrompt: "", activeLoop: null, ephemeral: !!ephemeral, mcpServers: [], modifiedFiles: [], autoCompactStatus: "idle" as const, autoCompactStartedAt: null, resumeAtUuid: null, forkParentSessionId: null,
          skipOpenwolf: false, toolUsageStats: {}, compactionCount: 0, subagentIds: [], hookEventLog: [],
        },
      };
      if (!ephemeral) debouncedSave();
      return { sessions };
    });
  },

  removeSession: (sessionId: string) => {
    set((s) => {
      const removed = s.sessions[sessionId];
      const { [sessionId]: _, ...rest } = s.sessions;
      // Delete from localStorage if unnamed or ephemeral (delegation children)
      // Named non-ephemeral sessions stay so they can be reopened later
      if (!removed?.name || removed?.ephemeral) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) { const d = JSON.parse(raw); delete d[sessionId]; localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }
        } catch (e) {
          console.warn("[claudeStore] Failed to clean up localStorage on remove:", e);
        }
      }
      return { sessions: rest };
    });
  },

  addUserMessage: (sessionId: string, text: string) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const msg: ChatMessage = { id: uuidv4(), role: "user", content: text, timestamp: Date.now() };
      const updated = updateSession(s.sessions, sessionId, { messages: [...session.messages, msg], error: null });
      saveToStorage(updated); // immediate save — user messages must never be lost
      return { sessions: updated };
    });
  },

  appendStreamingText: (sessionId: string, text: string) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { streamingText: session.streamingText + text }) };
    });
  },

  clearStreamingText: (sessionId: string) => {
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
      const msg: ChatMessage = { id: uuidv4(), role: "assistant", content: text, timestamp: Date.now(), toolCalls };
      const updated = updateSession(s.sessions, sessionId, { messages: [...session.messages, msg], streamingText: "" });
      saveToStorage(updated); // immediate save — finalized messages must never be lost
      return { sessions: updated };
    });
  },

  // Merge tool result INTO the last assistant message's toolCalls
  updateToolResult: (sessionId, toolUseId, result, isError) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      // Find the last assistant message that has this toolCall (scan backwards)
      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.role === "assistant" && msg.toolCalls) {
          const tcIdx = msg.toolCalls.findIndex((t) => t.id === toolUseId);
          if (tcIdx >= 0) {
            // Only copy the one message that changed instead of the full array
            const updatedToolCalls = msg.toolCalls.slice();
            updatedToolCalls[tcIdx] = { ...updatedToolCalls[tcIdx], result, isError };
            const messages = msgs.slice();
            messages[i] = { ...msg, toolCalls: updatedToolCalls };
            const updated = updateSession(s.sessions, sessionId, { messages });
            debouncedSave();
            return { sessions: updated };
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
      const updated = updateSession(s.sessions, sessionId, { totalCost: session.totalCost + cost });
      debouncedSave();
      return { sessions: updated };
    });
  },

  addTokens: (sessionId, tokens) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      debouncedSave();
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
      const updated = updateSession(s.sessions, sessionId, { promptCount: session.promptCount + 1, hasBeenStarted: true });
      debouncedSave();
      return { sessions: updated };
    });
  },

  addTask: (sessionId, task) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      // Don't add duplicates
      if (session.tasks.some((t) => t.id === task.id)) return s;
      const updated = updateSession(s.sessions, sessionId, { tasks: [...session.tasks, task] });
      debouncedSave();
      return { sessions: updated };
    });
  },

  updateTask: (sessionId, taskId, update) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const tasks = session.tasks.map((t) => t.id === taskId ? { ...t, ...update } : t);
      const updated = updateSession(s.sessions, sessionId, { tasks });
      debouncedSave();
      return { sessions: updated };
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
        // All questions answered — clear and return collected answers
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
      saveToStorage(updated);
      return { sessions: updated };
    });
  },

  setCwd: (sessionId, cwd) => {
    set((s) => {
      const updated = updateSession(s.sessions, sessionId, { cwd });
      debouncedSave();
      return { sessions: updated };
    });
  },

  setMcpServers: (sessionId, servers) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { mcpServers: servers }) }));
  },

  // Prompt queue management
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

  // Load message history from disk JSONL (replaces current messages unconditionally)
  loadFromDisk: (sessionId, messages) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const promptCount = messages.filter((m) => m.role === "user").length;
      const updated = updateSession(s.sessions, sessionId, { messages, promptCount, hasBeenStarted: promptCount > 0 });
      debouncedSave();
      return { sessions: updated };
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

  // Permanently delete a session from both memory and localStorage
  deleteSession: (sessionId) => {
    set((s) => {
      const { [sessionId]: _, ...rest } = s.sessions;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const d = JSON.parse(raw);
          delete d[sessionId];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
        }
      } catch (e) {
        console.warn("[claudeStore] Failed to delete session from localStorage:", e);
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

  // Truncate conversation from a specific message (for rewind)
  truncateFromMessage: (sessionId, messageId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const idx = session.messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return s;
      const messages = session.messages.slice(0, idx);
      const promptCount = messages.filter((m) => m.role === "user").length;
      const updated = updateSession(s.sessions, sessionId, {
        messages, promptCount, streamingText: "", isStreaming: false, error: null,
        pendingPermission: null, pendingQuestions: null, activeLoop: null, promptQueue: [],
      });
      debouncedSave();
      return { sessions: updated };
    });
  },

  // Hook event actions
  addHookEvent: (sessionId, event) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      // Cap log at 500 entries to prevent unbounded growth
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

// Emergency save on tab hide / close — prevents data loss from random stops or network issues
export function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveToStorage(useClaudeStore.getState().sessions);
}
const visibilityHandler = () => { if (document.visibilityState === "hidden") flushSave(); };
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("beforeunload", flushSave);
  // Periodic safety-net save every 5 seconds — only fires when state has changed
  const saveIntervalId = setInterval(() => {
    if (isDirty) saveToStorage(useClaudeStore.getState().sessions);
  }, 5000);

  // Clean up on HMR to prevent interval leaks
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      clearInterval(saveIntervalId);
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("beforeunload", flushSave);
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    });
  }
}
