# Step 1 — Rust Port Plan: ProviderAdapter for Terminal 64

**Author:** Agent 4 (planning synthesis, no code changes)
**Scope:** Port t3code's TS `ProviderAdapterShape` + `ProviderRuntimeEvent` union to a Rust `ProviderAdapter` trait and refactor `claude_manager.rs` into `providers/claude.rs`. Stub `providers/codex.rs` for the follow-up.
**Non-goals:** actually moving code, implementing Codex, or touching `AppState` wiring. This document is a blueprint for Step 2.

> Agents 01 / 02 / 03 had not landed files in `.wolf/codex-port/` at synthesis time. This doc therefore quotes t3code sources directly (verbatim symbols, URLs below) and defers to their reports for contract/catalog details once merged.

**t3code sources consulted (`main` branch):**
- `apps/server/src/provider/Services/ProviderAdapter.ts` — canonical adapter contract
- `apps/server/src/provider/Services/ServerProvider.ts` — snapshot/refresh/changes triple
- `apps/server/src/provider/Services/ClaudeAdapter.ts` + `Layers/ClaudeAdapter.ts` — Claude impl shape
- `apps/server/src/provider/Services/CodexAdapter.ts` + `Layers/CodexAdapter.ts` + `Layers/CodexSessionRuntime.ts` — Codex impl shape
- `packages/contracts/src/providerRuntime.ts` — `ProviderRuntimeEvent` discriminated union

---

## 1. Why mirror t3code's shape at all?

t3code factors every CLI backend (Claude Agent SDK, Codex app-server JSON-RPC, Cursor ACP, OpenCode) behind one interface: **`ProviderAdapterShape<TError>`** in `apps/server/src/provider/Services/ProviderAdapter.ts`. Each concrete adapter (`ClaudeAdapter`, `CodexAdapter`, …) simply narrows `provider: ProviderKind` and reuses the exact same method set. That means:

- Adding Codex does **not** change the call sites in `lib.rs` — only which adapter the dispatch picks.
- The **event stream** is already canonicalised at the adapter boundary (`streamEvents: Stream.Stream<ProviderRuntimeEvent>`), so the frontend never sees a Claude-shaped event vs. a Codex-shaped event.

Our port preserves that separation. T64's frontend already tolerates stringified JSON over `claude-event`; we will upgrade it to the canonical tagged `ProviderEvent` so it's provider-agnostic from day one.

---

## 2. Draft `pub trait ProviderAdapter` (Rust)

Rust equivalent of `ProviderAdapterShape<TError>` from `ProviderAdapter.ts:43–116`.

**Translations applied:**
- `Effect.Effect<T, E>` → `async fn(...) -> Result<T, ProviderAdapterError>` (tokio, not Effect).
- `Stream.Stream<ProviderRuntimeEvent>` → `tokio::sync::mpsc::UnboundedReceiver<ProviderEvent>` returned from `start_session` / `send_turn` (per-session), and a shared broadcast channel exposed to the caller.
- `ReadonlyArray<T>` → `Vec<T>`.
- `ThreadId` / `TurnId` / `ApprovalRequestId` → newtype `String` wrappers in `src-tauri/src/providers/types.rs`.
- The trait is `Send + Sync` (lives behind `Arc<dyn ProviderAdapter>` in `AppState`).
- `&self` everywhere (interior mutability with `Mutex`/`RwLock`, mirroring current `ClaudeManager` → `Arc<Mutex<HashMap<..>>>` pattern).

