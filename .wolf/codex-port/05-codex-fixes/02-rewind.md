# Codex Rewind — Findings

## (a) Current behavior (Anthropic path)

`ClaudeChat.tsx:1178` `handleRewind(messageId, content, revertCode)`:

1. `cancelByProvider` + `closeByProvider` (provider-aware, fine for Codex).
2. `truncateSessionJsonlByMessages(sessionId, cwd, keepMessages)` — `tauriApi.ts:238` → Rust `truncate_session_jsonl_by_messages` (`lib.rs:1388`), which uses `session_jsonl_path` (`lib.rs:124`) hard-coded to `~/.claude/projects/<dir-hash>/<session_id>.jsonl`.
3. `findRewindUuid(sessionId, cwd, keepMessages)` → fed into Anthropic's `--resume-session-at <uuid>` at `ClaudeChat.tsx:855-883`.
4. UI mutates `claudeStore`, restores checkpoint files, deletes new files.

For Codex, `sessionId` is the **T64-local UUID** (not `session.codexThreadId`), and the rollout lives at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`. So:

- `truncate_session_jsonl_by_messages` resolves to a Claude path that doesn't exist → silently no-ops via the `NotFound` skip branch (`lib.rs:1402-1416`).
- `codex exec resume --help` confirms **no `--resume-session-at` / `--resume-at-turn` flag exists** — only `[SESSION_ID]`, `--last`, `-c …`.

Net effect: the Codex rollout is never touched. Next `codex exec resume <thread_id>` re-feeds the full pre-rewind history. The store-side mutation makes the UI *look* rewound; on reload `hydrateFromJsonl` re-reads the full rollout and the "deleted" turns reappear — same class of regression `cerebrum.md:77` warned about.

## (b) Why it fails for Codex

1. Wrong file path (Claude projects dir vs. Codex sessions dir).
2. Wrong envelope. `truncate_session_jsonl_by_messages` matches Anthropic's `{type:"user"|"assistant", message:{content:[…]}}`. Codex lines are `{timestamp, type:"session_meta"|"event_msg"|"response_item"|"turn_context", payload:{…}}`.
3. No "resume-at" flag exists in `codex exec`, so even a perfect physical truncate can't be paired with a flag-based replay slice.
4. Line 1 is `session_meta` (id, cwd, cli_version, base_instructions, git). Codex relies on this header for resume — must be preserved verbatim.

## (c) Minimal fix

Codex rollouts **can** be physically truncated and `codex exec resume <thread_id>` **does** read the file as the session memory — but only on **turn boundaries**, not arbitrary message indexes. From sampling `~/.codex/sessions/2026/04/25/rollout-…-019dc280-….jsonl`, a turn is the run between `event_msg{type:"task_started"}` and the matching `event_msg{type:"task_complete"}` (with `turn_context`, `response_item`s, `agent_reasoning`, `agent_message`, `token_count` in between). Truncating mid-turn would leave a `task_started` with no `task_complete`, an unpaired `tool_call`, or an orphan `agent_reasoning` — all of which violate Codex's own state-machine assumptions and risk a panic on resume (Codex's own `thread/rollback` handler refuses partial turns; see "threadRollbackFailed" enum in `effect-codex-app-server/_generated/schema.gen.ts:10670`).

Concrete plan, **no code yet**, just the contract:

1. **New Rust command** `truncate_codex_rollout_by_turns(thread_id: String, num_turns: usize) -> Result<Value, String>`. Resolve the path via the existing `find_codex_rollout(thread_id)` (`codex.rs:708`). Algorithm:
   - Read all lines.
   - Always keep line 1 (`session_meta`); validate it parses and `type == "session_meta"`.
   - Walk forward, count completed turns by counting `event_msg.payload.type == "task_complete"`.
   - Truncate at the byte offset **immediately after** the Nth `task_complete` (where N = total_completed − num_turns). If the file ends mid-turn (no trailing `task_complete`), drop the trailing partial turn first, then count.
   - Atomic write back via the existing `atomic_write_jsonl` (`lib.rs:132`).
2. **Frontend branch in `handleRewind`** at `ClaudeChat.tsx:1198-1217`: if `sessionProviderFor(sessionId) === "openai"`, replace the `truncateSessionJsonlByMessages` call with the new `truncateCodexRolloutByTurns(session.codexThreadId, keepTurns)` and skip `findRewindUuid` entirely (no analogue exists). `keepTurns` derives from `keepMessages` by counting `assistant` boundaries in `preMsgs`.
3. **No flag on resume.** Just call `codex exec resume <thread_id> --json "<new prompt>"` as today; Codex re-reads the truncated rollout as full conversation memory.

## Reference: t3code

t3code sidesteps all of this by using the **`codex app-server`** JSON-RPC mode (not `codex exec`). They spawn `codex app-server` (see `apps/server/src/provider/Layers/CodexProvider.ts:257`, `args: ["app-server"]`) and call a first-class native method `thread/rollback` — `CodexAdapter.ts:1555-1578` `rollbackThread(threadId, numTurns)` → `CodexSessionRuntime.ts:1259-1271` `client.request("thread/rollback", { threadId, numTurns })`. Schema is `V2ThreadRollbackParams = { numTurns: number; threadId: string }` (`effect-codex-app-server/_generated/schema.gen.ts:33734`). The server handles partial-turn cleanup, header preservation, and active-turn cancellation atomically (returning `threadRollbackFailed` on bad input).

Stronger long-term fix for T64: switch the Codex adapter from `codex exec` to `codex app-server` and gain `thread/rollback`, `thread/read`, `turn/interrupt`, and resume-with-recovery for free. Short-term fix: the turn-boundary truncate above.
