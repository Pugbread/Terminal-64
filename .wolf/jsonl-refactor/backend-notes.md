# Agent 2 — Backend JSONL API Hardening

## Audit summary (`src-tauri/src/lib.rs`)

| Function | Pre-state | Post-state |
|---|---|---|
| `session_project_dir` / `session_jsonl_path` | Unchanged. cwd→`<home>/.claude/projects/<dir_hash>/<sid>.jsonl`. `dir_hash = cwd.replace([':','\\','/'], "-")` matches CLI behavior on macOS/Linux/Windows. | Unchanged — collision risk between `/foo/bar` and `\foo\bar` only matters cross-OS, which the CLI itself doesn't support. Documented as a known-non-issue. |
| `load_session_history` | Already returned `Ok(vec![])` on NotFound and skipped malformed lines via `continue`. ✅ fault-tolerant. | Unchanged. |
| `load_session_history_tail` | Trampoline over `load_session_history`. ✅ fault-tolerant. | Unchanged. |
| `truncate_session_jsonl` | `fs::read_to_string` errored on NotFound; `fs::write` was non-atomic — a crash mid-write would leave a partially truncated JSONL. | NotFound → no-op log + `Ok(())`. Write goes through `atomic_write_jsonl` (tmp + fsync + rename). |
| `truncate_session_jsonl_by_messages` | Same `fs::write` non-atomicity. | Switched to `atomic_write_jsonl`. NotFound left as a hard error (rewinding a never-persisted session is meaningless). |
| `fork_session_jsonl` | `fs::copy` then a non-atomic truncate; if the copy partially succeeded the truncate would silently work on a corrupt file. | Read source, write destination via `atomic_write_jsonl`, then truncate (also atomic). NotFound on source returns a clearer error. |
| `find_rewind_uuid` | `fs::read_to_string` returned `read <path>: <io>` for NotFound. | Explicit, more actionable NotFound message. Malformed-line handling already skipped via `continue`. |

## New: atomic_write_jsonl(path, contents)

- Stages to `<path>.<ext>.tmp.<pid>.<uuid-simple>`.
- `File::create` → `write_all` → `sync_all` (best-effort) → `rename`.
- `rename` is atomic on the same FS on macOS/Linux. On Windows, `std::fs::rename` calls `MoveFileExW` with `REPLACE_EXISTING`, which is atomic when the target exists.
- On rename failure, the tmp file is removed so we never leave litter.
- Per-pid + uuid suffix prevents collisions when two truncates race (e.g. rewind + fork on the same session).

## New command: `load_session_metadata(session_id, cwd) -> SessionMetadata`

```rust
pub struct SessionMetadata {
  session_id: String,
  exists: bool,
  msg_count: usize,
  last_timestamp: f64,
  first_user_prompt: String,        // up to 240 chars, system-reminders stripped
  last_assistant_preview: String,   // up to 240 chars, "[tool calls]" if no text
}
```

- **Stream-parses** the JSONL with a `BufReader::lines()` — never holds the full file or the full message vec in memory.
- Skips malformed lines with a counter (logged at end), never returns `Err` from a parse failure.
- Mid-read I/O error → returns the **partial** metadata collected so far. Rationale: a JSONL the CLI is actively appending to could throw EAGAIN-like errors in rare scheduler windows; the UI must never see "session disappeared" because of that.
- NotFound → `exists: false`, all numeric fields 0. Lets callers treat "not yet written" identically to "empty session".
- This is the primitive Agent 4's session browser will use to populate the recents list **without any localStorage fallback**.

Wrapper: `loadSessionMetadata(sessionId, cwd)` in `src/lib/tauriApi.ts`. Type `SessionMetadata` exported from `src/lib/types.ts`.

## Concurrency note (mid-write by CLI subprocess)

The Claude CLI appends to its own session JSONL while running. Truncate/fork is invoked from the UI between turns, so the typical race is benign. Even so:

- Reads (`load_session_history`, `_tail`, `_metadata`, `find_rewind_uuid`) tolerate a partial last line — JSON parse failure on the trailing line is silently skipped.
- Writes (truncate/fork) atomically rename onto the target. If the CLI is appending via an open FD on the *old* inode, those appends will land in an orphaned (deleted-but-still-open) file rather than corrupting the new contents. This is the standard "atomic-replace vs writer with open FD" tradeoff and is preferable to in-place writes that could interleave bytes.

## CI

- `cargo fmt` clean.
- `cargo clippy --all-targets -- -D warnings` clean.
- `tsc --noEmit` clean.

## Files changed

- `src-tauri/src/lib.rs` — added `atomic_write_jsonl`, `load_session_metadata`, `extract_user_text`; hardened `truncate_session_jsonl`, `truncate_session_jsonl_by_messages`, `fork_session_jsonl`, `find_rewind_uuid`; registered new command.
- `src-tauri/src/types.rs` — added `SessionMetadata` struct.
- `src/lib/types.ts` — added `SessionMetadata` interface.
- `src/lib/tauriApi.ts` — added `loadSessionMetadata` wrapper.
