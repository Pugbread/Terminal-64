# Agent 1 — XTerminal Selection & Copy/Paste Audit

Scope: `src/components/terminal/XTerminal.tsx` end-to-end, plus its direct host chain (`FloatingTerminal.tsx`, `Canvas.tsx`) insofar as they affect mouse-coordinate math or steal events. Research only; orchestrator will implement.

---

## Stack snapshot

- `@xterm/xterm ^6.0.0` (`package.json:27`)
- `@xterm/addon-fit ^0.11.0` (`package.json:25`)
- `@xterm/addon-webgl ^0.19.0` (`package.json:26`)
- **No** `@xterm/addon-canvas`, `@xterm/addon-web-links`, `@xterm/addon-search`, or `@xterm/addon-serialize`.
- Rendering: WebGL addon loaded conditionally; when it isn't loaded, xterm falls back to its built-in DOM renderer. There is no explicit `RENDERER_TYPE` setting — xterm v6 dropped that option.
- Consumers of `XTerminal`: `FloatingTerminal.tsx` (inside the scaled canvas) and `PopOutTerminal.tsx` (native window, unscaled).

`Terminal` constructor options (`XTerminal.tsx:154-168`):
```
cursorBlink: false
cursorStyle: "underline"
cursorWidth: 1
cursorInactiveStyle: "none"
fontSize: 14
fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace"
fontWeight: "400"
letterSpacing: 0
lineHeight: 1.2
theme: initialTheme
allowProposedApi: true
scrollback: 10000
rightClickSelectsWord: true
```
Selection-relevant options NOT set: `macOptionClickForcesSelection`, `macOptionIsMeta`, `screenReaderMode`, `rectangularSelection` (not exposed in v6 anyway).

---

## Ranked causes of "drag selects wrong cells / columns"

### 1. [HIGH — almost certainly the primary bug] Canvas `transform: scale(z)` breaks xterm mouse → cell math

`Canvas.tsx:89` writes the canvas pan/zoom as a single CSS transform on the content layer:
```ts
content.style.transform = `translate(${panX}px, ${panY}px) scale(${z})`;
```
with `transform-origin: 0 0` (`Canvas.css:335`). Every `FloatingTerminal` — and therefore every xterm — lives inside that scaled subtree.

xterm's `SelectionService` (v6) converts `MouseEvent.clientX/Y` to a buffer position via `_screenElement.getBoundingClientRect()` plus the pixel-per-cell values reported by `CoreBrowserService` / the render service. `getBoundingClientRect()` **does** include CSS transforms (so `rect.left`/`rect.width` are post-scale), but the cell-pixel dimensions xterm uses are the **unscaled** values measured from its canvas/WebGL backing surfaces. Whenever `zoom !== 1` the two are inconsistent and `col = (clientX - rect.left) / cellWidth` lands on the wrong column by a factor of `zoom`. Vertical rows are wrong by the same factor. This is a known class of xterm.js bug (see xtermjs/xterm.js issues #4703, #3067, etc.) and it matches the reported symptom exactly.

A fast sanity check the orchestrator can do once this is fixed: pop a terminal out (`PopOutTerminal.tsx` lives in a native webview outside the scaled canvas). Selection should behave correctly there even on a broken build, because there's no ancestor `scale()`.

Fix direction (for the orchestrator, not this task): counteract the scale on the terminal wrapper, e.g. apply an inverse `transform: scale(1/z)` on `.floating-terminal .xterm-screen` wrapper and compensate layout, OR stop using CSS `scale()` for zoom and instead scale the canvas content by adjusting xterm's `fontSize` / layout width and per-terminal `left/top/width/height`. The inverse-transform approach is more invasive because xterm measures its own canvas. Cleanest fix is usually to keep the canvas layout unzoomed at the terminal level and only zoom non-interactive panels — or to accept the zoom hit and rebuild layout using computed positions rather than a CSS transform.

### 2. [MED] Wrapper `onMouseDown={focus}` can race with xterm's own selection start

`XTerminal.tsx:359` attaches `onMouseDown={focus}` on the outer `.xterminal` div. `focus` runs `term.focus()` **and** `onFocus?.(terminalId)` → in `FloatingTerminal.tsx:240-243` that becomes `bringToFront(term.id) + setActive(term.terminalId)`.

