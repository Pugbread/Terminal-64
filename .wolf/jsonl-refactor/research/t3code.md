# t3code — Persistence & Claude-CLI Research

Repo: https://github.com/pingdotgg/t3code (cloned to `/tmp/t3code-research/t3code`, shallow @ master).
Stack: Bun/Node server (Effect-TS), React web client, Tauri-style desktop wrapper, SQLite via `@effect/sql-sqlite-bun`.

## TL;DR

t3code does **not** read, write, or parse Claude Code JSONL transcripts at all. They outsource 100% of session history persistence to the official **`@anthropic-ai/claude-agent-sdk`** and retain only a tiny **resume cursor** (`sessionId`, `lastAssistantUuid`, `turnCount`) in SQLite. Their *own* observable state is built with a full event-sourcing stack: an `orchestration_events` append-only table with monotonic sequence + stream-version uniqueness, plus rebuildable read-model projections. NDJSON files exist only as best-effort **observability logs**, not authoritative state. Crash recovery is automatic — projectors resume from `projection_state.last_applied_sequence`, and a reaper sweep reconciles orphaned provider sessions on startup/periodically.

This is the opposite philosophy from ours: we treat Claude CLI's JSONL file as the source of truth and rebuild our UI from it. t3code treats Claude's JSONL as opaque (via the SDK) and builds its *own* authoritative store on the side.

---

## 1. Claude CLI Integration Approach

### 1.1. They use the SDK, not raw `claude --output-format stream-json`

`apps/server/src/provider/Layers/ClaudeAdapter.ts:9-21` imports:

```ts
import {
  type CanUseTool, query, type Options as ClaudeQueryOptions,
  type PermissionMode, type PermissionResult, type PermissionUpdate,
  type SDKMessage, type SDKResultMessage, type SettingSource,
  type SDKUserMessage, type ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
```

Sessions are started by calling `query({ prompt, options })` (ClaudeAdapter.ts:2878-2891):

```ts
const queryRuntime = yield* Effect.try({
  try: () => createQuery({ prompt, options: queryOptions }),
  catch: (cause) => new ProviderAdapterProcessError({ ... }),
});
```

The SDK is handed an **`AsyncIterable<SDKUserMessage>`** (`prompt`, a `Stream.toAsyncIterable` of a queue — ClaudeAdapter.ts:2507-2514). Messages arrive as typed `SDKMessage` objects, not as raw stdout lines you have to parse:

```ts
interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}
```
(ClaudeAdapter.ts:176-182)

This means **no NDJSON parsing, no stdout buffering, no partial-line handling**. Crash/partial-message recovery is the SDK's problem.

### 1.2. SDK capability probe without burning tokens

The SDK can give you `initializationResult()` — account info, slash commands, provider metadata — without ever hitting the Anthropic API. They use it to discover subscription tier and available slash commands (`ClaudeProvider.ts:583-620`):

```ts
const probeClaudeCapabilities = (binaryPath: string) => {
  const abort = new AbortController();
  return Effect.tryPromise(async () => {
    const q = claudeQuery({
      // Never yield — we only need initialization data, not a conversation.
      // This prevents any prompt from reaching the Anthropic API.
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abort.signal);
      })(),
      options: {
        persistSession: false,
        pathToClaudeCodeExecutable: binaryPath,
        abortController: abort,
        settingSources: ["user", "project", "local"],
        allowedTools: [],
        stderr: () => {},
      },
    });
    const init = await q.initializationResult();
    return {
      subscriptionType: init.account?.subscriptionType,
      slashCommands: parseClaudeInitializationCommands(init.commands),
    };
  }).pipe(
    Effect.ensuring(Effect.sync(() => { if (!abort.signal.aborted) abort.abort(); })),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS), // 8_000 ms
    ...
  );
};
```

Note the `persistSession: false` to avoid polluting the real session JSONL with the probe.

### 1.3. `canUseTool` → runtime events for permission prompts

The SDK invokes a user-supplied `canUseTool(toolName, toolInput, callbackOptions)` callback for every tool call. t3code turns that into an event (`request.opened`) and blocks on a `Deferred` until the UI resolves it (`ClaudeAdapter.ts:2650-2803`). Special-case handling:
- `AskUserQuestion` → `user-input.requested` event.
- `ExitPlanMode` → captured as a proposed plan, then returns `deny` so Claude stops there.
- If `runtimeMode === "full-access"` → auto-allow without prompting.

