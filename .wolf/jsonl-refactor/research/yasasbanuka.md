---
source: https://github.com/yasasbanukaofficial/claude-code
cloned_to: /tmp/research-agent1/claude-code (depth 1)
date: 2026-04-23
agent: Agent 1
---

# Research: `yasasbanukaofficial/claude-code`

## What this repo actually is

It is **not a Claude-CLI wrapper**. It is a backup of the **leaked Claude Code source code itself** (Mar 31 2026, discovered via an npm source-map leak — see the repo `README.md`). So the persistence code here is the authoritative, canonical producer of the `~/.claude/projects/<hash>/<sessionId>.jsonl` files that Terminal 64 *reads*. Every assumption our refactor makes about the JSONL format can be cross-checked here.

Runtime is **Bun** (with Node.js fallbacks). Language is TypeScript.

Key files (all paths below are in the cloned repo):

| File | Lines | Role |
|---|---|---|
| `src/utils/sessionStorage.ts` | 5105 | Transcript writer — the heart of it. `Project` class, `appendEntry`, `recordTranscript`, write-queue, tombstones. |
| `src/utils/sessionStoragePortable.ts` | 793 | Pure-Node helpers shared with a VS Code extension. Path sanitization, tail reader, chunked forward reader. |
| `src/utils/sessionRestore.ts` | 551 | Restore state on `--resume` / `--continue`. |
| `src/utils/conversationRecovery.ts` | 597 | Entry point: `loadConversationForResume`, `loadMessagesFromJsonlPath`. |
| `src/utils/listSessionsImpl.ts` | 454 | Enumerate sessions by reading `.jsonl` filenames + tail metadata. |
| `src/utils/json.ts` | 277 | `parseJSONL` — tolerant JSONL parser. |
| `src/utils/fsOperations.ts` | 770 | `FsOperations` abstraction (seam for testing). |
| `src/history.ts` | 464 | Prompt history (`history.jsonl`) — different file, uses `proper-lockfile`. |

---

## The JSONL write model (authoritative)

### 1. One file per session, append-only, never rewritten

Path: `join(getProjectsDir(), sanitizePath(cwd), `${sessionId}.jsonl`)` — `sessionStoragePortable.ts:329`.

Sanitization is `name.replace(/[^a-zA-Z0-9]/g, '-')` with a 200-char cap + `Bun.hash` (or `djb2`) suffix for longer paths (`sessionStoragePortable.ts:311`). **T64's cwd-hash must match this exactly** or directory names diverge.

Files are created with mode `0o600`, directories with `0o700`.

### 2. Appends are plain `fsAppendFile` — no atomic rename, no fsync

```ts
// src/utils/sessionStorage.ts:634
private async appendToFile(filePath: string, data: string): Promise<void> {
  try {
    await fsAppendFile(filePath, data, { mode: 0o600 })
  } catch {
    // Directory may not exist — some NFS-like filesystems return
    // unexpected error codes, so don't discriminate on code.
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await fsAppendFile(filePath, data, { mode: 0o600 })
  }
}
```

No `fsync`, no atomic rename, no lockfile. They trust that:
- Only one CLI process writes a given session file (per-session, not per-project lock).
- The reader (`parseJSONL`) tolerates a malformed trailing line.
- A crashed partial write at EOF is acceptable data loss (last line only).

**Sync cleanup path** (`appendEntryToFile` at line 2572) uses `fs.appendFileSync` — called from exit cleanup and from `materializeSessionFile`. Same permissive `try { append } catch { mkdir; append }` pattern.

### 3. Per-file write queue with coalesced flush (the killer feature)

```ts
// src/utils/sessionStorage.ts:561
private writeQueues = new Map<string, Array<{ entry: Entry; resolve: () => void }>>()
private flushTimer: ReturnType<typeof setTimeout> | null = null
private FLUSH_INTERVAL_MS = 100
private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024
```

`enqueueWrite` (line 606) pushes onto a per-file queue. `scheduleDrain` (line 618) starts a 100 ms debounce timer. `drainWriteQueue` (line 645) concatenates everything in the queue into a single buffer, flushes it as one `appendFile`, then resolves all the per-entry promises. 100 MB safety chunk-break inside the drain.

Net effect: many small appends during a burst coalesce into one syscall, but callers can still `await` their individual write if they care (the resolver is attached to each queued item).