Consequences during a drag-selection:
- `bringToFront` mutates `zIndex` in the canvas store, which triggers a React re-render of the `FloatingTerminal` whose mouse is currently captured by xterm's selection service. The re-render doesn't replace the DOM node but React may write fresh inline styles, and any ancestor style write (e.g. z-index) can invalidate xterm's cached `_screenElement.getBoundingClientRect()` if the browser treats it as a layout/paint.
- `setActive` updates `isActive`, which triggers `XTerminal.tsx:108-112` — yet another `term.focus()` call mid-drag. `HTMLElement.focus()` on the hidden textarea while xterm is tracking pointer capture is cheap but not free; it can dispatch a `selectionchange` on the textarea itself and, on some WebKit builds, interrupt pointer capture.
- In the common case ("click on an already-active terminal and drag"), `bringToFront` and `setActive` are no-ops but still cause store subscriptions to fire.

This is more likely to manifest as "selection sometimes doesn't fire at all" or "selection restarts halfway" than as "wrong columns", but it's on the same code path.

### 3. [MED] WebGL addon is disposed/recreated on `bgAlpha` changes — leaves stale render state

`XTerminal.tsx:63-106` toggles the WebGL addon whenever `bgAlpha` crosses 1. Disposing the addon tears down the GL texture/buffer; xterm transparently re-creates a DOM renderer on the next refresh. During the swap, `term.refresh(0, term.rows-1)` is called but the selection-rendering overlay (WebGL path vs DOM path) can render stale highlight rects until the next paint. More importantly, the renderer swap reruns `CoreBrowserService` measurements of cell width/height; if the wrapper is currently CSS-scaled (see #1), the measurement is taken against a scaled layout and the cell dimensions xterm ends up caching depend on *when* the user toggled transparency. This can explain why selection "was fine yesterday, broken today" kinds of reports.

Low severity for the "wrong cells" bug directly, but it adds non-determinism on top of #1.

### 4. [LOW for column drift, HIGH for "copy/paste acts weird"] Paste path has three independent issues

`XTerminal.tsx:204-213`:
```ts
const xtermTA = containerRef.current.querySelector("textarea.xterm-helper-textarea");
const killPaste = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
xtermTA?.addEventListener("paste", killPaste, true);
```
Then `XTerminal.tsx:225-231` intercepts Cmd/Ctrl+V in `attachCustomKeyEventHandler` and calls `navigator.clipboard.readText().then(writeTerminal)`.

Problems:

- **`killPaste` silently breaks every non-keyboard paste path.** Middle-click paste (Linux X11 primary selection), native context-menu "Paste", programmatic paste from screen readers and accessibility tools all fire a real `paste` event on the helper textarea and get dropped. The user sees "paste sometimes doesn't fire at all".
- **Double-paste opportunity via `rightClickSelectsWord: true` combined with a platform context menu.** On macOS WebKit, right-click will both fire `rightClickSelectsWord` (xterm selects the word under the cursor) *and* surface the native WebKit context menu. If the user chooses "Paste" from that menu, the path goes through the native paste event → `killPaste` blocks it, so it actually under-pastes. But if the menu is dismissed quickly while the user also hits Cmd+V, both the residual paste event and the keydown path can fire and produce two writes. Reproduce by: right-click, let the menu flash, Cmd+V. Worth verifying.
- **`navigator.clipboard.readText()` is async and un-gated.** There's no "paste in flight" guard. Two rapid Cmd+V presses issue two independent reads; if the clipboard mutates between them (unlikely in normal use but possible with clipboard managers), the two writes contain different text. Also, if the clipboard permission is not yet granted, `readText()` rejects and nothing happens — the "sometimes doesn't fire at all" symptom.

Fix direction: drop `killPaste` + the keydown interception entirely and use xterm's own `onPaste` / the DOM `paste` event's `clipboardData.getData("text")` (synchronous, no permission prompt, matches what the user actually selected). If the custom wrapper is needed for non-text payloads, at minimum add a `pasteInFlight` flag and key off the `paste` event instead of keydown.

### 5. [LOW] Cmd/Ctrl+C path silently swallows copy when selection spans only whitespace

`XTerminal.tsx:234-241`: `if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection())`. `term.getSelection()` can return an empty string for whitespace-only or zero-width selections even when `hasSelection()` is true, and `navigator.clipboard.writeText("")` will clear the clipboard. Combined with `clearSelection()` immediately after, the user ends up with nothing on the clipboard and no selection. Minor but worth knowing.

### 6. [LOW] `autoCommand` 2 s setTimeout is not cancelled on unmount

`XTerminal.tsx:296-300` schedules `writeTerminal(terminalId, autoCommand + "\r")` at 2 s with no handle stored. `disposed = true` is set in cleanup but the timeout doesn't consult it. If the terminal is closed between mount and +2 s, the write still fires against a torn-down PTY. Mostly a resource/error-log nuisance, but could explain occasional "random text appeared" if the same `terminalId` is reused quickly.

### 7. [LOW / stylistic cruft] Global WebGL counter

`XTerminal.tsx:18-23` caps concurrent WebGL contexts at 10. This works but the counter is module-level mutable state; if a future code path forgets to call `releaseWebgl()` the cap drifts. Not a selection issue; flagged as "accumulated cruft" the user mentioned.

### 8. [LOW] `rightClickSelectsWord: true` without any context-menu suppression

On Windows and Linux, many users' muscle memory for terminal paste is right-click. xterm will instead select the word under the cursor. The config is internally consistent with "we use Cmd+V for paste" but together with #4 (killPaste) it means right-click-paste is doubly broken on Linux. The user is on macOS (per memory) so lower priority, but if the orchestrator is already refactoring, this is a candidate for a settings toggle.

---

## What is NOT a suspect, based on this audit

- **DOM renderer vs WebGL renderer**: both use the same `SelectionService`. Swapping them doesn't fix #1.
- **Custom `selectionChange` handlers**: none are registered. `term.onSelectionChange` is never called.
- **`term.onData` / `term.onBinary`**: straight pass-throughs to `writeTerminal`. No interception that would reshape text.
- **Paste sanitization**: there is none (bracketed paste, newline normalization, etc.). If PTY-side bracketed-paste is enabled, long pastes may already be wrapped — but that's the shell's job, not ours.
- **`attachCustomKeyEventHandler`** for Cmd+A / Cmd+C / Cmd+V: logic is correct; returning `false` suppresses xterm's default emit. No double-fire from this alone.

---

## File:line map for the orchestrator

| Concern | Location |
|---|---|
| CSS transform scale that breaks cell math | `src/components/canvas/Canvas.tsx:89` + `src/components/canvas/Canvas.css:335` |
| xterm lives inside that scaled subtree | `src/components/canvas/FloatingTerminal.tsx:272-274`, `496-506` |
| Focus on mousedown (race with selection start) | `src/components/terminal/XTerminal.tsx:57-60, 359` |
| `isActive`-driven focus (second race) | `src/components/terminal/XTerminal.tsx:108-112` |
| WebGL addon toggle on alpha change | `src/components/terminal/XTerminal.tsx:63-106` |
| WebGL counter global | `src/components/terminal/XTerminal.tsx:18-23` |
| xterm options | `src/components/terminal/XTerminal.tsx:154-168` |
| killPaste on helper textarea | `src/components/terminal/XTerminal.tsx:204-213, 343` |
| Cmd+V keydown paste path | `src/components/terminal/XTerminal.tsx:225-231` |
| Cmd+C copy path | `src/components/terminal/XTerminal.tsx:233-241` |
| autoCommand uncancelled setTimeout | `src/components/terminal/XTerminal.tsx:296-300` |
| Unscaled sibling for diffing behaviour | `src/components/canvas/PopOutTerminal.tsx:106-114` |

---

## Recommended cleanup scope (for orchestrator planning)

1. Resolve the CSS-scale ↔ xterm cell-math mismatch. This is the single fix that will make drag-selection feel right. Everything else in this list is noise around it.
2. Replace the `killPaste` + keydown-readText combo with a single `paste`-event handler that uses `e.clipboardData.getData("text")` synchronously. Removes permission prompts, double-paste, and the silent "paste doesn't fire" case.
3. Move the `onFocus?.(terminalId)` call out of `mousedown` on the wrapper. Fire it on `focus` (i.e. when the hidden textarea actually receives keyboard focus), so click-and-drag to select doesn't trigger a cross-component re-render mid-drag.
4. Stop toggling the WebGL addon on `bgAlpha` flips. Either live with opaque-only WebGL and always use the DOM renderer when transparency is enabled at mount time, or rebuild the terminal when alpha crosses 1 — but don't swap addons on a live terminal.
5. Trim the dead/weak bits: global WebGL counter (replace with try/catch on construction + a single retry), `autoCommand` setTimeout handle, empty-selection guard on Cmd+C.

No fixes applied — research only, as instructed.
