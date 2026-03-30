import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { onClaudeEvent, onClaudeDone, cancelClaude } from "../lib/tauriApi";
import { useClaudeStore } from "../stores/claudeStore";
import { ToolCall } from "../lib/types";

// Per-session tool ID → tool name maps (prevents cross-session collisions)
const sessionToolMaps = new Map<string, Map<string, string>>();

function getToolMap(sessionId: string): Map<string, string> {
  let map = sessionToolMaps.get(sessionId);
  if (!map) {
    map = new Map();
    sessionToolMaps.set(sessionId, map);
  }
  return map;
}

// RAF batching for streaming text — coalesces deltas into one store update per frame
const pendingText = new Map<string, string>();
let rafId: number | null = null;

function flushPendingText() {
  rafId = null;
  if (pendingText.size === 0) return;
  const store = useClaudeStore.getState();
  for (const [sid, text] of pendingText) {
    store.appendStreamingText(sid, text);
  }
  pendingText.clear();
}

function scheduleFlush() {
  if (rafId === null) {
    rafId = requestAnimationFrame(flushPendingText);
  }
}

// Tools hidden from the UI (handled internally by the wrapper)
const HIDDEN_TOOLS = new Set([
  "EnterPlanMode", "ExitPlanMode",
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop",
]);
// Tools that are internal but still shown in UI
const INTERNAL_TOOLS = new Set([
  ...HIDDEN_TOOLS, "AskUserQuestion",
]);

