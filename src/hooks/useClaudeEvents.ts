import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { onClaudeEvent, onClaudeDone, cancelClaude, sendClaudePrompt } from "../lib/tauriApi";
import { useClaudeStore, type ClaudeTask } from "../stores/claudeStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { ToolCall, HookEventPayload, HookEvent, HookEventType } from "../lib/types";

// --- Claude CLI stream JSON types ---

interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ClaudeContentBlock[];
  tool_use_id?: string;
  is_error?: boolean;
  parentToolUseId?: string;
}

interface ClaudeQuestion {
  question?: string;
  text?: string;
  description?: string;
  header?: string;
  options?: (string | { label?: string; description?: string })[];
  multiSelect?: boolean;
}

interface ClaudeMcpServerRaw {
  name?: string;
  status?: string;
  error?: string;
  type?: string;
  transport?: string;
  scope?: string;
  tools?: { name?: string; description?: string }[];
}

interface ClaudeModelUsageEntry {
  contextWindow?: number;
  [key: string]: unknown;
}

interface PermissionRequestPayload {
  request_id: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** Loosely-typed parsed event from the Claude CLI stream-JSON output.
 *  The CLI emits many event shapes — this captures common fields. */
interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  event?: ClaudeStreamEvent;
  parent_tool_use_id?: string;
  model?: string;
  mcp_servers?: ClaudeMcpServerRaw[];
  content_block?: { type: string; id?: string; name?: string; thinking?: string };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  message?: {
    content?: ClaudeContentBlock[];
    usage?: ClaudeUsage;
    stop_reason?: string;
    attachments?: ClaudeAttachment[];
  };
  content?: ClaudeContentBlock[];
  usage?: ClaudeUsage;
  total_cost_usd?: number;
  output_tokens?: number;
  is_error?: boolean;
  result?: string;
  modelUsage?: Record<string, ClaudeModelUsageEntry>;
  // Top-level error events from Claude CLI (rate limit, API error, overloaded, etc.)
  error?: { type?: string; message?: string } | string;
  message_text?: string;
}

interface ClaudeAttachment {
  type: string;
  message?: string;
  path?: string;
  stderr?: string;
  max_turns?: number;
}

const sessionToolMaps = new Map<string, Map<string, string>>();
const sessionFilePathMaps = new Map<string, Map<string, string>>();

const MAX_TOOL_MAP_ENTRIES = 2000;
function getSessionMap(store: Map<string, Map<string, string>>, sessionId: string): Map<string, string> {
  let map = store.get(sessionId);
  if (!map) {
    map = new Map();
    store.set(sessionId, map);
  }
  return map;
}