```rust
// src-tauri/src/providers/adapter.rs

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::providers::types::{
    ApprovalRequestId, ProviderApprovalDecision, ProviderEvent, ProviderKind,
    ProviderSendTurnInput, ProviderSession, ProviderSessionStartInput,
    ProviderThreadSnapshot, ProviderTurnStartResult, ProviderUserInputAnswers,
    ThreadId, TurnId,
};
use crate::providers::error::ProviderAdapterError;

/// Matches `ProviderSessionModelSwitchMode` in ProviderAdapter.ts:19.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderSessionModelSwitchMode {
    InSession,
    Unsupported,
}

/// Matches `ProviderAdapterCapabilities` in ProviderAdapter.ts:23–27.
#[derive(Debug, Clone)]
pub struct ProviderAdapterCapabilities {
    pub session_model_switch: ProviderSessionModelSwitchMode,
}

/// The primary event-stream handle returned when a session starts.
/// Replaces `streamEvents: Stream.Stream<ProviderRuntimeEvent>` with
/// a tokio mpsc receiver — 1:1 with the existing `emit("claude-event")`
/// fan-out but typed.
pub struct ProviderEventStream {
    pub rx: mpsc::UnboundedReceiver<ProviderEvent>,
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    /// `provider` discriminator — see ProviderAdapter.ts:48.
    fn provider(&self) -> ProviderKind;

    /// `capabilities` — ProviderAdapter.ts:49.
    fn capabilities(&self) -> ProviderAdapterCapabilities;

    /// Start a provider-backed session. ProviderAdapter.ts:54–57.
    /// Returns the session descriptor AND the mpsc receiver that will
    /// carry every `ProviderEvent` produced by this session until exit.
    async fn start_session(
        &self,
        input: ProviderSessionStartInput,
    ) -> Result<(ProviderSession, ProviderEventStream), ProviderAdapterError>;

    /// Send a turn to an active provider session. ProviderAdapter.ts:62–64.
    async fn send_turn(
        &self,
        input: ProviderSendTurnInput,
    ) -> Result<ProviderTurnStartResult, ProviderAdapterError>;

    /// Interrupt an active turn. ProviderAdapter.ts:69.
    async fn interrupt_turn(
        &self,
        thread_id: &ThreadId,
        turn_id: Option<&TurnId>,
    ) -> Result<(), ProviderAdapterError>;

    /// Respond to a permission/approval request. ProviderAdapter.ts:74–78.
    async fn respond_to_request(
        &self,
        thread_id: &ThreadId,
        request_id: &ApprovalRequestId,
        decision: ProviderApprovalDecision,
    ) -> Result<(), ProviderAdapterError>;

    /// Respond to a structured user-input request. ProviderAdapter.ts:83–87.
    async fn respond_to_user_input(
        &self,
        thread_id: &ThreadId,
        request_id: &ApprovalRequestId,
        answers: ProviderUserInputAnswers,
    ) -> Result<(), ProviderAdapterError>;

    /// Stop one provider session. ProviderAdapter.ts:92.
    async fn stop_session(&self, thread_id: &ThreadId) -> Result<(), ProviderAdapterError>;

    /// List active sessions owned by this adapter. ProviderAdapter.ts:97.
    async fn list_sessions(&self) -> Vec<ProviderSession>;

    /// Does this adapter own `thread_id`? ProviderAdapter.ts:102.
    async fn has_session(&self, thread_id: &ThreadId) -> bool;

    /// Read a provider thread snapshot. ProviderAdapter.ts:107.
    async fn read_thread(
        &self,
        thread_id: &ThreadId,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError>;

    /// Roll back a provider thread by N turns. ProviderAdapter.ts:112–115.
    /// On T64 today, this is implemented via `truncate_session_jsonl` /
    /// `--resume-session-at` — the trait gives both providers a single door.
    async fn rollback_thread(
        &self,
        thread_id: &ThreadId,
        num_turns: u32,
    ) -> Result<ProviderThreadSnapshot, ProviderAdapterError>;

    /// Stop every session this adapter owns. ProviderAdapter.ts:120.
    async fn stop_all(&self) -> Result<(), ProviderAdapterError>;
}
```

### Mapping table — t3code method → T64 today

| t3code (`ProviderAdapterShape`) | T64 equivalent today | File / lines |
|---|---|---|
| `startSession` | `ClaudeManager::create_session` | `claude_manager.rs:751–806` |
| `sendTurn` | `ClaudeManager::send_prompt` | `claude_manager.rs:808–848` |
| `interruptTurn` | `ClaudeManager::cancel` | `claude_manager.rs:850–860` |
| `stopSession` | `ClaudeManager::close` (delegates to `cancel`) | `claude_manager.rs:862–864` |
| `respondToRequest` | `PermissionServer` MCP approver path — routed via the `mcp__t64__approve` tool (see `build_command` note at `claude_manager.rs:487–492`). Not owned by `ClaudeManager` yet | `permission_server.rs` |
| `respondToUserInput` | Not currently exposed — new surface for Step 2 | — |
| `listSessions` | Implicit from `instances: HashMap<String, ClaudeInstance>` at `claude_manager.rs:359`. No public getter today | `claude_manager.rs:359` |
| `hasSession` | Same as above — implicit map lookup | `claude_manager.rs:733–739` |
| `readThread` | `load_session_history` (lives in `lib.rs`, reads JSONL) | `lib.rs` (session JSONL commands) |
| `rollbackThread` | `truncate_session_jsonl` + `fork_session_jsonl` in `lib.rs` + `--resume-session-at` flag | `claude_manager.rs:495–499` |
| `stopAll` | Not implemented; shutdown loops over `instances` implicitly | — |
| `streamEvents` | `app_handle.emit("claude-event", …)` + `emit("claude-done", …)` at `claude_manager.rs:646–654, 720–730` | `claude_manager.rs` |

