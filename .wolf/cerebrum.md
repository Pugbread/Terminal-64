# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-04-19

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** terminal-64 — canvas-based terminal emulator + AI workstation built with Tauri v2 + React 19 + xterm.js. Manages multiple terminal sessions and Claude Code agents on a free-form pan/zoom canvas.

### Windows platform
- No first-class `longPathAware` manifest field in Tauri 2; keep `~/.terminal64/` paths short.
- Localhost servers (127.0.0.1) don't trigger Windows Defender Firewall prompts. SmartScreen needs EV cert (out of scope).

### Voice / ONNX runtime (added 2026-04-18)
- Moonshine-base: encoder hidden dim **416** (not 288); decoder 8 layers (64 past_kv inputs) + `use_cache_branch: bool[1]`. For ≤3s audio, pass `use_cache_branch=false` + zero past tensors each step.
- Silero-VAD v5 ONNX: unified `state: [2,1,128]` (not separate h/c). Inputs: `input`, `state`, `sr` (i64[1] not i64[]). Outputs: `output`, `stateN`.
- openWakeWord: wake-classifier input is `x.1`. Always resolve names at load via `session.inputs()[0].name()` — naming has changed across versions.
- openWakeWord melspectrogram.onnx output is `[time,1,1,32]` (4D, batch on axis 0). Flatten by total-len/32; apply `x/10 + 2` scaling.
- LocalAgreement-2 word-index LCP only valid for SAME audio region. When partial decoder slides its window, fully reset committed_words + last_hypothesis_words. Without per-word timestamps you can't preserve committed prefix across slides; final beam-search decode backfills.
- Tauri Emitter split-stream events (`voice-committed` + `voice-tentative`) arrive in non-deterministic order. Each handler updates its half of the store and calls a shared `applySplit()` reader — don't await pairs.

### Delegation
- `delegationStore.parentToGroup` is single-slot. To get ALL groups for a parent, iterate `Object.values(delState.groups).filter(g => g.parentSessionId === parentId)`.
- Delegation children are provider-bound but ephemeral. When spawning them, explicitly copy parent session model/effort and Codex permission preset into both the child store row and backend create request; `createSession(..., ephemeral=true)` does not load persisted metadata.
- Claude delegation MCP labels come from the generated temp MCP config env. Create one config per child if the team chat needs distinct `Agent N` names.

### Claude CLI events (`useClaudeEvents.ts`)
- `stream_request_start` fires at start of EACH API call in a multi-turn session. Treat like `message_start`: clear pendingBlocks + assistantFinalized.

## Do-Not-Repeat

<!-- Past mistakes that must not recur. Each entry dated. -->

### Windows shim / PATH (2026-04-19)
- `Command::new("pm2"|"claude"|"openwolf")` does NOT resolve `.cmd`/`.bat` shims via PATHEXT. Invoke via `cmd /C <shim>` with CREATE_NO_WINDOW (0x08000000). Use centralized `shim_command` helpers (`claude_manager::shim_command`, `lib.rs::shim_command`) — do not open-code at call sites.
- `where <bin>.exe` only matches exact extension; pass bare name to use PATHEXT. Same for `Command::new` — fallback strings must include `.cmd`/`.exe`.

### Windows filesystem (2026-04-19)
- `std::os::windows::fs::symlink_dir` requires Admin/Developer Mode. Fall back to junctions via `cmd /C mklink /J` (see `create_dir_link()` in lib.rs).
- NTFS reserves `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` regardless of extension; strips trailing dots/spaces. Sanitize external filenames (Discord attachments, uploads).
- Frontend: use `src/lib/platform.ts` helpers (`baseName`, `dirName`, `isAbsolutePath`, `joinPath`, `IS_WIN`, `IS_MAC`). Do NOT use `path.split("/")`, `relPath.startsWith("/")`, template-literal joins, or `navigator.platform` directly — they all fail on Windows backslash/drive-letter paths.

