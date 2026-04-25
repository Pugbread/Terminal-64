# 02 — t3code's Claude adapter, mapped against T64's `claude_manager.rs`

**Sources** (read-only):
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` (3,263 lines) — adapter wrapping `@anthropic-ai/claude-agent-sdk`
- `apps/server/src/provider/Layers/ClaudeProvider.ts` (929 lines) — provider snapshot + status checks

> **Critical framing fact** — t3code's adapter does **not** spawn `claude` directly. It calls `query()` from the Anthropic-published `@anthropic-ai/claude-agent-sdk` npm package. The SDK spawns the CLI under the hood at `pathToClaudeCodeExecutable`, which is passed in. T64, by contrast, spawns the CLI itself with `std::process::Command` and parses raw `stream-json` from stdout. So the comparison is "T64's hand-rolled stdout parser" vs. "t3code's SDK-mediated `AsyncIterable<SDKMessage>` consumer."
>
> `ClaudeProvider.ts` is the only place that spawns the binary directly — for `claude --version` and `claude auth status` health probes (`runClaudeCommand`, line 622) — and once for an SDK-based "capabilities probe" that aborts before any prompt reaches the API (`probeClaudeCapabilities`, line 583).

---

## (a) Subprocess invocation

### t3code — there is no direct `spawn` of `claude` for chat sessions

The chat session is created by handing `query()` an options bag:

```ts
// ClaudeAdapter.ts:2867-2891
const queryOptions: ClaudeQueryOptions = {
  ...(input.cwd ? { cwd: input.cwd } : {}),
  ...(apiModelId ? { model: apiModelId } : {}),
  pathToClaudeCodeExecutable: claudeBinaryPath,
  settingSources: [...CLAUDE_SETTING_SOURCES],   // ["user","project","local"]
  ...(effectiveEffort ? { effort: ... } : {}),
  ...(permissionMode ? { permissionMode } : {}), // "acceptEdits" | "bypassPermissions" | "plan" | "default"
  ...(permissionMode === "bypassPermissions"
    ? { allowDangerouslySkipPermissions: true } : {}),
  ...(Object.keys(settings).length > 0 ? { settings } : {}),  // alwaysThinkingEnabled, fastMode
  ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
  ...(newSessionId ? { sessionId: newSessionId } : {}),
  includePartialMessages: true,
  canUseTool,                        // permission callback — see (d)
  env: process.env,
  ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
  ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}), // user-supplied launch flags
};
// :2918 — actual launch
const queryRuntime = createQuery({ prompt, options: queryOptions });
```

`runtimeMode` (`"full-access"` / `"auto-accept-edits"`) is mapped to SDK `permissionMode` via a small dict at line 2857. `claudeSettings.binaryPath` and `claudeSettings.launchArgs` come from `ServerSettingsService` (line 2823). `extraArgs` is parsed from launch args and passed through verbatim (line 2836).

The only direct `ChildProcess.make` calls live in `ClaudeProvider.ts:627`:
```ts
const command = ChildProcess.make(claudeSettings.binaryPath, [...args], {
  shell: process.platform === "win32",
});
```
…used by `runClaudeCommand(["--version"])` and `runClaudeCommand(["auth", "status"])` only.

### T64 — direct subprocess, hand-built argv

`build_command` (`claude_manager.rs:384-527`) constructs:

```
<resolved-claude-bin> \
  --print --output-format stream-json --verbose --include-partial-messages \
  --session-id <uuid>            # OR --resume <id>
  --permission-mode <mode>       # bypassPermissions | acceptEdits | plan | auto | default
  [--model <slug>]
  [--effort <level>]
  --disallowed-tools <csv>       # always merges in ScheduleWakeup (always_disallowed)
  [--settings <path>]
  [--dangerously-load-development-channels server:<url>]
  [--mcp-config <path> --strict-mcp-config]
  [--mcp-config <approver_path> --permission-prompt-tool mcp__t64__approve]
  [--resume-session-at <uuid>]   # rewind point
  [--max-turns N]
  [--max-budget-usd $]
  [--no-session-persistence]
  [--fork-session <parent-id>]
