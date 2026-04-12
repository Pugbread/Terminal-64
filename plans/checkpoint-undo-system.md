# Checkpoint & Undo System for Terminal 64

## Problem
Rewind currently only truncates the conversation — code changes on disk are permanent. Users need to be able to undo Claude's code modifications when rewinding to an earlier point.

## Design: File-Copy Checkpoints (same approach as Claude Code)

**Core idea:** Before each prompt is sent, snapshot every file that Claude has modified so far in the session. On rewind, restore files from the checkpoint.

### Why file-copy, not git?
- No git pollution (no commits, branches, stash entries)
- Works in non-git directories
- Simple to implement and reason about
- Same proven approach Claude Code uses (`~/.claude/file-history/`)

### Why per-prompt (not per-tool)?
- Claude CLI executes tools internally — we can't intercept between tool invocation and file write
- Per-prompt is the natural boundary (matches rewind granularity)
- Simpler: one checkpoint per turn, not N per turn

---

## Architecture

### Storage
```
~/.terminal64/checkpoints/<session-id>/
  turn-1/
    src/App.tsx          (copy of file as it was BEFORE turn 1 ran)
    src/lib/utils.ts
  turn-2/
    src/App.tsx          (copy of file as it was BEFORE turn 2 ran)
    src/components/Foo.tsx
  ...
```

Each `turn-N/` directory preserves the state of modified files **just before** prompt N was sent. To undo turn N, restore files from `turn-N/`.

### Data Flow

```
User clicks Send (prompt N)
  |
  +-- 1. Read session.modifiedFiles (accumulated from all prior turns)
  +-- 2. For each file path, read current content from disk
  +-- 3. Save to ~/.terminal64/checkpoints/<session>/<turn>/
  +-- 4. Send prompt to Claude CLI
  |
  ... Claude runs, modifies files via Write/Edit tools ...
  |
  +-- 5. Tool results arrive -> extract file paths from Write/Edit tool calls
  +-- 6. Add those paths to session.modifiedFiles
```

```
User clicks Rewind to turn N
  |
  +-- 1. Truncate conversation (existing behavior)
  +-- 2. Read checkpoint for turn N+1 (the state before the NEXT turn)
  +-- 3. Restore each file to its checkpointed content
  +-- 4. Delete checkpoints for turns > N
  +-- 5. Reset modifiedFiles
```

---

## Implementation Steps

### Step 1: Rust Backend — 3 New Tauri Commands (~60 lines)

**File: `src-tauri/src/lib.rs`**

```rust
#[tauri::command]
fn create_checkpoint(session_id: String, turn: usize, files: Vec<FileSnapshot>) -> Result<(), String>
// FileSnapshot = { path: String, content: String }
// Saves each file to ~/.terminal64/checkpoints/<session_id>/turn-<turn>/<encoded_path>
// Stores original path in a .manifest file alongside the content

#[tauri::command]
fn restore_checkpoint(session_id: String, turn: usize) -> Result<Vec<String>, String>
// Reads manifest + files from checkpoint dir
// Writes each file back to its original path
// Returns list of restored file paths

#[tauri::command]
fn cleanup_checkpoints(session_id: String, keep_up_to_turn: usize) -> Result<(), String>
// Deletes checkpoint dirs for turns > keep_up_to_turn
```

### Step 2: Frontend API Wrappers (~15 lines)

**File: `src/lib/tauriApi.ts`**

```typescript
export function createCheckpoint(sessionId: string, turn: number, files: { path: string; content: string }[]): Promise<void>
export function restoreCheckpoint(sessionId: string, turn: number): Promise<string[]>
export function cleanupCheckpoints(sessionId: string, keepUpToTurn: number): Promise<void>
```

### Step 3: Track Modified Files in Store (~15 lines)

**File: `src/stores/claudeStore.ts`**

- Add `modifiedFiles: string[]` to `ClaudeSession` (default `[]`)
- Add `addModifiedFiles(sessionId, paths)` action — deduplicates and appends
- Add `resetModifiedFiles(sessionId)` action — clears on rewind

### Step 4: Capture File Paths from Tool Results (~20 lines)

**File: `src/hooks/useClaudeEvents.ts`**

In the `assistant` event handler, when a Write/Edit/MultiEdit tool_use block is found:
- Extract `file_path` from `block.input`
- Store it in a per-session map: `toolFileMap.set(block.id, filePath)`

In the `user` (tool_result) handler:
- Look up the file path for the tool
- Call `store.addModifiedFiles(sessionId, [filePath])`

### Step 5: Snapshot Before Each Prompt (~15 lines)

**File: `src/components/claude/ClaudeChat.tsx`**

In `actualSend()`, before the IPC call to Claude:

```
if session.modifiedFiles.length > 0:
  read each file from disk via readFile()
  call createCheckpoint(sessionId, promptCount + 1, snapshots)
```

Turn 1 has no modified files yet, so no checkpoint is needed (correct — nothing to undo).

### Step 6: Restore on Rewind (~15 lines changed)

**File: `src/components/claude/ClaudeChat.tsx`**

In `handleRewind()`, after truncating conversation:

```
keepTurns = remaining user message count
restoreCheckpoint(sessionId, keepTurns + 1)  // restore to state before the next turn
cleanupCheckpoints(sessionId, keepTurns)      // delete future checkpoints
store.resetModifiedFiles(sessionId)           // clear tracking
```

---

## What Gets Tracked
- Write tool calls (new/overwritten files)
- Edit/MultiEdit tool calls (modified files)
- Files accumulate across turns — checkpoint always covers all known files

## What Does NOT Get Tracked (same as Claude Code)
- Bash side effects (rm, mv, chmod)
- External changes (user edits)
- Remote side effects (API calls, DB, deploys)

## File Changes Summary

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | +3 commands, +FileSnapshot struct (~60 lines) |
| `src/lib/tauriApi.ts` | +3 API wrappers (~15 lines) |
| `src/stores/claudeStore.ts` | +modifiedFiles field, +2 actions (~15 lines) |
| `src/hooks/useClaudeEvents.ts` | Track file paths from Write/Edit tools (~20 lines) |
| `src/components/claude/ClaudeChat.tsx` | Checkpoint before send, restore on rewind (~30 lines) |

**Total: ~140 lines across 5 files. No new dependencies.**