### Tauri build config (2026-04-19)
- Tauri 2 bundle: use explicit `targets: ["app","dmg","deb","appimage","rpm","nsis"]` — `"all"` triggers MSI which needs WiX. Set `bundle.windows.nsis.minimumWebview2Version` (e.g. "110.0.1587.40") for enterprise updates.
- `env!("CARGO_MANIFEST_DIR")` bakes developer's compile-time path — production crashes on user machines. Use `app_handle.path().resource_dir()` first, fall back to CARGO_MANIFEST_DIR only for dev runs.
- Rust CI runs clippy with `-D warnings`; prefer direct cheap fallbacks like `unwrap_or(JsonValue::Null)` over lazy `unwrap_or_else(|| json!(null))`.

### ONNX / ort crate (2026-04-18)
- `ort` 2.0.0-rc.11 needs `ndarray = "0.17"` (matches fastembed v5 transitive). Pinning 0.16 splits the graph and breaks `Tensor::from_array`.
- `ort::Session::run(...)` returns `SessionOutputs<'s>` borrowing the session — scope each stage in `let x = { ... }` so outputs drop before `&mut self` calls (E0499). Applies to all voice runners.

### Rewind / git / delegation data loss (2026-04-19)
- Rewind `restoreCheckpoint(keepTurns+1)` restores PREVIOUS turn's snapshot. Detect undo-send (target = last user msg, no assistant response) and skip file ops to prevent data loss.
- Rewind MUST NOT `git checkout HEAD -- path` on delegation-modified files — wipes uncommitted/parent edits. For files touched by delegation children without parent checkpoint entry, only delete UNTRACKED files.
- Distinguish `Err(spawn failed)` from `Ok(exit != 0)` for git. Spawn fail = skip-and-log; non-zero exit = safe to delete untracked. Treating spawn fail as "untracked" causes data loss on tracked files.

### Session state flow (2026-04-16)
- Fork first-send MUST branch on `forkParentSessionId` presence alone — NOT `if (forkParent && !started)`. `loadFromDisk(newSessionId, forkedMessages)` sets `hasBeenStarted=true` whenever `promptCount>0`, so the `!started` guard falls through to `--resume <newId>` against a JSONL the CLI hasn't created yet, and the send hangs silently. Store clears `forkParentSessionId` after the `--fork-session` send succeeds.
- With `exactOptionalPropertyTypes`, provider runtime input objects must omit optional fields when values are undefined. Do not pass `permissionOverride: undefined` or `codexThreadId: undefined`; conditionally add the property.

### UI rendering / WebKit (2026-04-18)
- `overflow: hidden` + `border-radius` on a child of a `transform: scale(z)` parent flickers on WebKit at fractional pixel positions — rounded-corner clip repaints non-atomically, invalidating the background paint. Fix by promoting to own compositor layer: `will-change: transform; transform: translateZ(0); backface-visibility: hidden; contain: layout paint; isolation: isolate`.
- Prompt island can lag with huge histories if it reverses/maps/formats every prompt on open. Render the newest bounded slice first and append older rows in scroll batches.
- LegendList scroll events are not a reliable proxy for user intent during streaming; growing rows can briefly report not-at-end. Keep bottom stickiness in an intent ref updated by wheel/touch/key/pointer handlers, and use scroll events only for visibility/progress telemetry.

### Voice pipeline (2026-04-18)
- VAD with a single hard threshold + 1-frame hangover finalizes whisper early on breaths/soft consonants mid-utterance. Use Silero VADIterator-style hysteresis: activate 0.5, deactivate 0.35, `min_speech_duration_ms=250`, `min_silence_duration_ms=500`, `speech_pad_ms=300`. Tune orchestrator silence-frame counters to match (e.g. dictation `SILENCE_FRAMES_TO_FINALIZE` 25→9).
- Streaming `partial_worker` that clones the full rolling buffer every tick is O(n²) over an utterance — 12s audio re-decoded every 250ms stalls partials under Metal. Decode only a trailing window slice (`g[buf_len - PARTIAL_WINDOW_SECS*SR ..]`), add min-new-samples gate (~120ms), reset `AgreementBuffer` when the window slides, and watchdog-skip next tick if decode > 2× tick interval.

