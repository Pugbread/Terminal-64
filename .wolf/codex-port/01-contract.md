# 01 — Provider Contract (research, no code changes)

Scope: Port Step 1 — read t3code's provider contract so T64 can later refactor
`ClaudeManager` into a Rust `Provider` trait that can accept additional CLI
backends (Codex first, then Cursor / OpenCode).

Sources (all from `pingdotgg/t3code`, branch `main`):

- `apps/server/src/provider/Services/ProviderAdapter.ts` — 126 lines
- `apps/server/src/provider/Services/ServerProvider.ts` — 8 lines
- `packages/contracts/src/providerRuntime.ts` — 1019 lines (where
  `ProviderRuntimeEvent` actually lives — `ProviderAdapter.ts` imports it
  from `@t3tools/contracts`)
- `packages/contracts/src/server.ts` — 244 lines (the `ServerProvider` *data*
  type consumed by the `ServerProviderShape` service)

Quotes below are verbatim.

---

## (a) `ProviderAdapterShape<TError>` — full method list

From `apps/server/src/provider/Services/ProviderAdapter.ts` (lines 45–126).
Every member is `readonly`. `TError` is the adapter-specific error channel
for the Effect; the last two (`listSessions`, `hasSession`) are declared
without an error channel (never-fails).

Two non-method fields:

```ts
readonly provider: ProviderKind;
readonly capabilities: ProviderAdapterCapabilities;
```

Methods (thirteen, one event stream):

```ts
readonly startSession: (
  input: ProviderSessionStartInput,
) => Effect.Effect<ProviderSession, TError>;

readonly sendTurn: (
  input: ProviderSendTurnInput,
) => Effect.Effect<ProviderTurnStartResult, TError>;

readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

readonly respondToRequest: (
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
) => Effect.Effect<void, TError>;

readonly respondToUserInput: (
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
) => Effect.Effect<void, TError>;

readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

readonly rollbackThread: (
  threadId: ThreadId,
  numTurns: number,
) => Effect.Effect<ProviderThreadSnapshot, TError>;

readonly stopAll: () => Effect.Effect<void, TError>;

readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
```

`ProviderThreadSnapshot` (same file, lines 35–43):

```ts
export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}
```

Mental model for the T64 port: each method becomes one `async fn` on a
`trait Provider` (or a `Box<dyn Provider>`), except `streamEvents`, which
becomes an owned `tokio::sync::broadcast::Receiver<ProviderRuntimeEvent>`
(or `mpsc::Receiver`) returned once at construction time. `listSessions`
and `hasSession` are the two calls that cannot fail in t3code — map them
to infallible `async fn`s (no `Result`) in Rust.

---

## (b) `capabilities` — keys + types

From `ProviderAdapter.ts` lines 26–33. The capability surface is
intentionally tiny today:

```ts
export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
}
```

| Key                 | Type                              | Notes                                                                                              |
|---------------------|-----------------------------------|----------------------------------------------------------------------------------------------------|
| `sessionModelSwitch`| `"in-session" \| "unsupported"`   | Whether the adapter supports swapping models on an existing session (Claude: yes; Codex: no today) |

Port note: in Rust this becomes a `struct ProviderCapabilities` returned by
`fn capabilities(&self) -> ProviderCapabilities`. Start with one field
(`session_model_switch: SessionModelSwitch { InSession, Unsupported }`);
new flags will accrete as we port more adapters.

---

## (c) `ProviderRuntimeEvent` — full discriminated union

`ProviderAdapter.ts` imports `ProviderRuntimeEvent` from `@t3tools/contracts`.
The actual definition is in `packages/contracts/src/providerRuntime.ts`.

### Shared base fields (every variant gets these — lines 246–257)

```ts
const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  providerRefs: Schema.optional(ProviderRefs),
  raw: Schema.optional(RuntimeEventRaw),
});
```

`ProviderRefs` (lines 44–48) preserves wire-level ids for debugging /
reconciliation:

```ts
const ProviderRefs = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
```

