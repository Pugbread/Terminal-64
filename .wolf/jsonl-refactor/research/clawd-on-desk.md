# Research: `rullerzhou-afk/clawd-on-desk`

**Repo:** https://github.com/rullerzhou-afk/clawd-on-desk
**What it is:** Electron desktop pet (animated crab) that reacts in real time to activity from Claude Code / Codex / Copilot / Gemini / Cursor / CodeBuddy / Kiro / opencode / Kimi sessions.
**License:** MIT. ~21k LOC of JS under `src/`, plus hook scripts.
**Clone path for citations:** `/tmp/clawd-on-desk/` (commit at `HEAD` on default branch, cloned 2026-04-23).

> ⚠️ **Observer, not wrapper.** Clawd does **not** spawn Claude CLI, does not own session history, does not read or write `~/.claude/projects/…/*.jsonl`. It only observes Claude state transitions via (a) Claude Code hook stdin events and (b) polling Codex's JSONL rollout files. Relevance to Terminal 64's refactor is therefore limited to **persistence utilities** and **JSONL tail-reading patterns**, not session-lifecycle design.

---

## 1. Architecture at a glance

| Component | File | Role |
|---|---|---|
| Electron main | `src/main.js` (3636 LOC) | App bootstrap, IPC routing, wires everything together |
| HTTP server | `src/server.js` (927 LOC) | Listens on a localhost port (`DEFAULT_SERVER_PORT`) for `/state` POSTs from hook scripts and `/permission` blocking calls |
| State machine | `src/state.js` (1451 LOC) | In-memory `Map<sessionId, SessionRecord>`; animation/priority/stale-cleanup |
| Prefs | `src/prefs.js` (515 LOC) | JSON-on-disk user preferences with schema + migration |
| Claude hook | `hooks/clawd-hook.js` | Runs **per hook event**; reads stdin JSON, optionally tails transcript, POSTs to `/state` |
| Codex log monitor | `agents/codex-log-monitor.js` | Polls `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for state changes |
| Hook JSON utils | `hooks/json-utils.js` | Shared `writeJsonAtomic` used by every hook-installer |

Sessions are **ephemeral, in-memory only** — when Clawd restarts, all session tracking is lost. A "startup recovery" mode (`src/state.js:1023-1049`) just probes running agent processes to decide whether to stay awake vs. sleep; no state is reconstructed from disk.

---

## 2. Persistence patterns — the good

### 2.1 Atomic JSON write (gold-standard)

`hooks/json-utils.js:20-32`:

```js
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}
```

Key properties:
- Temp filename is namespaced by **pid + timestamp** → two concurrent processes can't collide.
- Parent dir created with `recursive: true`.
- Temp file is unlinked on failure so retries don't leak.
- Uses POSIX `rename` for the atomic swap.

**Caveat:** no `fsync` on file or parent directory. On an abrupt power loss (not just crash) the rename may not be durable on macOS HFS+/APFS. Not fatal for Clawd's use case (hook installer configs are rewritable from code), but Terminal 64's session history would want to fsync — see recommendations.

This helper is used by every hook installer (`hooks/install.js:759,837,877`, `cursor-install.js:119`, `gemini-install.js:101`, `opencode-install.js:121`, `codebuddy-install.js:161`, `kiro-install.js:111,228,246`).

### 2.2 Prefs: schema-versioned load with defensive backup

`src/prefs.js:457-491`:

```js
function load(prefsPath) {
  let raw;
  try {
    const text = fs.readFileSync(prefsPath, "utf8");
    raw = JSON.parse(text);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { snapshot: getDefaults(), locked: false };
    }
    try {
      const bak = prefsPath + ".bak";
      fs.copyFileSync(prefsPath, bak);
      console.warn(`Clawd: prefs file unreadable, backed up to ${bak}:`, err.message);
    } catch (bakErr) { /* … */ }
    return { snapshot: getDefaults(), locked: false };
  }
  if (!raw || typeof raw !== "object") {
    return { snapshot: getDefaults(), locked: false };
  }
  // Future-version guard: refuse to overwrite a prefs file written by a newer version.
  const incomingVersion = typeof raw.version === "number" ? raw.version : 0;
  if (incomingVersion > CURRENT_VERSION) {
    console.warn(
      `Clawd: prefs file version ${incomingVersion} is newer than supported (${CURRENT_VERSION}). ` +
      `Settings will be readable but not saved to avoid data loss.`
    );
    return { snapshot: validate(raw), locked: true };
  }
  const migrated = migrate(raw);
  return { snapshot: validate(migrated), locked: false };
}
```

Three useful ideas rolled into one function:
1. **ENOENT is silent first-run default** — no warning noise.
2. **Any other read/parse failure → copy to `.bak` then return defaults.** The user doesn't lose their corrupt file; they just don't get it loaded.
3. **Future-version lock:** if the file's `version` is higher than what this code supports, the snapshot is usable in-memory but `locked=true` signals `save()` to no-op. A newer Clawd install doesn't get clobbered by an older one started on the same machine.

---

## 3. Persistence patterns — the bad / missing

### 3.1 Prefs save is NOT atomic

`src/prefs.js:493-501`:

```js
function save(prefsPath, snapshot) {
  const validated = validate(snapshot);
  try {
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  } catch {}
  fs.writeFileSync(prefsPath, JSON.stringify(validated, null, 2));
}
```

Anti-pattern: plain `writeFileSync` truncates then writes. A crash/power loss mid-write leaves a zero-byte or partial file, and the load path will back it up and return defaults — i.e. **all prefs silently revert to defaults**. They wrote `writeJsonAtomic` for the hook installer and forgot to dogfood it here.

### 3.2 No JSONL source-of-truth for Clawd's own data

Sessions are a `Map<sessionId, SessionRecord>` in RAM (`src/state.js:91`). `MAX_SESSIONS=20`; oldest-by-`updatedAt` evicted on overflow (`src/state.js:701-708`). On restart, everything is gone. There is no concept of resuming a Clawd session or browsing prior sessions — that responsibility is fully delegated to Claude/Codex.

### 3.3 No file locking, no fsync, no journal

Prefs writes and hook-config writes both skip `fsync` (data) and `fsyncSync` on the parent directory (rename durability). For a consumer app this is usually fine; for Terminal 64 where the JSONL **is** the session truth, stricter durability is worth considering.

---

## 4. JSONL reading patterns (directly applicable)

### 4.1 Tail-read for metadata: `extractSessionTitleFromTranscript`

`hooks/clawd-hook.js:34-78` reads the **last 256 KB** of a transcript and scans for custom title / agent-name events:

```js
const TRANSCRIPT_TAIL_BYTES = 262144; // 256 KB

function extractSessionTitleFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let data, truncated = false, fd = null;
  try {
    const stat = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, "r");
    const readLen = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
    truncated = stat.size > readLen;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
    data = buf.toString("utf8");
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }

  const lines = data.split("\n");
  // If we read a tail of a larger file, the first line is likely a truncated
  // JSON fragment — drop it so JSON.parse doesn't fail noisily on it.
  if (truncated && lines.length > 1) lines.shift();

  let latest = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    // … inspect obj.type, update `latest` …
  }
  return latest;
}
```

Four patterns worth copying into any Terminal 64 JSONL reader:

1. **Size-cap the read** (`TRANSCRIPT_TAIL_BYTES = 256KB`) so a 500MB JSONL can't OOM the process.
2. **Drop first line when truncated.** When you seek into the middle of a JSONL you almost always land inside a record; splitting on `\n` yields a corrupt JSON fragment as `lines[0]`.
3. **Per-line try/parse with `continue`.** Never let one corrupt record kill the whole read. (Our `load_session_history` already does this — good.)
4. **`fd` closed in `finally` block** with its own try/catch so a close failure can't mask the primary error.

### 4.2 Incremental offset-based tail: `CodexLogMonitor`

`agents/codex-log-monitor.js` is the most sophisticated pattern in the repo. It **watches Codex's rollout JSONL files**, which are the same category of artifact as Claude's session JSONL (append-only, one-JSON-object-per-line, written by an external process). The whole file is 500+ lines; extracting the relevant mechanics:

**Per-file tracked state** (`agents/codex-log-monitor.js:277-300`):

```js
tracked = {
  offset: 0,
  sessionId: "codex:" + sessionId,
  filePath,
  cwd: "",
  sessionTitle: null,
  lastEventTime: Date.now(),
  lastState: null,
  lastStateEvent: null,
  hasEmittedState: false,
  partial: "",
  hadToolUse: false,
  agentPid: null,
  pendingApprovalDetail: null,
  backfilling:
    stat.size > 0 &&
    stat.mtimeMs < this._startedAtMs - BACKFILL_GRACE_MS,
};
```

**Incremental read** (`agents/codex-log-monitor.js:304-341`):

```js
if (stat.size <= tracked.offset) return;

