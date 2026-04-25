# Agent 2 — Paste Pipeline Audit

Scope: trace a paste from DOM → `onData` / custom key handler → `writeTerminal` → Rust `pty_manager::write`, and explain why the user sees missing, duplicated, or malformed pastes.

## Data flow (current)

1. Keyboard path — `Ctrl/Cmd+V`
   - `XTerminal.tsx:217` `term.attachCustomKeyEventHandler` runs on every `keydown`.
   - `XTerminal.tsx:226-231` matches `mod(event) && event.key === "v"`, kicks off `navigator.clipboard.readText().then(text => writeTerminal(terminalId, text))`, and returns `false` so xterm ignores the key. It does **not** call `event.preventDefault()`; the DOM default Cmd+V still fires a `paste` event on the hidden textarea.
2. Native paste path — right-click menu, middle-click, drag-drop, browser-injected paste
   - `XTerminal.tsx:204-213` locates `textarea.xterm-helper-textarea` (via `querySelector` on the container **once**, right after `term.open`) and installs a capture-phase `paste` listener `killPaste` that calls `preventDefault()` + `stopImmediatePropagation()`. This is intended to silence xterm's own paste pipeline so the Cmd+V branch owns the write.
3. `writeTerminal(id, text)` → `invoke("write_terminal", { id, data })` (`src/lib/tauriApi.ts:35`) → `#[tauri::command] fn write_terminal` (`src-tauri/src/lib.rs:230`) → `PtyManager::write` (`src-tauri/src/pty_manager.rs:147`) which acquires the global `Mutex<HashMap<TerminalId, PtyInstance>>`, does a single `writer.write_all(data.as_bytes())` + `flush()`. No chunking, no escape translation, no bracketed-paste awareness on the Rust side.

There is no other paste-related producer in the terminal code path:
- Canvas / FloatingTerminal don't intercept `paste` (`src/components/canvas/Canvas.tsx`, `src/components/canvas/FloatingTerminal.tsx` checked).
- `useKeybindings.ts` only registers `Ctrl+Shift+V` → voice.toggle; plain `Ctrl/Cmd+V` is not in `DEFAULT_KEYBINDINGS` (`src/lib/keybindingEngine.ts:79`). So the global keydown listener does **not** swallow paste keystrokes.
- `useVoiceControl.ts` has no paste/keydown handler.
- Tauri has no clipboard plugin configured (`src-tauri/capabilities/default.json`); everything goes through `navigator.clipboard`.

## Ranked sources of "paste is wrong / duplicated / missing"

### 1. Bracketed-paste mode is completely bypassed — [HIGH, always]
`XTerminal.tsx:227-228` writes the raw clipboard string straight into the PTY. xterm.js's built-in paste path (which `killPaste` silences) is the thing that normally:
- tracks `bracketedPasteMode` toggled by `CSI ? 2004 h/l` from the PTY,
- wraps the payload in `\x1b[200~ ... \x1b[201~` when enabled,
- normalizes `\r\n` / `\n` → `\r`.

Consequences that match the user's "copy/paste acts weird" complaint:
- Pasting a multi-line command into zsh/bash executes each line on its own `\r` — there is no bracketed-paste envelope for readline to buffer it into one logical edit.
- Pasting into vim/nano/emacs arrives as normal typed input, so vim auto-indents, smart-tab expands tabs, and editors that key off bracketed paste (`set paste`) never see it.
- Pasting from the macOS clipboard that contains `\r\n` (common from Windows-origin text, Slack, some browsers) sends literal `\r\n` → shell sees `\r` then `\n`, and the extra line-feed can generate a blank prompt line.

Recommended fix for the orchestrator: reuse xterm's paste pipeline — replace the custom Cmd+V branch with `term.paste(await navigator.clipboard.readText())` (xterm exposes `Terminal.prototype.paste` which applies bracketed-paste + line-ending normalization and flows through `onData`). That also removes the need for `killPaste`.

### 2. `killPaste` listener goes stale if the helper textarea is re-created — [HIGH, explains "double paste"]
`XTerminal.tsx:206-213` captures the textarea **by reference** once, immediately after `term.open(containerRef.current)`. xterm.js replaces the helper textarea in several situations (WebGL init, screen reader mode toggles, `options.screenReaderMode` writes, and some renderer rebuilds triggered by theme changes on line 92 `term.refresh`). When that happens:
- Our `killPaste` is still attached to the orphan node, which is no longer in the DOM / no longer receives the paste event.
- xterm's internal paste listener on the *new* textarea fires, so xterm's paste handler calls `_coreService.triggerDataEvent(text)`, which runs the `term.onData` handler registered at `XTerminal.tsx:192-194` → `writeTerminal(terminalId, data)`.
- At the same time, the custom Cmd+V branch at line 226 is still firing its own `writeTerminal(terminalId, text)` for the same keystroke.

