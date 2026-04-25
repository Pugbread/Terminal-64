# 03 — Codex Adapter (research only)

Source files (t3code @ `main`, `apps/server/src/provider/Layers/`):
- `CodexAdapter.ts` (1683 lines) — `CodexAdapterLive` Layer
- `CodexProvider.ts` (519 lines) — `CodexProviderLive` Layer (probe + capabilities)
- `CodexSessionRuntime.ts` (1331 lines) — typed runtime wrapper (read but not quoted heavily)
- `apps/server/src/provider/builtInProviderCatalog.ts` (49 lines)
- `apps/server/src/provider/Services/ProviderAdapter.ts` (126 lines) — contract

All quoted symbols are real. Citations use `file:line`.

---

## (a) Codex CLI invocation

**Subcommand: `codex app-server`** (not `codex --json`). t3code speaks the **Codex App Server JSON-RPC protocol** via the external package `effect-codex-app-server/client` — it does *not* parse a stream-json stdout format.

Spawn call (`CodexProvider.ts:255-261`):

```ts
CodexClient.layerCommand({
  command: input.binaryPath,          // from settings.providers.codex.binaryPath
  args: ["app-server"],
  cwd: input.cwd,
  ...(input.homePath ? { env: { CODEX_HOME: expandHomePath(input.homePath) } } : {}),
})
```

Per-session runtime uses the same launch shape (see `CodexAdapter.ts:1368-1384` for the options passed into `makeCodexSessionRuntime`, which internally uses `CodexClient.layerCommand` again with `args: ["app-server"]`).

**Initialize handshake** (`CodexProvider.ts:235-276`):
1. JSON-RPC request `initialize` with:
   ```ts
   clientInfo: { name: "t3code_desktop", title: "T3 Code Desktop", version: packageJson.version }
   capabilities: { experimentalApi: true }
   ```
2. JSON-RPC notification `initialized` (no payload).
3. Version is extracted from `initialize.userAgent` by regex `/\/([^\s]+)/`.

**Probe / bootstrap requests** (`CodexProvider.ts:282-300`, parallel):
- `account/read` → `V2GetAccountResponse` (determines auth state: `apiKey` vs ChatGPT plan types: free/go/plus/pro/prolite/team/business/enterprise/edu).
- `model/list` (paged via `cursor`, loop in `requestAllCodexModels`, `CodexProvider.ts:217-233`) → `V2ModelListResponse`.
- `skills/list` with `{ cwds: [input.cwd] }` → `V2SkillsListResponse`.

**Turn submission (`turn/start` equivalent)** (`CodexAdapter.ts:1486-1518`): `session.runtime.sendTurn(...)` takes:
- `input` (prompt text)
- `model` (only when `modelSelection.provider === "codex"`)
- `effort` — reasoning effort enum: `none | minimal | low | medium | high | xhigh`
- `serviceTier: "fast"` (when capability `fastMode` boolean is set)
- `interactionMode`
- `attachments` — images encoded as `data:<mime>;base64,<bytes>` URIs (`CodexAdapter.ts:1480-1483`)

**Settings shape** (`codexSettings`, from `ServerSettingsService`): `.enabled`, `.binaryPath`, `.homePath`, `.customModels`.

**Fatal-stderr heuristic** (`CodexAdapter.ts:134-139`): substring match on `"failed to connect to websocket"` promotes a `process/stderr` event from warning to fatal error — a real Codex failure mode worth keeping.

---

## (b) Event mapping — Codex method → `ProviderRuntimeEvent.type`

The adapter's `mapToRuntimeEvents(event, canonicalThreadId)` (`CodexAdapter.ts:471-1319`) is the whole translation layer. `event.kind` is `"error" | "request" | "notification"`; `event.method` is the Codex JSON-RPC method string. Each branch emits zero, one, or (for `windowsSandbox/setupCompleted`) two runtime events.

### Core session / thread / turn

