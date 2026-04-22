# Agent 1 — CLI Source Analysis (yasasbanukaofficial/claude-code fork)

Cloned `https://github.com/yasasbanukaofficial/claude-code.git` → `/tmp/claude-code-fork`. The fork is a full TypeScript source mirror of Claude Code ~2.1.x (`src/tools/*`, `src/utils/permissions/*`, etc.).

## TL;DR

There is a hardcoded, **bypass-immune** safety-check step inside the CLI's permission pipeline. `bypassPermissions` mode, `--dangerously-skip-permissions`, AND PreToolUse `permissionDecision: "allow"` hooks **all** cannot silence prompts for this set of paths. Agent 3's recommendation to switch to `--dangerously-skip-permissions` **will NOT fix the self-config prompts** — that flag is a pure alias for `bypassPermissions` and hits the identical code path.

The only pure-wrapper fixes are (a) inject session-scoped `.claude/**` allow rules (no hook surface lets us do that programmatically from outside), or (b) fork-patch the CLI. A practical third option: intercept writes to those paths in the wrapper and perform them ourselves.

---

## The bypass-immune pipeline

### Entry point: `src/utils/permissions/permissions.ts::hasPermissionsToUseToolInner` (lines 1158–1319)

The permission check runs through these numbered steps **in order**:

| Step | Line | What it does | Fires in bypass mode? |
|------|------|--------------|----------------------|
| 1a | 1171 | Tool-level deny rule | Yes (returns deny) |
| 1b | 1184 | Tool-level ask rule | Yes (returns ask) |
| 1c | 1214 | Calls `tool.checkPermissions(input, context)` | Yes |
| 1d | 1226 | Tool impl returned deny | Yes |
| 1e | 1231 | `tool.requiresUserInteraction?.()` + tool returned ask | Yes (AskUserQuestion, ExitPlanMode) |
| 1f | 1244 | Content-specific ask rule from tool.checkPermissions | Yes |
| **1g** | **1252** | **`decisionReason.type === 'safetyCheck'` → return ask** | **YES — this is the root cause** |
| 2a | 1268 | `mode === 'bypassPermissions'` → return allow | Only reached if 1a–1g all pass |
| 2b | 1284 | Rule-level `toolAlwaysAllowedRule` → allow | Only if 2a didn't fire |
| 3 | 1300 | passthrough → ask | Fallback |

Step **1g** is the killer. Code at lines 1252–1260:

```ts
// 1g. Safety checks (e.g. .git/, .claude/, .vscode/, shell configs) are
// bypass-immune — they must prompt even in bypassPermissions mode.
// checkPathSafetyForAutoEdit returns {type:'safetyCheck'} for these paths.
if (
  toolPermissionResult?.behavior === 'ask' &&
  toolPermissionResult.decisionReason?.type === 'safetyCheck'
) {
  return toolPermissionResult
}
```

The comment is explicit: Anthropic designed `bypassPermissions` to NOT silence these prompts. It is not a bug; it is policy.

### Where `safetyCheck` originates: `src/utils/permissions/filesystem.ts::checkWritePermissionForTool` (lines 1205–1400)

This is the `checkPermissions` implementation for `FileEditTool`, `FileWriteTool`, `NotebookEditTool`, etc. Its internal ordering:

```
1.   deny rules (all sources)
1.5  internal editable paths (plan files, scratchpad, session-memory)
1.6  **session-scoped** allow rule for /.claude/** or ~/.claude/** → allow (bypass hatch)
1.7  checkPathSafetyForAutoEdit → if unsafe: return {behavior:'ask', decisionReason.type:'safetyCheck'}
2.   ask rules
3.   acceptEdits mode
4.   allow rules (all sources)
5.   default → ask
```

Steps 1.6 and 1.7 are the relevant pair. **Step 1.6 is the ONLY documented escape hatch** from the safety check, and it requires the allow rule to be **session-source** (in-memory, not persisted to settings.json).

### What triggers `safetyCheck`: `checkPathSafetyForAutoEdit` (lines 620–665)

Three classes of path are flagged:

