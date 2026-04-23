# Terminal-64 Baseline — JSONL Persistence Model

Self-contained reference doc. Captures exactly how Terminal-64 (T64) reads/writes
Claude CLI session JSONL files and how the frontend store hydrates from them.
The synthesis agent compares the three external repos (yasasbanuka, t3code,
clawd-on-desk) against this.

Source files (line numbers are current as of 2026-04-23):
- `src-tauri/src/lib.rs`
- `src-tauri/src/types.rs`
- `src/stores/claudeStore.ts`
- `src/lib/tauriApi.ts`
- `src/components/claude/ClaudeChat.tsx`

---

## 1. Path model

```
~/.claude/projects/<dir_hash>/<session_id>.jsonl
```

- `session_project_dir` (lib.rs:117) — `home()/.claude/projects/<dir_hash>`.
- `dir_hash = cwd.replace([':','\\','/'], "-")` (lib.rs:119). Matches the Claude CLI's own hashing so our reads align with what the CLI writes.
- `session_jsonl_path` (lib.rs:123) — `<project_dir>/<session_id>.jsonl`.
- **Known caveat** (documented in `backend-notes.md`): on macOS/Linux a path `/foo/bar` hashes to `-foo-bar`; on Windows `C:\foo\bar` hashes to `C--foo-bar`. Not cross-OS-portable, but the CLI itself isn't either, so this is a non-issue in practice.

## 2. JSONL record shape we consume

The CLI writes one JSON object per line. We care about these record types:

| `type` | Fields used | Produces UI message? |
|---|---|---|
| `user` | `uuid`, `timestamp`, `parentUuid`, `message.content` (string OR array) | Yes — **only** when content has non-empty text. `tool_result`-only array contents do NOT produce a visible message. |
| `assistant` | `uuid`, `timestamp`, `parentUuid`, `message.content[]` (blocks of `text` / `tool_use`), `message.model`, `message.usage` | Yes — when `has_text || has_tools`. |
| `summary`, `task-summary`, `context-collapse`, queue-operation, last-prompt, etc. | ignored for visible-message counting, but physically retained | No |

`tool_result` blocks inside a user record are merged into the preceding assistant message's `tool_calls[n].result/is_error` via a `tool_use_id → (msg_idx, tc_idx)` map (lib.rs:865-925).

## 3. Write paths (all go through `atomic_write_jsonl`)

`atomic_write_jsonl(path, contents)` (lib.rs:131-163)

1. `mkdir -p` parent dir (defensive — CLI normally creates it).
2. Stage to `<path>.<ext>.tmp.<pid>.<uuid-simple>`.
   - Per-pid + per-call suffix so two concurrent truncates (e.g. rewind racing fork on the same session) never collide on the tmp filename.
3. `File::create` → `write_all` → **`sync_all` best-effort** (`let _ = f.sync_all();` — does not error if fsync is unsupported).
4. `std::fs::rename(tmp, path)` — atomic on same-FS macOS/Linux; on Windows std lib calls `MoveFileExW` with `REPLACE_EXISTING`, which is atomic when the target exists.
5. On rename failure: best-effort `remove_file(tmp)` so the fs doesn't accumulate `.tmp.*` litter.

**Critical atomic guarantees**

- No partial JSONL after a mid-write crash — either old or new file exists, never interleaved bytes.
- The CLI subprocess may hold an open FD on the *old* inode. Post-rename, its appends land in a deleted-but-still-open file (standard POSIX behavior) rather than corrupting our new contents. We trade "CLI writes survive" for "file integrity is guaranteed". This is the right call when the operations that call `atomic_write_jsonl` (truncate/fork) are explicitly destructive.

**Non-atomic note:** the CLI's own append stream is **not** via `atomic_write_jsonl` — it's a normal append-mode write from a subprocess we don't control. The atomic path only covers *our* truncate/fork operations.

## 4. Read paths

### 4a. `load_session_history(session_id, cwd) -> Vec<HistoryMessage>` (lib.rs:857)

- Full-file `fs::read_to_string` (not streamed — entire JSONL into memory).
- NotFound → `Ok(vec![])` (fresh session, no error).
- Per-line `serde_json::from_str`; `Err(_) => continue` silently skips malformed lines.
- Builds `Vec<HistoryMessage>` with tool-use/tool-result pairing via the `tool_index` HashMap.
- Applies `strip_system_reminders` to user text (lib.rs:820-853) — trims CLI-injected `<system-reminder>…</system-reminder>` blocks.

