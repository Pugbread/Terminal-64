# Codex tool-call persistence on resume

## (a) Current behavior

`load_codex_history_by_thread` in `src-tauri/src/providers/codex.rs:751` walks the rollout JSONL and emits `HistoryMessage`s only for envelopes whose `type == "response_item"` AND `payload.type == "message"` (filter at line 773). Every other `response_item.payload.type` is silently dropped. `tool_calls` is therefore always `None` (line 818). The frontend pipes the result through `mapHistoryMessages` (`src/lib/tauriApi.ts:212`) → `loadFromDisk` (`src/stores/claudeStore.ts:747`); with no tool calls in the data, the rendered chat is text-only and tool diffs/commands disappear after a reload.

## (b) Why it fails for Codex

Catalogued `payload.type` values across every JSONL under `~/.codex/sessions/` (envelope `type` first, then nested `payload.type`):

```
envelope.type:         response_item | event_msg | turn_context | session_meta
response_item.payload.type:
  message                 (user / assistant text — already handled)
  reasoning               (assistant chain-of-thought summary[].text + encrypted_content)
  function_call           (tool request: { name, arguments: JSON-string, call_id })
  function_call_output    (tool result:  { call_id, output: string })
  web_search_call         (built-in search: { status, action: { type, query, queries } })
  local_shell_call / local_shell_call_output  (upstream schema; not in current samples)
  mcp_tool_call           (upstream schema; not in current samples)
event_msg.payload.type: task_started, task_complete, token_count,
                        agent_message, user_message  (all duplicate response_item.message — skip)
```

So every shell command, file edit, web search, and MCP call performed by Codex IS in the rollout but is currently filtered out. The live event stream already renders these correctly (`useClaudeEvents.ts:854-952`: `item.started` pushes a tool, `item.completed` calls `updateToolResult(sessionId, item.id, item.output, isError)`); reload just loses them.

## (c) Minimal fix

Extend `load_codex_history_by_thread` (codex.rs:751–822) to walk the same loop but build `HistoryToolCall` rows alongside text messages. Schema is in `src/lib/types.ts:266` (`{ id, name, input, result?, is_error? }`).

**Algorithm (single pass, preserves order):**

1. Keep two locals: `out: Vec<HistoryMessage>` and `pending_tools: HashMap<String /*call_id*/, (msg_idx, tc_idx)>`.
2. On `payload.type == "message"` role=assistant/user → push as today (existing branch).
3. On `payload.type == "function_call"`:
   - `id = payload.call_id` (string, matches what live `item.id` carries — keys equal across resume + live)
   - `name = payload.name`
   - `input = serde_json::from_str(payload.arguments).unwrap_or_else(|_| json!({"_raw": payload.arguments}))`
   - If the last `out` entry is an assistant message **without** intervening user message → append the `HistoryToolCall` to its `tool_calls` (initialise `Some(vec![])` lazily). Otherwise push a synthetic `HistoryMessage { role: "assistant", content: "", tool_calls: Some(vec![tc]), id: format!("codex-tools-{call_id}") }`. Record `(msg_idx, tc_idx)` in `pending_tools` keyed by `call_id`.
4. On `payload.type == "function_call_output"` → look up `pending_tools[call_id]`, set `tc.result = Some(payload.output)`, `tc.is_error = Some(detect_shell_failure(&output))` (regex `r"Process exited with code (\d+)"` → non-zero ⇒ true; otherwise false).
5. On `payload.type == "web_search_call"` → synthesise `HistoryToolCall { id: format!("ws-{idx}"), name: "web_search", input: json!({"query": action.query, "queries": action.queries}), result: Some(status.clone()), is_error: Some(status != "completed") }`. Same attach-to-last-assistant logic.
6. On `local_shell_call` / `mcp_tool_call` → identical pattern using upstream field names (`action.command`, `server.tool`, etc.).
7. On `payload.type == "reasoning"` → skip (live handler at `useClaudeEvents.ts:917` also drops it; no UI yet).
8. Skip `turn_context`, `session_meta`, all `event_msg.*`.

No frontend change needed — `mapHistoryMessages` already converts `tool_calls` → `ChatMessage.toolCalls` (`tauriApi.ts:215-221`) and `ChatMessage.tsx` already renders them for the live path.

## t3code cross-reference

`apps/server/src/provider/Layers/CodexAdapter.ts` lines 202–250: `toCanonicalItemType()` and `itemTitle()` define the same taxonomy — `assistant_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`, `web_search`, `image_view`, `error`. `mapItemLifecycle()` (line 433) shows the canonical lifecycle mapping (`item.started/updated/completed` → `inProgress|completed`). t3code consumes Codex’s **app-server** notification stream (JSON-RPC), not rollout JSONL — they do not solve our exact problem, but the bucket list above mirrors theirs 1:1, so the canonical names are safe.
