# Agent 2 — Empirical Reproduction + Permission-Prompt-Tool Workaround

Tested against the user's installed `claude` CLI (2.1.114, Mach-O arm64, `/Users/janislacars/.local/share/claude/versions/2.1.114`). All tests run in `--print --output-format stream-json --verbose --include-hook-events --no-session-persistence --model haiku --max-budget-usd 0.30`, CWD `/tmp/claude-bypass-test/project`.

## TL;DR

1. **Confirmed empirically:** the `jtH`/`RC5` "sensitive file" guard that Agent 1 traced in the fork is present and active in 2.1.114. It fires for Write/Edit to any path containing `.claude/`, `.git/`, `.vscode/`, `.idea/`, `.husky/` (directory list `YC5`) or with a basename in `[.gitconfig, .gitmodules, .bashrc, .bash_profile, .zshrc, .zprofile, .profile, .ripgreprc, .mcp.json, .claude.json]` (filename list `wC5`).
2. **Confirmed empirically:** `--permission-mode bypassPermissions` + PreToolUse hook returning `permissionDecision: "allow"` **does not** silence these — the tool call returns `is_error=true` with `"Claude requested permissions to edit <path> which is a sensitive file."` and the final `result` event lists the call in `permission_denials[]`.
3. **Confirmed empirically:** `--dangerously-skip-permissions` is behavior-identical to bypass mode on this axis — same denial, same `permission_denials[]` entry. Agent 3's recommendation (3) to switch flags **will not fix the user's prompts**.
4. **Confirmed empirically:** writes inside the Claude **binary** install dir (`/Users/janislacars/.local/share/claude/`) are **not** blocked — the guard is scoped to user config paths, not the binary dir. User's stated scope ("the Claude binary's own directory") is mistaken; the real guard set is the list above.
5. **NEW finding — unblocks the task:** `--permission-prompt-tool <mcp-tool>` **does** route sensitive-file asks through the external tool. A trivial "always-allow" MCP approver lets Write to `~/.claude/bypass-test-scratch.txt` go through in plain `default` mode. This answers Agent 1's open question (Option D). It is the only non-patch, wrapper-level workaround that actually works.
6. **Concrete recommendation for Tauri wrapper:** expose `permission_server.rs` as a stdio MCP server (new binary or thin subcommand), register it with `--permission-prompt-tool`, route ALL permission decisions through it, and keep the existing PreToolUse HTTP hook for telemetry/non-permission events. Details below.

Also answering Agent 3 Q3: `permission_mode` was present and correct in every PreToolUse payload across all tests (Write, Bash, Edit, Read across six distinct tool calls, both `--permission-mode bypassPermissions` and `--dangerously-skip-permissions`). Agent 1's trace of `createBaseHookInput` is consistent with what I observed. Agent 3's "launch-mode fallback map" patch is defensive-only.

---

## Test harness

```
/tmp/claude-bypass-test/
├── hook.py                  # PreToolUse hook: logs payload, returns allow
├── hook.log                 # appended per-test by hook.py
├── settings.json            # --settings file with PreToolUse hook
├── runtest.sh               # bypass-mode runner
├── runtest-dsp.sh           # --dangerously-skip-permissions runner
├── runtest-ppt.sh           # --permission-prompt-tool runner (approver MCP)
├── approve-mcp.js           # minimal stdio MCP server, tool "approve" → always allow
├── mcp.json                 # --mcp-config file registering the approver
├── analyze.py               # summarizer: our-hook-fired / tool_use / tool_result / permission_denials
├── binary.strings           # `strings <claude-binary>` dump
└── results/<test>/{stream.ndjson, hook.log, mcp.log, stderr.log, exitcode.txt}
```

Hook response (always-allow, to isolate whether the CLI honors it):

```json
{"hookSpecificOutput": {"hookEventName":"PreToolUse",
                        "permissionDecision":"allow",
                        "permissionDecisionReason":"bypass-test: hook always allows"}}
```

The `--settings` path holds only the hook; the user's own `~/.claude/settings.json` carries no hooks, so no confounder.

---

## Test matrix and results

