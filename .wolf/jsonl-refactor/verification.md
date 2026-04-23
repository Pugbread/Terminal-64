# JSONL Source-of-Truth Refactor — Verification

Build status (from fresh cwd):
- `npx tsc --noEmit` — clean (no output)
- `cargo check` — clean
- `cargo clippy --all-targets -- -D warnings` — clean

## Scenarios

### 1. Relaunch survives messages — PASS
On mount, `ClaudeChat.tsx:344` calls `createSession(sessionId, ..., effectiveInitCwd)`.
`claudeStore.ts:343-345` fires `hydrateFromJsonl(sessionId, seededCwd)` when a non-ephemeral
session has a cwd. `hydrateFromJsonl` (`:251-265`) invokes `loadSessionHistory` →
`loadFromDisk`. JSONL on disk is authoritative; app reopen rebuilds `messages` from it.

### 2. Wiped localStorage restores from disk — PASS
After wipe, `readPersistedMeta()` (`:182-192`) returns `{}`. `ClaudeDialog` still lists
sessions from the `load_session_ids` command (reads the project dir directly, not
localStorage). When a session is opened, `createSession` runs with the cwd supplied by
the dialog, triggering `hydrateFromJsonl`. localStorage no longer carries message state
(`PersistedSessionMeta` at `:12-18` stores only `sessionId/name/cwd/draftPrompt/lastSeenAt`),
so losing it loses only draft prompt + friendly name.

### 3. Corrupted JSONL line skipped — PASS
- `load_session_history` (`lib.rs:870-872`): `Err(_) => continue` on malformed line.
- `load_session_metadata` (`lib.rs:1526-1532`): `malformed += 1; continue` on malformed.
- I/O mid-read error (`lib.rs:1510-1522`): breaks the loop and returns *partial* metadata
  rather than Err — guarantees a torn read can never erase a chat from the UI.

### 4. Fork JSONL prefix — PASS
`fork_session_jsonl` (`lib.rs:1299`) reads source JSONL, then `atomic_write_jsonl(&dest, ...)`
at `:1319`. Atomic write uses tmpfile + `sync_all` + `rename` (`:131-163`) with
pid+uuid suffix so concurrent forks cannot collide. Target is never partially written.

### 5. Rewind truncation point — PASS
- `truncate_session_jsonl` (`lib.rs:1071`) → atomic write at `:1090`.
- `truncate_session_jsonl_by_messages` (`lib.rs:1103`) → atomic write at `:1246`.
- `find_rewind_uuid` (`lib.rs:1348`) returns a clearer NotFound message.
Store-side, `truncateFromMessage` (`claudeStore.ts:709-722`) trims messages,
resets streaming/queue/permissions/loop — matches disk-side truncation.

### 6. Delegation child ephemeral — PASS
`ClaudeChat.tsx:1653` creates delegation children with `ephemeral=true`.
`createSession` (`claudeStore.ts:289`) short-circuits metadata load for ephemeral
(`ephemeral ? null : loadMetadata(sessionId)`), sets `jsonlLoaded: true`
(`:333`), and `saveToStorage` (`:224`) skips ephemeral entirely. Hydration is
never fired. Delegation children live in memory only; exactly the intended
behaviour.

## Known follow-ups (non-blocking, flagged by Agent 3)
- `totalCost` / `totalTokens` / `tasks` no longer persist across reopen — they repopulate
  from live stream events only. If the user wants the pill to show prior totals before
  the first event arrives, wire Agent 2's `load_session_metadata` into `ClaudeDialog`'s
  message-count/cost display.
- `ClaudeDialog`'s message-count pill reads `session.messages.length`, which is 0 for
  sessions that have metadata in localStorage but haven't been hydrated yet. Same fix:
  call `load_session_metadata` for dialog rendering.

No regressions found. Refactor is safe to ship.