```

The prompt is **piped via stdin**, not as a positional arg, with this comment at `claude_manager.rs:517-521`:

> "Prompt is sent via stdin … because cmd.exe (used by `shim_command` on Windows) truncates arguments at literal newline characters, silently losing multi-line prompts."

`shim_command` (line 366) wraps Windows invocations in `cmd /C` with `CREATE_NO_WINDOW` (0x08000000) to suppress console flash. Binary resolution uses `which`/`where` plus a candidate list of well-known install dirs (`resolve_claude_path`, line 8).

---

## (b) Stream parsing → `ProviderRuntimeEvent`

### t3code

The adapter consumes `AsyncIterable<SDKMessage>` (typed by the SDK), not raw JSON lines. `runSdkStream` (`ClaudeAdapter.ts:2342`) wraps the iterable in an Effect `Stream` and routes each message through `handleSdkMessage` (line 2303):

```ts
switch (message.type) {
  case "stream_event":   handleStreamEvent;       // partial deltas
  case "user":           handleUserMessage;       // tool_result blocks
  case "assistant":      handleAssistantMessage;  // full assistant snapshot, ExitPlanMode capture
  case "result":         handleResultMessage;     // turn end + token usage
  case "system":         handleSystemMessage;     // init/status/hooks/tasks/files
  case "tool_progress":
  case "tool_use_summary":
  case "auth_status":
  case "rate_limit_event":
                         handleSdkTelemetryMessage;
}
```

The exhaustive native→canonical table:

| SDK message (`message.type` / `subtype` / nested) | Canonical `ProviderRuntimeEvent.type` | Notes / source line |
|---|---|---|
| `stream_event` → `content_block_delta` (`text_delta`) | `content.delta` (`streamKind: "assistant_text"`) | 1575 |
| `stream_event` → `content_block_delta` (`thinking_delta`) | `content.delta` (`streamKind: "reasoning_text"`) | 1582 |
| `stream_event` → `content_block_delta` (`input_json_delta`) | `item.updated` (with growing tool input); also `turn.plan.updated` if `TodoWrite` | 1631 / 1701 |
| `stream_event` → `content_block_start` (`text`) | (open assistant text block, no event yet) | 1729 |
| `stream_event` → `content_block_start` (`tool_use` / `server_tool_use` / `mcp_tool_use`) | `item.started` | 1734-1794 |
| `stream_event` → `content_block_stop` | `item.completed` (for assistant text) | 1797 |
| `user` (with `tool_result` blocks) | `item.updated` → `content.delta` (`command_output` / `file_change_output`) → `item.completed` | 1815-1923 |
| `assistant` (full snapshot) | back-fill assistant blocks + emit `turn.proposed.completed` if it contains an `ExitPlanMode` tool_use | 1925-2010 |
| `result` (any subtype) | `turn.completed` (status from `turnStatusFromResult`: `completed` / `interrupted` / `cancelled` / `failed`) + preceded by `thread.token-usage.updated` | 2012-2028, 1390-1563 |
| `system` / `init` | `session.configured` | 2055 |
| `system` / `status` | `session.state.changed` (`state: running`/`waiting`) | 2064 |
| `system` / `compact_boundary` | `thread.state.changed` (`state: "compacted"`) | 2075 |
| `system` / `hook_started` | `hook.started` | 2085 |
| `system` / `hook_progress` | `hook.progress` | 2096 |
| `system` / `hook_response` | `hook.completed` | 2108 |
| `system` / `task_started` | `task.started` | 2122 |
| `system` / `task_progress` | `task.progress` (+ `thread.token-usage.updated` if `usage` present) | 2133 |
| `system` / `task_notification` | `task.completed` (+ token usage) | 2165 |
| `system` / `files_persisted` | `files.persisted` | 2196 |
| `system` / *unknown subtype* | `runtime.warning` | 2218 |
| `tool_progress` | `tool.progress` | 2248 |
| `tool_use_summary` | `tool.summary` | 2262 |
| `auth_status` | `auth.status` | 2278 |
| `rate_limit_event` | `account.rate-limits.updated` | 2291 |
| `session_id` first appears (any non-hook system msg) | `thread.started` (only emitted once per id change) | 1257-1293 |

Synthetic emissions (no incoming SDK message):
- `turn.started` at start of `sendTurn` (line 3106) and a "synthetic" turn auto-opened when an assistant message arrives outside an active turn (1925-1972).
- `request.opened` / `request.resolved` from the `canUseTool` flow.
- `user-input.requested` / `user-input.resolved` from the `AskUserQuestion` flow.
- `session.started`, `session.configured`, `session.state.changed`, `session.exited` around lifecycle.
- `runtime.error` / `runtime.warning` for stream failures.

Every emitted event carries an `eventId` (`Random.nextUUIDv4`), `createdAt` (ISO via Effect's `DateTime`), `provider: "claudeAgent"`, the canonical `threadId`/`turnId`/`itemId` IDs, plus a `raw` envelope `{ source: "claude.sdk.message" | "claude.sdk.permission", method, payload }` containing the original SDK message. Token usage normalisation lives in `normalizeClaudeTokenUsage` (305) and `maxClaudeContextWindowFromModelUsage` (291).

### T64

`spawn_and_stream` (`claude_manager.rs:552`) reads stdout line-by-line on a `std::thread`:

```rust
for line in reader.lines() {
    let data = cap_event_size(line);                                 // 645
    handle.emit("claude-event", ClaudeEvent { session_id, data });   // 646-652
}
```

That's the entire backend "parser." The Rust side does **zero** event-type discrimination. Two transformations are applied to the raw line before emission:

1. `cap_event_size` (line 282) — if the JSON line exceeds 512 KiB, parse it, walk `/message/content[*]` arrays, and `truncate_text_field` (head 96 KiB + tail 96 KiB sandwiching a `[Terminal 64: truncated N bytes …]` marker) on `tool_result.content` and `text` blocks. Hard byte-cap fallback if structure is unexpected.
2. If the child produced no stdout, synthesize a `{type:"result", subtype:"error", is_error:true, result:<stderr>}` line so the frontend doesn't hang. Specifically detects "unrecognized argument: --session-id" via `stderr_rejects_session_id_flag` (546) and surfaces it as a typed `claude_cli_rejects_session_id:` prefix.

The actual SDK-message → UI-event mapping happens in **`src/hooks/useClaudeEvents.ts`** (frontend) — outside the scope of this file but worth flagging: T64 has no Rust analogue of `ProviderRuntimeEvent`, only TS-side parsing on top of the firehose.

A second Tauri event, `claude-done`, is emitted when the reader thread exits (line 723) — but only if the instance's `generation` counter still matches (701-720), so that re-spawning the CLI mid-stream doesn't false-flip the frontend's `isStreaming` to `false`.

---

## (c) Session lifecycle

### t3code — long-running interactive query, prompt as AsyncIterable

| Phase | Implementation | File ref |
|---|---|---|
| **Start** | `startSession` (2478): generate or resume `sessionId` (`Random.nextUUIDv4` if no `resumeCursor.resume`); build `Queue<PromptQueueItem>`; convert to `AsyncIterable<SDKUserMessage>`; call `createQuery({prompt, options})`; emit `session.started`/`session.configured`/`session.state.changed{ready}`; fork `runSdkStream` onto a fiber via `Effect.runForkWith`. If a session already exists for the threadId, replace it (best-effort `stopSessionInternal`). | 2478-3041 |
| **Send turn** | `sendTurn` (3044): if `turnState` exists, auto-complete it as `"completed"` (handles dangling synthetic turns from background subagents); if model changed, `await context.query.setModel(...)`; if `interactionMode === "plan"|"default"`, `context.query.setPermissionMode(...)`; mint `turnId`; build `SDKUserMessage` (text + base64 image attachments); `Queue.offer(promptQueue, { type: "message", message })`. Returns `{threadId, turnId, resumeCursor}`. | 3044-3135 |
| **Interrupt** | `interruptTurn` (3137): `await context.query.interrupt()`. The SDK propagates abort to the subprocess; `isClaudeInterruptedCause` (250) recognises the resulting cause and `completeTurn` emits `turn.completed{state: "interrupted"}`. | 3137-3145 |
| **Resume** | Resume cursor `{threadId, resume, resumeSessionAt, turnCount}` is updated on every system/assistant message via `updateResumeCursor` (1058). Passed back into `startSession.input.resumeCursor` next time → SDK option `resume: existingResumeSessionId`. The validity check `isUuid` rejects junk; synthetic ids prefixed `claude-thread-` are skipped. | 370-405, 1058-1076, 2510-2515 |
| **Stop** | `stopSessionInternal` (2381): cancel all pending approvals (`Deferred.succeed(decision, "cancel")` + emit `request.resolved`); complete current turn as `"interrupted"`; `Queue.shutdown(promptQueue)`; `Fiber.interrupt(streamFiber)`; `context.query.close()`; emit `session.exited`; remove from `sessions` map. | 2381-2453 |
| **Read** | `readThread` (3147) returns `snapshotThread` — `{threadId, turns: [{id, items:[...]}]}`. | 3147-3152, 1040-1056 |
| **Rollback** | `rollbackThread(threadId, numTurns)` (3154): `context.turns.splice(turns.length - numTurns)`; recompute resume cursor; return new snapshot. The SDK keeps its own state, so this only rewinds the *adapter's* turn ledger — actual replay relies on the resume cursor. | 3154-3162 |
| **List / has** | `listSessions` (3207), `hasSession` (3210) — pure map reads. | |
| **Stop all** | `stopAll` (3216) + Effect finalizer (3226) — graceful teardown on layer disposal. | |

State container: `ClaudeSessionContext` (152-174) — holds `query` runtime, `promptQueue`, `streamFiber`, `pendingApprovals`, `pendingUserInputs`, `turns`, `inFlightTools`, `turnState`, token-usage memos, etc. Sessions are keyed by `ThreadId` in `Map<ThreadId, ClaudeSessionContext>` (990).

### T64 — re-spawn-per-prompt

| Phase | Implementation | File ref |
|---|---|---|
| **Create** | `ClaudeManager::create_session` (751): pre-mint `session_id` via `resolve_session_id` (frontend can supply, else `uuid::Uuid::new_v4()`); build command with `--session-id`; `spawn_and_stream`. Returns the resolved id. | 751-806 |
| **Send prompt** | `ClaudeManager::send_prompt` (808): build command with **`--resume <id>`** (not `--session-id`), spawn fresh CLI process, write prompt to stdin. Each prompt = a brand-new short-lived `claude --print` invocation that reads JSONL state, runs one turn, exits. | 808-848 |
| **Cancel/interrupt** | `ClaudeManager::cancel` (850): `child.kill()` + `child.wait()`. Leaves the stale instance in the map so the next spawn's "remove old + 300 ms file-lock sleep" path triggers cleanly. | 850-860 |
| **Close** | `ClaudeManager::close` aliases `cancel`. No graceful drain. | 862-864 |
| **Resume** | Implicit via `--resume <session_id>` on every `send_prompt`. Optional `--resume-session-at <uuid>` for rewind to a specific message. `--fork-session <parent>` for branching. The CLI's own JSONL at `~/.claude/projects/<hash>/<sid>.jsonl` is the authoritative thread state. | 805 (build_command), 495-499 |
| **Pre-spawn JSONL repair** | `sanitize_dangling_tool_uses` (110): scans the JSONL for `tool_use` blocks without matching `tool_result`, appends synthetic cancelled `tool_result` records so the CLI doesn't replay a Bash that was killed when T64 force-closed. | 110-238 |
| **Generation counter** | `static GENERATION: AtomicU64` (91) bumped per spawn. Stale reader threads check `instance.generation == gen` before emitting `claude-done` (706-714) to avoid races when a session is re-spawned mid-stream. | |

State container: `ClaudeManager { instances: Arc<Mutex<HashMap<String, ClaudeInstance>>> }`. `ClaudeInstance { child: Child, generation: u64 }`. No turn/item ledger; no in-memory snapshot of conversation — the JSONL on disk is the single source of truth.

---

## (d) Tool-permission flow

### t3code

The SDK delivers permission requests through the `canUseTool` callback registered in `queryOptions` (2887). It runs as an Effect-wrapped function `canUseToolEffect` (2665):

```
canUseTool(toolName, toolInput, { signal, toolUseID, suggestions })
  → returns { behavior: "allow", updatedInput } | { behavior: "deny", message }