| Codex event                       | `ProviderRuntimeEvent.type`      | Notes (payload shape)                                              |
|----------------------------------|----------------------------------|--------------------------------------------------------------------|
| `session/connecting` (notif)     | `session.state.changed`          | `state: "starting"`                                                |
| `session/ready` (notif)          | `session.state.changed`          | `state: "ready"`                                                   |
| `session/started` (notif)        | `session.started`                | carries optional `resume`                                          |
| `session/exited` / `session/closed` | `session.exited`              | `exitKind: "graceful"` for `closed`                                |
| `thread/started` (notif)         | `thread.started`                 | `providerThreadId` = payload.thread.id                             |
| `thread/status/changed`          | `thread.state.changed`           | `toThreadState(status)` — `idle \| error \| active`                |
| `thread/archived`                | `thread.state.changed`           | `state: "archived"`                                                |
| `thread/unarchived`              | `thread.state.changed`           | `state: "active"`                                                  |
| `thread/closed`                  | `thread.state.changed`           | `state: "closed"`                                                  |
| `thread/compacted`               | `thread.state.changed`           | `state: "compacted"`                                               |
| `thread/name/updated`            | `thread.metadata.updated`        | `name`, plus `metadata.threadId`/`metadata.threadName`             |
| `thread/tokenUsage/updated`      | `thread.token-usage.updated`     | normalized `ThreadTokenUsageSnapshot` (see note below)             |
| `turn/started`                   | `turn.started`                   | empty payload                                                      |
| `turn/completed`                 | `turn.completed`                 | `state: toTurnStatus(...)`, optional `errorMessage`                |
| `turn/aborted`                   | `turn.aborted`                   | `reason`                                                           |
| `turn/plan/updated`              | `turn.plan.updated`              | `plan[]` with `{step, status}`, optional `explanation`             |
| `turn/diff/updated`              | `turn.diff.updated`              | `unifiedDiff`                                                      |

Token usage normalization (`CodexAdapter.ts:141-175`, `normalizeCodexTokenUsage`): maps Codex's `tokenUsage.last.*` + `tokenUsage.total.*` + `modelContextWindow` into `{usedTokens, totalProcessedTokens?, maxTokens?, inputTokens?, cachedInputTokens?, outputTokens?, reasoningOutputTokens?, lastUsedTokens, lastInputTokens, lastCachedInputTokens, lastOutputTokens, lastReasoningOutputTokens, compactsAutomatically: true}`. Drops usage entirely if `usedTokens <= 0`.

### Items (assistant output units)

Item types are canonicalized by `toCanonicalItemType(raw)` (`CodexAdapter.ts:202-221`) — a string-matching normalizer producing `CanonicalItemType ∈ {user_message, assistant_message, reasoning, plan, command_execution, file_change, mcp_tool_call, dynamic_tool_call, collab_agent_tool_call, web_search, image_view, review_entered, review_exited, context_compaction, error, unknown}`.

| Codex event                                 | Runtime event               | Notes                                                                              |
|--------------------------------------------|-----------------------------|------------------------------------------------------------------------------------|
| `item/started`                             | `item.started`              | `{itemType, status: "inProgress", title?, detail?, data}`                         |
| `item/completed` (generic)                 | `item.completed`            | `{itemType, status: "completed", title?, detail?, data}`                          |
| `item/completed` (when `itemType==="plan"`) | `turn.proposed.completed`   | `{planMarkdown: detail}` — **hijacked branch** if detail present                  |
| `item/reasoning/summaryPartAdded`          | `item.updated`              | `itemType: "reasoning"`                                                            |
| `item/commandExecution/terminalInteraction`| `item.updated`              | `itemType: "command_execution"`                                                    |

### Streaming deltas

All delta events collapse to `content.delta` with a `streamKind`:

| Codex event                                | `streamKind`                  |
|-------------------------------------------|-------------------------------|
| `item/agentMessage/delta`                 | `assistant_text`              |
| `item/reasoning/textDelta`                | `reasoning_text` (+ `contentIndex`) |
| `item/reasoning/summaryTextDelta`         | `reasoning_summary_text` (+ `summaryIndex`) |
| `item/commandExecution/outputDelta`       | `command_output`              |
| `item/fileChange/outputDelta`             | `file_change_output`          |
| `item/plan/delta`                         | *→ `turn.proposed.delta`* (not `content.delta`) |

### Approvals / user input / tool calls

