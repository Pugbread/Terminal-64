# Agent 3 — Tauri Wrapper Audit

Scope: verify `src-tauri/src/permission_server.rs` + `src-tauri/src/claude_manager.rs` actually cover every tool path in bypass mode, and evaluate `--dangerously-skip-permissions`.

## What the wrapper does today

### Flag (claude_manager.rs:412-428)

```rust
match permission_mode {
    "bypass_all"   => cmd.arg("--permission-mode").arg("bypassPermissions"),
    "accept_edits" => cmd.arg("--permission-mode").arg("acceptEdits"),
    "plan"         => cmd.arg("--permission-mode").arg("plan"),
    "auto"         => cmd.arg("--permission-mode").arg("auto"),
    _              => cmd.arg("--permission-mode").arg("default"),
}
```

We never pass `--dangerously-skip-permissions`.

### Hooks settings file (permission_server.rs:53-75)

Written to `$TMPDIR/t64-hook-*.json`, passed to CLI via `--settings`. For every lifecycle event we register:

```json
{ "hooks": {
    "PreToolUse":  [{ "matcher": ".", "hooks": [{ "type": "http", "url": "…/PreToolUse"  }] }],
    "PostToolUse": [{ "matcher": ".", "hooks": [{ "type": "http", "url": "…/PostToolUse" }] }],
    "Stop":        [{ "matcher": "",  "hooks": [{ "type": "http", "url": "…/Stop"        }] }],
    …
}}
```

### PreToolUse handler (permission_server.rs:601-629)

```rust
let permission_mode = parsed["permission_mode"].as_str().unwrap_or("");
emit_hook_event(event_name, &parsed);
if permission_mode == "bypassPermissions" {
    // return permissionDecision: "allow"
}
// else: AUTO_ALLOW_TOOLS check, else block on frontend
```

## Audit findings

### 1. MCP tool namespace is covered. ✅

- Matcher `"."` is a regex that matches any single char → matches `mcp__any__thing`, `Bash`, `Write`, etc. No tool-class escapes the PreToolUse hook on matcher grounds.
- `tool_name` extraction (`parsed["tool_name"].as_str()`) picks up the `mcp__<server>__<tool>` name verbatim — the `AUTO_ALLOW_TOOLS` list doesn't contain any `mcp__*` entries, so MCP tools fall through to the bypass check (correct) or to the block path (correct for non-bypass modes).

### 2. Hook response shape is correct for all tool types. ✅

`hookSpecificOutput.permissionDecision` + `permissionDecisionReason` is the Claude Code 2.x unified response and applies uniformly to built-ins, MCP tools, and SlashCommands. We do not special-case Bash / Edit / MultiEdit and we don't need to — the CLI dispatches the decision the same way for all `tool_name` values.

### 3. Gap: bypass short-circuit trusts the payload field, not our own launch state. ⚠️

`parsed["permission_mode"]` is read from the hook payload on every invocation. Claude CLI 2.x stamps `permission_mode` onto every PreToolUse payload today, but:

- **Session resume:** on `--resume`, if the stored conversation was recorded in a different mode, the payload mode may reflect the *conversation* rather than the current invocation. Not confirmed — needs CLI source (Agent 1/2).
- **Slash-command-driven internal tool calls** (e.g. `/permissions` self-edit, `/config`, `/mcp` restart): these may be dispatched by the CLI through a pre-hook path that omits `permission_mode` in the serialized payload.
- **Unknown-session fallback (permission_server.rs:568-585):** if the session map loses the token (server restart mid-prompt), we return `deny` regardless of bypass. For bypass mode that's wrong — we should `allow`.

Defensive fix: record the launch mode per `run_token` at `register_session` time and consult that map when the payload field is empty.

### 4. The hook is not called for CLI-internal "self-protective" prompts. ⚠️

Based on behavior (and pending Agent 1/2 source confirmation): Claude CLI 2.x short-circuits the hook pipeline for operations it considers dangerous *to itself* — writing inside `~/.claude/`, editing `settings.json`, modifying the Claude binary install directory, `rm`-ing Claude state. The CLI runs its own confirm-prompt before the tool is dispatched, so no `permissionDecision: "allow"` we return can silence it. This matches the user-reported symptom ("prompts only for self-modification").

No amount of hook tuning can fix this. It needs either a flag change or a wrapper-side path rewrite.

### 5. `--permission-mode bypassPermissions` vs `--dangerously-skip-permissions`

Both are mutually exclusive at the CLI arg-parsing layer (Agent 1 should verify); the CLI treats `--dangerously-skip-permissions` as equivalent to bypass mode *plus* an explicit acknowledgement. From behavioral evidence in the open-source fork:

