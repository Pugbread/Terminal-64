---
agent: Agent 5 (Synthesis)
date: 2026-04-23
inputs:
  - yasasbanuka.md   (Agent 1 — canonical Claude Code CLI leaked source)
  - t3code.md        (Agent 2 — pingdotgg/t3code, SDK + SQLite event-source)
  - clawd-on-desk.md (Agent 3 — rullerzhou/clawd, Electron observer pet)
  - our-baseline.md  (Agent 4 — T64 current impl)
---

# JSONL Persistence — Cross-Repo Synthesis

## 0. One-paragraph summary

Three external references sit on three very different points on the same spectrum: **Claude Code itself** (yasasbanuka) is the only one treating JSONL as authoritative and has spent real engineering on that choice (coalesced per-file write queue, positional tombstones, 64 KB tail metadata scan, tolerant parser). **t3code** ducks the problem entirely by letting the official `@anthropic-ai/claude-agent-sdk` own history and building a SQLite+event-source system for *its own* state alongside. **Clawd** doesn't own history at all — it's an observer that tails Codex JSONL files for animation state. T64's current architecture matches the CLI's model (JSONL-is-truth, localStorage is ephemeral UX) and is correct in its choice of where to go atomic: every write path we own goes through `atomic_write_jsonl`; we never try to append. The refactor landed well. The surviving gaps are small, mostly cosmetic, and listed below.

---

## 1. Side-by-side comparison

Legend: ✅ = implemented well · 🟡 = partial / caveat · ❌ = not done / not applicable · 🚫 = deliberately not done