`toRequestTypeFromMethod` (`CodexAdapter.ts:269-290`) and `toRequestTypeFromKind` (`CodexAdapter.ts:292-303`) produce `CanonicalRequestType`.

| Codex event (kind=request)                       | Runtime event          | `requestType`                 |
|-------------------------------------------------|------------------------|-------------------------------|
| `item/commandExecution/requestApproval`         | `request.opened`       | `command_execution_approval`  |
| `item/fileRead/requestApproval`                 | `request.opened`       | `file_read_approval`          |
| `item/fileChange/requestApproval`               | `request.opened`       | `file_change_approval`        |
| `applyPatchApproval`                            | `request.opened`       | `apply_patch_approval`        |
| `execCommandApproval`                           | `request.opened`       | `exec_command_approval`       |
| `item/tool/requestUserInput`                    | `user-input.requested` | — (emits `questions[]`)       |
| `item/tool/call`                                | `request.opened`       | `dynamic_tool_call`           |
| `account/chatgptAuthTokens/refresh`             | `request.opened`       | `auth_tokens_refresh`         |
| `item/requestApproval/decision` (notif)         | `request.resolved`     | (from `event.requestKind`)    |
| `serverRequest/resolved` (notif)                | `request.resolved`     | (from `event.requestKind`)    |
| `item/tool/requestUserInput/answered` (notif)   | `user-input.resolved`  | `answers` normalized          |
| `item/mcpToolCall/progress` (notif)             | `tool.progress`        | `summary: payload.message`    |

### Platform / account / realtime / diagnostics

| Codex event                                | Runtime event                  | Notes                                             |
|-------------------------------------------|--------------------------------|---------------------------------------------------|
| `model/rerouted`                          | `model.rerouted`               | `fromModel, toModel, reason`                      |
| `deprecationNotice`                       | `deprecation.notice`           | `summary, details?`                               |
| `configWarning`                           | `config.warning`               | `summary, details?, path?, range?`                |
| `account/updated`                         | `account.updated`              | raw account payload                               |
| `account/rateLimits/updated`              | `account.rate-limits.updated`  | raw rateLimits payload                            |
| `mcpServer/oauthLogin/completed`          | `mcp.oauth.completed`          | `success, name, error?`                           |
| `thread/realtime/started`                 | `thread.realtime.started`      | `realtimeSessionId`                               |
| `thread/realtime/itemAdded`               | `thread.realtime.item-added`   | `item`                                            |
| `thread/realtime/outputAudio/delta`       | `thread.realtime.audio.delta`  | `audio`                                           |
| `thread/realtime/error`                   | `thread.realtime.error`        | `message`                                         |
| `thread/realtime/closed`                  | `thread.realtime.closed`       | `reason`                                          |
| `error` (notif)                           | `runtime.warning` *if* `willRetry === true` else `runtime.error` | `class: "provider_error"` for error |
| `process/stderr`                          | `runtime.warning` OR `runtime.error` | fatal if message includes `"failed to connect to websocket"` |
| `windows/worldWritableWarning`            | `runtime.warning`              |                                                   |
| `windowsSandbox/setupCompleted`           | `session.state.changed` (+ optional `runtime.warning`) | state `ready` on success, `error` + extra warning on failure |
| `error` (kind=error)                      | `runtime.error`                | `class: "provider_error"`                         |

**Unhandled events** fall through `return [];` and are swallowed with an `Effect.logDebug` "ignoring unhandled Codex provider event" (`CodexAdapter.ts:1410-1416`).

**Every emitted event carries `runtimeEventBase`** (`CodexAdapter.ts:411-431`): `eventId, provider, threadId, createdAt, turnId?, itemId?, requestId?, providerRefs?, raw: { source: "codex.app-server.{request|notification}", method, payload }`.

---

## (c) Codex-specific escape hatches / things that don't fit cleanly

1. **`sessionModelSwitch: "in-session"` capability** (`CodexAdapter.ts:1659-1661`). The adapter advertises *mid-session model switching* — Claude's adapter almost certainly differs. This belongs on `ProviderAdapterCapabilities` (already declared in `ProviderAdapter.ts:26-33` as `ProviderSessionModelSwitchMode = "in-session" | "unsupported"`), so the contract handles it — but the T64 UI will need to read this flag per-provider.