export function useClaudeEvents() {
  useEffect(() => {
    let unlistenEvent: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenDiscord: (() => void) | null = null;
    let unlistenPerm: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const fn1 = await onClaudeEvent((payload) => {
        if (cancelled) return;
        const { session_id, data } = payload;
        const store = useClaudeStore.getState();

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch (err) {
          console.warn("[claude] Failed to parse event:", data.slice(0, 200), err);
          return;
        }

        const type = parsed.type;

        if (type === "system" && parsed.subtype === "init") {
          store.setModel(session_id, parsed.model || "");
          store.setStreaming(session_id, true);
          // Extract MCP server status
          if (Array.isArray(parsed.mcp_servers)) {
            store.setMcpServers(session_id, parsed.mcp_servers.map((s: any) => ({
              name: String(s.name || ""),
              status: String(s.status || "unknown"),
            })));
          }
          return;
        }

        if (type === "content_block_delta") {
          if (parsed.delta?.type === "text_delta" && parsed.delta?.text) {
            const existing = pendingText.get(session_id) || "";
            pendingText.set(session_id, existing + parsed.delta.text);
            scheduleFlush();
          }
          return;
        }

        if (type === "message_start") {
          store.setStreaming(session_id, true);
          store.clearStreamingText(session_id);
          return;
        }

        // Flush any buffered streaming text before finalization events
        if (type === "assistant" || type === "result") {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushPendingText();
        }

        if (type === "assistant") {
          const content = parsed.message?.content;
          if (Array.isArray(content)) {
            let text = "";
            const toolCalls: ToolCall[] = [];

            for (const block of content) {
              if (block.type === "text") {
                text += block.text;
              } else if (block.type === "tool_use") {
                const name = block.name;
                const input = block.input || {};
                getToolMap(session_id).set(block.id, name);

                // Handle internal tools
                if (name === "EnterPlanMode") {
                  store.setPlanMode(session_id, true);
                } else if (name === "ExitPlanMode") {
                  store.setPlanMode(session_id, false);
                } else if (name === "AskUserQuestion") {
                  // Input is an array of question objects OR a single question
                  let questions: any[] = [];
                  if (Array.isArray(input)) {
                    questions = input;
                  } else if (input.question || input.options) {
                    questions = [input];
                  } else {
                    // Try to find array in the input values
                    const vals = Object.values(input);
                    const arr = vals.find((v) => Array.isArray(v));
                    if (arr) questions = arr as any[];
                    else questions = [{ question: input.description || input.text || "Claude has a question", options: [] }];
                  }

                  const items = questions.map((q: any) => ({
                    question: q.question || q.text || q.description || "Question",
                    header: q.header,
                    options: (q.options || []).map((o: any) =>
                      typeof o === "string" ? { label: o } : { label: o.label || String(o), description: o.description }
                    ),
                    multiSelect: q.multiSelect || false,
                  }));

                  if (items.length > 0) {
                    store.setPendingQuestions(session_id, {
                      toolUseId: block.id,
                      items,
                      currentIndex: 0,
                      answers: [],
                    });
                    // Kill the process so it stops — we'll resume after user answers
                    cancelClaude(session_id).catch(() => {});
                    store.setStreaming(session_id, false);
                  }
                } else if (name === "TaskCreate") {
                  store.addTask(session_id, {
                    id: block.id,
                    subject: String(input.subject || input.title || "Task"),
                    description: input.description ? String(input.description) : undefined,
                    status: "pending",
                  });
                } else if (name === "TaskUpdate") {
                  if (input.taskId) {
                    store.updateTask(session_id, String(input.taskId), {
                      ...(input.status ? { status: input.status as any } : {}),
                      ...(input.subject ? { subject: String(input.subject) } : {}),
                    });
                  }
                }

                // Only add non-hidden tools to the visible tool call list
                if (!HIDDEN_TOOLS.has(name)) {
                  toolCalls.push({ id: block.id, name, input });
                }
              }
            }

            const trimmedText = text.trim();
            if (trimmedText || toolCalls.length > 0) {
              store.finalizeAssistantMessage(session_id, trimmedText, toolCalls.length > 0 ? toolCalls : undefined);
            } else {
              store.clearStreamingText(session_id);
            }
          }
          return;
        }

        if (type === "user") {
          const content = parsed.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const toolId = block.tool_use_id || "";
                const toolName = getToolMap(session_id).get(toolId);

                // Update task IDs from TaskCreate results
                if (toolName === "TaskCreate" && block.content) {
                  const resultStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                  const match = resultStr.match(/#(\d+)/);
                  if (match) {
                    const s = useClaudeStore.getState();
                    const session = s.sessions[session_id];
                    if (session) {
                      const newTasks = session.tasks.map((t) =>
                        t.id === toolId ? { ...t, id: match![1] } : t
                      );
                      useClaudeStore.setState({
                        sessions: { ...s.sessions, [session_id]: { ...session, tasks: newTasks } },
                      });
                    }
                  }
                }

                // Skip hidden tool results
                if (toolName && HIDDEN_TOOLS.has(toolName)) continue;

                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content.map((c: any) => c.type === "text" ? c.text : JSON.stringify(c)).join("\n")
                      : JSON.stringify(block.content);

                store.updateToolResult(session_id, toolId, resultText, block.is_error || false);
              }
            }
          }
          return;
        }

        if (type === "result") {
          store.setStreaming(session_id, false);
          if (parsed.total_cost_usd) store.addCost(session_id, parsed.total_cost_usd);
          const input_tokens = parsed.usage?.input_tokens || parsed.input_tokens || 0;
          const output_tokens = parsed.usage?.output_tokens || parsed.output_tokens || 0;
          if (input_tokens || output_tokens) store.addTokens(session_id, input_tokens + output_tokens);
          if (parsed.is_error && parsed.result) store.setError(session_id, parsed.result);
          return;
        }

        // Unknown event type — log for debugging but don't crash
        if (type && type !== "ping") {
          console.debug("[claude] Unhandled event type:", type);
        }
      });

      if (cancelled) { fn1(); return; }
      unlistenEvent = fn1;

      const fn2 = await onClaudeDone((payload) => {
        if (cancelled) return;
        useClaudeStore.getState().setStreaming(payload.session_id, false);
        // Clean up session's tool map to prevent unbounded growth
        sessionToolMaps.delete(payload.session_id);
      });
      if (cancelled) { fn2(); return; }
      unlistenDone = fn2;

      // Listen for Discord messages to show in the GUI
      const fn3 = await listen<{ session_id: string; username: string; content: string }>(
        "discord-message",
        (event) => {
          if (cancelled) return;
          const { session_id, username, content } = event.payload;
          const store = useClaudeStore.getState();
          store.addUserMessage(session_id, `[${username}]: ${content}`);
          store.incrementPromptCount(session_id);
        }
      );
      if (cancelled) { fn3(); return; }
      unlistenDiscord = fn3;

      // Listen for permission requests from the hook server
      const fn4 = await listen<{ request_id: string; session_id: string; tool_name: string; tool_input: any }>(
        "permission-request",
        (event) => {
          if (cancelled) return;
          const { request_id, session_id, tool_name, tool_input } = event.payload;
          useClaudeStore.getState().setPendingPermission(session_id, {
            requestId: request_id,
            toolName: tool_name,
            toolInput: tool_input || {},
          });
        }
      );
      if (cancelled) { fn4(); return; }
      unlistenPerm = fn4;
    })();

    return () => {
      cancelled = true;
      unlistenEvent?.(); unlistenDone?.(); unlistenDiscord?.(); unlistenPerm?.();
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pendingText.clear();
    };
  }, []);
}