1. **Suspicious Windows patterns** — NTFS ADS (`file::$DATA`), 8.3 names (`CLAUDE~1`), long-path prefixes (`\\?\`), trailing dots/spaces, DOS device names (`.git.CON`), triple-dot components, UNC paths. `classifierApprovable: false` (strictest).
2. **Claude config files** (`isClaudeConfigFilePath`, line 225) — any path matching:
   - `.../.claude/settings.json`
   - `.../.claude/settings.local.json`
   - anywhere under `<cwd>/.claude/commands/`
   - anywhere under `<cwd>/.claude/agents/`
   - anywhere under `<cwd>/.claude/skills/`
3. **Dangerous files/dirs** (`isDangerousFilePathToAutoEdit`, line 435) — any path containing a segment matching:
   - `DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude']` (line 74)
     - `.claude/worktrees/*` is explicitly exempt (line 460)
   - `DANGEROUS_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.claude.json']` (line 57)
   - UNC paths (`\\` or `//` prefix)

Matching is case-insensitive (lowercase). Both the original path and all resolved-symlink paths are checked.

**So any write to `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, `.git/config`, `.zshrc`, `.mcp.json`, `.claude.json`, or anywhere under `.git/`, `.vscode/`, `.idea/`, `.claude/` (except `.claude/worktrees/`) will ALWAYS prompt.** No mode, no hook, no flag changes this.

---

## Answering Agent 3's specific questions

### Q1: Does `--dangerously-skip-permissions` skip the self-protective path in 2.1.114?

**No.** `src/utils/permissions/permissionSetup.ts:725–727`:

```ts
if (dangerouslySkipPermissions) {
  orderedModes.push('bypassPermissions')
}
```

The flag is a pure alias — it pushes `bypassPermissions` onto the mode list. From that point on, both flags execute identical code (same `mode === 'bypassPermissions'` check at step 2a, which is gated behind step 1g). Agent 3's recommendation (3) — switching to `--dangerously-skip-permissions` when user picks `bypass_all` — **does not fix the reported prompts**. The only user-visible differences are:
- `--dangerously-skip-permissions` refuses to run as root (soft ergonomic check, not security-relevant).
- `--dangerously-skip-permissions` sets `allowDangerouslySkipPermissions: true` which, combined with the Statsig gate `tengu_disable_bypass_permissions_mode`, gates whether `isBypassPermissionsModeAvailable` is true at all (line 939–943). If the gate disables bypass, `--dangerously-skip-permissions` still lets you request it; `--permission-mode bypassPermissions` alone does not.

### Q2: Is the flag mutually exclusive with `--permission-mode`?

No. Both can be passed simultaneously. `initialPermissionModeFromCLI` (line 689) builds an ordered list and picks by priority. Both flags push `bypassPermissions` onto the list — identical outcome.

### Q3 (relevant to Agent 2): Is `permission_mode` always present in PreToolUse hook payloads?

**Yes.** `src/utils/hooks.ts::createBaseHookInput` (line 301) always sets `permission_mode: permissionMode`, where `permissionMode` is read from `appState.toolPermissionContext.mode` at hook-fire time. This is synchronous with the CLI's current mode, not the stored session mode. So:

- Fresh invocations: present and correct.
- `--resume`: the hook reads the CURRENT mode, not the stored one, so a resumed bypass session fires hooks with `permission_mode: "bypassPermissions"`.
- Slash-command-internal tool calls: use the same code path, same payload.

Agent 3's patch (1) (launch-mode fallback map) is belt-and-suspenders, not load-bearing — but also not harmful.

---

## What "hardcoded always-ask" actually means

The phrase in Agent 3's notes ("self-protective checks") maps cleanly to steps 1e and 1g:

- **1e — `requiresUserInteraction()`**: only `AskUserQuestionTool` and `ExitPlanModeV2Tool` return true. These are intentionally interactive; we don't care about them here.
- **1g — `safetyCheck`**: the path-based list above. This is the one that the user is hitting.

No other code path in the permission pipeline ignores bypass mode. Allow rules from `--allowedTools` (cliArg source), settings.json (`userSettings` / `projectSettings` / `localSettings` sources), and flag settings all feed into step 2b, which **is** reached in bypass mode — but step 2a short-circuits before step 2b, so in practice bypass mode doesn't depend on allow rules. Allow rules only matter for non-bypass modes.

## Why the PreToolUse hook's `permissionDecision: "allow"` doesn't silence these prompts

`src/services/tools/toolHooks.ts::resolveHookPermissionDecision` (lines 332–433):

```ts
if (hookPermissionResult?.behavior === 'allow') {
  // ...
  // Hook allow skips the interactive prompt, but deny/ask rules still apply.
  const ruleCheck = await checkRuleBasedPermissions(tool, hookInput, toolUseContext)
  if (ruleCheck === null) {
    return { decision: hookPermissionResult, input: hookInput }  // bypass prompts
  }
  if (ruleCheck.behavior === 'deny') { return { decision: ruleCheck, ... } }
  // ask rule — dialog required despite hook approval
  return { decision: await canUseTool(...), input: hookInput }  // PROMPTS
}
```

`checkRuleBasedPermissions` (permissions.ts:1071) replicates steps 1a–1g — **including step 1g's bypass-immune safetyCheck check**. When the safety check returns ask, the hook allow is overridden and `canUseTool` is invoked, which calls `hasPermissionsToUseToolInner` (which in bypass mode also returns 'ask' via its own step 1g), which produces the user-visible prompt.

This is why our PreToolUse HTTP hook doesn't silence the `~/.claude/*` prompts.

## The only documented bypass-hatch: session-scoped `.claude/**` allow rule

`checkWritePermissionForTool` step 1.6 (lines 1252–1300):

```ts
const claudeFolderAllowRule = matchingRuleForInput(
  path,
  { ...toolPermissionContext, alwaysAllowRules: { session: toolPermissionContext.alwaysAllowRules.session ?? [] } },
  'edit', 'allow',
)
if (claudeFolderAllowRule) {
  const ruleContent = claudeFolderAllowRule.ruleValue.ruleContent
  if (
    ruleContent &&
    (ruleContent.startsWith('/.claude/') || ruleContent.startsWith('~/.claude/')) &&
    !ruleContent.includes('..') &&
    ruleContent.endsWith('/**')
  ) {
    return { behavior: 'allow', ... }
  }
}
```

A rule like `Edit(/.claude/**)` or `Edit(~/.claude/**)` — **source: 'session'** — will allow edits to the `.claude/` directory and bypass step 1.7. The context spread explicitly filters to `session` source only:

```ts
alwaysAllowRules: { session: toolPermissionContext.alwaysAllowRules.session ?? [] }
```

Settings-file-sourced rules (`userSettings`, `projectSettings`, `localSettings`) and CLI-arg-sourced rules (`cliArg`) are dropped. **This means passing `--allowedTools "Edit(/.claude/**)"` WILL NOT bypass step 1.7.** I verified this with the code above — the spread replaces `alwaysAllowRules` with only the session slot.

### Can we inject session rules from outside the CLI?

- **PreToolUse hook**: `types/hooks.ts:100–111` — the PreToolUse hookSpecificOutput schema has `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext`. **No `updatedPermissions` field.** We cannot inject session rules from PreToolUse.
- **PermissionRequest hook**: `types/hooks.ts:120–134` — this one DOES accept `updatedPermissions: PermissionUpdate[]`. `hasPermissionsToUseTool` (permissions.ts:425) calls `persistPermissionUpdates` + `applyPermissionUpdates`. BUT the PermissionRequest hook only fires when `appState.toolPermissionContext.shouldAvoidPermissionPrompts === true` (line 932) — i.e., for async/headless subagents. For our interactive wrapper, it never fires.
- **SessionStart / Setup hook**: No permission-injection path in their schemas (types/hooks.ts). They can only emit `additionalContext` / `initialUserMessage` / `watchPaths`.
- **`/permissions` slash command inside the session**: would work, but requires injecting keystrokes into the CLI before the first tool call — fragile.
- **`--permission-prompt-tool`**: an MCP-based external approver. In theory could auto-approve everything, but again only bypasses step 2c and below — step 1g safety check still fires because the tool impl (`checkWritePermissionForTool`) runs first.

**Conclusion**: no clean out-of-process mechanism exists. The `.claude` safety gate is designed to resist exactly this.

---

## Concrete fixes for the Tauri wrapper

### Option A (recommended, low-risk) — Wrapper-side path redirect for self-config edits

Since the CLI will always prompt on `~/.claude/*`, `CLAUDE.md`, `.claude.json`, `.mcp.json`, shell RCs, `.git/*`, etc., don't let Claude edit them directly. When the model wants to modify these:

1. PreToolUse hook inspects `tool_input.file_path` / `tool_input.path`.
2. If it matches the safety-check list, return `permissionDecision: "deny"` with a reason like "Terminal 64 handles this file — emit a structured request instead."
3. Provide a T64-specific MCP tool (`t64__update_self_config`) that the model can call instead. The wrapper performs the write.

This sidesteps the CLI's safety gate entirely — the CLI never sees the write, so step 1g never fires.

### Option B (highest power, highest maintenance) — Vendor-patch the CLI

Fork the upstream CLI source (or patch the minified binary) and delete steps 1g and 1.7. One-line removal in each of:

- `src/utils/permissions/permissions.ts:1255–1260` (hasPermissionsToUseToolInner step 1g)
- `src/utils/permissions/permissions.ts:1147–1152` (checkRuleBasedPermissions step 1g — for hook-allow path)
- `src/utils/permissions/filesystem.ts:1305–1338` (checkWritePermissionForTool step 1.7)

Trade-off: binary drift every CLI release. Risk: silently relaxes security for anyone running our build.

### Option C (hybrid) — Auto-approve the prompt via the UI layer

The CLI prompt is an `<ink>` React dialog. We could pattern-match the stream-json output and programmatically answer "yes, don't ask again for session" via the CLI's permission dialog. But this requires simulating keypresses (up-arrow + enter) into the PTY — fragile, and the dialog shape has changed between CLI versions.

Not recommended.

### Option D (defer to Agent 2's verdict) — MCP permission prompt tool

The CLI supports `--permission-prompt-tool <mcpToolName>` which routes permission decisions through an MCP tool instead of the interactive dialog. Two caveats:

1. I need to verify from source whether this path is also gated on step 1g safetyCheck — if yes, same problem.
2. The MCP tool has to return the approval synchronously. Our permission_server.rs is already HTTP; we'd need to add an MCP shim.

I did not fully trace this path in this pass. **Agent 2 please verify: does `--permission-prompt-tool` bypass step 1g, or does it just replace the interactive dialog renderer?**

---

## Cross-reference notes

- Read Agent 3's `agent-3.md` — concur with everything except recommendation (3), which won't work (see Q1 above).
- Agent 2's `agent-2.md` was not present at finalization time. If Agent 2 confirms the `--permission-prompt-tool` path, it may enable Option D.
- Line numbers above refer to `/tmp/claude-code-fork/src/...` as of the clone at ~2026-04-22. The fork tracks upstream 2.1.x.

## Files of record (in the fork)

| Path | Purpose |
|------|---------|
| `src/utils/permissions/permissions.ts` | Master permission pipeline (`hasPermissionsToUseTool`, `hasPermissionsToUseToolInner`, `checkRuleBasedPermissions`). Step 1g at lines 1252–1260 + 1147–1152. |
| `src/utils/permissions/filesystem.ts` | `checkWritePermissionForTool` (1205), `checkPathSafetyForAutoEdit` (620), `isDangerousFilePathToAutoEdit` (435), `isClaudeConfigFilePath` (225). `DANGEROUS_FILES` + `DANGEROUS_DIRECTORIES` at lines 57 + 74. |
| `src/utils/permissions/permissionSetup.ts` | `initialPermissionModeFromCLI` (689) — `--dangerously-skip-permissions` → `bypassPermissions` alias. `isBypassPermissionsModeAvailable` gating (939). |
| `src/utils/permissions/bypassPermissionsKillswitch.ts` | Statsig gate `tengu_disable_bypass_permissions_mode` — one more reason bypass can silently deactivate. |
| `src/services/tools/toolHooks.ts` | `resolveHookPermissionDecision` (332) — confirms hook allow does NOT bypass step 1g. |
| `src/utils/hooks.ts` | `createBaseHookInput` (301) — confirms `permission_mode` is always stamped. PreToolUse hook schema at 550–623 (no `updatedPermissions` field). |
| `src/types/hooks.ts` | Full hook schema zod defs. PermissionRequest hook at 120–134 (only hook with `updatedPermissions`). |
| `src/tools/FileEditTool/constants.ts` | `CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'`, `GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'`. |