Result: user sees the clipboard content written twice (xterm's path with bracketed-paste wrapping + our Cmd+V path with raw text) — exactly the "sometimes triggers a double-paste" symptom. It happens intermittently because it depends on whether the textarea was re-created since mount.

### 3. Multi-line paste breaks because `\r\n` / `\n` are never normalized — [HIGH, always on Windows-clipboard content]
Even when paths #1 and #2 are resolved, `writeTerminal(terminalId, text)` at line 228 forwards the raw clipboard bytes. The Rust write (`pty_manager.rs:147-155`) is a direct `write_all` of the UTF-8 bytes. On a Unix PTY, pasting the three-line string `"a\r\nb\r\nc"` sends `a`, CR (submits as command `a`), LF (prints a blank prompt on some shells), `b`, CR, LF, `c`. This is why "copy/paste sometimes inserts wrong text" — what arrives at the shell is not what was on the clipboard.

### 4. Right-click, middle-click, and drag-drop paste are silently swallowed — [HIGH, explains "doesn't fire at all"]
`killPaste` (`XTerminal.tsx:209-213`) is indiscriminate — it drops *every* paste event on the helper textarea regardless of source. Because the Cmd+V fallback only fires from a keyboard event:
- macOS right-click → Paste menu → no text inserted.
- Linux middle-click (primary selection paste) → nothing.
- Drag-and-drop text onto the terminal → nothing.
- Any OS-level paste injected by accessibility/automation tools → nothing.
The "sometimes paste doesn't fire at all" symptom maps cleanly onto this.

### 5. Async `clipboard.readText()` without gesture guarantees — [MEDIUM, intermittent no-op]
`XTerminal.tsx:227-230` fires `navigator.clipboard.readText()` from inside `attachCustomKeyEventHandler`, which is a synchronous callback xterm expects to return `true/false`. By the time the promise resolves the user-activation context may have lapsed (especially when the terminal was just focused by the same keystroke). On failure the `.catch(() => {})` on line 228 swallows the rejection. User sees "Cmd+V did nothing". Also, because the read is async, if the user mashes Cmd+V twice quickly the two resolutions can interleave — first Cmd+V's write arrives after second Cmd+V's write, so the duplicate is visible even without path #2.

### 6. `Ctrl/Cmd+Shift+V` bubbles out of xterm to voice.toggle — [MEDIUM, UX footgun]
`XTerminal.tsx:219` returns `false` for any `mod+shift` combo to let app keybindings run. Users who expect `Cmd+Shift+V` to paste-as-plain-text (common in editors/browsers) instead trigger `voice.toggle` (`keybindingEngine.ts:79`) and, because `killPaste` is still active, any OS-emitted paste event that follows is dropped. This will feel like "pressed paste and nothing happened", possibly with the voice HUD flickering.

### 7. `autoCommand` rides the same write path with a bare `\r` — [LOW, only affects autolaunched sessions]
`XTerminal.tsx:298` sends `autoCommand + "\r"` via `writeTerminal` after a 2 s delay. If the autoCommand contains newlines (composite commands), the same bracketed-paste / line-ending problem applies. Not a user-triggered paste bug, but worth fixing together.

### 8. PTY write path is not a suspect — [NONE]
`PtyManager::write` (`pty_manager.rs:147-156`) is a straight synchronous `write_all` under a `Mutex`. A single `invoke("write_terminal", …)` = one atomic PTY write. It will never split, merge, or reorder bytes within one call. Concurrent writes from multiple frontend callers serialize in invoke order. No queuing-related duplication bug is possible here. The real problem is upstream — the frontend issues the write two or zero times.

## Quick summary for orchestrator

Root cause of all three symptoms is that the XTerminal component reinvented paste instead of delegating to xterm:
- **Delegate to `term.paste(text)`** on Cmd+V, right-click, middle-click, drag-drop. That single change fixes #1 (bracketed paste), #3 (line endings), #4 (multi-source paste), and removes the need for `killPaste` entirely (kill #2).
- Add a capability-gated fallback (`writeText` Tauri plugin or `document.execCommand("paste")`) only if `navigator.clipboard.readText()` rejects, to address #5 on locked-down webviews.
- Drop or document the `Cmd+Shift+V` bubble (#6). If voice.toggle is wanted, rebind it to something that doesn't shadow paste-as-plain-text.

## Files referenced

- `src/components/terminal/XTerminal.tsx:192-262` — paste + Cmd+V + killPaste
- `src/components/terminal/XTerminal.tsx:296-300` — autoCommand write
- `src/lib/tauriApi.ts:35-37` — `writeTerminal` IPC wrapper
- `src-tauri/src/lib.rs:229-236` — `write_terminal` command
- `src-tauri/src/pty_manager.rs:147-156` — `PtyManager::write`
- `src/lib/keybindingEngine.ts:29-82` — `DEFAULT_KEYBINDINGS`
- `src/hooks/useKeybindings.ts:10-28` — global keydown dispatcher (capture phase, does not match plain Cmd+V)
- `src/components/canvas/Canvas.tsx`, `src/components/canvas/FloatingTerminal.tsx` — verified no paste interception
- `src-tauri/capabilities/default.json` — no clipboard plugin; Tauri relies on web `navigator.clipboard`
