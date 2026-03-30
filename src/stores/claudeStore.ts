import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { ChatMessage, ToolCall } from "../lib/types";

const STORAGE_KEY = "terminal64-claude-sessions";

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

export interface McpServerStatus {
  name: string;
  status: string; // "connected" | "failed" | "error" etc.
}

export interface ClaudeSession {
  sessionId: string;
  messages: ChatMessage[];
  tasks: ClaudeTask[];
  isStreaming: boolean;
  streamingText: string;
  model: string;
  totalCost: number;
  totalTokens: number;
  error: string | null;
  promptCount: number;
  planModeActive: boolean;
  pendingQuestions: PendingQuestions | null;
  pendingPermission: PendingPermission | null;
  name: string;
  cwd: string;
  mcpServers: McpServerStatus[];
}

interface ClaudeState {
  sessions: Record<string, ClaudeSession>;

  createSession: (sessionId: string, initialName?: string) => void;
  removeSession: (sessionId: string) => void;
  addUserMessage: (sessionId: string, text: string) => void;
  appendStreamingText: (sessionId: string, text: string) => void;
  clearStreamingText: (sessionId: string) => void;
  finalizeAssistantMessage: (sessionId: string, text: string, toolCalls?: ToolCall[]) => void;
  updateToolResult: (sessionId: string, toolUseId: string, result: string, isError: boolean) => void;
  setStreaming: (sessionId: string, streaming: boolean) => void;
  setModel: (sessionId: string, model: string) => void;
  addCost: (sessionId: string, cost: number) => void;
  addTokens: (sessionId: string, tokens: number) => void;
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
  deleteSession: (sessionId: string) => void;
  truncateFromMessage: (sessionId: string, messageId: string) => void;
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

function saveToStorage(sessions: Record<string, ClaudeSession>) {
  try {
    // Merge with existing localStorage to preserve named sessions that were removed from memory
    let existing: Record<string, any> = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) existing = JSON.parse(raw);
    } catch {}

    // Remove unnamed sessions that are no longer in memory
    for (const id of Object.keys(existing)) {
      if (!existing[id]?.name && !sessions[id]) {
        delete existing[id];
      }
    }

    // Update with current in-memory sessions
    for (const [id, s] of Object.entries(sessions)) {
      existing[id] = {
        sessionId: s.sessionId,
        messages: s.messages,
        model: s.model,
        tasks: s.tasks,
        totalCost: s.totalCost,
        totalTokens: s.totalTokens,
        promptCount: s.promptCount,
        name: s.name,
        cwd: s.cwd,
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch {}
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
      model: saved.model || "",
      totalCost: saved.totalCost || 0,
      totalTokens: saved.totalTokens || 0,
      error: null,
      promptCount: saved.promptCount || saved.messages.filter((m: any) => m.role === "user").length,
      planModeActive: false,
      pendingQuestions: null,
      pendingPermission: null,
      name: saved.name || "",
      cwd: saved.cwd || "",
      mcpServers: [],
    };
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(sessions: Record<string, ClaudeSession>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToStorage(sessions), 1000);
}

export const useClaudeStore = create<ClaudeState>((set, get) => ({
  sessions: {},

  createSession: (sessionId: string, initialName?: string) => {
    const existing = get().sessions[sessionId];
    if (existing) {
      if (initialName && !existing.name) {
        set((s) => {
          const updated = updateSession(s.sessions, sessionId, { name: initialName });
          saveToStorage(updated);
          return { sessions: updated };
        });
      }
      return;
    }
    const restored = loadSession(sessionId);
    if (restored) {
      if (initialName && !restored.name) restored.name = initialName;
      set((s) => ({ sessions: { ...s.sessions, [sessionId]: restored } }));
      return;
    }
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          sessionId, messages: [], tasks: [], isStreaming: false, streamingText: "",
          model: "", totalCost: 0, totalTokens: 0, error: null, promptCount: 0, planModeActive: false,
          pendingQuestions: null, pendingPermission: null, name: initialName || "", cwd: "", mcpServers: [],
        },
      },
    }));
  },

  removeSession: (sessionId: string) => {
    set((s) => {
      const removed = s.sessions[sessionId];
      const { [sessionId]: _, ...rest } = s.sessions;
      // Only delete from localStorage if the session has no name (unnamed = disposable)
      // Named sessions stay in localStorage so they can be reopened later
      if (!removed?.name) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) { const d = JSON.parse(raw); delete d[sessionId]; localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }
        } catch {}
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
      debouncedSave(updated);
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
      debouncedSave(updated);
      return { sessions: updated };
    });
  },

  // Merge tool result INTO the last assistant message's toolCalls
  updateToolResult: (sessionId, toolUseId, result, isError) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      // Find the last assistant message that has this toolCall
      const messages = [...session.messages];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant" && msg.toolCalls) {
          const tc = msg.toolCalls.find((t) => t.id === toolUseId);
          if (tc) {
            const updatedToolCalls = msg.toolCalls.map((t) =>
              t.id === toolUseId ? { ...t, result, isError } : t
            );
            messages[i] = { ...msg, toolCalls: updatedToolCalls };
            const updated = updateSession(s.sessions, sessionId, { messages });
            debouncedSave(updated);
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
      return { sessions: updateSession(s.sessions, sessionId, { isStreaming: streaming }) };
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
      debouncedSave(updated);
      return { sessions: updated };
    });
  },

  addTokens: (sessionId, tokens) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      return { sessions: updateSession(s.sessions, sessionId, { totalTokens: session.totalTokens + tokens }) };
    });
  },

  setError: (sessionId, error) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { error }) }));
  },

  incrementPromptCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const updated = updateSession(s.sessions, sessionId, { promptCount: session.promptCount + 1 });
      debouncedSave(updated);
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
      debouncedSave(updated);
      return { sessions: updated };
    });
  },

  updateTask: (sessionId, taskId, update) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;
      const tasks = session.tasks.map((t) => t.id === taskId ? { ...t, ...update } : t);
      const updated = updateSession(s.sessions, sessionId, { tasks });
      debouncedSave(updated);
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
      debouncedSave(updated);
      return { sessions: updated };
    });
  },

  setMcpServers: (sessionId, servers) => {
    set((s) => ({ sessions: updateSession(s.sessions, sessionId, { mcpServers: servers }) }));
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
      } catch {}
      return { sessions: rest };
    });
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
      });
      debouncedSave(updated);
      return { sessions: updated };
    });
  },
}));