Write-tracking: `trackWrite` increments/decrements `pendingWriteCount` so `flushSessionStorage()` (line 1583) can `await` quiescence before exit.

### 4. Lazy materialization — no metadata-only files

```ts
// src/utils/sessionStorage.ts:993-1010 (insertMessageChain)
if (this.sessionFile === null &&
    messages.some(m => m.type === 'user' || m.type === 'assistant')) {
  await this.materializeSessionFile()
}
```

Until the first real user/assistant message, all entries (hook progress, attachments, cached title, cached mode) sit in `pendingEntries: Entry[]` in memory. On first real message, `materializeSessionFile` (line 976) creates the file, re-appends cached metadata, then drains pendingEntries. This prevents orphan files for sessions the user abandons before sending anything.

### 5. Concurrent-session writes go through the same queue

`appendEntry` (line 1128) accepts an optional `sessionId` so you can write to a non-current session (e.g., forked agents writing back). Non-current sessions route through `getExistingSessionFile` (line 1285) which `stat`s once and caches positive results. The per-file queue guarantees per-file serialization even across sessions.

### 6. Tombstone / message removal — **positional truncate**, not rewrite

```ts
// src/utils/sessionStorage.ts:871 (removeMessageByUuid)
const fh = await fsOpen(this.sessionFile, 'r+')
// …read last 64KB, find `"uuid":"<target>"` via byte-level lastIndexOf…
await fh.truncate(absLineStart)
if (afterLen > 0) {
  await fh.write(tail, lineEnd, afterLen, absLineStart)
}
```

Fast path: if the target line is in the last 64 KB, they `ftruncate` at the line start and re-write the bytes that came after it. Slow path (target > 64 KB back) falls back to full read/split/`writeFile`, but **only if** `fileSize <= MAX_TOMBSTONE_REWRITE_BYTES` — very large files skip removal with a warning. No atomic rename even here.

### 7. Metadata is inline JSONL entries, not a separate file

Entry types appended to the same session file:
- `custom-title` — user-set or AI-set title (line 2625, `saveCustomTitle`)
- `ai-title`, `task-summary`, `last-prompt`
- `tag`, `pr-link`, `agent-name`, `agent-color`, `agent-setting`, `mode`
- `worktree-state`, `file-history-snapshot`, `attribution-snapshot`
- `content-replacement`, `speculation-accept`, `marble-origami-*` (context-collapse)
- `summary`, `queue-operation`, `compact_boundary`

"Last-wins" semantics on reload: tail reader scans ≤ 64 KB at EOF, uses `extractLastJsonStringField` (portable:85+) to pull the most recent `customTitle`/`tag`/etc. without JSON-parsing the whole file.

### 8. Crash-recovery posture

`reAppendSessionMetadata` is called on **compaction** and on **exit cleanup** (sync handler registered in `registerCleanup`). It appends the cached in-memory metadata (title, tag, agent info) again so that even after a compact-boundary truncate the metadata stays within the 64 KB tail window `readLiteMetadata` scans. Two orderings matter:
- During compaction, metadata lands *before* the boundary marker → recovered by `scanPreBoundaryMetadata`.
- On exit, metadata lands *after* the last entry → recovered by standard tail read.

No transactions, no WAL, no checksums. Recovery is entirely read-side tolerance + idempotent re-appends.

---

## The JSONL read model

### `parseJSONL` tolerance (`src/utils/json.ts:129-175`)

Three implementations, picked at module load:
1. **Bun native** (`Bun.JSONL.parseChunk`) — preferred, streaming with continuation on mid-stream errors.
2. **Buffer path** — `buf.indexOf(0x0a, start)`, `JSON.parse(line)` wrapped in `try {} catch {}`, **malformed lines silently skipped**.
3. **String path** — same but on a string.

UTF-8 BOM stripped (`0xEF 0xBB 0xBF`) for PowerShell-authored files. 100 MB tail cap (`readJSONLFile` at line 201) — if the file is larger, they read only the last 100 MB and skip the first partial line.

### `readTranscriptForLoad` — chunked forward scan with compact-boundary truncation (`sessionStoragePortable.ts:717`)

