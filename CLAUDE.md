# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Terminal 64 is a canvas-based terminal emulator built with Tauri v2 (Rust backend) + React 19 (TypeScript frontend) + xterm.js. It manages multiple terminal sessions and Claude Code agent sessions simultaneously on a free-form pan/zoom canvas.

## Build & Development Commands

```bash
npm install              # Install Node dependencies (first time / after package.json changes)
npm run tauri dev        # Start dev mode (Vite on port 1420 + Rust backend with hot reload)
npm run tauri build      # Production build (outputs native executable + installer)
npm run dev              # Frontend-only dev server (no Rust backend)
npm run build            # Frontend-only production build to dist/
```

Rust-specific (from `src-tauri/`):
```bash
cargo check              # Type-check Rust code without building
cargo build              # Build Rust backend only
cargo clippy             # Lint Rust code
```

**Prerequisites**: Rust stable (1.77.2+), Node.js v18+, Xcode CLI tools on macOS, VS Build Tools (C++ workload) on Windows.

## Architecture

### Two-Process Model

The app runs as a Tauri desktop application with two main processes:

1. **Rust backend** (`src-tauri/src/`) — PTY lifecycle, Claude CLI process management, Discord bot, permission server. All state lives in `AppState` (defined in `lib.rs`) which holds the four managers behind `Arc`/`Mutex`.

2. **React frontend** (`src/`) — Canvas UI, terminal rendering via xterm.js + WebGL, settings, command palette, Claude chat interface.

### Frontend → Backend Communication

- Frontend calls backend via `invoke("command_name", { params })` (Tauri IPC) — wrappers in `src/lib/tauriApi.ts`
- Backend pushes data to frontend via `app_handle.emit("event-name", payload)` — listened to with Tauri event listeners
- All IPC types are defined in `src-tauri/src/types.rs` (Rust, serde) and `src/lib/types.ts` (TypeScript)

### Rust Backend Modules (`src-tauri/src/`)

| Module | Purpose |
|---|---|
| `lib.rs` | Entry point, `AppState` struct, all `#[tauri::command]` handlers, Tauri plugin setup |
| `pty_manager.rs` | Creates/manages PTY instances via `portable-pty`, reads output in spawned threads |
| `claude_manager.rs` | Spawns Claude CLI as subprocess with `--output-format stream-json`, streams parsed responses |
| `discord_bot.rs` | Optional Discord bot that links Claude sessions to Discord threads via WebSocket gateway |
| `permission_server.rs` | TCP server on dynamic port handling Claude CLI tool permission requests |
| `types.rs` | Shared serde structs for IPC payloads |

### Frontend Structure (`src/`)

| Directory | Purpose |
|---|---|
| `components/canvas/` | Canvas layout engine — `Canvas.tsx` (pan/zoom/spawn), `FloatingTerminal.tsx` (draggable terminal windows), `PopOutTerminal.tsx` (detached native windows) |
| `components/terminal/` | `XTerminal.tsx` — xterm.js wrapper handling PTY data events, resize, WebGL rendering |
| `components/claude/` | Chat UI for Claude sessions — `ClaudeChat.tsx`, `ChatMessage.tsx`, `ChatInput.tsx` |
| `components/command-palette/` | `CommandPalette.tsx` — Ctrl+Shift+P command search/execute |
| `components/settings/` | `SettingsPanel.tsx` — UI for all user preferences |
| `stores/` | Zustand stores: `canvasStore` (layout), `claudeStore` (sessions), `settingsStore` (prefs), `themeStore` (theme) |
| `hooks/` | `useKeybindings.ts` (global keyboard handler), `useClaudeEvents.ts` (event listeners), `useTheme.ts` |
| `lib/` | Utilities: `tauriApi.ts` (IPC wrappers), `commands.ts` (command registry), `keybindingEngine.ts`, `themeEngine.ts`, `types.ts` |
| `themes/` | JSON theme definitions (8 built-in themes) |

### Key Patterns

- **State management**: Zustand stores with auto-save to localStorage every 5 seconds for session persistence
- **Terminal I/O flow**: `PtyManager` spawns PTY → reads output in a dedicated thread → emits `terminal-output-{id}` event → `XTerminal.tsx` writes to xterm.js instance
- **Claude session flow**: `ClaudeManager` spawns CLI process → streams JSON from stdout → emits `claude-output-{id}` events → `ClaudeChat.tsx` renders messages. Permission requests route through `PermissionServer` (TCP)
- **Keybindings**: Global `keydown` listener dispatches to command registry. Treats Cmd as Ctrl for macOS compatibility