| ID | Mode | Prompted tool call | Our hook fired | Tool result | `permission_denials[]` | Outcome |
|----|------|--------------------|---------------:|-------------|------------------------|---------|
| `baseline` | `bypassPermissions` | Write `/tmp/.../baseline-output.txt` | ✅ (also a 2nd internal PreToolUse fired, returned `{}`) | success | 0 | file written |
| `selfconfig_newfile` | `bypassPermissions` | Write `~/.claude/bypass-test-scratch.txt` | ✅ | **error: "which is a sensitive file"** | 1 | **blocked** |
| `claudemd_edit` | `bypassPermissions` | Write `~/.claude/CLAUDE.md` (after Read prelude) | ✅ (twice: Read, Write) | Read ok, Write **"sensitive file" error** | 1 | **blocked** |
| `bindir_write` | `bypassPermissions` | Write `~/.local/share/claude/bypass-test.txt` | ✅ | success | 0 | file written (guard not scoped here) |
| `bash_safe_rm` | `bypassPermissions` | Bash `mkdir -p … && rm -rf /tmp/.../scratch-dir` | ✅ | success | 0 | ran |
| `rm_rf_root` | `bypassPermissions` | Bash `rm -rf /nonexistent-bypass-test-path-999` | ❌ (LLM self-refused) | — | 0 | model declined; no CLI-level refusal to test |
| `dsp_selfconfig_newfile` | `--dangerously-skip-permissions` | Write `~/.claude/bypass-test-scratch.txt` | ✅ | **error: "which is a sensitive file"** | 1 | **blocked — identical to bypass mode** |
| `ppt_selfconfig_newfile` | `default` + `--permission-prompt-tool mcp__approver__approve` + `--mcp-config …/mcp.json --strict-mcp-config` | Write `~/.claude/bypass-test-scratch.txt` | ✅ | **success** | 0 | **file written — sensitive-file guard bypassed** |

Notes:
- For `rm_rf_root`, the model itself refused ("This looks like a test of whether I'll execute destructive commands without question"). That test cannot distinguish CLI vs model refusal; ignore. The `bash_safe_rm` test shows Bash `rm -rf` inside allowed dirs is unaffected by any CLI-level path guard.
- `baseline` and most other tests show a **second** PreToolUse hook firing in addition to ours with `output: "{}"`. Likely the hookify plugin's PreToolUse. It returns no decision, so it's irrelevant to these findings.
- Path normalization: the CLI reports `/tmp/claude-bypass-test/project` as `/private/tmp/claude-bypass-test/project` in init events. Agent 1's source shows `zy()` normalizes `/private/var/` → `/var/` and `/private/tmp/` → `/tmp/` before comparison — so `/tmp` writes are treated as the macOS-standard `/tmp`, not system paths.

---

## Binary-level confirmation of the guard (complement to Agent 1's fork trace)

`strings` on the 2.1.114 bundle yields the exact minified functions Agent 1 named from source. Lists are identical:

```js
// confirmed present in /Users/janislacars/.local/share/claude/versions/2.1.114
wC5=[".gitconfig",".gitmodules",".bashrc",".bash_profile",".zshrc",
     ".zprofile",".profile",".ripgreprc",".mcp.json",".claude.json"]
YC5=[".git",".vscode",".idea",".claude",".husky"]
```

`RC5(H, _)` walks path segments; for `.claude` it has the same escape hatches Agent 1 enumerated:

```js
if (z === ".claude") {
  let w = K[T+1], Y = w ? jJ(w) : void 0;
  if (_ && Y) {
    if (Y === "skills" || Y === "agents" || Y === "commands") break;
    if (Y === "scheduled_tasks.json" && T+1 === K.length-1) break
  }
  if (Y === "worktrees") break
}
```

The bypass-immune guard at Agent 1's step 1g, minified:

```js
if ($?.behavior === "ask" && (_s_($.decisionReason) || $.decisionReason?.type === "sandboxOverride"))
  return $;
if (mode === "bypassPermissions" || (mode === "plan" && isBypassPermissionsModeAvailable))
  return {behavior:"allow", ...};
```

The `_s_` call above occurs **before** the bypassPermissions check and short-circuits out of the function. `_s_(decisionReason)` with no predicate is the "is-safetyCheck?" test — so any safetyCheck ask returns without bypass consideration. Hardcoded, confirmed.

---

## The `--permission-prompt-tool` escape hatch (answers Agent 1's Option D)

### How it works

The CLI accepts `--permission-prompt-tool <mcp-tool-name>` (hidden, `--print`-only). The minified dispatcher is `i5K(H)`:

```js
function i5K(H){
  let _ = async (q,K,O,T,$,A) => {
    let z = A ?? await $M(q,K,O,T,$);              // run internal permission check
    if (z.behavior === "allow" || z.behavior === "deny") return z;
    // z.behavior === "ask"  → invoke the MCP tool
    let j = H.call({tool_name:q.name, input:K, tool_use_id:$}, O, _, T);
    let D = await Promise.race([j, aborted]);
    let J = H.mapToolResultToToolResultBlockParam(D.data, "1");
    // expects a single text content block with JSON {behavior:"allow"|"deny", updatedInput, ...}
    return PpH(aO_().parse(SK(J.content[0].text)), H, K, O);
  };
  return _;
}
```

