# Memory

> Chronological action log. Hooks and AI append to this file automatically.
> Old sessions are consolidated by the daemon weekly.

| Time | Description | File(s) | Outcome | ~Tokens |
|------|-------------|---------|---------|---------|
| 2026-04-16 | Enhanced RewindPromptDialog with git-style line stats (+/-), generate description via Haiku | ClaudeChat.tsx, ClaudeChat.css, lib.rs | Complete, compiles clean | ~500 |
| 2026-04-16 | Fixed rewind "undo send" bug — rewinding to last user msg no longer reverts files | ClaudeChat.tsx | Complete, compiles clean | ~200 |

| Time | Description | File(s) | Outcome | ~Tokens |
|------|------------|---------|---------|---------|
| 22:15 | Verified hook matcher fix compiles | permission_server.rs | cargo check clean | ~200 |
| 22:15 | Copied project-intel widget files to ~/.terminal64 | main.js, index.html, styles.css | synced | ~50 |
| 14:20 | rewrote streaming beam to use offset-path traveling dot + opacity fade-out | ClaudeChat.css, ChatInput.tsx | clean | ~800 |
| 14:44 | replaced beam dots with SVG rect + stroke-dashoffset (3-layer glow/mid/core) | ChatInput.tsx, ClaudeChat.css | clean | ~1200 |
| 15:22 | Windows compat pass: fixed 15 Windows bugs (node/openwolf/pm2/git/symlinks/zip-traversal/paths) | lib.rs,claude_manager.rs,discord_bot.rs,tauri.conf.json,ChatInput.tsx,ClaudeChat.tsx,tauriApi.ts | clean typecheck | ~8000 |