function evictIfNeeded(map: Map<string, string>) {
  if (map.size > MAX_TOOL_MAP_ENTRIES) {
    const excess = map.size - MAX_TOOL_MAP_ENTRIES;
    const iter = map.keys();
    for (let i = 0; i < excess; i++) { map.delete(iter.next().value!); }
  }
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

// Default context window — the CLI's `result` event provides the real value
// via modelUsage.contextWindow, but for 1M variants the CLI sometimes still
// reports 200k which makes the percentage overshoot (e.g. 200% at 40% real
// usage). Detect the `[1m]` suffix the CLI appends to extended-context model
// IDs and return 1M so the ratio is correct regardless of what the CLI says.
function getContextWindowForModel(model: string): number {
  if (/\[1m\]|-1m\b|:1m\b/i.test(model)) return 1_000_000;
  return 200_000;
}

/** Sum all input token fields to get total context usage for a turn */
function totalInputTokens(usage: ClaudeUsage | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

// Per-session pending content blocks — tracks tool calls from content_block_start
// events so we can finalize even if the synthetic "assistant" event never arrives.
interface PendingBlock {
  id: string;
  type: string;
  name?: string;
  inputJson: string; // accumulate input_json_delta chunks
  parentToolUseId?: string;
}
const pendingBlocks = new Map<string, PendingBlock[]>();
// Track whether the assistant event already finalized for this turn
const assistantFinalized = new Set<string>();

function processContentArray(
  session_id: string,
  content: ClaudeContentBlock[],
  store: ReturnType<typeof useClaudeStore.getState>,
): boolean {
  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      const name = block.name ?? "";
      const blockId = block.id ?? "";
      const input = block.input || {};
      const toolMap = getSessionMap(sessionToolMaps, session_id);
      toolMap.set(blockId, name);
      evictIfNeeded(toolMap);

      if ((name === "Write" || name === "Edit" || name === "MultiEdit") && input.file_path) {
        const fileMap = getSessionMap(sessionFilePathMaps, session_id);
        fileMap.set(blockId, String(input.file_path));
        evictIfNeeded(fileMap);
      }

      if (name === "EnterPlanMode") {
        store.setPlanMode(session_id, true);
      } else if (name === "ExitPlanMode") {
        store.setPlanMode(session_id, false);
      } else if (name === "AskUserQuestion") {
        let questions: ClaudeQuestion[] = [];
        if (Array.isArray(input)) {
          questions = input as ClaudeQuestion[];
        } else if (input.question || input.options) {
          questions = [input as ClaudeQuestion];
        } else {
          const vals = Object.values(input);
          const arr = vals.find((v) => Array.isArray(v));
          if (arr) questions = arr as ClaudeQuestion[];
          else questions = [{ question: (input.description as string) || (input.text as string) || "Claude has a question", options: [] }];
        }

        const items = questions.map((q) => ({
          question: q.question || q.text || q.description || "Question",
          header: q.header,
          options: (q.options || []).map((o) =>
            typeof o === "string" ? { label: o } : { label: o.label || String(o), description: o.description }
          ),
          multiSelect: q.multiSelect || false,
        }));

        if (items.length > 0) {
          store.setPendingQuestions(session_id, {
            toolUseId: blockId,
            items,
            currentIndex: 0,
            answers: [],
          });
          cancelClaude(session_id).catch(() => {});
          store.setStreaming(session_id, false);
        }
      } else if (name === "TaskCreate") {
        store.addTask(session_id, {
          id: blockId,
          subject: String(input.subject || input.title || "Task"),
          description: input.description ? String(input.description) : undefined,
          status: "pending",
        });
      } else if (name === "TaskUpdate") {
        if (input.taskId) {
          store.updateTask(session_id, String(input.taskId), {
            ...(input.status ? { status: String(input.status) as ClaudeTask["status"] } : {}),
            ...(input.subject ? { subject: String(input.subject) } : {}),
          });
        }
      }

      if (!HIDDEN_TOOLS.has(name)) {
        toolCalls.push({ id: blockId, name, input, parentToolUseId: block.parentToolUseId });
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
    let unlistenPerm: (() => void) | null = null;
    const unlistenHooks: (() => void)[] = [];
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

        let parsed: ClaudeStreamEvent;
        try {
          parsed = JSON.parse(data) as ClaudeStreamEvent;
        } catch (err) {
          console.warn("[claude] Failed to parse event:", data.slice(0, 200), err);
          store.setError(session_id, `Failed to parse Claude response — the session may need to be restarted.`);
          return;
        }

        // Unwrap stream_event envelope — Claude CLI wraps raw streaming API
        // events (content_block_start, content_block_delta, etc.) inside a
        // { type: "stream_event", event: {...}, parent_tool_use_id?: "..." }
        // wrapper. Extract the inner event so existing handlers process it.
        let streamParentToolUseId: string | undefined;
        if (parsed.type === "stream_event" && parsed.event) {
          streamParentToolUseId = parsed.parent_tool_use_id;
          parsed = parsed.event;
        }

        const type: string = parsed.type;

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
          const model = String(parsed.model || "");
          store.setModel(session_id, model);
          store.setStreaming(session_id, true);
          // Only update contextMax — preserve existing contextUsed so the
          // topbar badge doesn't vanish between turns.
          const prevUsed = store.sessions[session_id]?.contextUsed || 0;
          store.setContextUsage(session_id, prevUsed, getContextWindowForModel(model));
          if (Array.isArray(parsed.mcp_servers)) {
            store.setMcpServers(session_id, parsed.mcp_servers.map((s) => {
              const tools = Array.isArray(s.tools) ? s.tools.map((t) => ({
                name: String(t.name || ""),
                ...(t.description ? { description: String(t.description) } : {}),
              })) : undefined;
              return {
                name: String(s.name || ""),
                status: String(s.status || "unknown"),
                ...(s.error ? { error: String(s.error) } : {}),
                ...(s.type || s.transport ? { transport: String(s.type || s.transport) } : {}),
                ...(s.scope ? { scope: String(s.scope) } : {}),
                ...(tools ? { tools, toolCount: tools.length } : {}),
              };
            }));
          }
          return;
        }

        // Top-level error from the CLI (API rate limit, overloaded, auth failure, etc.)
        // Without this handler the spinner never stops — the "safety net" above would
        // keep re-enabling streaming on every subsequent event.
        if (type === "error") {
          const errMsg =
            typeof parsed.error === "string"
              ? parsed.error
              : parsed.error?.message || parsed.result || parsed.message_text || "Claude reported an error.";
          store.setError(session_id, errMsg);
          store.setStreaming(session_id, false);
          store.clearStreamingText(session_id);
          pendingBlocks.delete(session_id);
          assistantFinalized.delete(session_id);
          return;
        }

        // Claude CLI emits stream_request_start at the beginning of each underlying
        // API call in a multi-turn session. Treat it like message_start so stale
        // pending blocks from a prior turn don't leak into the new one.
        if (type === "stream_request_start") {
          store.setStreaming(session_id, true);
          pendingBlocks.delete(session_id);
          assistantFinalized.delete(session_id);
          return;
        }

        // ---- Streaming content block events ----

        if (type === "content_block_start") {
          const cb = parsed.content_block;
          if (cb?.type === "tool_use" && cb.id && cb.name) {
            const blocks = pendingBlocks.get(session_id) || [];
            blocks.push({ id: cb.id, type: "tool_use", name: cb.name, inputJson: "", parentToolUseId: streamParentToolUseId });
            pendingBlocks.set(session_id, blocks);
          }
          // Other block types (text, thinking) don't need tracking here — text deltas
          // go to pendingText directly, thinking deltas are discarded until we wire up
          // a thinking-block UI. Explicitly ignoring thinking prevents its input_json_delta
          // from ever being misattributed to a tool_use block.
          return;
        }

        if (type === "content_block_delta") {
          const d = parsed.delta;
          if (d?.type === "text_delta" && d.text) {
            const existing = pendingText.get(session_id) || "";
            pendingText.set(session_id, existing + d.text);
            scheduleFlush();
          } else if (d?.type === "input_json_delta" && d.partial_json) {
            const blocks = pendingBlocks.get(session_id);
            // Only accumulate onto a tool_use block. If the most recent content block
            // was thinking/text (not tracked here), this delta is unrelated to any
            // pending tool_use and must be ignored.
            if (blocks && blocks.length > 0 && blocks[blocks.length - 1].type === "tool_use") {
              blocks[blocks.length - 1].inputJson += d.partial_json;
            }
          }
          // thinking_delta / signature_delta are intentionally dropped — no UI yet
          return;
        }

        if (type === "content_block_stop") {
          // Nothing to do — block is complete, will be finalized on assistant or message_stop
          return;
        }

        if (type === "message_start") {
          store.setStreaming(session_id, true);
          store.clearStreamingText(session_id);
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
          const totalIn = totalInputTokens(msgUsage);
          if (totalIn > 0) {
            const sess = store.sessions[session_id];
            const ctxMax = sess?.contextMax || getContextWindowForModel(sess?.model || "");
            store.setContextUsage(session_id, totalIn, ctxMax);
          }

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
              const content: ClaudeContentBlock[] = [];
              if (streamText.trim()) {
                content.push({ type: "text", text: streamText });
              }
              if (blocks) {
                for (const b of blocks) {
                  if (b.type === "tool_use") {
                    let input = {};
                    try { input = JSON.parse(b.inputJson || "{}"); } catch { /* partial JSON */ }
                    content.push({ type: "tool_use", id: b.id, name: b.name, input, parentToolUseId: b.parentToolUseId });
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

        // message_delta: may contain usage info and stop_reason at end of turn
        if (type === "message_delta") {
          const totalIn = totalInputTokens(parsed.usage);
          if (totalIn > 0) {
            const sess = store.sessions[session_id];
            const ctxMax = sess?.contextMax || getContextWindowForModel(sess?.model || "");
            store.setContextUsage(session_id, totalIn, ctxMax);
          }
          // Surface non-normal stop reasons (refusal, pause_turn, max_tokens) — these
          // currently vanish silently and leave the user wondering why the turn ended.
          const sr = parsed.delta?.stop_reason;
          if (sr === "refusal") {
            store.setError(session_id, "Claude declined to continue (policy refusal).");
          } else if (sr === "max_tokens") {
            store.setError(session_id, "Response cut off — hit max_tokens. Ask Claude to continue.");
          }
          // pause_turn / tool_use / end_turn are normal flow — no surface needed
          return;
        }

        if (type === "user") {
          const content = parsed.message?.content || parsed.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const toolId = block.tool_use_id || "";
                const toolName = getSessionMap(sessionToolMaps, session_id).get(toolId);

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

                if (toolName && HIDDEN_TOOLS.has(toolName)) continue;

                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content.map((c: ClaudeContentBlock) => c.type === "text" ? c.text : JSON.stringify(c)).join("\n")
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
          const resultUsage = parsed.usage || {};
          const totalIn = totalInputTokens(resultUsage);
          const output_tokens = resultUsage.output_tokens || parsed.output_tokens || 0;
          if (totalIn || output_tokens) store.addTokens(session_id, totalIn + output_tokens);

          const sess = store.sessions[session_id];
          const modelCtx = getContextWindowForModel(sess?.model || "");
          let ctxMax = sess?.contextMax || modelCtx;
          if (parsed.modelUsage) {
            for (const modelData of Object.values(parsed.modelUsage)) {
              if (modelData?.contextWindow && modelData.contextWindow > 0) {
                ctxMax = modelData.contextWindow;
                break;
              }
            }
          }
          // Guard against the CLI reporting 200k for 1M variants — trust the
          // name-derived size when it's larger so the percentage stays sane.
          if (modelCtx > ctxMax) ctxMax = modelCtx;
          // Only update ctxMax here — the `assistant` event already set the
          // correct per-turn contextUsed.  The `result` event's usage is
          // cumulative across the session which would overcount.
          if (ctxMax !== (sess?.contextMax || 0)) {
            store.setContextUsage(session_id, sess?.contextUsed || 0, ctxMax);
          }
          // Auto-compact check (fresh read — prior set() calls have settled)
          const freshSess = useClaudeStore.getState().sessions[session_id];
          const settings = useSettingsStore.getState();
          if (
            settings.autoCompactEnabled &&
            freshSess &&
            freshSess.autoCompactStatus === "idle" &&
            freshSess.contextMax > 0 &&
            freshSess.contextUsed > 0 &&
            !parsed.is_error
          ) {
            const pct = (freshSess.contextUsed / freshSess.contextMax) * 100;
            if (pct >= settings.autoCompactThreshold) {
              useClaudeStore.getState().setAutoCompactStatus(session_id, "compacting");
              setTimeout(() => {
                const s = useClaudeStore.getState().sessions[session_id];
                if (!s || s.isStreaming) return;
                useClaudeStore.getState().addUserMessage(session_id, "/compact");
                useClaudeStore.getState().setStreaming(session_id, true);
                sendClaudePrompt({
                  session_id,
                  cwd: s.cwd || ".",
                  prompt: "/compact",
                  permission_mode: "auto",
                }, s.skipOpenwolf).catch((err) => {
                  useClaudeStore.getState().setError(session_id, `Auto-compact failed: ${err}`);
                  useClaudeStore.getState().setAutoCompactStatus(session_id, "idle");
                });
              }, 500);
            }
          } else if (freshSess?.autoCompactStatus === "compacting") {
            useClaudeStore.getState().setAutoCompactStatus(session_id, "done");
          }

          if (parsed.is_error && parsed.result) store.setError(session_id, parsed.result);
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
        sessionToolMaps.delete(payload.session_id);
        sessionFilePathMaps.delete(payload.session_id);
        pendingBlocks.delete(payload.session_id);
        assistantFinalized.delete(payload.session_id);
      });
      if (cancelled) { fn2(); return; }
      unlistenDone = fn2;

      // Listen for permission requests from the hook server
      const fn4 = await listen<PermissionRequestPayload>(
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

      // Listen for Claude hook lifecycle events
      const HOOK_EVENTS: HookEventType[] = [
        "PreToolUse", "PostToolUse", "Stop",
        "SubagentStart", "SubagentStop", "Notification",
        "PreCompact", "PostCompact", "SessionStart", "SessionEnd",
      ];
      for (const hookType of HOOK_EVENTS) {
        const fn = await listen<HookEventPayload>(
          `claude-hook-${hookType}`,
          (event) => {
            if (cancelled) return;
            const p = event.payload;
            const store = useClaudeStore.getState();
            const hookEvent: HookEvent = {
              type: hookType,
              sessionId: p.session_id,
              timestamp: Date.now(),
              toolName: p.tool_name,
              toolInput: p.tool_input,
              toolResult: p.tool_result,
              subagentId: p.subagent_id,
              message: p.message,
              reason: p.reason,
            };
            store.addHookEvent(p.session_id, hookEvent);

            if (hookType === "PostToolUse" && p.tool_name) {
              store.recordToolUsage(p.session_id, p.tool_name);
            } else if (hookType === "PostCompact") {
              store.incrementCompactionCount(p.session_id);
            } else if (hookType === "SubagentStart" && p.subagent_id) {
              store.addSubagent(p.session_id, p.subagent_id);
            } else if (hookType === "SubagentStop" && p.subagent_id) {
              store.removeSubagent(p.session_id, p.subagent_id);
            }
          }
        );
        if (cancelled) { fn(); return; }
        unlistenHooks.push(fn);
      }
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
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      flushPendingText();
      unsubStore();
      unlistenEvent?.(); unlistenDone?.(); unlistenPerm?.();
      for (const u of unlistenHooks) u();
      pendingText.clear();
      pendingBlocks.clear();
      assistantFinalized.clear();
    };
  }, []);
}