Streams the file in 1 MB chunks. Does three things simultaneously at the byte level:
1. Strips `attribution-snapshot` lines except the last one (appended at EOF).
2. On hitting a `compact_boundary` line **without** `preservedSegment`, resets the output buffer to that offset — everything before the boundary is dropped.
3. Carries cross-chunk straddles for partial lines.

All without ever materializing the full file as a string, and without `JSON.parse`-ing every line (only the candidate boundary/snap lines).

### Tail-only metadata read for session list (`sessionStoragePortable.ts` + `listSessionsImpl.ts`)

For `listSessions`, they never read the full file. Instead `readSessionLite` reads head + tail windows (`LITE_READ_BUF_SIZE = 65536` each) via `fsOpen` + positional `fd.read`, then uses regex-free `indexOf`-based field extraction (`extractJsonStringField`, `extractLastJsonStringField`) to pull just the keys they need for the picker UI. This is why `/resume`'s list is fast even with hundreds of sessions.

Two enumeration paths in `listSessionsImpl.ts:235-298`:
- `applySortAndLimit` — stat-pass for sort key, batch-reads 32 candidates at a time by sorted mtime until `limit` survivors collected.
- `readAllAndSort` — no-limit path; skips stat, reads all, dedups by sessionId post-filter keeping newest.

Both tolerate unreadable files (drop them), and both dedup by sessionId after reading (a session can exist in multiple worktree project dirs).

---

## Lockfile usage (important nuance)

`proper-lockfile` is used in **exactly one place**: `src/history.ts:308` for the shared `~/.claude/history.jsonl` (the prompt history — cross-process contention because every CLI invocation appends). It is **not** used for per-session transcripts, because the assumption is exactly one writer per session.

---

## Skip-persistence gate

```ts
// src/utils/sessionStorage.ts:960
private shouldSkipPersistence(): boolean {
  return (
    (getNodeEnv() === 'test' && !allowTestPersistence) ||
    getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
    isSessionPersistenceDisabled() ||
    isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)
  )
}
```

Checked inside both `appendEntry` AND `materializeSessionFile` — otherwise `reAppendSessionMetadata` would bypass the guard (it writes via `appendEntryToFile`, not the queue) and produce a metadata-only file even with persistence off.

---

## Cross-reference to Terminal 64's implementation

