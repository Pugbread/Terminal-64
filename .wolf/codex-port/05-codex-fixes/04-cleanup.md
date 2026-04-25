# 04 — Codex cleanup + parity-gap audit

Read-only audit. Punch list ordered by user-visible impact. Each item cites
file:line. Sibling reports own rewind (02), fork (03), and tool-call
persistence (01); I touch them only where they hide bugs in shared code.

## High — blocks Codex sessions

1. **Rewind kills the chat for Codex sessions.**
   `src/components/claude/ChatMessage.tsx:589–645` exposes `Rewind` for every
   message, no provider gate. `ClaudeChat.tsx:1175` `handleRewind` calls
   `truncateSessionJsonlByMessages(sessionId, ...)` (1211, 1275) and
   `findRewindUuid(sessionId, ...)` (1222, 1298) — both keyed by the T64
   UUID and rooted at `~/.claude/projects/...`. Codex history lives at
   `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` and is keyed
   by `codexThreadId`. The truncate command will silently no-op (or 404)
   and the next prompt will resume the *un-truncated* upstream rollout —
   the user thinks they rewound but didn't. Sibling 02 covers the fix.
   Action here: gate the menu in ChatMessage by `sessionProviderFor(...)`
   so the button doesn't render for openai until 02 lands.

2. **Fork creates an Anthropic clone of a Codex session.**
   `ClaudeChat.tsx:1396–1434` calls `forkSessionJsonl(...)` (Claude-only)
   then `canvasStore.addClaudeTerminalAt(...)` and `store.createSession(...)`
   — neither accepts a `provider` param (`canvasStore.ts:91–92, 273`;
   `claudeStore.ts:401`). The new panel defaults to anthropic and can't
   resume the Codex thread. Sibling 03 covers wiring; gate the menu item
   meanwhile.

3. **Topbar Permission picker is hard-coded to Anthropic.**
   `ClaudeChat.tsx:344, 500, 2498–2500` cycle through `PERMISSION_MODES`
   built from `PROVIDER_CONFIG.anthropic.permissions` regardless of
   `selectedProvider`. For openai sessions the chevrons display "ask
   permissions / accept_edits / bypass_all" — labels Codex doesn't
   understand — and `permMode.id` is sent into Codex flows nowhere
   (luckily `actualSend` at 806 ignores it for openai). The Codex preset
   selection lives in dead state at line 471 (`selectedCodexPermission`,
   read-only `useState` with no setter). The TODO at 469–470 acknowledges
   this. Net effect: Codex users cannot change sandbox/approval mid-session.

## Medium — UX polish