### 4b. `load_session_history_tail(session_id, cwd, limit)` (lib.rs:1011)

- Thin wrapper: calls `load_session_history` then `split_off(len - limit)`.
- **Still parses the full file** — the tail version only saves IPC cost, not parse cost.
- Used only by the refresh button (`ClaudeChat.tsx:1967`) at `limit=50`.

### 4c. `load_session_metadata(session_id, cwd) -> SessionMetadata` (lib.rs:1485)

The lean primitive intended for session-browser rendering.

- **Streamed** via `BufReader::lines()` — never allocates the full message vec.
- NotFound → `Ok({exists: false, msg_count: 0, …})`. Callers can't distinguish "not yet written" from "empty".
- Mid-read I/O error → `break` + returns **partial** metadata (rationale: CLI mid-write EAGAIN-like errors must never erase a session from the UI).
- Malformed lines: `malformed += 1; continue` with a summary log.
- Yields: `{session_id, exists, msg_count, last_timestamp, first_user_prompt (<=240ch, reminders stripped), last_assistant_preview (<=240ch or "[tool calls]")}`.

### 4d. `find_rewind_uuid(session_id, cwd, keep_messages)` (lib.rs:1348)

Full-file read + two-pass graph walk:

1. Parse every line into a `HashMap<uuid, serde_json::Value>` plus a `HashSet<uuid>` of UUIDs referenced as `parentUuid`.
2. Find the **transcript leaf**: the last UUID (by file order) whose type is `user` or `assistant` AND isn't anyone's parent. The filter on type is critical — `summary`/`task-summary` records are also UUID-bearing but aren't part of the conversation chain.
3. Walk `parentUuid` chain backward from leaf → reverse → get the "active" chain after prior rewinds have left orphaned branches in the append-only JSONL.
4. Count visible messages along the chain; return UUID at position `keep_messages`.

**This is the only function that understands the append-only/forked history structure.** All other readers (history, metadata, tail) do a linear scan of the file — they see orphaned branches as part of the message list.

## 5. Write paths in detail

### 5a. `truncate_session_jsonl(session_id, cwd, keep_turns)` (lib.rs:1071)

- Legacy turn-counting truncate (counts user turns, not visible messages).
- NotFound → no-op log + `Ok(())` (rewinding never-persisted session is a no-op).
- Calls `atomic_write_jsonl` with `collect_jsonl_lines_up_to_turns` output.

### 5b. `truncate_session_jsonl_by_messages(session_id, cwd, keep_messages)` (lib.rs:1103)

The exact match for the frontend's message-count semantics.