`RuntimeEventRaw` (lines 20–38) is the untyped passthrough of the original
provider line — sources include `"claude.sdk.message"`,
`"claude.sdk.permission"`, `"codex.app-server.notification"`,
`"codex.app-server.request"`, `"codex.eventmsg"`,
`"codex.sdk.thread-event"`, `"opencode.sdk.event"`, `"acp.jsonrpc"`, and a
template-literal `` `acp.${string}.extension` ``.

### Discriminator type list (lines 147–196)

Every variant of the union has shape `{ ...ProviderRuntimeEventBase, type: <literal>, payload: <payload> }`. The 46 literal values:

```ts
const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "thread.realtime.started",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.plan.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "runtime.warning",
  "runtime.error",
]);
```

### Shared enum payload bits

```ts
const RuntimeSessionState = Schema.Literals([
  "starting", "ready", "running", "waiting", "stopped", "error",
]);
const RuntimeThreadState = Schema.Literals([
  "active", "idle", "archived", "closed", "compacted", "error",
]);
const RuntimeTurnState = Schema.Literals([
  "completed", "failed", "interrupted", "cancelled",
]);
const RuntimePlanStepStatus = Schema.Literals([
  "pending", "inProgress", "completed",
]);
const RuntimeItemStatus = Schema.Literals([
  "inProgress", "completed", "failed", "declined",
]);
const RuntimeContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);
const RuntimeErrorClass = Schema.Literals([
  "provider_error", "transport_error", "permission_error",
  "validation_error", "unknown",
]);
const ToolLifecycleItemType = Schema.Literals([
  "command_execution", "file_change", "mcp_tool_call",
  "dynamic_tool_call", "collab_agent_tool_call",
  "web_search", "image_view",
]);
const CanonicalItemType = Schema.Literals([
  "user_message", "assistant_message", "reasoning", "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
  "review_entered", "review_exited", "context_compaction",
  "error", "unknown",
]);
const CanonicalRequestType = Schema.Literals([
  "command_execution_approval", "file_read_approval",
  "file_change_approval", "apply_patch_approval",
  "exec_command_approval", "tool_user_input",
  "dynamic_tool_call", "auth_tokens_refresh", "unknown",
]);
```

### Per-variant payloads (verbatim)

Each variant extends `ProviderRuntimeEventBase` with `type: <literal>` and
the payload listed below. Grouped by family for readability.

**Session lifecycle**

```ts
// session.started
{ message?: TrimmedNonEmptyString; resume?: unknown }

// session.configured
{ config: Record<string, unknown> }

// session.state.changed
{ state: RuntimeSessionState; reason?: TrimmedNonEmptyString; detail?: unknown }

// session.exited
{ reason?: TrimmedNonEmptyString; recoverable?: boolean; exitKind?: RuntimeSessionExitKind }
```

**Thread lifecycle**

```ts
// thread.started
{ providerThreadId?: TrimmedNonEmptyString }

// thread.state.changed
{ state: RuntimeThreadState; detail?: unknown }

// thread.metadata.updated
{ name?: TrimmedNonEmptyString; metadata?: Record<string, unknown> }

// thread.token-usage.updated
{ usage: ThreadTokenUsageSnapshot }
```

Where `ThreadTokenUsageSnapshot` (lines 301–318) is:

```ts
export const ThreadTokenUsageSnapshot = Schema.Struct({
  usedTokens: NonNegativeInt,
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
});
```

**Realtime (voice) sub-stream**

```ts
// thread.realtime.started
{ realtimeSessionId?: TrimmedNonEmptyString }

// thread.realtime.item-added
{ item: unknown }

// thread.realtime.audio.delta
{ audio: unknown }

// thread.realtime.error
{ message: TrimmedNonEmptyString }

// thread.realtime.closed
{ reason?: TrimmedNonEmptyString }
```

**Turn lifecycle**

```ts
// turn.started
{ model?: TrimmedNonEmptyString; effort?: TrimmedNonEmptyString }

// turn.completed
{
  state: RuntimeTurnState;
  stopReason?: TrimmedNonEmptyString | null;
  usage?: unknown;
  modelUsage?: Record<string, unknown>;
  totalCostUsd?: number;
  errorMessage?: TrimmedNonEmptyString;
}

// turn.aborted
{ reason: TrimmedNonEmptyString }

// turn.plan.updated
{
  explanation?: TrimmedNonEmptyString | null;
  plan: ReadonlyArray<{ step: TrimmedNonEmptyString; status: RuntimePlanStepStatus }>;
}

// turn.proposed.delta
{ delta: string }

// turn.proposed.completed
{ planMarkdown: TrimmedNonEmptyString }

// turn.diff.updated
{ unifiedDiff: string }
```