---

## 3. `ProviderEvent` enum (Rust, serde-tagged)

Matches the `ProviderRuntimeEvent` union defined in `packages/contracts/src/providerRuntime.ts`. The TS file lists 48 distinct event types under `ProviderRuntimeEventType` (providerRuntime.ts:135–184). Every variant shares a base envelope (providerRuntime.ts:228+):

```ts
const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  // + per-variant fields via Schema.Union
});
```

Rust port strategy:
- **External-tagged** serde enum with `#[serde(tag = "type")]`, renaming variants to the kebab-case strings from `ProviderRuntimeEventType`. The frontend can decode the event as-is — no schema change needed beyond typing.
- Shared base fields live in a `ProviderEventEnvelope` struct flattened with `#[serde(flatten)]` into each variant payload. This mirrors the TS `ProviderRuntimeEventBase.pipe(Schema.extend(...))` idiom.
- Variant payloads are plain `serde_json::Value` for Step 1, **not** typed. Reason: the contract TS file is 600+ lines of per-variant schemas; binding each one is out-of-scope for this refactor. We type the envelope + the discriminator, keep the payload opaque, and iterate later.

```rust
// src-tauri/src/providers/events.rs

use serde::{Deserialize, Serialize};

use crate::providers::types::{EventId, IsoDateTime, ProviderKind, ThreadId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderEventEnvelope {
    #[serde(rename = "eventId")]
    pub event_id: EventId,
    pub provider: ProviderKind,
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    #[serde(rename = "createdAt")]
    pub created_at: IsoDateTime,
}

/// 1:1 with `ProviderRuntimeEventType` in
/// packages/contracts/src/providerRuntime.ts:135–184.
/// The `type` tag uses the exact kebab-case strings from the TS union so
/// the frontend decodes without a translation layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProviderEvent {
    #[serde(rename = "session.started")]
    SessionStarted {
        #[serde(flatten)]
        base: ProviderEventEnvelope,
        #[serde(flatten)]
        payload: serde_json::Value,
    },
    #[serde(rename = "session.configured")]
    SessionConfigured { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "session.state.changed")]
    SessionStateChanged { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "session.exited")]
    SessionExited { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "thread.started")]
    ThreadStarted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.state.changed")]
    ThreadStateChanged { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.metadata.updated")]
    ThreadMetadataUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.token-usage.updated")]
    ThreadTokenUsageUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.realtime.started")]
    ThreadRealtimeStarted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.realtime.item-added")]
    ThreadRealtimeItemAdded { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.realtime.audio.delta")]
    ThreadRealtimeAudioDelta { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.realtime.error")]
    ThreadRealtimeError { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "thread.realtime.closed")]
    ThreadRealtimeClosed { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "turn.started")]
    TurnStarted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "turn.completed")]
    TurnCompleted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "turn.aborted")]
    TurnAborted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "turn.plan.updated")]
    TurnPlanUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "turn.proposed.delta")]
    TurnProposedDelta { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "turn.proposed.completed")]
    TurnProposedCompleted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "turn.diff.updated")]
    TurnDiffUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "item.started")]
    ItemStarted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "item.updated")]
    ItemUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "item.completed")]
    ItemCompleted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "content.delta")]
    ContentDelta { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "request.opened")]
    RequestOpened { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "request.resolved")]
    RequestResolved { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "user-input.requested")]
    UserInputRequested { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "user-input.resolved")]
    UserInputResolved { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "task.started")]
    TaskStarted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "task.progress")]
    TaskProgress { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "task.completed")]
    TaskCompleted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "hook.started")]
    HookStarted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "hook.progress")]
    HookProgress { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "hook.completed")]
    HookCompleted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "tool.progress")]
    ToolProgress { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "tool.summary")]
    ToolSummary { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },

    #[serde(rename = "auth.status")]
    AuthStatus { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "account.updated")]
    AccountUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "account.rate-limits.updated")]
    AccountRateLimitsUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "mcp.status.updated")]
    McpStatusUpdated { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "mcp.oauth.completed")]
    McpOauthCompleted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "model.rerouted")]
    ModelRerouted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "config.warning")]
    ConfigWarning { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "deprecation.notice")]
    DeprecationNotice { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "files.persisted")]
    FilesPersisted { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "runtime.warning")]
    RuntimeWarning { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
    #[serde(rename = "runtime.error")]
    RuntimeError { #[serde(flatten)] base: ProviderEventEnvelope, #[serde(flatten)] payload: serde_json::Value },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    ClaudeAgent,
    Codex,
    Cursor,
    OpenCode,
}
```