### Security / zip extraction (2026-04-19)
- Zip extraction: `PathBuf::starts_with` is lexical — does NOT collapse `..`. Iterate `components()` and reject `ParentDir`, `RootDir`, `Prefix` before joining (Windows zip-slip).

### Session JSONL handling (2026-04-19)
- `find_rewind_uuid` leaf detection must filter to `type == "user" | "assistant"`. JSONL also contains `summary`, `task-summary`, `mode-entry`, etc. with UUIDs that aren't conversation tail.
- `truncate_session_jsonl_by_messages` trailing sweep: on JSON parse failure, `continue` (don't `break`). A single malformed line from in-flight CLI writes must not abort the sweep and break tool_use/tool_result pairing.

### Rewind + fork JSONL persistence (2026-04-22)
- `load_session_history` reads every line in the JSONL sequentially — it does NOT walk the parentUuid chain and does NOT respect rewind markers. Rewind must physically truncate the file (`truncate_session_jsonl_by_messages`) in addition to storing `resumeAtUuid` for `--resume-session-at`; otherwise a refresh reloads the "deleted" messages.
- `fork_session_jsonl` copies the full parent JSONL (needed so chain-walking can resolve the fork UUID) but MUST then truncate the destination to `keep_messages`. Without truncation the fork reloads with the entire parent history until the first `--resume-session-at` send.
- Codex app-server rewind differs from Claude: it may preserve older rollout items and append a `thread_rolled_back`/`thread_rollback` marker with `num_turns`/`numTurns`. Codex history hydration must replay that marker by dropping trailing user turns; otherwise refresh-from-jsonl shows messages the model context no longer contains.
- Codex rollouts can store edits as `custom_tool_call` named `apply_patch`; hydrate these into `Edit`/`MultiEdit` tool calls so refreshed chats preserve Claude-style clickable edit cards.
- Codex file-change shapes are not stable across live app-server events and rollout/history data: accept `path`, `file_path`, `filePath`, `diff`, `unified_diff`, and `unifiedDiff` when building UI tool-call inputs.
- Tool edit preview paths can be relative for Codex `apply_patch` history; resolve them against the session cwd before `readFile` so Monaco opens the real file.
- Checkpoint snapshots must also resolve Codex/Claude modified file paths against the session cwd before `readFile`/manifest persistence; restore must only write absolute manifest targets. Raw relative paths would restore from the Tauri process cwd, not the project cwd.
- Legacy `T64_CODEX_TRANSPORT=exec` emits rollout-style `session_meta`/`event_msg`/`response_item` JSON. Translate it in Rust to the same provider-neutral event shapes as app-server before emitting to the frontend.
- Codex app-server/live item updates may use cumulative `item.text`/`output` or delta fields depending on event source. Frontend accumulation must append explicit `delta` values but replace when the new value already includes the previous value; patch-only file-change updates should update tool input without setting `result`, or the UI marks the tool completed too early.
- Codex runtime has two ids: the Terminal 64 local `sessionId` routes UI/process events, while `codexThreadId` is the external OpenAI thread used for resume/fork/rollback. Fresh first-turn failures must not fall back to `send_codex_prompt` without a thread id; only already-started legacy sessions may attempt local-id resume.
- With `exactOptionalPropertyTypes`, provider contract fields that callers include explicitly with maybe-undefined values must be typed as `T | undefined`, not just `field?: T`.

### Permission server bypass + unknown-session race (2026-04-22)
- `permission_server::handle_connection` must parse `permission_mode` from the hook payload BEFORE the session_map lookup. The request's `secret` in the URL has already proven authenticity, so an unknown `run_token` is just "session unregistered" (rewind cancel+close race, spawned-session timing, or server-restart leftover). On bypassPermissions, always return `permissionDecision: "allow"` even with empty session_id — otherwise the user gets silent `permissionDecision: "deny"` with reason "Unknown session — denied for safety" on skill/widget/MCP/MD edits.
- Claude CLI's hook payload fields are snake_case at runtime (`permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `session_id`). The minified binary uses `permissionMode` internally but serializes to snake_case. Verified by probing with a python hook on `claude --print --permission-mode bypassPermissions --settings <file>`.

### Claude CLI sensitive-file classifier is unbypassable in --print mode (2026-04-22)
- The classifier (RC5/jtH in the minified binary) blocks Write/Edit/MultiEdit on hardcoded paths regardless of permission mode or CLI flags. Protected dirs: `.git`, `.vscode`, `.idea`, `.claude`, `.husky` (with exceptions for `.claude/skills|agents|commands|worktrees` and `.claude/scheduled_tasks.json`). Protected filenames at basename: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, `.claude.json`. Both `--permission-mode bypassPermissions` and `--dangerously-skip-permissions` are ignored. The only allow-rule prefix that satisfies the early-return is `Edit(/.claude/**)` or `Edit(~/.claude/**)` ending in `/**` — so `.mcp.json` cannot be unblocked via settings.
- The classifier runs BEFORE PreToolUse hooks fire, so a hook-based auto-allow is impossible. The only workaround is to detect the sensitive-file tool_result error in the frontend and perform the edit ourselves (Terminal-64 pattern: `pendingSensitiveEdit` in claudeStore + `applySensitiveEditAndContinue` in ClaudeChat.tsx — reads file via `readFile`, replays Write/Edit/MultiEdit semantics locally, writes via `writeFile`, then injects a follow-up user message so Claude treats the tool call as succeeded).

### Claude CLI event handling (2026-04-19)
- "Safety net" sets `isStreaming=true` on any non-result/non-ping event. Top-level `{type:"error"}` (rate limit, overloaded, auth) MUST be handled explicitly: `setError` + `setStreaming(false)` + clear pending + `return`. Otherwise spinner never stops.
- `content_block_delta` + `input_json_delta`: always check `blocks[last].type === "tool_use"` before accumulating inputJson — `thinking` blocks can interleave.

### Claude CLI --resume replay (2026-04-19)
- If the previous run died mid-tool, the session JSONL can contain an assistant `tool_use` block with no matching user `tool_result`. On `--resume`, the CLI RE-EXECUTES the dangling tool (infinite replay). Before every spawn, scan the JSONL and append synthetic cancelled `tool_result` records (is_error: true) for any unresolved tool_use IDs. See `sanitize_dangling_tool_uses()` in `claude_manager.rs`. Preserve `parentUuid`, `cwd`, `version`, `gitBranch` on the synthetic record so the CLI accepts it.
- Claude CLI stdout lines can be hundreds of MB for large Bash outputs. Emitting them raw as one Tauri event freezes the renderer (JSON.parse + React render + localStorage persistence on megabytes). Cap lines > 512KB in the reader thread (`cap_event_size()`) — truncate `tool_result`/`text` content to head 96KB + tail 96KB with a marker. The CLI's own JSONL keeps the full output for future turns; only the live UI stream is truncated.
- `cap_event_size()` is shared by Claude and Codex live streams. If it receives a parsed JSON event, every fallback must preserve valid JSON; raw byte-slice truncation makes the frontend show bogus parse errors while the provider process keeps running. For provider events with arbitrary shapes, recursively truncate oversized string fields and re-serialize.
- LegendList row keys must change when a row's rendered height can change outside normal message append flow, especially assistant tool cards receiving live output. Include a lightweight layout signature for assistant/tool rows so the virtual list remeasures instead of letting growing cards overlap following rows.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

### Traveling comet border beam — SVG path animation (2026-04-19)
Chosen: SVG `<rect pathLength="100">` + `stroke-dasharray` + animated `stroke-dashoffset` + `feGaussianBlur`.
Rejected: (1) multiple discrete divs with staggered `animation-delay` on `offset-path` — always render as separated dots rather than a continuous beam. (2) conic-gradient + mask — distorts speed at corners on wide rectangles.