**Item lifecycle (item.started / item.updated / item.completed share one payload)**

```ts
export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
});
```

**Streaming content delta**

```ts
// content.delta
{
  streamKind: RuntimeContentStreamKind;
  delta: string;
  contentIndex?: number; // int
  summaryIndex?: number; // int
}
```

**Approval / permission requests**

```ts
// request.opened
{ requestType: CanonicalRequestType; detail?: TrimmedNonEmptyString; args?: unknown }

// request.resolved
{ requestType: CanonicalRequestType; decision?: TrimmedNonEmptyString; resolution?: unknown }
```

**Structured user input (questions → answers)**

```ts
export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption), // { label, description }
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});

// user-input.requested
{ questions: ReadonlyArray<UserInputQuestion> }

// user-input.resolved
{ answers: Record<string, unknown> }
```

**Task lifecycle (sub-agent / Task-tool style)**

```ts
// task.started
{ taskId: RuntimeTaskId; description?: TrimmedNonEmptyString; taskType?: TrimmedNonEmptyString }

// task.progress
{
  taskId: RuntimeTaskId;
  description: TrimmedNonEmptyString;
  summary?: TrimmedNonEmptyString;
  usage?: unknown;
  lastToolName?: TrimmedNonEmptyString;
}

// task.completed
{
  taskId: RuntimeTaskId;
  status: "completed" | "failed" | "stopped";
  summary?: TrimmedNonEmptyString;
  usage?: unknown;
}
```

**Hook lifecycle**

```ts
// hook.started
{ hookId: TrimmedNonEmptyString; hookName: TrimmedNonEmptyString; hookEvent: TrimmedNonEmptyString }

// hook.progress
{ hookId: TrimmedNonEmptyString; output?: string; stdout?: string; stderr?: string }

// hook.completed
{
  hookId: TrimmedNonEmptyString;
  outcome: "success" | "error" | "cancelled";
  output?: string; stdout?: string; stderr?: string;
  exitCode?: number; // int
}
```

**Tool UI hints**

```ts
// tool.progress
{
  toolUseId?: TrimmedNonEmptyString;
  toolName?: TrimmedNonEmptyString;
  summary?: TrimmedNonEmptyString;
  elapsedSeconds?: number;
}

// tool.summary
{ summary: TrimmedNonEmptyString; precedingToolUseIds?: ReadonlyArray<TrimmedNonEmptyString> }
```

**Auth / account / MCP / model**

```ts
// auth.status
{ isAuthenticating?: boolean; output?: ReadonlyArray<string>; error?: TrimmedNonEmptyString }

// account.updated
{ account: unknown }

// account.rate-limits.updated
{ rateLimits: unknown }

// mcp.status.updated
{ status: unknown }

// mcp.oauth.completed
{ success: boolean; name?: TrimmedNonEmptyString; error?: TrimmedNonEmptyString }

// model.rerouted
{
  fromModel: TrimmedNonEmptyString;
  toModel: TrimmedNonEmptyString;
  reason: TrimmedNonEmptyString;
}
```

**Warnings / deprecations / files / errors**

```ts
// config.warning
{
  summary: TrimmedNonEmptyString;
  details?: TrimmedNonEmptyString;
  path?: TrimmedNonEmptyString;
  range?: unknown;
}

// deprecation.notice
{ summary: TrimmedNonEmptyString; details?: TrimmedNonEmptyString }

// files.persisted
{
  files: ReadonlyArray<{ filename: TrimmedNonEmptyString; fileId: TrimmedNonEmptyString }>;
  failed?: ReadonlyArray<{ filename: TrimmedNonEmptyString; error: TrimmedNonEmptyString }>;
}

// runtime.warning
{ message: TrimmedNonEmptyString; detail?: unknown }

// runtime.error
{
  message: TrimmedNonEmptyString;
  class?: RuntimeErrorClass;
  detail?: unknown;
}
```