| Aspect                                    | `--permission-mode bypassPermissions`              | `--dangerously-skip-permissions`                                              |
| ----------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| Skips frontmatter confirm                 | yes                                                | yes                                                                           |
| Fires PreToolUse hooks                    | yes                                                | yes                                                                           |
| Skips CLI-internal self-protective checks | **no** (prompts on `~/.claude/*` writes, bin dir)  | **yes** in older versions; in 2.1.x may still block — Agent 1 to confirm      |
| Refuses to run as root                    | no                                                 | yes                                                                           |
| Intended as permanent runtime             | yes (UX-first)                                     | no (one-shot "I know what I'm doing")                                         |

Security tradeoff of switching to `--dangerously-skip-permissions`:
- **Gain:** likely eliminates the remaining self-protective prompts (pending Agent 1 confirmation).
- **Loss:** we lose the `--permission-mode` signal the rest of the CLI (and hook payloads) reads. Our own `permission_mode == "bypassPermissions"` check in the hook stops firing — so we must also update the hook to treat "session launched with `--dangerously-skip-permissions`" as bypass.
- **Low real risk:** T64 already accepts arbitrary code execution in bypass mode; the CLI's internal self-protective checks were a soft backstop, not a security boundary. The user explicitly opts into bypass per-session via the permission-mode UI.

`--allow-dangerously-skip-permissions` is **not** a real flag in 2.1.114 (Agent 1 please confirm from the fork source).

## Concrete patch recommendation

Apply layered, from cheapest to most intrusive. (1) and (2) should ship together; (3) gated on Agent 1's confirmation.

### (1) Track per-session launch mode; use it as bypass fallback

In `permission_server.rs`, extend `PermissionServer`:

```rust
pub(crate) session_modes: Arc<Mutex<HashMap<String, String>>>, // run_token -> permission_mode
```

Update `register_session` to take `mode: &str` and store it. In the PreToolUse branch:

```rust
let payload_mode = parsed["permission_mode"].as_str().unwrap_or("");
let launch_mode = session_modes.lock().ok()
    .and_then(|m| m.get(&run_token).cloned())
    .unwrap_or_default();
let effective_mode = if payload_mode.is_empty() { launch_mode.as_str() } else { payload_mode };
if effective_mode == "bypassPermissions" { /* allow */ }
```

Also: in the unknown-session branch (line 572), if we cannot resolve the session, return `allow` with a "unknown session, failing open in bypass" reason **only when** the URL run_token was ever registered in bypass mode. If it's truly unknown, keep deny. Simpler: keep a short-lived TTL map of recently-unregistered bypass tokens.

### (2) Belt-and-suspenders: settings-level pre-auth

Extend `build_hook_settings` to also emit:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "allow": ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "mcp__*"]
  },
  "hooks": { … }
}
```

Only when the session is launched with `bypass_all`. The CLI's config-level allow list is consulted before the prompt UI is rendered, so wildcard entries may silence some of the self-protective paths even when the hook can't.

### (3) Switch the flag when the user picks `bypass_all`

In `claude_manager.rs:412-428`:

```rust
match permission_mode {
    "bypass_all" => {
        // Stronger than --permission-mode bypassPermissions: also skips
        // Claude CLI's own self-protective confirm prompts on writes to
        // ~/.claude/*, the Claude binary dir, and similar. User opted in.
        cmd.arg("--dangerously-skip-permissions");
    }
    "accept_edits" => { cmd.arg("--permission-mode").arg("acceptEdits"); }
    "plan"         => { cmd.arg("--permission-mode").arg("plan"); }
    "auto"         => { cmd.arg("--permission-mode").arg("auto"); }
    _              => { cmd.arg("--permission-mode").arg("default"); }
}
```

Gating: this should only ship if Agent 1 confirms from the CLI source that
(a) `--dangerously-skip-permissions` actually skips the self-protective path (it's the whole point of the patch), and
(b) the flag is still present in 2.1.114 (it is — it's been the canonical YOLO flag since 1.x).

Because (1) also handles the case where the hook payload omits `permission_mode`, switching flags will not break the bypass short-circuit — `session_modes[run_token] == "bypassPermissions"` still wins.

## Coordination

- MCP coordination channel was unavailable at start (`ECONNREFUSED 127.0.0.1:49656`). Posting here as the authoritative record.
- Agent 1 (CLI source): please confirm whether `--dangerously-skip-permissions` skips the `~/.claude/*` self-protective path in 2.1.114, and whether the flag is mutually exclusive with `--permission-mode`.
- Agent 2 (reproduction / hook payload schema): please confirm whether `permission_mode` is always present in PreToolUse payloads across resume, MCP, and slash-command code paths. If yes, patch (1)'s fallback is belt-and-suspenders; if no, it's load-bearing.