---

## 2. Stream-JSON Output Handling (SDK messages)

Because t3code uses the SDK, they get typed `SDKMessage` events — not raw JSONL lines. Handling lives in `ClaudeAdapter.ts:1550+ (handleStreamEvent)`:

- **`stream_event` with `content_block_delta` / `text_delta` / `thinking_delta`**: emit `content.delta` runtime events.
- **`assistant` messages**: `extractAssistantTextBlocks` pulls text blocks, they backfill any delta stream that was missed (`backfillAssistantTextBlocksFromSnapshot`, line 1197+). This is the t3code analogue of our "reconciliation" layer — it matches snapshot content-blocks against emitted streaming deltas positionally, synthesizing any block the stream missed and forcing `completeAssistantTextBlock` with a fallback text.
- **`user` messages with `tool_result`**: `toolResultBlocksFromUserMessage` (line 806+).
- **`result`** (`SDKResultMessage`): triggers `completeTurn(status, errorMessage, result)`, which emits `turn.completed`, fires `thread.token-usage.updated`, and pushes the turn into `context.turns`.

### 2.1. Token usage normalization

`normalizeClaudeTokenUsage` (ClaudeAdapter.ts:293-348) is instructive. They specifically note the SDK result `usage` field is a *cumulative* total across every API call in the turn, not the current context window fill:

```ts
// The SDK result.usage contains *accumulated* totals across all API calls
// (input_tokens, cache_read_input_tokens, etc. summed over every request).
// This does NOT represent the current context window size.
// Instead, use the last known context-window-accurate usage from task_progress
// events and treat the accumulated total as totalProcessedTokens.
```
(ClaudeAdapter.ts:1386-1390)

They keep `lastKnownTokenUsage` and `lastKnownContextWindow` on the session context and only trust snapshot-like sources for "how full is the context window right now."

### 2.2. Interrupt detection

Interruption is detected by string-matching multiple sources (`isClaudeInterruptedMessage`, `isInterruptedResult`, line 229-273):

```ts
function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}
```

Result messages with `subtype === "error_during_execution" && is_error === false` and error text containing "aborted"/"interrupted"/"request was aborted" are treated as interrupts (not failures).

### 2.3. Native event NDJSON observability log (optional)

Every raw SDK message can be mirrored to a per-thread rotating NDJSON file for debugging (`EventNdjsonLogger.ts`, `logNativeSdkMessage` at ClaudeAdapter.ts:989-1026). Important: this is **observability only**, never replayed as state. Writes are batched (`Logger.batched`, 200ms window, EventNdjsonLogger.ts:141-161) and failures are downgraded to warnings — the runtime never blocks on log I/O.

The sink is `RotatingFileSink` (`packages/shared/src/logging.ts:11+`). Writes use **`fs.appendFileSync`** directly — no tmp+rename, no fsync. Rotation happens on size threshold by renaming `.log` → `.log.1` → ... → `.log.{maxFiles}` and deleting overflow. The sink is explicitly best-effort: try/catch swallows errors and resyncs `currentSize` from `fs.statSync`.

---

## 3. Session Persistence Model

### 3.1. SQLite as the authoritative store

`apps/server/src/persistence/Layers/Sqlite.ts:29-35`:

```ts
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations();
  }),
);
```

WAL mode + foreign keys on. Migrations run at startup (26+ migrations in the tree).

### 3.2. Event-sourcing spine

Migration 001 (`001_OrchestrationEvents.ts`) defines the append-only event log:

```sql
CREATE TABLE orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  command_id TEXT,
  causation_event_id TEXT,
  correlation_id TEXT,
  actor_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_orch_events_stream_version
  ON orchestration_events(aggregate_kind, stream_id, stream_version);
```

Append query (OrchestrationEventStore.ts:99-155) computes `stream_version` atomically inside the INSERT via a `COALESCE((SELECT MAX(stream_version)+1 ...), 0)` subquery. The unique index on `(aggregate_kind, stream_id, stream_version)` is the concurrency guard — two writers racing for the same version both see 42, one INSERTs 42 first, the other's INSERT fails with UNIQUE constraint violation. No advisory locks needed.