**Emission path** (replaces `claude_manager.rs:646–654`):

```rust
let event = ProviderEvent::ContentDelta { base, payload };
app_handle.emit("provider-event", &event)?;
```

The current `ClaudeEvent { session_id, data: String }` at `types.rs:59–63` becomes a compat alias that wraps `ProviderEvent` so existing listeners continue to work during the migration window.

---

## 4. Refactor plan — `claude_manager.rs` → `providers/claude.rs`

### Target layout

```
src-tauri/src/providers/
├── mod.rs              # re-exports ProviderAdapter, ProviderEvent, registry
├── adapter.rs          # ProviderAdapter trait (section 2)
├── events.rs           # ProviderEvent enum (section 3)
├── error.rs            # ProviderAdapterError (matches Errors.ts)
├── types.rs            # ThreadId, TurnId, ProviderKind, ProviderSession, etc.
├── registry.rs         # HashMap<ProviderKind, Arc<dyn ProviderAdapter>>
├── claude.rs           # impl ProviderAdapter for ClaudeProvider
├── codex.rs            # impl ProviderAdapter for CodexProvider (stub)
└── util.rs             # shim_command, resolve_*_path, cap_event_size (shared)
```

### What moves out of `claude_manager.rs`

| Current symbol | Current location | Target location |
|---|---|---|
| `resolve_claude_path` | `claude_manager.rs:8–84` | `providers/claude.rs` (Claude-specific — binary lookup) |
| `shim_command` | `claude_manager.rs:366–379` | `providers/util.rs` (shared with Codex, which also needs `cmd /C` on Windows) |
| `build_command` | `claude_manager.rs:384–527` | `providers/claude.rs` (private; arg translation stays Claude-only) |
| `resolve_session_id` | `claude_manager.rs:534–541` | `providers/claude.rs` |
| `stderr_rejects_session_id_flag` | `claude_manager.rs:546–550` | `providers/claude.rs` |
| `spawn_and_stream` | `claude_manager.rs:552–742` | `providers/claude.rs` — **rewritten** to produce `ProviderEvent`s over `mpsc::UnboundedSender<ProviderEvent>` instead of raw `emit("claude-event", ClaudeEvent { data: String })` |
| `session_jsonl_path` | `claude_manager.rs:95–104` | `providers/claude.rs` (JSONL path is a Claude CLI implementation detail; Codex has its own thread storage) |
| `sanitize_dangling_tool_uses` | `claude_manager.rs:110–238` | `providers/claude.rs` — **Claude-specific**: the tool_use/tool_result reconciliation matches Claude CLI's JSONL format exactly. Codex has its own rollout file model (see `CodexSessionRuntime.ts` resume-cursor logic) and will need its own sanitizer |
| `MAX_EVENT_LINE_BYTES` + `cap_event_size` + `truncate_text_field` + `char_boundary_*` | `claude_manager.rs:246–354` | `providers/util.rs` (size-cap protection applies to any provider streaming large tool results) |
| `ClaudeInstance` / `ClaudeManager` / `GENERATION` | `claude_manager.rs:86–91, 358–360, 744–865` | `providers/claude.rs` (renamed `ClaudeProvider`, implements `ProviderAdapter`) |
| `resolve_openwolf_path` / `openwolf_env_path` / `ensure_openwolf` / `openwolf_hook_entries` / `merge_openwolf_hooks` | `claude_manager.rs:867–1189` | **Split out.** These are OpenWolf-related, not provider-related. Move to a new `src-tauri/src/openwolf.rs` in the same refactor to keep `providers/claude.rs` focused. |