```

Special tools intercepted before the generic flow:

- **`AskUserQuestion`** (2681 → `handleAskUserQuestion` 2541): emit `user-input.requested` with parsed questions, store `Deferred<ProviderUserInputAnswers>` in `pendingUserInputs`, await the user, emit `user-input.resolved`, return `{ behavior: "allow", updatedInput: { questions, answers } }`. Abort signal cancels the deferred with empty answers and returns `deny`.
- **`ExitPlanMode`** (2685): emit `turn.proposed.completed` with the captured plan markdown, then **always return `deny`** with the message *"The client captured your proposed plan. Stop here and wait for the user's feedback…"* — this is how plan-mode produces a frozen plan instead of executing it.

For every other tool, when `runtimeMode === "full-access"` (2707) the callback short-circuits to `{behavior:"allow", updatedInput: toolInput}`. Otherwise (lines 2715-2818):

1. Mint `requestId` (`ApprovalRequestId.make(uuid)`).
2. Classify: `classifyRequestType` (464) → `file_read_approval` / `command_execution_approval` / `file_change_approval` / `dynamic_tool_call`.
3. Make a `Deferred<ProviderApprovalDecision>` and stash a `PendingApproval` in `pendingApprovals`.
4. Emit `request.opened` carrying `{ requestType, detail, args:{ toolName, input, toolUseId } }`.
5. Register an `abort` listener on the SDK's `signal` to cancel the deferred with `"cancel"`.
6. `await Deferred.await(decisionDeferred)` — blocks the SDK turn here.
7. Emit `request.resolved` with the decision.
8. Map decision → SDK return value:
   - `accept` / `acceptForSession` → `{behavior: "allow", updatedInput}` (with `updatedPermissions` from the SDK's `suggestions` if `acceptForSession`)
   - `cancel` / `decline` → `{behavior: "deny", message}`

The host fulfils a request via `respondToRequest(threadId, requestId, decision)` (3164) which `Deferred.succeed`s the pending approval. `respondToUserInput` (3181) is the analogue for AskUserQuestion answers.

### T64

There is **no in-process callback**. T64 takes the only escape hatch the CLI exposes: `--permission-prompt-tool mcp__t64__approve` (`claude_manager.rs:487-492`). When the CLI's internal sensitive-file classifier returns `{behavior:"ask"}` (e.g. for `.mcp.json`, `.zshrc`, `.git/*`, `.claude/settings.json`), it routes through this stdio MCP tool. The MCP server is supplied via a side-channel `--mcp-config <approver_path>` and lives in **`src-tauri/src/permission_server.rs`** (separate TCP server), which decides allow/deny and replies synchronously so the stream never pauses. The leading comment at lines 477-486 cites `.wolf/bypass-investigation/agent-2.md` as the empirical confirmation that this is the *only* layer that fires before bypass mode or PreToolUse hooks.

`--disallowed-tools` is hard-merged with `ScheduleWakeup` (444-455) regardless of caller input, with the comment that the scheduler pathway "doesn't work for either normal chats or delegated agents."

---

## (e) Side-by-side delta — what each side has that the other doesn't

### What t3code does that T64 doesn't

| Capability | Where in t3code | T64 status |
|---|---|---|
| Long-running interactive `query` with prompt-as-AsyncIterable (one process, many turns) | `createQuery` + `promptQueue` + `Stream.fromQueue` (2521-2530) | T64 re-spawns CLI per prompt with `--resume`; no persistent stdin pipe across turns. |
| In-process `canUseTool` callback with rich `request.opened`/`request.resolved` events and structured `accept`/`acceptForSession`/`decline`/`cancel` decisions | 2665-2821 | T64 only has `mcp__t64__approve` (MCP-routed, allow/deny only) over a TCP permission server; no per-turn approval UI flow at the manager level. |
| `AskUserQuestion` user-input channel with structured questions + answer routing | 2541-2663 (`handleAskUserQuestion`) and `respondToUserInput` (3181) | Not implemented. |
| Mid-session **model swap** without restarting the session | `context.query.setModel(...)` in `sendTurn` (3055-3068) | T64 must include `--model` on the next `--resume` spawn; no live swap. |
| Mid-session **permission-mode swap** (e.g. switch into plan mode for one turn) | `context.query.setPermissionMode(...)` (3074-3084) | T64 sets `--permission-mode` per spawn; conceptually equivalent because each turn is a new spawn, but no "switch back to base mode" symmetry. |
| Canonical `ProviderRuntimeEvent` schema with stable `eventId` / `threadId` / `turnId` / `itemId` and a `raw` provenance envelope | Throughout | T64 emits raw stream-json lines verbatim through Tauri (`claude-event`); typed mapping is done frontend-side in `useClaudeEvents.ts`. |
| Explicit token-usage normalization & context-window tracking (`normalizeClaudeTokenUsage`, `lastKnownContextWindow`, `lastKnownTokenUsage`, accumulated-vs-current distinction at 1401-1428) | 305-360, 1390-1530 | No backend bookkeeping; frontend (`claudeStore`) tracks. |
| `ExitPlanMode` capture → `turn.proposed.completed` event (so the UI can present a plan separately from execution) | 1989-1999, 2685-2705 | Not implemented; plan-mode behaviour relies on CLI defaults. |
| `TodoWrite` parsed into a `turn.plan.updated` plan-step list | 1701-1722 | Not parsed in Rust; frontend may handle. |
| Native event NDJSON logger (`logNativeSdkMessage`, 1001) for replay/debug | 84, 1001-1038 | No backend log; only `safe_eprintln!` lines. |
| Rollback at the adapter level (`rollbackThread`) | 3154-3162 | T64 has rewind via the `--resume-session-at <uuid>` flag, JSONL truncation, and `--fork-session`; semantics are coarser. |
| Effect-based concurrent primitives — `Deferred`, `Queue`, `Fiber`, `Stream`, `Cause` analysis (`isClaudeInterruptedCause`, `messageFromClaudeStreamCause`) | Throughout | T64 uses bare `std::thread::spawn` + `Arc<Mutex<…>>` + atomic generation counter. |
| Provider snapshot/health: `claude --version`, `claude auth status`, model list with capability descriptors, subscription-type extraction (incl. SDK `initializationResult()` fallback that aborts before any prompt is sent) | `ClaudeProvider.ts` 583-846 | Not implemented; T64 has no provider-status surface. |
| Session-replacement guard (if `startSession` is called while a session exists, gracefully stop the old one) | 2488-2507 | T64 kills+removes any existing instance for the same id and sleeps 300 ms for file-lock release (552-568). Functionally similar but cruder. |
| `additionalDirectories` per session (filesystem boundary control) | 2889 | Not exposed; T64 only sets `current_dir`. |
| `extraArgs` pass-through from user settings to the CLI | 2890 | T64 hardcodes its argv list — no user-extensible flag injection. |
| `settingSources: ["user","project","local"]` (explicit precedence) | 2871 | T64 supplies `--settings <path>` (single file) only. |

### What T64 does that t3code doesn't

| Capability | Where in T64 | t3code status |
|---|---|---|
| **Hand-rolled stream-json parsing** without the Anthropic SDK as a dep | `claude_manager.rs:636-660` | t3code is bound to `@anthropic-ai/claude-agent-sdk` and its types. |
| Oversized-event truncation with structural awareness of `tool_result`/`text` blocks (caps event line at 512 KiB, sandwich head/tail markers) | 246-354 (`cap_event_size`, `truncate_text_field`, `truncate_block_content`) | Relies on SDK message sizes; no comparable cap. The Effect/Stream pipeline ingests the full message into memory. |
| **Pre-spawn JSONL sanitization** of dangling `tool_use` blocks left by killed processes (writes synthetic cancelled `tool_result` records to break replay loops) | 110-238 (`sanitize_dangling_tool_uses`) | t3code keeps state in-process and has no analogous on-disk repair step; if a session crashes, the resume cursor relies on the SDK's own JSONL handling. |
| Stderr error-shape detection and synthesis of a typed `result/error` event when the CLI rejects `--session-id` | 546-550, 663-700 | No equivalent — the SDK abstracts argv, so this failure mode can't surface. |
| Generation counter to suppress `claude-done` from a stale reader after re-spawn | 91, 631, 706-731 | t3code uses fiber identity instead (`if context.streamFiber === streamFiber`, 3024) — equivalent intent, different mechanism. |
| Windows-specific `cmd /C` shim with `CREATE_NO_WINDOW` to suppress console flash, plus `where`/`PATHEXT` `.cmd` shim resolution | 366-379, 8-84 | t3code passes `shell: process.platform === "win32"` to `ChildProcess.make` for the version/auth probes only (627); chat sessions go through the SDK which handles platform quirks internally. |
| Stdin-piped prompt (works around `cmd.exe` newline-truncation of argv) | 590-599 | SDK uses message-passing, not argv. |
| `--fork-session` (branch from a parent session) | 511-515 | t3code's `rollbackThread` truncates in-memory turns; no native CLI-level fork. |
| `--max-budget-usd`, `--max-turns`, `--no-session-persistence` CLI flags | 502-510 | Some of these may be reachable via `extraArgs`, but they aren't first-class options in `ClaudeQueryOptions`. |
| `--dangerously-load-development-channels server:<url>` (dev-channel routing) | 461-466 | Not exposed. |
| OpenWolf hooks merging into the settings JSON (`merge_openwolf_hooks`, 1107) | 1107-1189 | Project-specific; not relevant to the generic provider abstraction. |
| Discord/permission TCP server side-channel for delegation message routing | `permission_server.rs` (referenced from build_command at 461-466 and 487-492) | t3code routes everything through Effect Streams; no separate TCP plane. |

---

## Summary for the Rust port

When refactoring `ClaudeManager` into a `Provider` trait, the gap that matters most:

1. **Event model.** T64 currently emits raw bytes; the trait will need a Rust analogue of `ProviderRuntimeEvent` (a typed enum) and the per-message `handle*` mapping logic that today lives in `useClaudeEvents.ts`. Move that mapping to Rust so Codex (and other adapters) can emit the same canonical shape.
2. **Permission flow.** T64's MCP-tool detour is Claude-CLI–specific. Codex doesn't have a `--permission-prompt-tool` hook, so the trait needs an explicit `respond_to_request(thread_id, request_id, decision)` method backed by a `tokio::sync::oneshot` (or `mpsc`) channel inside the session context, mirroring t3code's `Deferred<ProviderApprovalDecision>` (`ClaudeAdapter.ts:2718-2772`).
3. **Session lifecycle.** Codex (per Agent 1's research) expects a long-running interactive process; T64's "fresh `--print --resume` per prompt" idiom won't generalise. The trait should expose `start_session` / `send_turn` / `interrupt_turn` / `stop_session` and the Claude adapter must be retrofitted to keep the CLI alive across turns (or accept that the Claude adapter remains uniquely re-spawn-per-prompt while wrapping that as a `send_turn` impl).
4. **Resume cursor.** Make the cursor an opaque per-provider value (`{thread_id, resume, resume_session_at, turn_count}` for Claude; whatever Codex needs for itself).
5. **What to keep from T64.** The oversized-line cap (`cap_event_size`), the dangling-tool-use JSONL repair, and the generation counter are real production fixes for problems t3code never had to solve (it doesn't process raw JSONL or re-spawn). Preserve them in the Claude adapter; expose hooks on the trait if other adapters benefit.
