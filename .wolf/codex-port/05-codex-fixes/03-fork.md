# 03 — Codex Fork: provider not propagated, no `--fork-session` equivalent

## (a) Current behavior

`handleFork` in `src/components/claude/ClaudeChat.tsx:1396-1434` is the entry
point. The relevant block:

```ts
// ClaudeChat.tsx:1412
const newPanel = canvas.addClaudeTerminalAt(
  effectiveCwd, false, undefined, undefined, x, y, w, h,
);

if (forkedMessages.length > 0) {
  try {
    await forkSessionJsonl(sessionId, newPanel.terminalId, effectiveCwd, msgIdx); // 1422
  } catch (err) {
    console.warn("[fork] forkSessionJsonl failed — falling back to --fork-session:", err);
  }
}

store.createSession(newPanel.terminalId);            // 1429
if (forkedMessages.length > 0) {
  store.loadFromDisk(newPanel.terminalId, forkedMessages); // 1431
}
store.setCwd(newPanel.terminalId, effectiveCwd);     // 1433
```

Two things are missing for Codex:

1. **`createSession(newPanel.terminalId)`** is called with no `provider`
   argument. `claudeStore.ts:139-146` declares `provider?: ProviderId`, and
   `claudeStore.ts:423` resolves
   `seededProvider = provider ?? meta?.provider ?? "anthropic"`. Because the
   forked id is brand-new, `loadMetadata` returns nothing → the new session
   is locked to `"anthropic"`.
2. **`forkSessionJsonl`** (`src/lib/tauriApi.ts:242` → `src-tauri/src/lib.rs:1602`)
   is hard-wired to Anthropic JSONL: it copies a file out of
   `~/.claude/projects/<hash>/<parentSessionId>.jsonl`, walks `parent_uuid`
   chains, and truncates. Codex rollouts live under
   `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` and have no
   parent-uuid chain — the call would 404 on the parent path.

The send path at `ClaudeChat.tsx:863-876` also encodes the Anthropic-only
strategy: `forkParentSessionId` triggers `--fork-session <parentId>` on a
Claude `--resume`. Codex CLI has no equivalent flag (`codex exec resume`
takes only `<thread_id>` and reuses the same rollout, append-only).

## (b) Why it fails for Codex

The clone shows `provider="anthropic"` because of issue (1) above; the first
prompt then breaks because `ClaudeChat.handleSend` dispatches via the
Anthropic branch (`createClaudeSession` / `sendClaudePrompt` with
`fork_session: forkParent`), which spawns the `claude` CLI against a
non-existent JSONL in `~/.claude/projects/...`. There is no Codex fork
backend at all (`grep -i fork src-tauri/src/providers/codex.rs` → 0 hits).

## (c) What "fork" should mean for Codex

A Codex thread is a single append-only rollout owned by the CLI; it can be
resumed but not branched. The reasonable contract is:

- Branch from message N with prior context preserved.
- Implementation: **mint a new T64-local UUID, start a fresh `codex exec`
  thread, and seed it with the parent's transcript up to message N rendered
  into the first prompt** (or pass it through the system prompt). The parent
  thread is left untouched. The new session's `codexThreadId` stays `null`
  until `thread.started` fires from the fresh `codex exec`.
- Optionally, retain `parentCodexThreadId` purely as metadata, so
  `load_codex_session_history(parentCodexThreadId)` can hydrate the UI's
  read-only history view without writing into the new rollout.

This matches the t3code shape: `effect-codex-app-server` exposes a
`thread/fork` RPC alongside `thread/start`, `thread/resume`, and
`thread/rollback` (see
`packages/effect-codex-app-server/src/_generated/meta.gen.ts`), confirming
fork is a first-class operation distinct from rollback (truncate-in-place)
and resume (continue same rollout).

## (d) Minimal fix

**Frontend — propagate provider (real bug):**

- `ClaudeChat.tsx:1429` — pass parent provider + codexThreadId:
  `store.createSession(newPanel.terminalId, undefined, false, undefined,
  effectiveCwd, sess.provider);` and, for Codex, also call
  `store.setCodexThreadId(newPanel.terminalId, null)` (already null by
  default — be explicit if a "parent thread id" field is added later).

**Frontend — branch by provider in `handleFork`:**

- Wrap `forkSessionJsonl` (line 1422) and the `--fork-session` first-send
  path (`ClaudeChat.tsx:863-876`) in `if (sess.provider === "anthropic")`.
- For `provider === "openai"`, skip the JSONL copy entirely; instead,
  serialize `forkedMessages` (already prepared at line 1403) into a
  prefix string and stash it on the new session — e.g. extend
  `claudeStore` with `seedTranscript: ChatMessage[] | null` analogous to
  `resumeAtUuid`, consumed once on the first `createCodexSession` call so
  the prefix is prepended to the user prompt (or wired into Codex's system
  prompt by `CodexAdapter` in `src-tauri/src/providers/codex.rs`).

**Store — accept fork metadata:**

- `claudeStore.ts:185` `setForkParentSessionId` is Anthropic-only; add
  `setSeedTranscript(sessionId, msgs)` and a corresponding field at
  `claudeStore.ts:111` near `forkParentSessionId`. `createSession` already
  threads `provider` through (line 423) — no signature change needed.

No backend change is required for the provider-propagation fix; the seed-
transcript fork strategy is additive and lives entirely in the existing
Codex send path.