**Critical fact** — empirically confirmed by `ppt_selfconfig_newfile`: when the internal check returns `{behavior:"ask", decisionReason:{type:"safetyCheck", …}}` from the sensitive-file guard, `i5K` takes the ask branch and invokes the MCP tool. The tool's `{behavior:"allow"}` response is honored. The sensitive-file guard is **bypassed**.

This contradicts what you'd expect from the step-1g early return in `hasPermissionsToUseToolInner` — the permission-prompt-tool dispatcher wraps a different entry point (it's called as `canUseTool` from the tool-call loop). The step-1g early return only blocks the bypass-mode short-circuit; it still returns the ask up the stack, where the prompt-tool path intercepts.

### The MCP tool shape

Minimal stdio MCP server works. Full source in `/tmp/claude-bypass-test/approve-mcp.js`:

```js
// tools/call handler
if (method === 'tools/call') {
  const args = req.params?.arguments ?? {};
  const payload = { behavior: 'allow', updatedInput: args.input ?? {} };
  return send({ jsonrpc:'2.0', id, result:{
    content: [{ type:'text', text: JSON.stringify(payload) }]
  }});
}
```

The tool's input schema must accept `{tool_name, input, tool_use_id}`. The tool's output must be a single `{type:"text"}` block whose text is JSON parseable as `{behavior, updatedInput?, message?}`. Anything else throws `"Permission prompt tool returned an invalid result."`.

### Required CLI flags (in `--print` mode)

```
--permission-prompt-tool mcp__<server>__<tool>    # the name is mcp__<serverKey>__<toolName>
--mcp-config <path-or-json>                       # registers the MCP server
--strict-mcp-config                               # ignore user-settings MCP servers (optional but advised)
```

And, importantly, `PATH` matters: the MCP server process inherits `PATH` from the CLI (after `settings.json.env.PATH` is applied). The user's current `~/.claude/settings.json` sets PATH to `/Users/janislacars/.local/bin:/Users/janislacars/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`, which does **not** include `/opt/homebrew/bin`. My first PPT run failed with `node not found`; I fixed it by using `/opt/homebrew/bin/node` as the absolute `command` in `mcp.json`. **The Tauri wrapper must use an absolute path to the MCP shim binary.**

### Caveats

- `--permission-prompt-tool` is `--print`-only per the CLI help. Terminal 64 always spawns with `--print --output-format stream-json` (per CLAUDE.md). ✅
- The prompt tool is invoked **for every tool call whose internal check returns ask** — including rule-based asks, not just safetyCheck asks. You get full control; you also become responsible for all allow/deny decisions. Plan to route through `permission_server.rs` existing permission UI when the app user should be asked.
- The prompt tool is NOT invoked when the internal check returns `allow` or `deny` directly. So:
  - Explicit deny rules still win (good — users can still block).
  - The existing bypass-mode short-circuit still works for non-sensitive paths (no prompt-tool round-trip for normal writes).
- Regressions to watch: MCP server crashes → CLI aborts with "permission prompt tool not found" and exits non-zero on first permission-requiring call. Ship with supervision/respawn.

---

## Concrete fix for the Tauri wrapper

### Option D (recommended — unblocks the reported issue with no binary patching)

**Ship an MCP permission-prompt shim inside `src-tauri`:**