4. **MCP dropdown shows stale Anthropic data for Codex sessions.**
   `ClaudeChat.tsx:1962–2023` reads `session.mcpServers` (populated only
   from Claude's `system.init` event — `useClaudeEvents.ts:464`) and
   falls back to `listMcpServers(cwd)` which scans `~/.claude.json`.
   Codex MCP config lives in `~/.codex/config.toml [mcp_servers]`. For an
   openai session the dropdown either is empty or, worse, lists Claude's
   MCP servers as if they're connected. Hide for openai or add a
   `list_codex_mcp_servers` command.

5. **Hook log toggle is meaningless for Codex.**
   `ClaudeChat.tsx:2090–2099, 2153–2175` and the `claude-hook-*` listeners
   in `useClaudeEvents.ts:1069–1107` are wired to Claude's hook server.
   Codex emits no such events; the panel always reads "No hook events
   yet." Hide the toggle when `selectedProvider === "openai"`.

6. **Slash-command panel mixes Claude built-ins into Codex sessions.**
   `ClaudeChat.tsx:528–550` merges `t64Commands` + `listSlashCommands()`
   (reads `~/.claude/commands/...`) + `CLAUDE_BUILTIN_COMMANDS`. For
   Codex sessions `/compact`, `/clear`, `/model`, etc. silently fail on
   send. Filter by provider before merging.

7. **`/delegate` and `/loop` send the spawn prompt as a Claude prompt.**
   The delegate handler at `ClaudeChat.tsx:959–987` and orchestrator never
   look at `selectedProvider`; child sessions are always Claude. Document
   or block on Codex parents until properly supported.

8. **`actualSend`'s Codex branch retries `createCodexSession` on
   `sendCodexPrompt` failure (831–836).** Mirrors the Claude path but
   semantically wrong: a failed resume here will spawn a *new* thread,
   discarding the conversation. Codex `exec resume` failure should
   surface, not silently restart.

9. **Empty-state label is correct (line 2298), but `cc-loading`
   "Initializing..." (1937) and the "Code Session" dialog title
   (`ClaudeDialog.tsx:102`) are provider-agnostic.** Minor; flag only.

## Low — janitorial

10. **`CodexAdapter` trait impl is a stub graveyard** —
    `providers/codex.rs:556–674`: every async method returns
    `Err("...not implemented...")`. Only the inherent `create_session` /
    `send_prompt` / `cancel` / `close` are called from
    `lib.rs:413–440`. The trait impl exists solely so the registry's
    `Arc<dyn ProviderAdapter>` map (lib.rs:218, 4995–4996) compiles.
    Either delete the impl + the registry entry, or actually wire
    `start_session`/`send_turn`/`stop_session` and have lib.rs call the
    trait. Right now the registry is dead weight.

11. **`CodexAdapter.capabilities` field is dead** —
    `providers/codex.rs:442`, marked `#[allow(dead_code)]`. Set in `new()`,
    never read. Drop or expose via a topbar capability gate.

12. **Older-shape NDJSON aliases may be unreachable.**
    `useClaudeEvents.ts:906–919` (top-level `agent_message`,
    `agent_reasoning`) and 957–979 (`tool_use`/`tool_result`,
    `tool_call_begin`/`_end`) are documented as "older shape" fallbacks.
    `codex exec --json` 0.121.0 emits only `thread.*` / `turn.*` /
    `item.*`. Verify against current CLI; if confirmed dead, delete.

13. **`CodexItem.classifyCodexItem` (useClaudeEvents.ts:205–211)** treats
    every non-message non-reasoning item as `"tool"`. `todo_list`,
    `file_change`, `web_search` get generic tool-call rendering. Sibling
    01 likely needs to specialize these — coordinate.

14. **`is_codex_system_injected_user_text` (codex.rs:740–746)** filters
    only four prefixes (`<environment_context>`, `<permissions
    instructions>`, `<model_switch>`, `<user_instructions>`). Sample the
    rollouts in `~/.codex/sessions/` for additional injected tags before
    declaring this complete.

15. **`SendCodexPromptRequest` (types.rs:94–112) has no equivalent of
    Claude's `mcp_config`, `max_turns`, `max_budget_usd`,
    `no_session_persistence`, `disallowed_tools`, `resume_session_at`,
    `fork_session`** — correctly so for now, but `mcp_config` is the
    likely first add when item 4 is fixed. `peek_codex_rollout`
    200-line scan limit (914) is undocumented; add a comment.

16. **`actualSend` debug `console.log` calls (829, 834, 838, 869, 876,
    880, 882) and `[rewind] === REWIND START ===` block (1179–1392)**
    are noisy in production. Demote to `console.debug` or gate on a flag.

## Three concrete next-step delegations (each ≤500 LOC)

A. **Provider-aware permission UI + fork plumbing.**
   - In `canvasStore.ts:91–283` add an optional `provider` param to
     `addClaudeTerminal` / `addClaudeTerminalAt` and pass it through to
     `createSession`. Update `App.tsx:455–465` to forward it.
   - Replace `PERMISSION_MODES` constant (`ClaudeChat.tsx:344`) with a
     `providerPermModes = useMemo(() => PROVIDER_CONFIG[selectedProvider].permissions, ...)` pattern. Persist Codex selection in
     `settingsStore` as `codexPermission`; remove the dead
     `selectedCodexPermission` `useState` at 471. Wire `decodeCodexPermission`
     against the live selection in `actualSend`'s codex branch (810).
   - Estimate: ~250 LOC.

B. **Hide Claude-only chrome from Codex sessions + gate Rewind/Fork
   menu items.**
   - In `ChatMessage.tsx:642–647` accept a `provider` prop (or read from
     store) and render Rewind/Fork only when `provider === "anthropic"`.
   - In `ClaudeChat.tsx`: hide the MCP dropdown trigger (1968), the
     Hook-log toggle (2090), and filter `slashCommands` (550) when
     provider is openai. Localize the `cc-loading` and dialog title.
   - Estimate: ~150 LOC.

C. **Trim dead Codex code + retry semantics.**
   - Delete `CodexAdapter`'s ProviderAdapter trait impl
     (`providers/codex.rs:556–674`) and the `Arc<dyn ProviderAdapter>`
     entry in lib.rs (4988–5003) **or** finish wiring it. Pick one.
   - Drop the unused `capabilities` field (442) + `selectedCodexPermission`
     `useState` (ClaudeChat.tsx:471). Demote noisy `console.log`s.
   - Remove the `sendCodexPrompt` → `createCodexSession` fallback at
     ClaudeChat.tsx:831–836 (replace with explicit error toast) so a
     failed resume doesn't silently spawn a new thread.
   - Verify older NDJSON alias branches (useClaudeEvents.ts:906–919,
     957–979) against current `codex exec --json`; delete if dead.
   - Estimate: ~200 LOC, mostly deletions.

## t3code references

The user's brief points at https://github.com/pingdotgg/t3code
`apps/server/src/provider/` and `packages/effect-codex-app-server/`.
I cannot fetch the repo from this sandbox; the briefing already cites
their `REASONING_EFFORT_LABELS` (matched by `OPENAI_EFFORTS` in
`providers.ts:86–92`) and the principle of storing `threadId` distinctly
from `sessionId` (already done in `claudeStore.ts:122–127`). For items
4 (Codex MCP), 12 (current event schema), and 14 (full injected-tag
list), have the next agent quote t3code's
`packages/effect-codex-app-server/src/Codex.ts` and the
`apps/server/src/provider/codex` adapter directly before changing code.