2. **Reasoning effort + fast mode**, both provider-tagged (`CodexAdapter.ts:1377-1383`, `1494-1513`). Codex takes `reasoningEffort: none|minimal|low|medium|high|xhigh` and `serviceTier: "fast"`; Claude has neither. These are threaded through `ModelCapabilities.optionDescriptors` (`CodexProvider.ts:110-133`) — an opaque `{id, label, type, options?, currentValue?}` list. Any new provider has to plug into this same descriptor scheme rather than getting a bespoke Codex field.

3. **`modelSelection.provider === "codex"` gating.** Model selections are tagged with a provider kind and ignored if they belong to a different one (`CodexAdapter.ts:1377-1383`, `1495-1501`, `1504-1507`). Implies the shared `ProviderSendTurnInput.modelSelection` is a discriminated union — a new adapter must check `.provider === <ownKind>` before trusting its fields.

4. **Realtime voice sub-API** (5 events: `thread/realtime/started|itemAdded|outputAudio/delta|error|closed`). Claude has no analogue today. The enum has to include `thread.realtime.*` variants, but Claude's adapter will simply never emit them. Treat as optional per-provider surface area.

5. **Windows-specific notifications** (`windows/worldWritableWarning`, `windowsSandbox/setupCompleted`). Platform-scoped — doesn't generalize. Map into generic `runtime.warning` / `session.state.changed` and keep the raw payload on `.raw`.

