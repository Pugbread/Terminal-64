import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { onClaudeEvent, onClaudeDone, cancelClaude } from "../lib/tauriApi";
import { useClaudeStore } from "../stores/claudeStore";
import { ToolCall } from "../lib/types";

const sessionToolMaps = new Map<string, Map<string, string>>();
const sessionFilePathMaps = new Map<string, Map<string, string>>();

function getSessionMap(store: Map<string, Map<string, string>>, sessionId: string): Map<string, string> {
  let map = store.get(sessionId);
  if (!map) {
    map = new Map();
    store.set(sessionId, map);
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

// Per-session pending content blocks — tracks tool calls from content_block_start
// events so we can finalize even if the synthetic "assistant" event never arrives.
interface PendingBlock {
  id: string;
  type: string;
  name?: string;
  inputJson: string; // accumulate input_json_delta chunks
}
const pendingBlocks = new Map<string, PendingBlock[]>();
// Track whether the assistant event already finalized for this turn
const assistantFinalized = new Set<string>();

function processContentArray(
  session_id: string,
  content: any[],
  store: ReturnType<typeof useClaudeStore.getState>,
): boolean {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      const name = block.name;
      const input = block.input || {};
      getSessionMap(sessionToolMaps, session_id).set(block.id, name);

      if ((name === "Write" || name === "Edit" || name === "MultiEdit") && input.file_path) {
        getSessionMap(sessionFilePathMaps, session_id).set(block.id, String(input.file_path));
      }

      // Handle internal tools
      if (name === "EnterPlanMode") {
        store.setPlanMode(session_id, true);
      } else if (name === "ExitPlanMode") {
        store.setPlanMode(session_id, false);
      } else if (name === "AskUserQuestion") {
        let questions: any[] = [];
        if (Array.isArray(input)) {
          questions = input;
        } else if (input.question || input.options) {
          questions = [input];
        } else {
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

      if (!HIDDEN_TOOLS.has(name)) {
        toolCalls.push({ id: block.id, name, input });
      }
    }
  }

  const trimmedText = text.trim();
  if (trimmedText || toolCalls.length > 0) {
    store.finalizeAssistantMessage(session_id, trimmedText, toolCalls.length > 0 ? toolCalls : undefined);
    return true;
  } else {
    store.clearStreamingText(session_id);
    return false;
  }
}

export function useClaudeEvents() {
  useEffect(() => {
    let unlistenEvent: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let unlistenDiscord: (() => void) | null = null;
    let unlistenPerm: (() => void) | null = null;
    let cancelled = false;

    // Fallback flush: RAF stops firing when the window is backgrounded,
    // so use a setInterval to ensure pending text is still delivered
    const fallbackFlush = setInterval(() => {
      if (pendingText.size > 0) flushPendingText();
    }, 250);

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
          store.setError(session_id, `Failed to parse Claude response — the session may need to be restarted.`);
          return;
        }

        const type = parsed.type;

        // Safety net: if we receive events while isStreaming is false, the process is
        // clearly still running — re-enable streaming. This catches stale claude-done
        // race conditions and any other desync between backend process state and frontend.
        if (type !== "result" && type !== "ping") {
          const sess = store.sessions[session_id];
          if (sess && !sess.isStreaming) {
            store.setStreaming(session_id, true);
          }
          // Touch last-event timestamp so the stuck-streaming timeout measures
          // inactivity instead of total duration
          store.touchLastEvent(session_id);
        }

        if (type === "system" && parsed.subtype === "init") {
          store.setModel(session_id, parsed.model || "");
          store.setStreaming(session_id, true);
          store.setContextUsage(session_id, 0, 200000);
          if (Array.isArray(parsed.mcp_servers)) {
            store.setMcpServers(session_id, parsed.mcp_servers.map((s: any) => ({
              name: String(s.name || ""),
              status: String(s.status || "unknown"),
            })));
          }
          return;
        }

        // ---- Streaming content block events ----

        if (type === "content_block_start") {
          const cb = parsed.content_block;
          if (cb?.type === "tool_use" && cb.id && cb.name) {
            const blocks = pendingBlocks.get(session_id) || [];
            blocks.push({ id: cb.id, type: "tool_use", name: cb.name, inputJson: "" });
            pendingBlocks.set(session_id, blocks);
          }
          return;
        }

        if (type === "content_block_delta") {
          if (parsed.delta?.type === "text_delta" && parsed.delta?.text) {
            const existing = pendingText.get(session_id) || "";
            pendingText.set(session_id, existing + parsed.delta.text);
            scheduleFlush();
          } else if (parsed.delta?.type === "input_json_delta" && parsed.delta?.partial_json) {
            // Accumulate tool input JSON for pending blocks
            const blocks = pendingBlocks.get(session_id);
            if (blocks && blocks.length > 0) {
              blocks[blocks.length - 1].inputJson += parsed.delta.partial_json;
            }
          }
          return;
        }

        if (type === "content_block_stop") {
          // Nothing to do — block is complete, will be finalized on assistant or message_stop
          return;
        }

        if (type === "message_start") {
          store.setStreaming(session_id, true);
          store.clearStreamingText(session_id);
          // Reset per-turn state
          pendingBlocks.delete(session_id);
          assistantFinalized.delete(session_id);
          return;
        }

        // Flush any buffered streaming text before finalization events
        if (type === "assistant" || type === "result" || type === "message_stop") {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushPendingText();
        }

        if (type === "assistant") {
          const msgUsage = parsed.message?.usage || parsed.usage;
          if (msgUsage?.input_tokens) {
            const sess = store.sessions[session_id];
            const ctxMax = sess?.contextMax || 200000;
            store.setContextUsage(session_id, msgUsage.input_tokens, ctxMax);
          }

          // Try both parsed.message.content and parsed.content as fallback
          const content = parsed.message?.content || parsed.content;
          if (Array.isArray(content)) {
            processContentArray(session_id, content, store);
            assistantFinalized.add(session_id);
            pendingBlocks.delete(session_id);
          }
          return;
        }

        // message_stop: end of an assistant turn in the raw streaming protocol.
        // If the synthetic "assistant" event didn't fire (newer CLI versions),
        // finalize from the content blocks we tracked ourselves.
        if (type === "message_stop") {
          if (!assistantFinalized.has(session_id)) {
            const blocks = pendingBlocks.get(session_id);
            const sess = store.sessions[session_id];
            const streamText = sess?.streamingText || "";

            if ((blocks && blocks.length > 0) || streamText.trim()) {
              // Build a synthetic content array from accumulated blocks
              const content: any[] = [];
              if (streamText.trim()) {
                content.push({ type: "text", text: streamText });
              }
              if (blocks) {
                for (const b of blocks) {
                  if (b.type === "tool_use") {
                    let input = {};
                    try { input = JSON.parse(b.inputJson || "{}"); } catch { /* partial JSON */ }
                    content.push({ type: "tool_use", id: b.id, name: b.name, input });
                  }
                }
              }
              processContentArray(session_id, content, store);
            }
          }
          pendingBlocks.delete(session_id);
          assistantFinalized.delete(session_id);
          return;
        }

        // message_delta: may contain usage info at end of turn
        if (type === "message_delta") {
          const usage = parsed.usage;
          if (usage?.input_tokens) {
            const sess = store.sessions[session_id];
            const ctxMax = sess?.contextMax || 200000;
            store.setContextUsage(session_id, usage.input_tokens, ctxMax);
          }
          return;
        }

        if (type === "user") {
          const content = parsed.message?.content || parsed.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const toolId = block.tool_use_id || "";
                const toolName = getSessionMap(sessionToolMaps, session_id).get(toolId);

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

                const filePath = getSessionMap(sessionFilePathMaps, session_id).get(toolId);
                if (filePath && !block.is_error) {
                  store.addModifiedFiles(session_id, [filePath]);
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
          // Clear per-turn tracking so stale blocks don't leak into the next assistant turn
          pendingBlocks.delete(session_id);
          assistantFinalized.delete(session_id);
          return;
        }

        if (type === "result") {
          store.setStreaming(session_id, false);
          if (parsed.total_cost_usd) store.addCost(session_id, parsed.total_cost_usd);
          const input_tokens = parsed.usage?.input_tokens || parsed.input_tokens || 0;
          const output_tokens = parsed.usage?.output_tokens || parsed.output_tokens || 0;
          if (input_tokens || output_tokens) store.addTokens(session_id, input_tokens + output_tokens);
          const sess = store.sessions[session_id];
          const ctxMax = sess?.contextMax || 200000;
          if (input_tokens > 0) {
            store.setContextUsage(session_id, input_tokens, ctxMax);
          } else if (sess && sess.totalTokens > 0) {
            store.setContextUsage(session_id, Math.round(sess.totalTokens * 0.65), ctxMax);
          }
          if (parsed.is_error && parsed.result) store.setError(session_id, parsed.result);
          // Clean up any leftover pending state
          pendingBlocks.delete(session_id);
          assistantFinalized.delete(session_id);
          return;
        }

        // Unknown event type — ignore silently (content_block_stop, etc.)
      });

      if (cancelled) { fn1(); return; }
      unlistenEvent = fn1;

      const fn2 = await onClaudeDone((payload) => {
        if (cancelled) return;
        // Flush any RAF-buffered text before cleanup
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        flushPendingText();

        const store = useClaudeStore.getState();
        // If streaming text exists but was never finalized by a result/assistant event
        // (e.g. process died mid-stream), preserve it as a message instead of losing it
        const session = store.sessions[payload.session_id];
        if (session?.streamingText?.trim()) {
          store.finalizeAssistantMessage(payload.session_id, session.streamingText.trim());
        }
        // Guarantee a true→false streaming transition so store subscribers
        // (e.g. delegation orchestrator) detect process exit even when
        // isStreaming was already false from an earlier result event.
        const current = useClaudeStore.getState().sessions[payload.session_id];
        if (current && !current.isStreaming) {
          store.setStreaming(payload.session_id, true);
        }
        store.setStreaming(payload.session_id, false);
        store.clearStreamingText(payload.session_id);
        // Clean up session's maps to prevent unbounded growth
        sessionToolMaps.delete(payload.session_id);
        sessionFilePathMaps.delete(payload.session_id);
        pendingBlocks.delete(payload.session_id);
        assistantFinalized.delete(payload.session_id);
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

    // Clean up module-scoped maps when sessions are removed from the store
    // (handles cases where claude-done never fires, e.g. user closes panel)
    const unsubStore = useClaudeStore.subscribe((state, prev) => {
      for (const id of Object.keys(prev.sessions)) {
        if (!state.sessions[id]) {
          sessionToolMaps.delete(id);
          sessionFilePathMaps.delete(id);
          pendingText.delete(id);
          pendingBlocks.delete(id);
          assistantFinalized.delete(id);
        }
      }
    });

    return () => {
      cancelled = true;
      clearInterval(fallbackFlush);
      unsubStore();
      unlistenEvent?.(); unlistenDone?.(); unlistenDiscord?.(); unlistenPerm?.();
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pendingText.clear();
      pendingBlocks.clear();
      assistantFinalized.clear();
    };
  }, []);
}