- NotFound → hard error (current behavior — likely wrong for the same reason 5a's was fixed; see gap #6 below).
- Walks lines, counts visible user+assistant messages via `is_real_user_message` (lib.rs:1281) — mirrors `load_session_history`'s filtering.
- After reaching `keep_messages`, enters a "trailing sweep" mode where it continues to keep tool-result-only user records that pair with the last kept assistant's `tool_use` blocks. Stops as soon as a real new turn appears.
- Malformed lines in trailing sweep: `kept.push(line); continue` — passes malformed through rather than aborting.
- Atomic write + re-read verification (counts lines post-write, logs both).
- Returns JSON with keep_messages, actual_visible_kept, original_lines, new_lines, original_bytes, new_bytes, verify_lines, last_visible_role, last_visible_preview (diagnostic payload).

### 5c. `fork_session_jsonl(parent, new, cwd, keep_messages)` (lib.rs:1299)

1. `read_to_string` parent JSONL; NotFound → clearer error.
2. `atomic_write_jsonl(&dest, src_content)` — full copy through the atomic path, so a crash mid-copy can't leave a half-written sibling JSONL.
3. `find_rewind_uuid(new_session_id, ...)` on the freshly-written copy to locate the fork point.
4. `truncate_session_jsonl_by_messages(new_session_id, ..., keep_messages)` — so reloads from JSONL show only pre-fork messages (without this, the fork appears with full parent history until `--resume-session-at` triggers a new write).
5. Returns the fork-point UUID.

**Two atomic renames land on `<dest>` here** — one in step 2, one in step 4. If step 4's truncate fails it's logged (`safe_eprintln "[fork] truncate failed: ..."`) but the fork UUID still returns — meaning the dest JSONL is left at its full, non-truncated state. That's a silent partial success; caller has no way to know.

## 6. Frontend store — hydration lifecycle

### 6a. localStorage schema (post-refactor)

`STORAGE_KEY = "terminal64-claude-sessions"` holds:

```ts
Record<sessionId, {
  sessionId: string;
  name: string;
  cwd: string;          // needed to locate the JSONL
  draftPrompt: string;  // unsent UI text
  lastSeenAt: number;
}>
```

No `messages`, `tasks`, `totalCost`, `totalTokens`, `contextUsed`, `contextMax`, `promptCount`, `model`, or `hasBeenStarted` are persisted. All derive from (or are recomputed over) the JSONL.

Payload is kilobytes even with thousands of sessions — quota-exhaustion path (truncate messages to recover space) has been deleted.

### 6b. `createSession(sessionId, initialName?, ephemeral?, skipOpenwolf?, cwd?)` (claudeStore.ts:271)

- If session already exists: optionally patches `name` and, if a new `cwd` arrives for an un-hydrated non-ephemeral session, triggers `hydrateFromJsonl`.
- Otherwise: seeds defaults from `loadMetadata(sessionId)` (unless ephemeral — then no disk read), flips `jsonlLoaded = !!ephemeral`, and **if non-ephemeral + seededCwd is non-empty**, fires `hydrateFromJsonl(sessionId, seededCwd)`.

### 6c. `hydrateFromJsonl(sessionId, cwd)` (claudeStore.ts:251)

Fire-and-forget:

```
loadSessionHistory(sessionId, cwd)
  .then(history => history.length > 0
    ? loadFromDisk(sessionId, mapHistoryMessages(history))
    : patchSession({jsonlLoaded: true}))
  .catch(err => patchSession({jsonlLoaded: true}))
```

Failure always flips `jsonlLoaded: true` so UI spinners resolve. No retry. No exponential backoff.

### 6d. `loadFromDisk(sessionId, messages)` (claudeStore.ts:603)

**Anti-shrink guard** (line 607): `if (session.messages.length >= messages.length) return {jsonlLoaded: true}`. Prevents a late-arriving stale hydration from clobbering a live session that has already accumulated more messages than existed when the JSONL was read. Still flips the loaded flag.

When it does replace: sets `messages`, recomputes `promptCount` from user-role filter, sets `hasBeenStarted = promptCount > 0`, flips `jsonlLoaded: true`.

### 6e. `mergeFromDisk(sessionId, incoming)` (claudeStore.ts:621)

Append-only merge by message id. Used only by the refresh button's tail-50 path. Filters out duplicates via `Set(existingIds)`. Never replaces existing messages with disk copies — disk is treated as additive-only.

### 6f. `setCwd(sessionId, cwd)` (claudeStore.ts:549)

On cwd change for a non-ephemeral, un-hydrated session with a new non-empty cwd, triggers `hydrateFromJsonl`. This is the second entry point that might kick off hydration for the same session — but it's guarded by `!prev.jsonlLoaded` so it can't double-fire if `createSession` already started one.

**Subtle race:** `createSession` fires `hydrateFromJsonl` asynchronously; if `setCwd` runs with a new cwd before that first hydrate resolves, `jsonlLoaded` is still `false`, so a second `hydrateFromJsonl` starts. The two promises race. The anti-shrink guard in `loadFromDisk` resolves the conflict (whichever settles second with fewer messages no-ops), but we pay two full-file parses. Minor cost — not a correctness bug.

### 6g. Persistence writes

- `saveToStorage` (claudeStore.ts:209) — writes the meta-only schema. Called synchronously from `setName`, debounced (1s) from `setCwd`, `setDraftPrompt`, and `createSession` (non-ephemeral).
- `flushSave` on `visibilitychange: hidden` and `beforeunload` — cheap since payload is tiny.
- No more 5s interval safety save (removed in refactor).
- No `saveToStorage` calls on `addUserMessage`, `finalizeAssistantMessage`, `updateToolResult`, etc. — message mutations are memory-only; JSONL is the CLI's responsibility.

### 6h. Ephemeral sessions (delegation children)

- Ephemeral flag set in `ClaudeChat.tsx:1653`.
- `createSession` short-circuits metadata load, starts with `jsonlLoaded: true`, never hydrates.
- `saveToStorage` skips ephemeral entries entirely.
- `removeSession` / `deleteSession` purge metadata rows for ephemeral or unnamed sessions only — named non-ephemeral rows are retained so the session dialog can reopen them later.

## 7. Concurrency model

Single-process Rust backend, single-process frontend, one Claude CLI subprocess per session. Relevant concurrency surfaces:

1. **CLI appending vs our truncate/fork.** CLI writes via open FD on old inode; our atomic rename replaces the inode. Post-rename CLI appends are orphaned on the deleted inode (POSIX). This is the documented, accepted trade-off — "truncate during active turn" loses turn data written after the read-to-string snapshot.
2. **Concurrent truncate + fork.** Tmp suffix `.<pid>.<uuid>` prevents tmp-file collisions. The last rename wins — whichever finishes later overwrites the earlier's result. No locking. In practice, UI gates these operations between turns, so the race is theoretical.
3. **Concurrent `load_session_history` + CLI append.** Fault-tolerant: malformed-last-line (CLI wrote partial JSON when we read) → silent skip via `Err(_) => continue`.
4. **Concurrent frontend hydrations.** Two in-flight `hydrateFromJsonl` for the same sid → anti-shrink guard resolves. Parse cost doubled; correctness preserved.
5. **No file locks** (flock, OS-level, or app-level) anywhere in the stack. The design leans entirely on atomic-rename + tolerant readers.

## 8. Hydration triggers — enumerated

Where does JSONL get re-read into the store?

| Trigger | Call site | Path used |
|---|---|---|
| Session panel mount | `ClaudeChat.tsx:344` → `createSession(sid, ..., cwd)` | `hydrateFromJsonl` → `loadFromDisk` |
| Late cwd learning | `setCwd` (claudeStore.ts:549) | `hydrateFromJsonl` → `loadFromDisk` |
| Refresh button (tail-50) | `ClaudeChat.tsx:1967` | `loadSessionHistoryTail` → `mergeFromDisk` |
| Fork (explicit seed) | `ClaudeChat.tsx:1482` | `loadFromDisk(forkedMessages)` (caller-supplied, not from disk re-read) |
| Rewind flow | `ClaudeChat.tsx` (near rewind action) | Calls `truncate_session_jsonl_by_messages`, then either relies on in-memory `truncateFromMessage` or triggers a refresh |

**There is no "subscribe to file changes" mechanism.** The JSONL is re-read only on explicit user action (open, refresh, rewind, fork).

## 9. Corruption handling summary

| Failure mode | Behavior |
|---|---|
| Malformed JSON line in `load_session_history` | silent `continue` |
| Malformed line in `load_session_metadata` | counter increment, summary log |
| Mid-read I/O error in `load_session_metadata` | break + return partial metadata |
| NotFound in `load_session_history` | `Ok(vec![])` |
| NotFound in `load_session_metadata` | `Ok({exists: false, ..})` |
| NotFound in `truncate_session_jsonl` | `Ok(())` (no-op) |
| NotFound in `truncate_session_jsonl_by_messages` | `Err` (gap — see below) |
| NotFound in `fork_session_jsonl` | `Err("fork source JSONL not found …")` |
| NotFound in `find_rewind_uuid` | `Err("JSONL not found …")` |
| Mid-write crash on truncate/fork | old or new file exists; never interleaved bytes |
| Trailing partial line (CLI writing while we read) | dropped via malformed-line skip |

## 10. Known gaps and sharp edges

Candidates for the synthesis agent to consider against the reference repos:

1. **`load_session_history` is not streamed.** Reads entire file into a `String`, then builds a `Vec<HistoryMessage>` in memory, then serdes it over IPC. For a 100k-line session, we allocate 3× peak memory (raw bytes + serde_json::Value per line + HistoryMessage). No limit enforcement.
2. **`load_session_history_tail` still parses the full file.** The "tail" is applied after building the full vec. A real tail (scan backward from EOF, line-buffer until N lines) would be O(N) instead of O(file). 50-message refresh on a huge session = full re-parse.
3. **`find_rewind_uuid` also full-file + full-graph.** No lazy option. On every rewind we rebuild the whole `HashMap<uuid, Value>`. Fine for conversation-sized files; could become slow for 10k-turn sessions.
4. **`fork_session_jsonl` reads then writes the whole file into memory (to `atomic_write_jsonl`).** A server-side `copy`+`truncate` would halve peak memory on large sessions. Streaming atomic copy (read chunked into tmp, rename) avoids the `String` intermediate.
5. **No mtime-based invalidation or caching.** Every hydration re-parses from scratch. For a session reopened 10 times, we do 10 full parses. A `{sid, mtime, Vec<Message>}` IndexedDB cache (keyed on file mtime, invalidated on mismatch) was explicitly deferred in the design — worth revisiting if reference repos solved it cheaply.
6. **`truncate_session_jsonl_by_messages` NotFound is a hard error.** Inconsistent with the legacy `truncate_session_jsonl`'s no-op behavior. A rewind on a session whose JSONL hasn't hit disk yet (very short fresh session, pre-first-CLI-flush) would error instead of no-op'ing the store-side truncation.
7. **`fork_session_jsonl` silent partial success.** If step-4 truncate fails, `Ok(uuid)` still returns with dest at full parent contents. Frontend believes fork succeeded; reopen shows surplus messages. Should bubble up the truncate error or roll back the dest file.
8. **`atomic_write_jsonl` fsyncs the file but not the directory.** On macOS/Linux a post-rename crash before the parent dir's dirent is flushed to disk can leave the old contents visible on recovery (or, worse, a dangling tmp name). Most real-world filesystems (APFS, ext4 w/ data=ordered) hide this, but strict POSIX durability requires `fsync(parent_dir_fd)` after rename. Low-probability corruption window.
9. **Ignoring `fsync` errors (`let _ = f.sync_all()`).** Fine on platforms where sync isn't supported; masks real I/O errors on platforms where it is. Could surface in a log without making the write fail.
10. **No locking between multiple T64 instances.** If the user opens T64 twice pointing at the same home dir, both instances can truncate/fork the same JSONL simultaneously. `atomic_write_jsonl` keeps each write consistent, but the result is a last-writer-wins race. No OS-level `flock` guard.
11. **No integrity check on read.** We trust the CLI's output. A JSONL with duplicate `uuid`s (possible across rewind+CLI-resume sequences) will produce duplicates in `messages`. `mapHistoryMessages` doesn't dedupe. Evidence of this would be seen as "messages jumped to top" in the UI after reopen.
12. **`strip_system_reminders` runs only in `load_session_history` / `load_session_metadata`.** Fork's copy path preserves reminders in the output JSONL unchanged — correct behavior (the CLI expects them), but worth documenting so future cleanup passes don't strip on write.
13. **No versioning / schema marker in localStorage.** If we ever change `PersistedSessionMeta`, there's no `version: 2` field to migrate on. `loadMetadata` will defensively fall back to empty strings, but a breaking schema change needs explicit handling.
14. **`load_session_history` doesn't expose `parentUuid`.** The conversation-chain structure known by `find_rewind_uuid` isn't visible to the frontend — history UI is a linear list. Fine today, but means branching / show-alternative-path UI can't be built without extending the history schema.
15. **Rewind store-side trim vs disk-side truncate are sequenced by the caller.** `truncateFromMessage` (store) and `truncate_session_jsonl_by_messages` (disk) aren't atomic together. If disk truncate fails after store trim, the UI shows a shorter list than the JSONL — next reopen will surface the lost messages again via hydration (because hydration length > store length → anti-shrink bypass triggers the replace). That's arguably the *safer* default (no data loss) but means a failed rewind is silently reverted on next reopen. The user sees the rewind "succeed" then "undo itself" — confusing.

## 11. Data-flow recap

**Write (turn):**

```
User prompt
  → claudeStore.addUserMessage (memory only)
  → CLI subprocess append to ~/.claude/projects/<hash>/<sid>.jsonl
  → CLI stream-json stdout → claude-output-<sid> event
  → useClaudeEvents parses → finalizeAssistantMessage (memory only)
  → debouncedSave → localStorage (metadata only)
```

**Read (reopen):**

```
App boot
  → ClaudeDialog queries list_session_ids (reads project dir)
  → User clicks session
  → ClaudeChat mounts
  → createSession(sid, name, false, false, cwd)
  → hydrateFromJsonl → load_session_history (full file read)
  → loadFromDisk → messages in memory
  → UI renders
```

**Rewind:**

```
User clicks rewind on message N
  → find_rewind_uuid(sid, cwd, N) → uuid
  → setResumeAtUuid(uuid)           // memory
  → truncate_session_jsonl_by_messages(sid, cwd, N)  // disk
  → truncateFromMessage(sid, messageId)              // memory
  // Next prompt passes --resume-session-at=<uuid> to CLI
```

**Fork:**

```
User clicks fork on message N
  → newSid = uuid()
  → forkSessionJsonl(parent, newSid, cwd, N)
      → read parent JSONL
      → atomic_write_jsonl(dest, parent_content)
      → find_rewind_uuid(newSid, cwd, N) → forkUuid
      → truncate_session_jsonl_by_messages(newSid, cwd, N)
  → store.createSession(newSid)
  → store.loadFromDisk(newSid, forkedMessages)   // supplied by caller, not re-read
  → setResumeAtUuid(newSid, forkUuid)
```