### Union declaration (lines 946–998)

```ts
export const ProviderRuntimeEventV2 = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionConfiguredEvent,
  ProviderRuntimeSessionStateChangedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeThreadStartedEvent,
  ProviderRuntimeThreadStateChangedEvent,
  ProviderRuntimeThreadMetadataUpdatedEvent,
  ProviderRuntimeThreadTokenUsageUpdatedEvent,
  ProviderRuntimeThreadRealtimeStartedEvent,
  ProviderRuntimeThreadRealtimeItemAddedEvent,
  ProviderRuntimeThreadRealtimeAudioDeltaEvent,
  ProviderRuntimeThreadRealtimeErrorEvent,
  ProviderRuntimeThreadRealtimeClosedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeTurnAbortedEvent,
  ProviderRuntimeTurnPlanUpdatedEvent,
  ProviderRuntimeTurnProposedDeltaEvent,
  ProviderRuntimeTurnProposedCompletedEvent,
  ProviderRuntimeTurnDiffUpdatedEvent,
  ProviderRuntimeItemStartedEvent,
  ProviderRuntimeItemUpdatedEvent,
  ProviderRuntimeItemCompletedEvent,
  ProviderRuntimeContentDeltaEvent,
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
  ProviderRuntimeUserInputRequestedEvent,
  ProviderRuntimeUserInputResolvedEvent,
  ProviderRuntimeTaskStartedEvent,
  ProviderRuntimeTaskProgressEvent,
  ProviderRuntimeTaskCompletedEvent,
  ProviderRuntimeHookStartedEvent,
  ProviderRuntimeHookProgressEvent,
  ProviderRuntimeHookCompletedEvent,
  ProviderRuntimeToolProgressEvent,
  ProviderRuntimeToolSummaryEvent,
  ProviderRuntimeAuthStatusEvent,
  ProviderRuntimeAccountUpdatedEvent,
  ProviderRuntimeAccountRateLimitsUpdatedEvent,
  ProviderRuntimeMcpStatusUpdatedEvent,
  ProviderRuntimeMcpOauthCompletedEvent,
  ProviderRuntimeModelReroutedEvent,
  ProviderRuntimeConfigWarningEvent,
  ProviderRuntimeDeprecationNoticeEvent,
  ProviderRuntimeFilesPersistedEvent,
  ProviderRuntimeWarningEvent,
  ProviderRuntimeErrorEvent,
]);

export const ProviderRuntimeEvent = ProviderRuntimeEventV2;
export type ProviderRuntimeEvent = ProviderRuntimeEventV2;
```

### Legacy aliases (lines 1000–1012)

The file keeps these aliases for older adapter/test call sites. They do
not expand the union — they re-export existing variants under old names:

```ts
const ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
const ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
const ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
const ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;
```

Port note for T64: this union is the *canonical* event surface the Rust
`Provider` trait should emit. It is already a superset of the JSON we
currently emit from `ClaudeManager` (`assistant message`, `tool_use`,
`result`, permission request). In Rust, represent this as:

```rust
// sketch only — not to be implemented in Step 1
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ProviderRuntimeEvent {
    #[serde(rename = "session.started")]       SessionStarted(EventBase<SessionStartedPayload>),
    #[serde(rename = "session.configured")]    SessionConfigured(EventBase<SessionConfiguredPayload>),
    // … 44 more arms …
    #[serde(rename = "runtime.error")]         RuntimeError(EventBase<RuntimeErrorPayload>),
}
```

…where `EventBase<P>` flattens in the nine shared fields
(`eventId`, `provider`, `threadId`, `createdAt`, optional `turnId`,
`itemId`, `requestId`, `providerRefs`, `raw`) and the discriminator
`type` on the outer tag matches the t3code wire literal exactly. The
frontend stays wire-compatible with t3code's emitted JSON, which unlocks
sharing UI logic later if we ever pull their web client in.

---

## (d) `ServerProviderShape` — methods

From `apps/server/src/provider/Services/ServerProvider.ts` (the entire file):

```ts
import type { ServerProvider } from "@t3tools/contracts";
import type { Effect, Stream } from "effect";

export interface ServerProviderShape {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
```