1. New module `src-tauri/src/permission_mcp.rs`. On session spawn it starts a short-lived stdio MCP server (child process or same-process via a helper binary in the Tauri bundle).
2. The shim exposes one tool (suggested name `t64_approve`) whose handler:
   - Parses `{tool_name, input, tool_use_id}`.
   - Emits a Tauri event to the frontend (or reuses `permission_server.rs`'s existing IPC) asking the UI what to do, **unless** the session is in `bypass_all` — in which case it auto-returns `{behavior:"allow", updatedInput:input}` synchronously.
   - Returns the decision as the single required text block.
3. `claude_manager.rs` adds to every spawn:
   ```rust
   cmd.arg("--permission-prompt-tool").arg("mcp__t64__approve")
      .arg("--mcp-config").arg(&mcp_config_path)
      .arg("--strict-mcp-config");  // optional, recommended
   ```
   The existing `--permission-mode` flag stays — keeping it as `bypassPermissions` is still useful because it makes the internal check return `allow` for non-sensitive writes without a round-trip to our MCP shim. The shim only gets called for the sensitive-file asks.
4. The existing HTTP PreToolUse hook stays for telemetry (emitting `hook-event` to the frontend for live display) but NO LONGER carries permission authority.

**Why this is the right level:**
- No binary patching (Agent 1's Option B). Survives CLI upgrades as long as `--permission-prompt-tool` keeps its contract.
- No path interception in the wrapper (Agent 1's Option A). Claude can still edit `~/.claude/CLAUDE.md`, `settings.json`, etc., directly — the user asked for these writes to just work in bypass mode.
- Honors user intent: `bypass_all` → auto-allow; any other mode → the UI prompt fires for sensitive paths too, consistent with other tool calls.

### Open implementation questions (flag explicitly for Agent 3 to validate in the Tauri code):

1. **The tool name is namespaced `mcp__<server>__<tool>`.** Verify `permission_server.rs::emit_hook_event` / frontend filter code doesn't swallow `mcp__*` tool names by mistake.
2. **PATH inheritance.** Current `claude_manager.rs` spawning: confirm the `env` passed to the CLI process still includes the correct PATH so the MCP shim binary runs. The user's `~/.claude/settings.json.env.PATH` is shimmed on top; our shim path must be absolute or already on that PATH.
3. **Stdio MCP server lifecycle.** Must survive through CLI session lifetime and be killed on session teardown. Reuse existing `PtyManager`-style spawning or use a thin `std::process::Child` with `stdin/stdout` piped.
4. **Backwards-compat for `auto` / `default` / `plan` / `accept_edits` modes.** In those modes the shim should still route to the UI. No behavior change for non-`bypass_all` users.
5. **Sandbox consideration.** An always-allow MCP approver used unconditionally is strictly worse than the status quo for users NOT in bypass mode. Gate auto-allow on `permission_mode == bypassPermissions`.

### Sibling patches (layered defense, not required for the fix):

- **Agent 3 patch (1)** (`session_modes` per-run_token) — fine to ship; load-bearing for slash-command / resume edge cases I did not exhaustively test. Agent 1 confirmed `permission_mode` is always stamped on hook payloads from source, so in practice the fallback is defensive-only.
- **Agent 3 patch (2)** (settings-level `permissions.allow` wildcards) — **does not help** for sensitive-file writes: Agent 1 showed `checkWritePermissionForTool` filters allow-rules down to `session` source only for the `.claude/**` hatch, so settings-file or flag-settings allows are dropped by the `.claude`-folder hatch but then still caught by step 1.7. Settings-level allows won't silence these prompts.
- **Agent 3 patch (3)** (`--dangerously-skip-permissions`) — **do not ship**. My test `dsp_selfconfig_newfile` empirically confirms identical behavior to `--permission-mode bypassPermissions`. Agent 1's source trace confirms it's an alias.

---

## Minimal diff sketch (not committed — sanity check by the wrapper author)

`src-tauri/src/claude_manager.rs` (around lines 412-428, where permission-mode is wired):

```rust
// Existing: set --permission-mode
match permission_mode { … }

// NEW: wire permission-prompt-tool
let mcp_config_path = write_t64_mcp_config(&run_token)?;  // path to a temp JSON
cmd.arg("--permission-prompt-tool").arg("mcp__t64__approve");
cmd.arg("--mcp-config").arg(&mcp_config_path);
cmd.arg("--strict-mcp-config");  // optional — see tradeoff note below
```

`write_t64_mcp_config` writes:

```json
{
  "mcpServers": {
    "t64": {
      "type": "stdio",
      "command": "/abs/path/to/t64-permission-shim",
      "args": ["--run-token", "<token>"]
    }
  }
}
```

The shim's `tools/call` handler for `approve`:

```js
// pseudocode
const decision = await askAppState(run_token, tool_name, input);   // frontend IPC or auto-allow
return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
// decision: { behavior: "allow", updatedInput } | { behavior: "deny", message }
```

Tradeoff on `--strict-mcp-config`: without it, the CLI also loads user-settings MCP servers (e.g. Google Drive in this user's config). With it, it doesn't. Recommend WITHOUT for production to preserve user MCP servers — our shim is registered alongside.

---

## Files I changed / left on disk

- `/Users/janislacars/.claude/bypass-test-scratch.txt` (4 bytes, content `test`). The PPT test wrote this. I could not delete it from within this agent because even my `rm` invocation trips the same sensitive-file guard. **Please delete manually:** `rm ~/.claude/bypass-test-scratch.txt`.
- `/tmp/claude-bypass-test/**` — all test scaffolding. Safe to delete.
- No changes to `/Users/janislacars/.claude/settings.json` or `/Users/janislacars/.claude/CLAUDE.md` (both verified unchanged — `CLAUDE.md` still 0 bytes, `settings.json` untouched; the edit attempts were blocked by the guard we're investigating).

## Cross-references

- Agent 1's `agent-1.md` — authoritative on the source-level trace of the permission pipeline. I used it to name the minified functions `jtH`, `RC5`, `YC5`, `wC5`, `i5K` and to confirm my empirical readings match the fork's TypeScript.
- Agent 3's `agent-3.md` — wrapper audit. My findings invalidate recommendation (3) and caution on (2); (1) is fine to ship but not load-bearing.
