# Agent 3 — Frontend Store Refactor

## Goal
Move the Claude session source-of-truth off localStorage and onto the JSONL files at `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. localStorage becomes a transient UI cache.

## Contract change — localStorage schema

**Before** (`STORAGE_KEY = "terminal64-claude-sessions"`):
```ts
{
  [sessionId]: {
    sessionId, messages, model, tasks, totalCost, totalTokens,
    contextUsed, contextMax, promptCount, name, cwd, draftPrompt
  }
}
```

**After**:
```ts
{
  [sessionId]: PersistedSessionMeta = {
    sessionId: string;
    name: string;
    cwd: string;
    draftPrompt: string;
    lastSeenAt: number;
  }
}
```

If the user wipes `STORAGE_KEY` entirely, every named session still reopens with full history — the JSONL is untouched. Only the draft prompt, friendly name, and cached `cwd` are lost.

## Files changed

### `src/stores/claudeStore.ts` (rewritten)
- **`PersistedSessionMeta`** — new exported interface documenting the on-disk shape.
- **`saveToStorage`** — writes `{sessionId, name, cwd, draftPrompt, lastSeenAt}` only. The old quota-recovery path that truncated messages is gone; the payload can't realistically exceed quota now. Still prunes ephemeral delegation children (name prefix `"[D] "`).
- **`loadSession` deleted.** Replaced by `loadMetadata(sessionId)` which returns only `PersistedSessionMeta`.
- **`ClaudeSession.jsonlLoaded: boolean`** — new field. `true` once the JSONL hydration has completed (or failed). UI can distinguish "empty session" from "still loading". Ephemeral sessions start with `jsonlLoaded: true` (they never touch disk).
- **`createSession(sessionId, initialName?, ephemeral?, skipOpenwolf?, cwd?)`** — new optional 5th `cwd` param. When not ephemeral and `cwd` is known, synchronously seeds an empty in-memory session from persisted metadata and kicks off an async `loadSessionHistory(sessionId, cwd)` → `loadFromDisk(...)`. If the session already exists and a `cwd` is newly supplied, adopts it and triggers hydration.
- **`hydrateFromJsonl(sessionId, cwd)`** — new internal helper. Fire-and-forget. On success calls `loadFromDisk`; on failure logs and still flips `jsonlLoaded: true` so loading UI can resolve.
- **`setCwd`** — when cwd changes for a non-ephemeral, un-hydrated session, triggers `hydrateFromJsonl`. Guarded so it won't double-fire when `createSession` already kicked off a load.
- **5s `setInterval` safety save removed.** Messages no longer live in localStorage, so there's nothing critical to flush on a timer. `flushSave` on `visibilitychange` + `beforeunload` remains (now cheap).
- **Per-message `saveToStorage` calls removed.** `addUserMessage` and `finalizeAssistantMessage` no longer hit localStorage — JSONL is the message log. Other metadata mutations (`setName`, `setCwd`, `setDraftPrompt`) still debounce-save metadata.
- **`loadFromDisk` / `mergeFromDisk`** — keep their anti-shrink guard; additionally flip `jsonlLoaded: true` so the UI can tell a completed load from an in-flight one.

### `src/App.tsx`
- `onReopen` no longer inspects `messages?.length` or calls `loadSessionHistory`/`mapHistoryMessages`. Just reads `name` + `cwd` metadata, spawns the canvas panel, and lets `createSession` (triggered when ClaudeChat mounts) do the hydration.
- Dropped unused imports `loadSessionHistory`, `mapHistoryMessages`.

### `src/components/claude/ClaudeChat.tsx`
- Mount `useEffect` now passes `cwd` into `createSession` so JSONL hydration starts as soon as the session is registered, instead of waiting for the subsequent `setCwd` call. (The `setCwd` call is still made to keep it the single point of truth for persistence.)

## Callers that did **not** need changes

- `ClaudeChat.tsx:1477` fork path — still calls `createSession` + explicit `loadFromDisk(forkedMessages)`. The manual `loadFromDisk` flips `jsonlLoaded: true` before `setCwd`, so no redundant JSONL hit.
- `ClaudeChat.tsx:1650` delegation children — `ephemeral: true`, no hydration.
- `tauriApi.ts:spawnClaudeWithPrompt` and `WidgetPanel.tsx` — no `cwd` arg; new sessions without existing JSONL. Harmless — hydration either skips or returns `[]`.
- `FloatingTerminal.tsx:409` widget-spawned Claude — same as above.
- `SettingsPanel.tsx` + `ClaudeDialog.tsx` — only read `name` / `cwd` from persisted metadata, which is still present. ClaudeDialog's "Saved Sessions" message-count pill will now always show `0` for non-live sessions (the count came from `messages.length` which isn't persisted). Acceptable info loss; could be restored later by Agent 2's metadata command if needed.

## Guarantees

1. **JSONL is authoritative.** Wiping `localStorage["terminal64-claude-sessions"]` → every named session still reopens with full history on the next launch. Only the friendly name, draft prompt, and last-used `cwd` are lost; reopening through the Claude dialog at the right directory restores the history through `load_session_history`.
2. **Storage quota-safe.** Per-session payload is ~4 small strings, so the old "save truncated messages on quota exceeded" fallback is obsolete and deleted.
3. **No silent drift.** There is no longer a second source of message truth for them to disagree with. Assistant message finalization no longer writes to localStorage — it mutates memory only, and the JSONL is written by the CLI itself.
4. **UI "still-loading" signal.** `session.jsonlLoaded` lets future UI (empty-state, spinner) distinguish between a freshly mounted session and a truly empty one. Current UI keeps the `hasMessages` check and behaves the same way — during the brief hydration window the panel shows the pre-prompt empty state, then fills in once messages arrive. This is only observable on reopen of a session that has history; fresh sessions are identical to before.

## Risks / Follow-ups

- **Token / cost counters reset on reopen.** `totalCost`, `totalTokens`, `contextUsed`, `contextMax` no longer persist. They'll repopulate once the live session emits a new `result` event. For a reopened long-running session that hasn't sent a prompt yet, those numbers read 0. If we want to keep them, they should come from the JSONL (sum over messages). Low priority — the cost/token display is informational.
- **Task list resets on reopen.** `tasks` is not persisted. If TodoWrite state matters across reopens, Agent 2 could surface it through the metadata command or derive it from the JSONL.
- **Message-count pill in ClaudeDialog.** Always `0` for persisted (not-live) sessions. Fix by adding a message-count to the metadata command or reading from `list_disk_sessions` which already returns sizes.
- **Delegation child pruning.** Still relies on name prefix `"[D] "` to recognize orphaned delegation metadata rows. Unchanged from the previous behavior — if Agent 2 or a future task adds an explicit `ephemeral` marker to metadata, the check can tighten.

## Verification done

- `npx tsc --noEmit` passes (TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`).
- Manual read-through of every other `createSession` / `loadFromDisk` caller — all still work with the new signature.
- No remaining references to the deleted `loadSession` symbol anywhere in `src/`.