### What stays in `AppState` (`src-tauri/src/lib.rs`)

Today:
```rust
// lib.rs:205–207
struct AppState {
    claude_manager: Arc<ClaudeManager>,
    …
}
```

After the refactor:
```rust
struct AppState {
    providers: Arc<ProviderRegistry>,  // new: HashMap<ProviderKind, Arc<dyn ProviderAdapter>>
    …
}
```

- **Stays in AppState:** PTY manager, Discord bot, permission server, audio manager, browser manager, widget server, settings — none of these are provider-specific.
- **Removed from AppState:** `claude_manager: Arc<ClaudeManager>` (replaced by `providers`).
- **Wiring** (`lib.rs:4911` currently `claude_manager: Arc::new(ClaudeManager::new())`): becomes `providers: Arc::new(ProviderRegistry::with_claude())` initially; `with_codex()` adds the stub later.

### Tauri command migration

The commands at `lib.rs:325-ish, 361-ish, 366–368, 371–390` currently call `state.claude_manager.{create_session, send_prompt, cancel, close}`. They'll become:

```rust
// Unchanged external surface — same invoke name, same args.
#[tauri::command]
async fn create_claude_session(state: State<'_, AppState>, …) -> Result<String, String> {
    let adapter = state.providers.get(ProviderKind::ClaudeAgent)?;
    adapter.start_session(input).await
        .map(|(sess, stream)| { spawn_event_forwarder(stream, app_handle); sess.thread_id })
        .map_err(|e| e.to_string())
}
```

No frontend change required at Step 1. In Step 2 we introduce a `create_provider_session` that accepts a `provider: ProviderKind` arg and deprecate the per-provider commands.

### Event emission bridge

A single `spawn_event_forwarder` task in `providers/mod.rs` drains each session's `mpsc::UnboundedReceiver<ProviderEvent>` and forwards to Tauri:

```rust
tokio::spawn(async move {
    while let Some(ev) = stream.rx.recv().await {
        let _ = app_handle.emit("provider-event", &ev);
    }
    let _ = app_handle.emit("provider-session-done", ThreadId(...));
});
```