Three members, all infallible (no `TError` channel):

| Member          | Kind                            | Purpose (inferred from types)                                                                                   |
|-----------------|---------------------------------|------------------------------------------------------------------------------------------------------------------|
| `getSnapshot`   | `Effect.Effect<ServerProvider>` | Return the current cached status of *one* provider (installed?, version, auth, models, slash commands, skills). |
| `refresh`       | `Effect.Effect<ServerProvider>` | Force-recompute that snapshot (CLI version probe, auth check) and return the fresh value.                        |
| `streamChanges` | `Stream.Stream<ServerProvider>` | Push updates whenever the snapshot changes (e.g. CLI reinstalled, auth flipped, model list refreshed).           |

The `ServerProvider` value that flows through all three is defined in
`packages/contracts/src/server.ts` (lines 86–104):

```ts
export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState, // "ready" | "warning" | "error" | "disabled"
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
```

Port note: this is orthogonal to `ProviderAdapterShape` — it is the
out-of-band "is the CLI present and how do I render it in the picker"
surface. In the T64 Rust port this should map to a distinct trait (or a
method-set on `AppState`), not onto `Provider` itself:

```rust
// sketch — later step, not Step 1
trait ServerProviderProbe {
    async fn snapshot(&self) -> ServerProvider;
    async fn refresh(&self) -> ServerProvider;
    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ServerProvider>;
}
```

---

## Glossary — identifiers referenced but not fully defined above

These are imported from `@t3tools/contracts`. They are *inputs / ids*, not
events, so the exact shape isn't required for Step 1 — but the names
need to be preserved in the Rust port:

- `ApprovalRequestId`, `EventId`, `RuntimeItemId`, `RuntimeRequestId`,
  `RuntimeTaskId`, `ThreadId`, `TurnId`, `ProviderItemId` —
  newtype-wrapped `TrimmedNonEmptyString`s from `baseSchemas.ts`.
- `ProviderKind` — enum of provider identifiers (`"claude"`, `"codex"`,
  `"opencode"`, `"acp-*"` …) defined in
  `packages/contracts/src/orchestration.ts`.
- `ProviderSessionStartInput`, `ProviderSendTurnInput`,
  `ProviderSession`, `ProviderTurnStartResult`,
  `ProviderApprovalDecision`, `ProviderUserInputAnswers` — defined in
  `packages/contracts/src/provider.ts` (out-of-scope for this report;
  Agent 2 / 3 territory).

---

## Delta against T64 today — short version

What `src-tauri/src/claude_manager.rs` already does vs. what the
`ProviderAdapterShape` contract demands:

| Shape method                     | T64 today                                                     |
|----------------------------------|---------------------------------------------------------------|
| `startSession`                   | `ClaudeManager::spawn_session` (spawns `claude … stream-json`) |
| `sendTurn`                       | writes user input to PTY stdin via `ClaudeManager::send_input` |
| `interruptTurn`                  | `ClaudeManager::interrupt_session` (SIGINT)                   |
| `respondToRequest`               | routed through `PermissionServer` (TCP)                       |
| `respondToUserInput`             | not implemented (no structured UI-question pattern yet)        |
| `stopSession`                    | `ClaudeManager::kill_session`                                  |
| `listSessions` / `hasSession`    | `AppState.claude_sessions: Arc<Mutex<HashMap<...>>>`           |
| `readThread` / `rollbackThread`  | approximated by JSONL helpers in `lib.rs` (`load_session_history`, `truncate_session_jsonl`, `fork_session_jsonl`) |
| `stopAll`                        | emerges from `ClaudeManager::Drop` / app shutdown              |
| `streamEvents`                   | raw `claude-output-{id}` Tauri events — not normalized into the 46-variant union yet |

The biggest Step-2 delta is `streamEvents`: today we re-emit Claude's
wire JSON nearly verbatim; the port needs a canonical
`ProviderRuntimeEvent` enum emitted on *one* Tauri channel, with a
per-adapter translator that converts Claude / Codex / OpenCode native
events into it. Everything else is a straightforward `trait Provider`
method-to-method mapping of code that already exists.