6. **Dual approval schemas.** Two generations coexist: old (`applyPatchApproval`, `execCommandApproval`) and new (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/fileRead/requestApproval`). Both get mapped to `request.opened`. The Rust side needs to emit a canonical `request.opened` with `requestType` *regardless of which Codex version answered* — don't leak the method name upstream.

7. **Account-aware probe semantics.** `probeCodexAppServerProvider` (`CodexProvider.ts:248-308`) behaves very differently based on auth: if `requiresOpenaiAuth && !account`, it short-circuits *before* calling `skills/list` / `model/list`. The probe surfaces plan type (`Free/Go/Plus/Pro/Pro Lite/Team/Business/Enterprise/Edu`, `CodexProvider.ts:60-91`). Claude has no analogous concept — shared `ServerProvider.auth` needs to be flexible (`status + type? + label?`, `CodexProvider.ts:366-370`).

8. **OAuth on MCP servers** (`mcpServer/oauthLogin/completed`). Codex runs OAuth on behalf of MCP servers; Claude does not. Maps to `mcp.oauth.completed` — another optional event in the shared enum.

9. **`CODEX_HOME` env var** for auth/config directory (`CodexProvider.ts:259`). Per-provider env injection that T64's current `ClaudeManager` doesn't have a slot for. The Rust `Provider` trait's `start_session` needs an `env: HashMap<String, String>` or equivalent, computed by the provider implementation itself.

10. **Initialize `capabilities: { experimentalApi: true }`**. A magic opt-in flag — the adapter hard-codes it at two sites (`CodexProvider.ts:242-245` and `272-274`). Worth parameterizing if we plan to track Codex API evolution.

11. **Probe timeout (8 s)** and **refresh interval (5 min)** (`CodexProvider.ts:38`, `CodexProvider.ts:516`). The `makeManagedServerProvider` harness takes `refreshInterval: Duration`. In T64 Rust, each provider probably wants its own timeout constant passed to the manager.

12. **Attachments as `data:` URIs** (`CodexAdapter.ts:1480-1483`). Codex wants inline base64 `image/*` data URIs. Other providers may want file paths or a different schema — the `ProviderSendTurnInput.attachments` contract in shared code is typed, but each adapter translates it differently.

13. **Item-type normalization heuristic** (`toCanonicalItemType`, `CodexAdapter.ts:191-221`). String `includes` matching on free-form Codex item type names. Fragile by design; a hard switch to `CanonicalItemType` in the shared enum papers over this but puts the onus on each adapter to own its translation table.

---

## (d) Catalog wiring — how `claudeAgent` and `codex` become a registry

`builtInProviderCatalog.ts` is tiny (49 lines). Key shapes:

```ts
// line 14-20
type BuiltInProviderServiceMap = Record<ProviderKind, ServerProviderShape>;
type BuiltInAdapterMap = {
  readonly codex: ProviderAdapterShape<ProviderAdapterError>;
  readonly claudeAgent: ProviderAdapterShape<ProviderAdapterError>;
  readonly opencode: ProviderAdapterShape<ProviderAdapterError>;
  readonly cursor?: ProviderAdapterShape<ProviderAdapterError>;
};

// line 22-27 — enumeration order (UI reads this)
export const BUILT_IN_PROVIDER_ORDER = [
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
] as const satisfies ReadonlyArray<ProviderKind>;
```

Two factory functions:

**`createBuiltInProviderSources(services)`** (`builtInProviderCatalog.ts:29-38`) — emits one `ProviderSnapshotSource` per kind, each carrying `{ provider, getSnapshot, refresh, streamChanges }`. `ProviderSnapshotSource` is the UI-facing thing: an observable per provider with current state + refresh trigger.

**`createBuiltInAdapterList(adapters)`** (`builtInProviderCatalog.ts:40-49`) — returns a flat `ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>` in the canonical order. `cursor` is conditionally included (`...(adapters.cursor ? [adapters.cursor] : [])`); the other three are mandatory.

**Where `ProviderKind` lives.** The union type is imported from `@t3tools/contracts` (`builtInProviderCatalog.ts:1`) — a separate package, not defined in the provider layer. From this catalog plus the adapter imports in `CodexProvider.ts:18-26`, `ProviderKind` enumerates *at least* `"codex" | "claudeAgent" | "opencode" | "cursor"`. The string `"claudeAgent"` (not `"claude"`) is the canonical id.

**How the UI enumerates.** The frontend calls something that reads `BUILT_IN_PROVIDER_ORDER`; for each `ProviderKind` it subscribes to the matching `ProviderSnapshotSource.streamChanges` and displays the `ServerProvider` it receives — which carries `presentation: { displayName, showInteractionModeToggle }` (e.g. `CodexProvider.ts:39-42` sets `{ displayName: "Codex", showInteractionModeToggle: true }`) plus `probe`, `auth`, `models`, `skills`, `enabled`.

**Adapter → provider split.**
- `ServerProviderShape` (provider side) = metadata/probing/capabilities (is the CLI installed, what models does it offer, is the user authed).
- `ProviderAdapterShape` (adapter side) = runtime operations (start session, send turn, interrupt, approve, stream events). See `Services/ProviderAdapter.ts:45-126`.

Both are keyed by the same `ProviderKind` string, which is what makes the registry work.

**Implication for T64.** The Rust-side `Provider` trait should own both halves (or be split into `ProviderProbe` + `ProviderRuntime` mirroring t3code). `AppState` in `src-tauri/src/lib.rs` today has a single `ClaudeManager` behind `Arc<Mutex<…>>`; the refactor needs:
- A `HashMap<ProviderKind, Arc<dyn ProviderRuntime>>` registry in `AppState`.
- A `ProviderKind` enum (serde-tagged) mirroring `"claudeAgent" | "codex" | ...`, matching t3code's catalog strings exactly so the frontend can share types.
- A fixed enumeration order (the `BUILT_IN_PROVIDER_ORDER` equivalent) exposed via a Tauri command for the React side to list.
- Per-session routing: every existing `claude-output-{sessionId}` event becomes `provider-output-{sessionId}` (or the IPC carries `provider: ProviderKind` inside the payload) so the same event listener serves all providers.

---

## Summary for the Rust port

Start with **contract parity first** (Agent 1's deliverable) — the `ProviderRuntimeEvent` enum and `CanonicalItemType` / `CanonicalRequestType` / `CanonicalContentStreamKind` unions must be nailed down before Codex-specific code is written. Then: port `CodexSessionRuntime` as a Rust module wrapping the `codex app-server` JSON-RPC stdio pipe, and port `mapToRuntimeEvents` as a `fn translate_codex_event(&self, ev: CodexEvent) -> Vec<ProviderRuntimeEvent>` on the Codex adapter. The mapping table in (b) is the direct spec for that function.