| Axis | Claude Code (yasasbanuka) | t3code | Clawd | **T64 (us)** |
|---|---|---|---|---|
| **Source of truth** | Per-session JSONL, append-only | SQLite `orchestration_events` + SDK-owned resume cursor | In-memory `Map` (ephemeral) | Per-session JSONL (CLI-owned) |
| **Atomic writes (data)** | 🚫 Not used — plain `fsAppendFile`, no rename, no fsync. Single-writer invariant is the guard. | ✅ SQLite WAL + UNIQUE(stream_id, stream_version) | 🚫 Never writes session data | ✅ `atomic_write_jsonl` (tmp+fsync+rename) for truncate/fork only |
| **Atomic writes (config)** | N/A | ✅ `writeFileStringAtomically` with scoped tmp dir | 🟡 `writeJsonAtomic` in `hooks/json-utils.js` — **not** used for own prefs (anti-pattern) | ✅ localStorage (browser-atomic from app POV) |
| **Corruption tolerance (read)** | ✅ `parseJSONL` try/catch per line; UTF-8 BOM strip; 100 MB tail cap; tolerates truncated trailing line | ✅ Event sourcing — malformed payload row fails the migration/projector loudly | ✅ Per-line try/catch; drop first line when reading from tail offset | ✅ `Err(_) => continue` in `load_session_history`; counter+log in `load_session_metadata`; mid-read I/O error → partial metadata (never "session disappeared") |
| **BOM / encoding** | ✅ Strips UTF-8 BOM (Windows PS users) | N/A (sql) | ❌ Not handled | ❌ **Gap** — Rust readers do not strip BOM |
| **Session resume** | Full JSONL replay via `loadConversationForResume` | Resume cursor `{resume: sessionId, resumeSessionAt: lastAssistantUuid, turnCount}` handed to SDK — SDK rebuilds | No resume concept | `load_session_history` → `mapHistoryMessages` → `loadFromDisk` |
| **Session ID generation** | CLI generates it | ✅ **Pre-generated** (`Random.nextUUIDv4`) before SDK spawn → removes TOCTOU race, filename known up-front | N/A | ❌ Captured from first CLI `system` event |
| **Fork** | `writeFile`-based full-file replace (`sessionStorage.ts:1608`), no atomic rename | N/A | N/A | ✅ `read → atomic_write_jsonl → find_rewind_uuid → truncate` (two atomic renames). 🟡 Silent partial success if truncate fails |
| **Truncate / rewind** | Positional `fh.truncate` + tail rewrite (64 KB fast path); slow-path full rewrite capped at `MAX_TOMBSTONE_REWRITE_BYTES`; above cap → warn & skip | N/A (immutable event log) | N/A | ✅ Atomic full rewrite via `atomic_write_jsonl`. 🟡 NotFound is `Err` on `_by_messages` (inconsistent with legacy turn-based variant which is `Ok(())`) |
| **Concurrency model** | Per-file write queue (100 ms debounce), `pendingWriteCount` fence for exit flush, `proper-lockfile` on shared `history.jsonl` only | SQL UNIQUE constraint = optimistic concurrency; 5 min reaper for stale provider sessions | PID-liveness probe every 10 s; capacity eviction at `MAX_SESSIONS=20` | 🟡 Single-writer invariant per session. `atomic_write_jsonl` has per-pid + per-uuid tmp suffix so two UI-initiated writes never collide on the tmp name, but last-writer-wins on the target |
| **Crash / torn-write recovery** | Read-side tolerance + idempotent `reAppendSessionMetadata` on compaction & exit cleanup. No transactions. Partial trailing line is expected | SQLite WAL handles durability; projector cursor (`projection_state.last_applied_sequence`) means replay resumes mid-stream; reaper sweeps orphaned provider rows | First-line-drop on tail reads; file-level "backfill" flag suppresses replay-storms on reattach; line-level timestamp guard | 🟡 Truncated last line silently dropped on read; post-rename crash before dir fsync can lose metadata update under strict POSIX. No WAL, no journal (don't need either). No backfill guard — we re-read full file on reopen |
| **JSONL vs DB** | JSONL (they *are* the producer) | SQLite WAL (opposite philosophy — delegates JSONL to SDK) | Neither (stateless observer) | JSONL (we are consumer of the canonical log — matches producer philosophy) |
| **Hydration strategy** | `readTranscriptForLoad` chunked forward scan w/ compact-boundary truncation; tail-only for session-list metadata | Replay from projector cursor | Offset-based incremental tail w/ 64 KB partial-line cap | Full-file `read_to_string` in `load_session_history`; streamed `BufReader::lines()` in `load_session_metadata`; no offset cache, no mtime invalidation |
| **Schema / version evolution** | Entry-type discriminator on every line, unknown types ignored | 26+ migrations + `PRAGMA journal_mode = WAL` | Prefs have `version` field + future-version lock + `.bak` on corrupt read | ❌ `PersistedSessionMeta` has no version field |

**Architectural takeaway:** T64 sits in the same camp as the CLI itself — JSONL-as-truth with a thin UI-cache. That choice is validated by the CLI's own design. t3code's event-sourcing path is a different answer to a different question (multi-client web service); porting it would cost weeks for no user-visible win. Clawd contributes tactical snippets, not architecture.

---

## 2. Ranked recommendations for T64

Each item: **what · why · effort · risk**. Effort scale: XS (<30 min) · S (1–2 h) · M (half day) · L (1+ day).

### Tier A — must-fix-first (correctness, user-visible)

**A1. `truncate_session_jsonl_by_messages` NotFound → `Ok(())`**
- *What:* `lib.rs:1103` — currently returns `Err` if file missing. Make it a no-op + log, matching `truncate_session_jsonl` (lib.rs:1071).
- *Why:* Rewinding a fresh session whose CLI hasn't flushed yet produces a user-facing error for no reason. Legacy path was already fixed during the refactor; the by-messages variant was missed (see baseline §10 gap 6).
- *Effort:* XS · *Risk:* none.

**A2. `fork_session_jsonl` — propagate the step-4 truncate error**
- *What:* `lib.rs:1299` — if `truncate_session_jsonl_by_messages` fails after the `atomic_write_jsonl` copy, currently we `safe_eprintln` and still return the fork UUID. Either bubble the error (caller can decide to rollback) or `fs::remove_file(dest)` before erroring.
- *Why:* Silent partial success leaves the dest JSONL at full parent contents; user sees the fork "succeed" with surplus pre-fork messages on next reopen (baseline §10 gap 7).
- *Effort:* S · *Risk:* low — the recovery path needs a test for "dest exists, truncate failed → dest removed, error returned".

**A3. Strip UTF-8 BOM when parsing JSONL lines**
- *What:* One-liner in the Rust readers (`load_session_history`, `load_session_metadata`, `find_rewind_uuid`). On the first line only, strip `\xEF\xBB\xBF` prefix before `serde_json::from_str`.
- *Why:* yasasbanuka explicitly notes Windows PowerShell-authored edits to the JSONL ship with a BOM. Silent parse-failure on line 1 of a hand-edited JSONL is a mystery to debug.
- *Effort:* XS · *Risk:* none (BOM stripping is idempotent).

### Tier B — high-value hardening

**B1. Size ceiling on `atomic_write_jsonl`**
- *What:* Refuse truncate/fork on any source JSONL larger than a cap (e.g. `MAX_REWRITE_BYTES = 100 * 1024 * 1024`). Return a typed error the UI can surface.
- *Why:* Fork currently reads the whole source into a Rust `String`, then writes it through atomic rename. A 500 MB session will stall UI + possibly OOM small laptops. yasasbanuka has the same cap (`MAX_TOMBSTONE_REWRITE_BYTES`).
- *Effort:* S · *Risk:* negligible — the cap only refuses pathological inputs; the common case is untouched.

**B2. Rescue corrupt localStorage like clawd rescues corrupt prefs**
- *What:* In `readPersistedMeta` — on `JSON.parse` failure, copy the raw string to `terminal64-claude-sessions.bak` (separate localStorage key) before defaulting to `{}`.
- *Why:* Today a single unparseable byte in localStorage wipes every session's name/draftPrompt/cwd to defaults with no recovery trail. Clawd's `src/prefs.js:467-474` pattern is cheap and rescues users from upgrade-induced corruption (baseline §10 gap 13 adjacency).
- *Effort:* XS · *Risk:* none.

**B3. Add `schemaVersion: 1` to `PersistedSessionMeta`**
- *What:* Write the field on save, read it on load. Refuse to overwrite if `storedVersion > CURRENT_VERSION` (log + continue read-only).
- *Why:* Downgrade-clobber protection. A user running a newer T64 build alongside an older one shouldn't have the older build silently strip fields the newer one added. Clawd pattern `src/prefs.js:480-491`.
- *Effort:* XS · *Risk:* none.

**B4. Real tail read for `load_session_history_tail`**
- *What:* Replace "parse whole file + split_off(len-limit)" with a reverse-scan from EOF that buffers N completed lines and returns them. Matches the refresh-button's 50-message request semantically.
- *Why:* Today's refresh on a 30k-line session does a 30k-line parse to show 50 messages. Not a bug, but it wastes wall-clock the user feels when clicking refresh. yasasbanuka `readSessionLite` pattern.
- *Effort:* M · *Risk:* medium — reverse line-scan needs to handle the "truncated last line" edge case the forward scan already handles for free. Write a test harness with truncated-tail fixtures.

**B5. Pre-generate Claude session UUID before spawn**
- *What:* Generate `uuid::Uuid::new_v4()` in `claude_manager.rs` and pass to CLI via `--session-id` (verify the flag is surfaced on the binary we ship against). Remove the "capture sessionId from first `system` event" dance in `useClaudeEvents.ts`.
- *Why:* Removes a TOCTOU window — today we don't know the JSONL filename until the first stream event, so any persist-metadata-up-front logic is racy. t3code `ClaudeAdapter.ts:2494-2500` uses the same trick for exactly this reason.
- *Effort:* S (verify CLI flag) to M (if we have to fall back to capturing from event on older CLIs) · *Risk:* medium — needs a compat shim for CLI versions that don't accept `--session-id`.

### Tier C — nice-to-have, low urgency

**C1. `fsync` the parent directory after rename in `atomic_write_jsonl`**
- *What:* On Unix, `File::open(parent_dir)?.sync_all()?` after the `fs::rename`. Windows: no equivalent, skip.
- *Why:* Strict POSIX durability — without it a post-rename crash before the dirent flushes can revert to the pre-write state on next boot. APFS and ext4-w/data=ordered hide this in practice; strict correctness still wants it (baseline §10 gap 8).
- *Effort:* XS · *Risk:* low (one more syscall per atomic write — writes are rare).

**C2. Stop silencing `sync_all()` errors**
- *What:* `let _ = f.sync_all();` at `lib.rs:131` discards failures. Upgrade to `f.sync_all()?` or at minimum log the error.
- *Why:* Masks genuine disk-failure signals on platforms where fsync is meaningful (baseline §10 gap 9).
- *Effort:* XS · *Risk:* XS — `sync_all` failure on a healthy disk is rare; we'd surface it instead of swallowing.

**C3. mtime-keyed hydration cache**
- *What:* IndexedDB (or sessionStorage) cache keyed on `{sessionId, mtime, size}` storing the parsed `HistoryMessage[]`. On hydrate: stat first, cache-hit if unchanged, full parse on mismatch.
- *Why:* A session reopened 10 times does 10 full parses. For 10k-line sessions this is user-perceptible. Design doc explicitly deferred this pending measurement — worth doing the measurement now that the JSONL path is stable.
- *Effort:* M · *Risk:* medium — cache staleness bugs are worse than no cache. Keep the anti-shrink guard as backstop.

**C4. Failed rewind should surface, not silently revert**
- *What:* `truncateFromMessage` (store) + `truncate_session_jsonl_by_messages` (disk) aren't atomic together. If disk truncate fails after the store trim, next reopen re-hydrates the longer JSONL and the "rewind" appears to undo itself.
- *Options:* (a) only trim store after disk succeeds; (b) on disk failure, show a toast and leave store/disk intact. Prefer (a).
- *Why:* Today's behavior is "data preserved" but "UX confusing" — user sees rewind succeed, then come back on next reopen (baseline §10 gap 15).
- *Effort:* S · *Risk:* low — requires promise-sequencing in `ClaudeChat.tsx` rewind handler.

**C5. Duplicate-UUID dedup on hydration**
- *What:* `mapHistoryMessages` should dedupe by message `id`/`uuid`, keeping the last occurrence.
- *Why:* Rewind + CLI-resume sequences can leave duplicate UUIDs in the JSONL (branches that share an ancestor, orphaned on truncate and then re-appended). Not observed as a live bug, but we'd show it as duplicates in the chat list (baseline §10 gap 11). `find_rewind_uuid` already walks the parent chain correctly — the linear readers don't.
- *Effort:* XS · *Risk:* XS.

### Tier D — deliberately NOT recommended

- **DO NOT** migrate to SQLite/event-sourcing (t3code approach). Cost: weeks of churn. Benefit: zero for a single-user desktop app where the CLI's JSONL already plays event-log. Both yasasbanuka (the producer) and our current design agree on JSONL-as-truth.
- **DO NOT** add a per-append coalesced write queue (yasasbanuka's `writeQueues`). We don't append; the CLI does. Reserve complexity for writes we own (truncate/fork) which are already atomic.
- **DO NOT** switch to positional `fh.truncate` for rewinds. Our rewinds are rare and user-initiated; the CLI uses positional truncate because tombstoning individual assistant messages at runtime must be cheap for it. Our usage pattern doesn't justify the fragility.
- **DO NOT** add `flock`/`proper-lockfile` around per-session JSONLs. Single-writer invariant is preserved by "one CLI subprocess per session"; a lockfile would create new cross-process deadlock surfaces for no gain. (yasasbanuka only locks the shared `history.jsonl`, which every CLI invocation appends to — a true multi-writer file. We have nothing analogous.)
- **DO NOT** move per-message message state back into localStorage or add a debounced 5 s safety save (the refactor removed both — it was the right call; the verification agent confirmed no data loss).

---

## 3. Bugs & gaps uncovered in our impl

Ordered by severity. Numbers cross-reference `our-baseline.md §10`.

| # | Bug / gap | Severity | Source | Fix |
|---|---|---|---|---|
| 1 | `truncate_session_jsonl_by_messages` NotFound is `Err`, inconsistent with `truncate_session_jsonl`'s `Ok(())` | **user-visible** | baseline §10 gap 6 | A1 above |
| 2 | `fork_session_jsonl` silently returns `Ok(uuid)` even if step-4 truncate fails → surplus messages on reopen | **data presentation** | baseline §10 gap 7 | A2 above |
| 3 | No UTF-8 BOM handling → first line of hand-edited JSONLs parse-fails silently | edge | yasasbanuka §6.3 | A3 above |
| 4 | No size ceiling on `atomic_write_jsonl` → fork of 500 MB JSONL stalls UI | edge, but severe when hit | yasasbanuka §MAX_TOMBSTONE_REWRITE_BYTES | B1 above |
| 5 | `sync_all()` errors are swallowed (`let _ = f.sync_all()`) | observability | baseline §10 gap 9 | C2 above |
| 6 | Parent directory not fsync'd after rename | strict-POSIX durability (rare in practice) | baseline §10 gap 8 | C1 above |
| 7 | `load_session_history_tail` parses whole file then truncates — wastes refresh-button wallclock on large sessions | perf | baseline §10 gap 2 | B4 above |
| 8 | Failed rewind silently reverts on next reopen via anti-shrink-replace | UX confusion | baseline §10 gap 15 | C4 above |
| 9 | No dedupe by UUID in `mapHistoryMessages` | theoretical | baseline §10 gap 11 | C5 above |
| 10 | No `schemaVersion` on `PersistedSessionMeta` | future-proofing | baseline §10 gap 13 | B3 above |
| 11 | No corrupt-localStorage rescue (no `.bak` copy) | upgrade-safety | clawd §2.2 | B2 above |
| 12 | Session UUID captured from CLI event rather than pre-generated (TOCTOU window) | minor race | t3code §5.1 | B5 above |
| 13 | Two T64 instances → last-writer-wins on truncate/fork; no cross-process lock | edge (who runs two T64s?) | baseline §10 gap 10 | Document as known limitation; no fix |
| 14 | `load_session_history` exposes no `parentUuid` to frontend → branching UI impossible without extending schema | feature gap, not bug | baseline §10 gap 14 | Defer until branching UI is spec'd |

---

## 4. Ship verdict

**Ship as-is** with the three Tier-A items promoted as follow-up commits *before* the next user-facing release, but they do **not** block merging the refactor branch.

Rationale:
- The refactor's design invariant (JSONL is authoritative, localStorage is ephemeral UX) is the same invariant Claude Code itself operates under. Validated by the canonical source.
- Agent 4's verification report confirmed all six scenarios pass (relaunch, wiped localStorage, corrupted JSONL line, fork, rewind, delegation-ephemeral).
- `atomic_write_jsonl` is correctly positioned on exactly the paths we own. We don't compete with the CLI's append stream; we replace whole files only on rare, user-initiated edits.
- Every uncovered gap is either (a) edge-case severity, (b) strict-POSIX rather than observable-in-the-wild, or (c) a pre-existing issue the refactor didn't introduce.

**Must-fix-before-next-release (Tier A):**
1. `truncate_session_jsonl_by_messages` NotFound → `Ok(())` — ~5 lines.
2. `fork_session_jsonl` propagate/rollback on truncate failure — ~20 lines + test.
3. UTF-8 BOM strip in JSONL readers — ~3 lines × 3 call sites.

Total Tier-A effort: ~1 hour, near-zero risk. Bundle as one small commit after this refactor merges.

**Nice-to-haves (Tier B/C):** file as individual GitHub issues; work them as capacity allows. None affect correctness on the happy path.

**Explicitly declined (Tier D):** SQLite event-sourcing, coalesced write queue, positional truncate, file locking, per-message localStorage. These are other-projects' answers to other-projects' problems.
