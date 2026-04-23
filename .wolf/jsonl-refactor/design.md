# JSONL-as-source-of-truth — Target Architecture

## Current state (why it drifts)

- `~/.claude/projects/<cwd-hash>/<sid>.jsonl` is the CLI's authoritative log (every user/assistant/tool_use/tool_result).
- `localStorage["terminal64-claude-sessions"]` persists full `messages[]` plus derived counters. Two writers (`claudeStore` + `App.tsx` Discord block) mutate it at different tempos → races, clobbers, stale reads on reopen (see `.wolf/save-bug-investigation.md`).
- JSONL is only consulted (a) on reopen when `hasMessages===false` (`App.tsx:484`), (b) on refresh button (`ClaudeChat.tsx:1964`, tail-50), (c) on fork (`ClaudeChat.tsx:1479`). Silent drift is possible: JSONL advances while user sends prompts to a CLI that bypasses the store, or localStorage truncates to last 200 on quota (`claudeStore.ts:208-226`).
- Upstream `yasasbanukaofficial/claude-code` (sourcemap reconstruction) has no analogous persistence layer — no guidance to mine.

## Target architecture

**JSONL is the only source of conversation content.** localStorage becomes an ephemeral UI-state cache; nuking it must lose nothing a user cares about.

1. On `createSession(sid, cwd)`: always call `load_session_history` (if file exists) and populate `messages`. No "is it already in localStorage?" short-circuit.
2. Hot path (live streaming) still uses in-memory `claudeStore.messages` — CLI → `claude-output-<sid>` events → store append. The JSONL is written by the CLI in parallel; store is a read-through mirror, not a ledger.
3. New Rust command `load_session_metadata(sid, cwd) -> { lastTurnTs, promptCount, lastAssistantModel, totalInputTokens, totalOutputTokens, totalCacheRead, totalCacheCreation }` by summing JSONL `usage` fields. This kills the need to persist token/cost in localStorage — recompute on open, aggregate deltas in memory during the session.
4. Write-back on stream end: nothing. No `saveToStorage(sessions)`. `flushSave()` becomes a no-op (or persists only UI cache).
5. Quota-recovery truncation path deleted — localStorage payload is now tiny (kilobytes, not megabytes).

## Field-by-field matrix

| Field | Category | Disposition |
|---|---|---|
| `messages[]` | (a) derivable | Remove from localStorage. Fetch via `load_session_history` on createSession. |
| `tasks[]` | (a) derivable | Parse from TodoWrite tool_use blocks in JSONL on open; stop persisting. |
| `totalCost` | (a) derivable | Compute from JSONL `usage.cost_usd` sums via `load_session_metadata`. |
| `totalTokens`, `contextUsed`, `contextMax` | (a) derivable | Same — sum from JSONL. |
| `promptCount` | (a) derivable | Count user turns in JSONL. |
| `model` | (a) derivable | Last assistant record's `message.model`. |
| `sessionId` | (b) UI | Keep — index key. |
| `name` | (b) UI | Keep — user-assigned, not in JSONL. |
| `cwd` | (b) UI | Keep — needed to locate the JSONL itself. |
| `draftPrompt` | (b) UI | Keep — unsent text. |
| `skipOpenwolf` | (b) UI | Keep — widget/skill flag. |
| `lastSeenAt` | (b) UI | **Add** — drives session-list sort. |
| `isStreaming`, `streamingText`, `error`, `pending*`, `promptQueue`, `activeLoop`, `resumeAtUuid`, `forkParentSessionId`, `mcpServers`, `modifiedFiles`, `hookEventLog`, `toolUsageStats`, `subagentIds`, `autoCompact*` | in-memory only | Already not persisted — confirm stays that way. |
| `hasBeenStarted` | (a) derivable | `promptCount > 0`. Drop field. |
| Parsed-history cache (optional) | (c) costly | If JSONL parse >100ms, keep a `{sid, mtime, messages}` IndexedDB cache keyed on file mtime; invalidate on mismatch. Skip in v1 — measure first. |

## Migration plan (no data loss)

1. **Read-compat shim (one release)**: on boot, for each localStorage row with `messages.length>0` but no JSONL file on disk, write the messages out as a synthetic JSONL under `~/.claude/projects/<hash>/<sid>.jsonl` using the CLI's record schema (type=user/assistant, uuid=message.id, timestamp, content). Then strip `messages/tasks/totalCost/...` from the row, leaving `{sessionId,name,cwd,draftPrompt,skipOpenwolf,lastSeenAt}`.
2. **Key rename**: bump to `terminal64-claude-sessions-v2`. Old key retained read-only for one release as fallback for step 1, then deleted.
3. **Remove Discord orphan-prune block** (`App.tsx:105-146`) — with JSONL authoritative, stale localStorage rows are harmless and re-derive on open.
4. **Delete** `loadFromDisk`'s length-guard (no longer needed — JSONL is always loaded fresh) and `mergeFromDisk`'s role shrinks to the refresh-button tail merge only.
5. Ship behind a one-time migration flag in `settingsStore` so re-running the shim is idempotent.

Agents 2/3 own the Rust command + store rewrite; Agent 4 verifies via the six scenarios listed in team chat.