This replaces the per-thread std::thread + `emit("claude-event")` pair at `claude_manager.rs:636–731`. The stale-generation guard at `claude_manager.rs:706–720` moves **inside** `ClaudeProvider`, which still tracks `generation: u64` per `ClaudeInstance` — the invariant (don't emit `done` from a superseded reader) is unchanged.

### Migration order (Step 2 — not now)

1. Land `providers/{adapter,events,error,types,registry,util}.rs` — no behaviour change, `ClaudeManager` still in place.
2. Add `providers/claude.rs` implementing `ProviderAdapter`, wrapping the existing `ClaudeManager` — pure delegation, translating JSON-RPC stream lines into `ProviderEvent::ContentDelta { payload: ... }`.
3. Switch `AppState` to `providers`; keep old Tauri commands as thin shims over `providers.get(ClaudeAgent)`.
4. Migrate frontend listeners from `claude-event` → `provider-event`.
5. Delete `claude_manager.rs`; move the OpenWolf block to `openwolf.rs`.
6. Add `codex.rs` (section 5).

---

## 5. `providers/codex.rs` — stub

**Reference:** `apps/server/src/provider/Layers/CodexSessionRuntime.ts` + `Layers/CodexAdapter.ts`.

Key differences from Claude that drive the stub's shape:

- **Transport:** Codex speaks JSON-RPC over stdio to `codex app-server`, not `--print --output-format stream-json`. The binary is spawned once per session and kept alive; requests are sent as JSON-RPC messages on stdin. t3code uses `effect-codex-app-server/client` + `rpc` modules for this — Rust equivalent will be a hand-rolled length-prefixed JSON-RPC reader/writer pair wrapping `tokio::process::Child`.
- **Session init:** `buildCodexInitializeParams` in `CodexProvider.ts` + `V2SessionStartParams` — initialization and turn-start are **two separate RPCs**, unlike Claude CLI's single spawn-with-prompt flow.
- **Developer instructions:** `CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS` and `CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS` from `CodexDeveloperInstructions.ts` are passed as part of `V2SessionStartParams`. Port as `const`s in `providers/codex.rs`.
- **Thread persistence:** Codex writes rollout files with its own schema; the resume cursor is a `{ threadId: string }` (`CodexResumeCursorSchema` at `CodexSessionRuntime.ts`). No `sanitize_dangling_tool_uses` equivalent — the app-server manages its own thread state. Benign errors like `"state db missing rollout path"` are filtered at `CodexSessionRuntime.ts:BENIGN_ERROR_LOG_SNIPPETS`; port that filter list as-is.
- **Event shape:** incoming Codex events go through `EffectCodexSchema.V2*` → map to `ProviderEvent::*`. Mapping table **deferred to Agent 3's report** (`03-codex-adapter.md` when it lands). The stub leaves `// TODO(codex): map <CodexEventName> → ProviderEvent::<Variant>` markers at the known insertion points.

```rust
// src-tauri/src/providers/codex.rs — STUB, no logic, Step 2 scaffold.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::providers::adapter::{
    ProviderAdapter, ProviderAdapterCapabilities, ProviderEventStream,
    ProviderSessionModelSwitchMode,
};
use crate::providers::error::ProviderAdapterError;
use crate::providers::types::{
    ApprovalRequestId, ProviderApprovalDecision, ProviderKind, ProviderSendTurnInput,
    ProviderSession, ProviderSessionStartInput, ProviderThreadSnapshot,
    ProviderTurnStartResult, ProviderUserInputAnswers, ThreadId, TurnId,
};

pub struct CodexSessionHandle {
    pub child: Child,
    pub thread_id: ThreadId,
    // TODO(codex): writer half of stdin JSON-RPC pipe
    // TODO(codex): in-flight request map: request_id -> oneshot::Sender<Response>
}

pub struct CodexProvider {
    sessions: Arc<Mutex<HashMap<ThreadId, CodexSessionHandle>>>,
    // TODO(codex): resolved binary path (cached); PATH injection helpers
    // TODO(codex): developer-instructions constants (default / plan modes)
}

impl CodexProvider {
    pub fn new() -> Self {
        Self { sessions: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Build the `codex app-server` spawn command.
    /// TODO(codex): mirror `shim_command` for Windows .cmd resolution.
    /// TODO(codex): args go here — Codex has NO `--output-format stream-json`.
    /// Instead: bare `app-server` subcommand, JSON-RPC over stdio.
    fn build_command(_input: &ProviderSessionStartInput) -> Command {
        // TODO(codex): Command::new(resolve_codex_path())
        //              .arg("app-server")
        //              .stdout(Stdio::piped()).stdin(Stdio::piped()).stderr(Stdio::piped());
        unimplemented!("codex spawn args — see Agent 3 report for exact flags")
    }

    /// Serialize `V2SessionStartParams` (buildCodexInitializeParams in
    /// CodexProvider.ts) and send as a JSON-RPC request on session stdin.
    /// TODO(codex): include CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS or the
    /// plan-mode variant depending on `input.permission_mode`.
    async fn send_initialize(&self, _handle: &CodexSessionHandle) -> Result<(), ProviderAdapterError> {
        unimplemented!()
    }

    /// Reader task — equivalent to ClaudeProvider's stdout line reader at
    /// claude_manager.rs:636–661 but JSON-RPC framed (Content-Length headers).
    /// Maps each Codex event into a `ProviderEvent` variant.
    /// TODO(codex): implement event mapping table from
    ///   effect-codex-app-server/schema V2 types → ProviderEvent variants.
    /// TODO(codex): apply BENIGN_ERROR_LOG_SNIPPETS filter (see
    ///   CodexSessionRuntime.ts) to stderr before emitting RuntimeError.
    async fn reader_loop(
        _handle: Arc<Mutex<CodexSessionHandle>>,
        _tx: tokio::sync::mpsc::UnboundedSender<crate::providers::events::ProviderEvent>,
    ) {
        unimplemented!()
    }
}

#[async_trait]
impl ProviderAdapter for CodexProvider {
    fn provider(&self) -> ProviderKind { ProviderKind::Codex }

    fn capabilities(&self) -> ProviderAdapterCapabilities {
        // TODO(codex): confirm from CodexProvider.ts — Codex currently
        // reports sessionModelSwitch: "in-session".
        ProviderAdapterCapabilities {
            session_model_switch: ProviderSessionModelSwitchMode::InSession,
        }
    }

    async fn start_session(
        &self,
        _input: ProviderSessionStartInput,
    ) -> Result<(ProviderSession, ProviderEventStream), ProviderAdapterError> {
        // TODO(codex): spawn `codex app-server`, send initialize RPC,
        // send V2SessionStart, return ThreadId + event stream.
        unimplemented!()
    }

    async fn send_turn(&self, _input: ProviderSendTurnInput) -> Result<ProviderTurnStartResult, ProviderAdapterError> {
        // TODO(codex): send V2TurnStart JSON-RPC. Note that
        // CodexSessionRuntime.ts extends V2TurnStartParams with
        // `collaborationMode` — keep that in the Rust params struct.
        unimplemented!()
    }

    async fn interrupt_turn(&self, _thread_id: &ThreadId, _turn_id: Option<&TurnId>) -> Result<(), ProviderAdapterError> {
        // TODO(codex): V2TurnInterrupt RPC.
        unimplemented!()
    }

    async fn respond_to_request(
        &self,
        _thread_id: &ThreadId,
        _request_id: &ApprovalRequestId,
        _decision: ProviderApprovalDecision,
    ) -> Result<(), ProviderAdapterError> {
        // TODO(codex): V2ApprovalDecision RPC.
        unimplemented!()
    }

    async fn respond_to_user_input(
        &self,
        _thread_id: &ThreadId,
        _request_id: &ApprovalRequestId,
        _answers: ProviderUserInputAnswers,
    ) -> Result<(), ProviderAdapterError> {
        // TODO(codex): V2UserInputAnswer RPC.
        unimplemented!()
    }

    async fn stop_session(&self, _thread_id: &ThreadId) -> Result<(), ProviderAdapterError> {
        // TODO(codex): send V2SessionStop, then child.kill() if graceful times out.
        unimplemented!()
    }

    async fn list_sessions(&self) -> Vec<ProviderSession> { Vec::new() }
    async fn has_session(&self, _thread_id: &ThreadId) -> bool { false }

    async fn read_thread(&self, _thread_id: &ThreadId) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        // TODO(codex): V2ThreadRead RPC → canonicalize items.
        unimplemented!()
    }

    async fn rollback_thread(&self, _thread_id: &ThreadId, _num_turns: u32) -> Result<ProviderThreadSnapshot, ProviderAdapterError> {
        // TODO(codex): V2ThreadRollback RPC.
        unimplemented!()
    }

    async fn stop_all(&self) -> Result<(), ProviderAdapterError> {
        // TODO(codex): iterate self.sessions and stop each.
        unimplemented!()
    }
}
```

---

## 6. Open questions for Step 2

1. **Typed payloads vs. `serde_json::Value`** — worth the line count to bind every `ProviderRuntimeEvent` variant's payload in Rust, or is opaque `Value` fine long-term? Recommend: opaque now, type the 6–8 most-consumed variants (content.delta, item.*, turn.*) in a follow-up.
2. **Approval routing** — today's `PermissionServer` (TCP, `mcp__t64__approve`) is orthogonal to `ProviderAdapter::respond_to_request`. Decide whether approvals continue to flow through the MCP shim or migrate to the trait method. Recommend: keep MCP for Claude (it's the only escape hatch for sensitive-file paths — see `claude_manager.rs:480–492`), use the trait method for Codex.
3. **`async-trait` cost** — dynamic dispatch + boxed futures on every call. Not a hot path (session lifecycle), so fine.
4. **Generation counter** — move it into `ClaudeProvider` or into a shared base? Claude's stale-reader guard (`claude_manager.rs:706–720`) is Claude-specific (PTY restart on resume); Codex keeps the same process open, so it probably doesn't need it. Keep per-provider.
5. **`CreateClaudeRequest` / `SendClaudePromptRequest` fields at `types.rs:28–57`** — several are Claude-specific (`mcp_config`, `channel_server`, `resume_session_at`, `fork_session`). Resolve by splitting into `ProviderSessionStartInput` (common) + `ClaudeSessionStartOptions` (Claude-only, stashed in `input.provider_options` as a typed enum).

---

## 7. Deliverable checklist

- [x] Draft `ProviderAdapter` trait in Rust with tokio/mpsc shape — §2
- [x] `ProviderEvent` enum with serde tags matching `ProviderRuntimeEventType` — §3
- [x] Refactor plan: what moves from `claude_manager.rs` → `providers/claude.rs`, what stays in `AppState`, with exact line-number references — §4
- [x] `providers/codex.rs` stub showing spawn-arg + event-mapping insertion points — §5
- [x] No T64 source files modified — confirmed (only this planning doc written)