let buf;
try {
  const fd = fs.openSync(filePath, "r");
  const readLen = stat.size - tracked.offset;
  buf = Buffer.alloc(readLen);
  fs.readSync(fd, buf, 0, readLen, tracked.offset);
  fs.closeSync(fd);
} catch { return; }
tracked.offset = stat.size;

const text = tracked.partial + buf.toString("utf8");
const lines = text.split("\n");
const remainder = lines.pop() || "";
tracked.partial = remainder.length > MAX_PARTIAL_BYTES ? "" : remainder;

for (const line of lines) {
  if (!line.trim()) continue;
  this._processLine(line, tracked);
}

if (tracked.backfilling) {
  this._emitBackfillSnapshot(tracked);
  tracked.backfilling = false;
}
```

Patterns:

1. **Stateful `offset` per file.** Each poll reads `[offset, stat.size)` then advances offset. No re-reading; bounded memory.
2. **Partial-line carry-over.** `lines.pop()` saves the last (possibly incomplete) line across polls. **Capped at 64KB** (`MAX_PARTIAL_BYTES`) — if one logical line exceeds this, drop it rather than buffer unbounded (`tracked.partial = remainder.length > MAX_PARTIAL_BYTES ? "" : remainder`). Acknowledges one state update is silently lost; deliberate trade-off for memory safety.
3. **Bounded tracked-files map.** `MAX_TRACKED_FILES = 50` (`agents/codex-log-monitor.js:22`), with stale-cleanup before adding new entries.
4. **Backfill mode — replay-silent attach.** Files whose mtime predates the monitor's start by more than 5 s are marked `backfilling=true`. The first drain reads them to completion but `_processLine` suppresses all emissions and timers; only bookkeeping (lastState, cwd, sessionTitle) is updated. After the first drain finishes, `_emitBackfillSnapshot` may synthesize **exactly one** current sustained state (thinking / working / codex-permission). Prevents "replay storms" where restarting Clawd would re-fire every historical tool-use as a new notification.
5. **Two-layer replay guard** (`agents/codex-log-monitor.js:1-15`, top-of-file comment):
   - Line-level: skip any line whose `timestamp` field predates monitor start − 1500 ms.
   - File-level: the `backfilling` flag above.
   The layers overlap but don't duplicate — line-level only helps events that carry a `timestamp` field; file-level covers any line shape.
6. **Active-session window for pickup.** Files not written within 5 minutes are skipped entirely on initial discovery (`ACTIVE_SESSION_WINDOW_MS`, line 29; used at 104): saves a directory scan from promoting every ancient JSONL to a tracked file.
7. **Multi-tier directory scanning** (`_getSessionDirs`, lines 113-138): check today/yesterday/2-days-ago directories explicitly, plus recent-existing-day-dir fallback (for clock skew / cross-midnight sessions), plus any day dir with a recently-modified file (for Codex desktop app's long-lived conversations that keep writing to their original day dir weeks later). Shows how much care is needed when you don't control the JSONL path layout.

---

## 5. Session lifecycle (for comparison)

No create/resume/fork/delete at all — Clawd's sessions are side-effect bookkeeping, not a user-facing concept. The lifecycle is entirely driven by Claude Code hook events:

| Event → state | File |
|---|---|
| `SessionStart → idle` | `hooks/clawd-hook.js:118` |
| `SessionEnd → sleeping` (or `sweeping` if `source=="clear"`) | `hooks/clawd-hook.js:119`, `src/state.js:741-765` |
| `UserPromptSubmit → thinking` | `hooks/clawd-hook.js:120` |
| `PreToolUse / PostToolUse → working` | `hooks/clawd-hook.js:121-122` |
| `SubagentStart → juggling`, `SubagentStop → working` | `hooks/clawd-hook.js:126-127`, state `src/state.js:710-738` |

Interesting details worth noting:
- **Subagent resume** (`src/state.js:719-728`): when a subagent stops, Clawd restores the parent session's `resumeState` instead of reverting to idle. The pre-juggling state is stored on `SubagentStart`.
- **Stale cleanup** (`src/state.js:875-962`): runs every 10 s; deletes sessions whose `agentPid` is no longer alive, or whose `updatedAt` exceeds `SESSION_STALE_MS=10min` and whose source PID is gone. Two thresholds: `WORKING_STALE_MS=5min` demotes stuck `working/thinking/juggling` back to idle; `SESSION_STALE_MS=10min` deletes.
- **Capacity eviction** (`src/state.js:701-708`): oldest-by-`updatedAt` evicted at `MAX_SESSIONS=20`.

None of this maps directly to Terminal 64's rewind/fork/delete semantics — Clawd never mutates session history.

---

## 6. Multi-session management

In-memory `Map<sessionId, SessionRecord>` with:
- Priority-based display resolution (`STATE_PRIORITY` at `src/state.js:44-47`): error > notification > sweeping > attention > carrying/juggling > working > thinking > idle > sleeping. When N sessions exist, Clawd shows the state of the highest-priority one.
- Keyed by `session_id` from the hook payload (Claude) or by `"codex:" + uuid` parsed from filename (Codex `src/codex-log-monitor.js:514-518`).
- Per-session metadata: `sourcePid`, `cwd`, `editor`, `pidChain`, `agentPid`, `agentId`, `host`, `headless`, `sessionTitle`, `recentEvents` (ring buffer, cap 8), `pidReachable`.

Coexistence between agents is handled by **namespacing session IDs** per-agent (`"codex:<uuid>"`), which sidesteps the risk of a Claude UUID colliding with a Codex UUID. Terminal 64 already scopes by project path, but worth noting if we ever integrate non-Claude agents.

---

## 7. Reload / data-loss prevention

Clawd has essentially no "data loss on reload" problem to solve — the interesting data lives in Claude/Codex. Things they **do** protect:

| Asset | Protection |
|---|---|
| Hook-installer configs | `writeJsonAtomic` (tmp+rename) |
| User prefs JSON | Version lock + backup-on-corrupt-read; **not** atomic-write |
| In-memory sessions | None — ephemeral by design |
| Replay on restart | Codex backfill mode + timestamp guard (does **not** reconstruct sessions, just prevents spurious state emissions) |

The **future-version lock** on prefs (section 2.2) is the one pattern here that maps directly to Terminal 64's `PersistedSessionMeta` in localStorage: if a user opens an older build of Terminal 64 after running a newer one, we should refuse to save-over the newer metadata.

---

## 8. Comparison to Terminal 64

| Concern | Clawd | Terminal 64 (current) |
|---|---|---|
| Atomic JSONL write | N/A (never writes Claude JSONL) | `atomic_write_jsonl` at `src-tauri/src/lib.rs:131` — intended atomic; should verify it `fsync`s |
| Atomic config write | `writeJsonAtomic` in `hooks/json-utils.js` (good); **not** used for own prefs (bad) | localStorage for metadata (browser-managed, atomic from app POV) |
| JSONL partial-line handling on tail read | Drop first line when truncated (`hooks/clawd-hook.js:57-59`); 64KB partial buffer cap (`codex-log-monitor.js:328`) | `load_session_history` reads full file — partial-line concerns less acute, but relevant if we ever tail |
| Per-line parse-error tolerance | `try { JSON.parse } catch { continue }` everywhere | ✅ already in `load_session_history` |
| Version lock on persisted data | `src/prefs.js:480-491` | ❌ not present in `PersistedSessionMeta` |
| Backup on corrupt read | `src/prefs.js:467-474` | ❌ no equivalent for metadata |
| Incremental tail with offset | `codex-log-monitor.js` full impl | ❌ full-file reload on each `hydrateFromJsonl` — fine for short sessions, would hurt for 10k-message sessions |
| Backfill / replay guard | Two-layer system in `codex-log-monitor.js` | N/A until we tail |
| No-shrink guard on reload | Not applicable (stateless) | ✅ `loadFromDisk` already has it |

---

## 9. Recommendations for Terminal 64's JSONL refactor

**Short-term (verify existing code):**

1. **Audit `atomic_write_jsonl` at `src-tauri/src/lib.rs:131`** — confirm it:
   - Writes to a sibling `.tmp` file in the same directory as the target (required for atomic rename — rename across filesystems is a copy).
   - Calls `file.sync_all()` or `sync_data()` before rename.
   - Calls `File::open(parent_dir)?.sync_all()` after rename on Unix (durability of the directory entry).
   - Cleans up `.tmp` on error.
   Clawd's JS version (`hooks/json-utils.js:20-32`) skips the fsync steps — we should be stricter than they are.

2. **Add a `schema_version` field to `PersistedSessionMeta`** and implement the future-version lock from `src/prefs.js:480-491`. If localStorage has `version > CURRENT_VERSION`, load read-only and skip writes. Prevents downgrade-induced clobbering when a user moves between Terminal 64 builds.

3. **Mirror the ENOENT-silent / corrupt-backup split in `load_session_metadata`** at `src-tauri/src/lib.rs:1485`:
   - File missing → return defaults without logging.
   - Parse failure → `copy(path, path + ".bak")` then return defaults with a warning.

**Medium-term (if sessions grow long):**

4. **Consider incremental offset-based tailing in `hydrateFromJsonl`** rather than full-file reload. Clawd's `CodexLogMonitor` is a complete reference implementation. The main payoff is reload latency for sessions with 5k+ messages. Required invariants if we do this:
   - Persist `offset` per session alongside `{sessionId, name, cwd, draftPrompt, lastSeenAt}`.
   - Cap partial-line buffer at ~64 KB (`MAX_PARTIAL_BYTES` at `agents/codex-log-monitor.js:23`).
   - Add a **backfill flag** for replay-silent first-attach (prevents UI event spam when we reload a live session whose JSONL has grown since we last saw it). See `agents/codex-log-monitor.js:291-300,455-463`.
   - Add a **line-level timestamp guard** for events older than the UI's "latest-seen" cursor (complement to backfill). See `agents/codex-log-monitor.js:351-356`.

5. **If we ever reopen the JSONL after crash** and need to seek to the tail without re-reading the whole file: borrow `extractSessionTitleFromTranscript`'s "read last N bytes, drop first line if truncated" pattern. Particularly important if Claude CLI was killed mid-write — the last line may be corrupt and we should tolerate that.

**Non-recommendations (from their anti-patterns):**

- Don't follow their `src/prefs.js:500` `writeFileSync` shortcut — always atomic. They have a 515-line prefs module with versioning and migration, and then blow it all with one non-atomic call.
- Don't skip fsync on the grounds that "atomic rename is enough" — it isn't, at least not across power loss on macOS APFS.

---

## 10. Patterns (TL;DR)

- `writeJsonAtomic` (pid+timestamp tmp, rename, unlink-on-fail): `hooks/json-utils.js:20`.
- Version lock on persisted data: `src/prefs.js:480-491`.
- Tail-read with drop-first-line-when-truncated: `hooks/clawd-hook.js:34-78`.
- Incremental offset tail + partial-line carry + 64KB cap: `agents/codex-log-monitor.js:258-341`.
- Backfill mode (replay silent + synthesize one current snapshot): `agents/codex-log-monitor.js:291-300, 388-391, 455-463`.
- Two-layer replay guard (line timestamp + file-mtime attach flag): file header comment `agents/codex-log-monitor.js:5-15`.
- MAX_TRACKED_FILES / MAX_SESSIONS capacity caps with oldest-eviction: `agents/codex-log-monitor.js:22`, `src/state.js:92,701-708`.
- Stale cleanup with PID-liveness probe every 10 s: `src/state.js:875-962,1053`.

## 11. Anti-patterns (TL;DR)

- Non-atomic write while having an atomic helper in the same repo: `src/prefs.js:500` vs `hooks/json-utils.js:20`.
- No `fsync` anywhere — relies on rename-atomicity only.
- Full-file reads for metadata extraction when a tail would do (addressed in `extractSessionTitleFromTranscript` but not elsewhere).
- No session persistence at all — acceptable for a desktop pet, but if we were evaluating them as a wrapper, this would be disqualifying.