| Concern | Claude Code (producer) | Terminal 64 (current) | Divergence |
|---|---|---|---|
| JSONL path | `projects/<sanitized-cwd>/<sessionId>.jsonl`, mode 0600 | Same dir layout; we *read* these files directly | None |
| cwd → dirname | `replace(/[^a-zA-Z0-9]/g, '-')`, 200-char cap, hash suffix on overflow | Verify our hash matches exactly | **ACTION ITEM** — confirm sanitizer parity; a mismatch on long paths or unicode breaks discovery |
| Normal appends | `appendFile` via coalesced 100 ms queue, no rename, no fsync | N/A — CLI owns writes | — |
| Atomic rename | Never for appends; not even for tombstones | `atomic_write_jsonl` at `src-tauri/src/lib.rs:131` used on **truncate/fork only** | **Correct** — we only rewrite on rare edits, which is exactly when atomic makes sense. CLI can't use it because many writers queue; we have only one writer per op. |
| Tombstone / edit | Positional `fh.truncate` + tail rewrite, 64 KB fast path | We do full-rewrite-with-rename | **Acceptable** — our truncate/fork is user-initiated, not per-message. Don't bother with positional. |
| Load whole file on list | No — tail `LITE_READ_BUF_SIZE` (64 KB) windowed positional reads | `load_session_history` at `lib.rs:857` — check if it parses whole file | **ACTION ITEM** — verify we don't read the full JSONL when all we need is first-prompt / title for the picker |
| Malformed-line tolerance | `parseJSONL` silently skips | Our `hydrateFromJsonl` — verify it tolerates truncated last line | **ACTION ITEM** — mirror JSON.parse try/catch per-line, don't bail on first bad line |
| BOM handling | Strips UTF-8 BOM before parse | Verify | **ACTION ITEM** — Windows PowerShell may add BOM; strip before parse |
| Metadata storage | Inline JSONL entries (`custom-title`, `tag`, `mode`, …), last-wins, tail-read | localStorage blob: `{sessionId, name, cwd, draftPrompt, lastSeenAt}` | **By design, correct for us**. JSONL is source of truth for messages; localStorage is UX metadata (draftPrompt is UI state the CLI doesn't own anyway). Keep the split. |
| Lockfile | Only on the cross-process `history.jsonl` | We don't write JSONL during normal chat | No lockfile needed for us |
| Skip-persistence gate | Multi-source (env, setting, NODE_ENV, flag), checked on every write path | N/A — we're a wrapper | — |

---

## Patterns worth stealing

1. **Tail-only metadata read for the session picker.** Open, `fd.read(buf, 0, 65536, 0)` for the head (first prompt, model), `fd.read(buf, 0, 65536, size-65536)` for the tail (latest title/tag). Skip `JSON.parse` entirely — use `indexOf(`\"customTitle\":\"`)` + string scan. This is the biggest perf win they extracted; with hundreds of sessions, never fully parsing any of them until the user picks one cuts `/resume` UX latency from seconds to ms. See `sessionStoragePortable.ts:53` (`extractJsonStringField`) and `listSessionsImpl.ts:204` (`readCandidate`).

2. **Malformed-line-tolerant parser.** Wrap every `JSON.parse(line)` in try/catch and skip silently. Our `no-shrink guard` on `loadFromDisk` is the right instinct, but if the JSONL has a truncated last line from a crash, we want to load the first N-1 lines rather than refusing. Pair no-shrink with tolerant parse.

3. **UTF-8 BOM strip.** One line, covers Windows users who `Out-File -Encoding UTF8` into the claude dir. See `src/utils/jsonRead.ts:stripBOM`.

4. **Long-path sanitizer.** 200-char truncate + hash suffix. Our directory discovery will silently miss sessions from long cwds if we don't match. Confirm parity with their `sanitizePath` (`sessionStoragePortable.ts:311`).

5. **Prefix-match fallback for project-dir lookup.** `findProjectDir` (`sessionStoragePortable.ts:354`) tries the exact sanitized dir first, then prefix-scans `~/.claude/projects/` when the path is long (because Bun.hash ≠ Node djb2 on the long-path suffix). We should do the same: exact match, else scan-for-prefix, else empty.

6. **`pendingWriteCount` + flush promise.** Not directly relevant to us (the CLI writes, we read), but if we ever add T64-side writes (e.g., draft prompt persisted inline), copy this pattern rather than fire-and-forget.

7. **Dedup-by-sessionId after read, not before.** If the same `sessionId.jsonl` appears in two worktree dirs, pick the newest-mtime survivor post-filter. Our read paths probably don't worry about this, but if we ever scan worktree-aware, do the dedup in the right place (`listSessionsImpl.ts:281`).

8. **Entry-type discriminator on every line.** Every JSONL line is `{type: '…', …}`. Our hydrator should switch on `type` and ignore unknown types (forward-compat) rather than bailing.

---

## Anti-patterns to avoid

1. **Atomic rename for per-message appends.** CLI never does this; it would serialize every message behind an fsync + rename and destroy throughput. Reserve `atomic_write_jsonl` for truncate/fork/rewind, which is what `lib.rs:131` already does. Do not extend it to cover writes we don't even perform.

2. **Parsing the whole file to extract the title.** CLI explicitly avoids this — 64 KB tail + string-scan. If our `load_session_metadata` (`lib.rs:1485`) reads the full file for the picker, that's a perf bug in large sessions.

3. **Refusing to load a transcript with a malformed trailing line.** CLI treats this as normal (crash signature). Refuse only if the *whole* file fails to parse.

4. **Relying on a separate metadata index that can desync.** CLI inlines metadata as JSONL entries with last-wins semantics — there's no `sessions.json` registry. Our localStorage `PersistedSessionMeta` is fine because it only holds UX state (draftPrompt, lastSeenAt) the CLI doesn't care about. Do **not** mirror message counts, last-message-text, or anything derivable from the JSONL into localStorage; that's where drift bugs live.

5. **Reading 100 MB+ files fully.** CLI caps JSONL reads at 100 MB tail (`MAX_JSONL_READ_BYTES`, `json.ts:192`) and warns on tombstone slow-path above a threshold (`MAX_TOMBSTONE_REWRITE_BYTES`). Our full-rewrite atomic writer should have a similar ceiling — currently `atomic_write_jsonl` has no size check, so a deranged session could OOM when we try to fork it.

6. **Mutex around the JSONL file from the host side.** We don't write during normal chat (the CLI does). If we ever add writes, they must not contend with the CLI — so prefer "compose a new JSONL on truncate/fork" (what we do) over "lock + append" (what the CLI does internally, for its own writers).

7. **Assuming the CLI flushed before the process exited.** CLI has `registerCleanup` running `reAppendSessionMetadata` + `flushSessionStorage`, but if the process is SIGKILLed the tail can be truncated mid-line. Our reader must cope (see #2 above).

---

## Concrete recommendations for hardening

Ranked by impact:

1. **Audit `load_session_history` (`src-tauri/src/lib.rs:857`) and `load_session_metadata` (`lib.rs:1485`) for full-file parsing when the caller only needs head+tail.** If true, port the 64 KB head-and-tail pattern. Cite `sessionStoragePortable.ts:53` / `listSessionsImpl.ts:204`.

2. **Verify `hydrateFromJsonl` (frontend) skips malformed lines instead of bailing.** Add a test with a trailing `{"type":"user","content":` (truncated). Expected: load all preceding lines, drop the bad one, `loadFromDisk` returns healthy state.

3. **Confirm cwd-sanitization matches Claude CLI exactly.** Dump `~/.claude/projects/` listing and compare byte-for-byte to what our `atomic_write_jsonl`'s parent dir resolves to. Break case: a cwd with unicode or with a path > 200 chars. Cite `sessionStoragePortable.ts:311`.

4. **Add a size cap + warning to `atomic_write_jsonl`.** Full-rewrite of a 200 MB session during fork will stall the UI and may OOM on 8 GB boxes. Suggest `MAX_REWRITE_BYTES = 100 * 1024 * 1024` mirroring CLI's `MAX_TOMBSTONE_REWRITE_BYTES`. Refuse fork with a user-facing error rather than hanging.

5. **Strip UTF-8 BOM on read.** One-liner in the Rust parser. Cross-platform users on Windows will thank us.

6. **Document the invariants.** In `.wolf/jsonl-refactor/design.md`, add: "JSONL is append-only per-session; atomic rename is reserved for truncate/fork; readers MUST tolerate a truncated final line; metadata comes from localStorage + JSONL-inline entries with last-wins."

7. **Consider not reading the whole file on `load_session_metadata`.** Our metadata storage is localStorage, so this may already be cheap — but if it currently opens the JSONL to e.g. count messages, that's avoidable work. Push all "latest-N" UI hints to either (a) the localStorage meta or (b) a 64 KB tail scan.

8. **No-shrink guard interaction with crash recovery.** If the CLI crashes mid-write, file size on next read can shrink (CLI calls `ftruncate` on tombstone removal). Our no-shrink guard should key on `mtime` + `file size`, and only reject a *decrease* when `mtime` didn't advance — otherwise legitimate truncation-removal is blocked. Verify.

---

## Appendix: citation-accurate line references

- `atomic_write_jsonl` equivalent? **None in CLI.** They never do it for the transcript.
- `appendFile` path: `sessionStorage.ts:634-642`
- Write queue: `sessionStorage.ts:559-686`
- `insertMessageChain`: `sessionStorage.ts:993-1083`
- Materialize session file: `sessionStorage.ts:976-991`
- `appendEntry` dispatcher: `sessionStorage.ts:1128-1265`
- Tombstone / positional truncate: `sessionStorage.ts:871-950`
- Remote-snapshot hydrate (full-file replace via `writeFile`): `sessionStorage.ts:1608`, `1660`
- `parseJSONL` tolerant: `json.ts:129-175`
- Tail-head metadata scan helpers: `sessionStoragePortable.ts:53-105`
- `readTranscriptForLoad` chunked reader: `sessionStoragePortable.ts:717-790`
- Path sanitize: `sessionStoragePortable.ts:311-319`
- Project-dir discovery with prefix fallback: `sessionStoragePortable.ts:354-380`
- Session list sort + dedup: `listSessionsImpl.ts:235-298`
- `loadConversationForResume`: `conversationRecovery.ts:456-596`
- Prompt history w/ `proper-lockfile`: `history.ts:292-327`
- Skip-persistence gate: `sessionStorage.ts:960-970`