### 3.3. Projections (read models) rebuilt from events

Migration 005 (`005_Projections.ts`) creates `projection_projects`, `projection_threads`, `projection_thread_messages`, `projection_thread_activities`, `projection_thread_sessions`, `projection_turns`, `projection_pending_approvals`, and crucially:

```sql
CREATE TABLE projection_state (
  projector TEXT PRIMARY KEY,
  last_applied_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

Each projector (identified by a string name like `projection.threads`) tracks the last event sequence it applied. `ProjectionStateRepository.upsert` writes via `INSERT ... ON CONFLICT DO UPDATE` (ProjectionState.ts:22-41). On startup, the pipeline reads `MIN(last_applied_sequence)` across all projectors (ProjectionState.ts:71-80) and catches up by streaming events from that cursor forward — so crashes mid-projection just resume from wherever each projector stopped. **This is the clean version of our "hydrateFromJsonl" — replay with a durable cursor.**

### 3.4. Claude session runtime binding (the resume cursor)

Migration 004 (`004_ProviderSessionRuntime.ts`) stores the live-session state:

```sql
CREATE TABLE provider_session_runtime (
  thread_id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  runtime_mode TEXT NOT NULL DEFAULT 'full-access',
  status TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resume_cursor_json TEXT,
  runtime_payload_json TEXT
);
```

`resume_cursor_json` is the tiny blob handed back to Claude SDK on session resume. For Claude it contains (ClaudeAdapter.ts:1052-1064):

```ts
const resumeCursor = {
  threadId,
  ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
  ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
  turnCount: context.turns.length,
};
```

Shape:
- `resume` — Claude SDK's `session_id` (validated UUID; `isUuid` check, line 193-195).
- `resumeSessionAt` — the last assistant message UUID seen on the stream.
- `turnCount` — counter.

On resume (`startSession`, ClaudeAdapter.ts:2494-2500):

```ts
const resumeState = readClaudeResumeState(input.resumeCursor);
const existingResumeSessionId = resumeState?.resume;
const newSessionId = existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
const sessionId = existingResumeSessionId ?? newSessionId;
```

And later passes to the SDK (line 2869-2870):

```ts
...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
...(newSessionId ? { sessionId: newSessionId } : {}),
```

They **generate their own session UUID ahead of time** (`Random.nextUUIDv4`) when starting a fresh session, rather than letting Claude pick one and then having to race to capture it from the first stream event. The SDK accepts `sessionId` to pin the ID at spawn. Clever.

### 3.5. Directory service wraps the raw repository

`ProviderSessionDirectory.ts` is a domain service over the SQL repo. The `upsert` method (line 94-131) does a useful thing: it merges `runtime_payload_json` shallowly instead of replacing:

```ts
function mergeRuntimePayload(existing, next) {
  if (next === undefined) return existing ?? null;
  if (isRecord(existing) && isRecord(next)) return { ...existing, ...next };
  return next;
}
```

Lets adapters update one field (`lastSeenAt`, `status`) without having to re-fetch the full runtime payload, while still preserving arbitrary provider-specific keys.

### 3.6. Client-side persistence

Web/desktop frontend stores **only UI state** (expanded projects, changed-files panels, tab order) in `localStorage` under a versioned key `"t3code:ui-state:v1"` with legacy-key fallbacks (`apps/web/src/uiStateStore.ts:4-16`). **Zero conversation data in localStorage.** Everything else comes from the server over HTTP/WS. They have a debouncer on persistence writes (`@tanstack/react-pacer`, line 1).

---

## 4. Crash & Interrupted-Write Handling

### 4.1. SQLite does the heavy lifting

- **WAL mode** (Sqlite.ts:32) — writers don't block readers, commits are durable via WAL checkpoint.
- **Unique stream-version index** (`idx_orch_events_stream_version`) — concurrent double-appends to the same stream fail loudly.
- **Projection cursor** in `projection_state` — resume any projector mid-stream without re-applying earlier events.
- **`INSERT ... ON CONFLICT DO UPDATE`** patterns everywhere for idempotent upserts (ProjectionState.ts:36-40).

There is no tmp-file + rename dance for the authoritative data — SQLite's WAL is the atomicity layer.

### 4.2. Atomic writes reserved for *config* files only

`apps/server/src/atomicWrite.ts` provides `writeFileStringAtomically` — but it's only used for JSON settings (`keybindings.ts`, `serverSettings.ts`, `serverRuntimeState.ts`, `providerStatusCache.ts`). Interestingly, their variant places the tmp file in a **temp subdirectory** rather than a sibling, then renames out:

```ts
yield* fs.makeDirectory(targetDirectory, { recursive: true });
const tempDirectory = yield* fs.makeTempDirectoryScoped({
  directory: targetDirectory,
  prefix: `${path.basename(input.filePath)}.`,
});
const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);
yield* fs.writeFileString(tempPath, input.contents);
yield* fs.rename(tempPath, input.filePath);
```
(atomicWrite.ts:15-23)

`makeTempDirectoryScoped` auto-cleans on scope exit, so aborted writes leave no orphaned `.tmp` siblings. No `fsync` is issued — they rely on POSIX rename atomicity.

### 4.3. Observability NDJSON logs are best-effort

`appendFileSync` without `fsync`, errors swallowed, `currentSize` resynced via `fs.statSync` on failure (logging.ts:36-57). Rotation is size-triggered and happens in-line on the write call. If the process crashes mid-append, you may get a torn final line — but nothing authoritative depends on those logs.

### 4.4. Stale-session reaper

`ProviderSessionReaper.ts` runs a sweep every 5 minutes (line 12) and stops any `provider_session_runtime` row whose `last_seen_at` is older than 30 minutes AND whose read-model shows no active turn (line 58-66):

```ts
const thread = threadsById.get(binding.threadId);
if (thread?.session?.activeTurnId != null) {
  yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", { ... });
  continue;
}
```

Failures are logged, not propagated. This is the mechanism that cleans up sessions killed by a hard crash — on next startup the reaper eventually notices stale rows and closes them.

### 4.5. Interrupt semantics

`isClaudeInterruptedCause` (ClaudeAdapter.ts:238-243) treats `Cause.hasInterruptsOnly(cause)` OR any message matching the interrupt pattern as interrupted, not failed. The `turnStatusFromResult` function distinguishes `completed`/`interrupted`/`cancelled`/`failed` (line 659-672).

---

## 5. Unique Techniques Worth Copying

### 5.1. **Pre-assigned session IDs** (big win)

Generating the Claude session UUID *before* spawning and passing it via `sessionId: newSessionId` (ClaudeAdapter.ts:2498-2500, 2870) means:
- You know the JSONL filename before any I/O happens.
- No TOCTOU race between "create session" and "persist metadata pointing at session."
- Rollback is trivial — you can delete the pre-committed metadata if spawn fails.

Applicability to us: our `claude_manager.rs` currently discovers the session ID from the first `system` init event. We could pre-generate (`uuid::Uuid::new_v4`) and pass via the CLI's `--session-id` flag if supported — removing the "capture on first event" dance in `useClaudeEvents.ts`.

### 5.2. **Atomic stream-version via SQL subquery**

Rather than `BEGIN; SELECT MAX; INSERT; COMMIT;`, they do it in one INSERT statement (OrchestrationEventStore.ts:117-133) and let the UNIQUE constraint on `(aggregate_kind, stream_id, stream_version)` be the concurrency guard. Same pattern could harden any future multi-writer invariant.

### 5.3. **Projector cursor = crash-safe replay**

`projection_state.last_applied_sequence` with `INSERT ... ON CONFLICT DO UPDATE` means projections are rebuilt by a pure function `(events, cursor) → updated_cursor`. There is no "hydrate then hope" — you always know exactly where you left off. Even if a projector implementation changes, you can reset its row to 0 and it will catch up from the start.

### 5.4. **Shallow-merge payload blob in `upsert`**

`mergeRuntimePayload` (ProviderSessionDirectory.ts:43-54) — when updating a JSON blob column, merge rather than replace. Avoids read-modify-write races where a `status` update clobbers a concurrent `lastSeenAt` update.

### 5.5. **Reaper with idle-threshold + active-turn guard**

Separates "stale because idle" from "stale because active but unresponsive." The `activeTurnId != null` check from the read model means an actively-working session never gets reaped even if its binding row looks old (ProviderSessionReaper.ts:58-66). Good pattern for any long-running session that might have gaps in heartbeats.

### 5.6. **Backfill deltas from snapshot messages**

`backfillAssistantTextBlocksFromSnapshot` (ClaudeAdapter.ts:1197-1243) reconciles the streamed `content.delta` events against the final `assistant` message content blocks positionally. If a content block's streaming deltas were missed, it synthesizes the missing content from the snapshot and emits a fallback `content.delta` + `item.completed`. This is the t3code equivalent of `whisper.rs`'s anti-hallucination reconciliation — snapshot is the authority, streams are a best-effort optimization.

### 5.7. **Observability stream logger as a hot-swappable interface**

`EventNdjsonLogger` is a tiny interface (`write`, `close`, `filePath`) with a `makeEventNdjsonLogger` factory. ClaudeAdapter accepts either a path (will construct the logger) or a pre-built logger (EventNdjsonLogger.ts:31-36, ClaudeAdapter.ts:189-191). Makes tests trivially able to inject a capture-in-memory variant without touching disk.

### 5.8. **Capability probe that never fires a prompt**

An `AsyncGenerator` that `await`s an `AbortSignal` → SDK does its full init handshake (including subscription metadata and slash-command list) but never ingests a user turn (ClaudeProvider.ts:590-612). Zero-cost account check.

---

## 6. Anti-Patterns (or at least: choices we should NOT copy)

### 6.1. Event-sourcing for a solo desktop app is overkill

t3code has 26+ migrations and a full CQRS split (commands → events → projections). Justified if you have a web tier + server, multiple clients reading the same state, audit-log requirements, arbitrary query needs. **Not justified** for a single-user Tauri app where the Claude CLI's own JSONL already serves as a durable append-only log with the right semantics. Porting this wholesale would cost weeks for marginal win.

### 6.2. `appendFileSync` without `fsync` for NDJSON

Fine for observability logs (their use), **not** fine for authoritative data. If we keep localStorage-metadata-only and use JSONL as source of truth, we shouldn't mirror this pattern for any file where data loss would be user-visible.

### 6.3. String-matching interrupt detection

`isClaudeInterruptedMessage` matches hardcoded English substrings (`"interrupted by user"`, `"request was aborted"`). Brittle to Claude CLI copy changes. We already consume typed init/result payloads; prefer those.

### 6.4. Periodic reaper sweep instead of structured cleanup

A 5-minute sweep with a 30-minute threshold means orphaned sessions may hang around for up to 30 minutes in the worst case. A reaper is a nice safety net but shouldn't be the primary cleanup path — structured scope/drop handlers for the normal case, reaper only for crash recovery.

### 6.5. Heavy frontend debouncing of UI-state persistence

They use `@tanstack/react-pacer`'s `Debouncer` for localStorage writes. Fine for high-frequency UI state, but our current 5s auto-save + immediate-save-on-user-message is already the right tradeoff; don't add a dependency for this.

---

## 7. Concrete Recommendations for Terminal 64

### HIGH-VALUE, LOW-COST

1. **Pre-generate session UUID before spawning Claude CLI.** Pass via `--session-id` if supported (check `claude` CLI flags — this is an SDK option but the CLI may also expose it). Removes the "wait for first system event to learn our own session ID" race in `claudeStore.ts`. See §5.1.

2. **Separate observability NDJSON from source-of-truth JSONL.** If we want a crash-debug log of stream-json raw events, make it a best-effort rotating NDJSON next to the real JSONL (pattern from `EventNdjsonLogger.ts`), never read back for state.

3. **Add a `last_seen_at` field + reaper to localStorage metadata.** Already `lastSeenAt` in `PersistedSessionMeta` per the design doc — make sure the frontend updates it on every activity tick and have a boot-time pass that marks sessions idle if `now - lastSeenAt > threshold`. Cheap insurance against "zombie" session entries whose PID is long dead.

4. **For the no-shrink guard in `loadFromDisk`**: also track the last-known JSONL size (in metadata) so you can detect "file was truncated out-of-band" vs. "legitimate smaller file post-fork." A bytes cursor per session turns the guard from a heuristic into a check.

### MEDIUM-VALUE

5. **If we ever need concurrent writers to the JSONL**, adopt the `INSERT ... stream_version + 1` pattern via a sidecar SQLite (one row per session with `last_written_byte`) — atomic increment is the simplest sanity guarantee. Right now we're single-writer per session so this is theoretical.

6. **Generalize `atomic_write_jsonl` (`src-tauri/src/lib.rs:131`) to use a scoped tmp dir** (t3code pattern, atomicWrite.ts:16-19). Protects against half-written `.tmp.XXX` sibling files if the process crashes *between* `write` and `rename`. Today a `.tmp.XXX` sibling can linger forever in `~/.claude/projects/<hash>/`.

7. **Explicit "backfill from snapshot" reconciliation for assistant messages.** Our `hydrateFromJsonl` already effectively does this (the JSONL *is* the snapshot), but worth auditing `useClaudeEvents.ts` for cases where a partial delta stream would leave a ghost message if the final assistant message is missing.

### DO-NOT-DO

- Do not move to SQLite + event sourcing. The cost/benefit is wrong for a solo desktop app where Claude CLI's JSONL already plays the role of the event log.
- Do not ship a per-message NDJSON observability log by default. Gate behind a setting or `RUST_LOG` level; otherwise every session doubles its disk writes.
- Do not rely on string-matching interrupt detection. Our `ClaudeManager` already parses typed events; keep it that way.

---

## File:Line Citations Summary

| Concern | File | Lines |
|---|---|---|
| SDK import | `apps/server/src/provider/Layers/ClaudeAdapter.ts` | 9-21 |
| `query()` call site | `ClaudeAdapter.ts` | 2878-2891 |
| Pre-generated session UUID | `ClaudeAdapter.ts` | 2494-2500, 2869-2870 |
| Resume cursor shape | `ClaudeAdapter.ts` | 1052-1064, 358-394 |
| `canUseTool` → event | `ClaudeAdapter.ts` | 2650-2803 |
| Capability probe (no tokens) | `ClaudeProvider.ts` | 583-620 |
| Token usage caveat | `ClaudeAdapter.ts` | 1386-1390 |
| Interrupt detection | `ClaudeAdapter.ts` | 229-273 |
| Snapshot → delta backfill | `ClaudeAdapter.ts` | 1197-1243 |
| Native NDJSON logger | `provider/Layers/EventNdjsonLogger.ts` | (whole file) |
| RotatingFileSink | `packages/shared/src/logging.ts` | 11-115 |
| SQLite WAL + migrations | `persistence/Layers/Sqlite.ts` | 29-35 |
| Event store schema | `persistence/Migrations/001_OrchestrationEvents.ts` | 1-45 |
| Event append w/ stream_version | `persistence/Layers/OrchestrationEventStore.ts` | 99-155 |
| Provider session runtime schema | `persistence/Migrations/004_ProviderSessionRuntime.ts` | 1-30 |
| Projection state (cursor) | `persistence/Migrations/005_Projections.ts` | 106-112 |
| Projection state repo upsert | `persistence/Layers/ProjectionState.ts` | 22-41 |
| Directory upsert + shallow merge | `provider/Layers/ProviderSessionDirectory.ts` | 43-54, 94-131 |
| Reaper sweep | `provider/Layers/ProviderSessionReaper.ts` | 19-123 |
| Atomic config write | `apps/server/src/atomicWrite.ts` | 1-25 |
| Frontend localStorage (UI only) | `apps/web/src/uiStateStore.ts` | 4-55 |

---

## Research metadata

- Cloned: `git clone --depth 1 https://github.com/pingdotgg/t3code.git` → `/tmp/t3code-research/t3code`
- Snapshot time: 2026-04-23 session.
- Primary files read: `ClaudeProvider.ts`, `ClaudeAdapter.ts` (first ~1600 + 2480-3080), `EventNdjsonLogger.ts`, `ProviderSessionDirectory.ts`, `ProviderSessionReaper.ts`, `Sqlite.ts`, Migrations 001/004/005, `ProjectionState.ts`, `OrchestrationEventStore.ts`, `atomicWrite.ts`, `logging.ts`, `uiStateStore.ts`, `ProjectionPipeline.ts` (partial).
