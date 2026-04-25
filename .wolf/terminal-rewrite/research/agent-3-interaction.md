# Agent 3 — Interaction & Coordinate Layer Audit

**Scope:** how xterm.js is embedded in the pan/zoom canvas. Why drag-select picks wrong cells, copy/paste misbehaves, and which pieces are bundled cruft.

**TL;DR:** the single biggest bug is that `Canvas.tsx` applies a CSS `scale()` transform to an ancestor of every xterm instance. xterm.js hit-tests selection using `getBoundingClientRect()` (which *includes* the scale) combined with cached cell-pixel sizes measured at load time (which do *not*). The ratio between those two is exactly `1/zoom`, so at any zoom ≠ 1 the selection anchor lands in the wrong cell. A secondary bug cluster in copy/paste is three overlapping handlers racing against each other.

---

## 1. The scale() trap — drag selects wrong cells

### Where it happens

`src/components/canvas/Canvas.tsx:76-96` — the whole canvas content, including every `FloatingTerminal`, is written with:

```ts
content.style.transform = `translate(${panX}px, ${panY}px) scale(${z})`;
```

Applied to `.canvas-content` (`Canvas.css:30-43`). That node contains all `FloatingTerminal` instances, which contain `XTerminal`, which hosts xterm's DOM.

### Why xterm breaks under a scaled ancestor

xterm's selection service resolves mouse events like this (`@xterm/xterm` internals — `SelectionService.onMouseDown` → `Viewport.getCoords`):

1. `const rect = this._element.getBoundingClientRect()` → returns *scaled* pixels (a 100-cell wide terminal at 80% zoom reports `rect.width = 0.8 × layoutWidth`).
2. `col = Math.floor((ev.clientX - rect.left) / this._renderService.dimensions.css.cell.width)` → `dimensions.css.cell.width` is measured at `Terminal.open()` on the *unscaled* DOM (see `WebglAddon`/`DomRenderer` — cell width comes from a one-shot canvas `measureText` scaled to the root `devicePixelRatio` but not to ancestor CSS transforms).

So `clientX - rect.left` is in scaled space, while `cell.width` is in unscaled space. At zoom=1.5 the user clicks on visual column N but the math lands on column `≈N/1.5`. That's the textbook "drag selects the wrong spot" symptom.

The same bug breaks:
- Click-to-place cursor
- Double-click word select
- Triple-click line select
- Drag-to-select columns
- Shift-click range extension
- xterm's mouse reporting to PTYs in apps like `htop`, `vim`, `less`

### Why the fit addon *doesn't* hide the problem

`XTerminal.tsx:307-329` uses a `ResizeObserver` on the container. `ResizeObserver` reports the **unscaled** content-box (per spec), so `fitAddon.fit()` computes correct cols/rows. Nothing refires on zoom change because the layout box doesn't change — only the visual size does. That's why the terminal *looks* right at any zoom but *clicks wrong*.

### Confirming it's not some other transform

- `FloatingTerminal.css:11` — `transform: translateZ(0)` on `.floating-terminal`: identity transform, doesn't scale.
- `XTerminal.css` — no transforms.
- No `zoom:` CSS property anywhere in `src/`.
- WebGL context itself isn't scaled — the scaling is pure CSS.

So the scale is 100% coming from `Canvas.tsx:89`.

### Fix options (ranked)

**A. Scale per-panel instead of scaling the canvas.** (RECOMMENDED)
Keep `translate()` on `.canvas-content` for pan. For zoom, scale each `FloatingTerminal`'s `width`, `height`, `left`, `top`, and — for xterm panels only — bump the xterm `fontSize` proportionally and re-fit. xterm then lives in real CSS pixels at all times. Non-terminal panels (Claude chat, widgets) can keep a `transform: scale()` at the panel root since they don't care about pixel-accurate hit-testing.

**B. Counter-scale the terminal.** Wrap `.xterminal` in a container that applies `transform: scale(1/zoom)` with `transform-origin: 0 0` and sizes itself to `width: ${100*zoom}%`. Fragile, breaks subpixel alignment.

**C. Exclude terminals from zoom.** Render terminals with `translate` only, other panels with `translate scale`. Messier but minimal code churn; possibly acceptable if terminals are the only hit-test-sensitive panel type.

**D. Ban non-1 zoom while a terminal is focused.** User-hostile; not recommended.

---

## 2. Copy/paste — three handlers walking on each other

### The overlapping code paths

1. **`attachCustomKeyEventHandler`** (`XTerminal.tsx:217-262`). On `Ctrl/Cmd+V`, reads `navigator.clipboard.readText()` then calls `writeTerminal(terminalId, text)`. Returns `false` so xterm doesn't process the key.
2. **Hidden-textarea paste blocker** (`XTerminal.tsx:204-213`). Captures `paste` events on `textarea.xterm-helper-textarea` and calls `stopImmediatePropagation` + `preventDefault`.
3. **xterm's own paste handling** — still compiled in because `term.attachCustomKeyEventHandler` only governs `keydown`; xterm *also* listens to the browser's native `paste` event on its internal textarea for OS-level paste (right-click menu, trackpad two-finger paste on macOS, drag-and-drop text).
4. **Global `useKeybindings`** (`useKeybindings.ts:10-23`). Runs in capture phase (`true` in `addEventListener`). `DEFAULT_KEYBINDINGS` does not bind Ctrl+V / Ctrl+C today (`keybindingEngine.ts:29-79`), so it's inert — but the capture listener still runs for every key and can `preventDefault` on surprise bindings.

### Symptoms mapped to causes

| User symptom | Likely cause |
|---|---|
| **Double paste** | Cmd+V → custom handler fires (async `readText`) AND the OS-synthesized `paste` event hits the hidden textarea. If focus is on the textarea, `killPaste` catches it. If focus drifted (e.g. into xterm's screen element, or the panel's outer div after `handleFocus`), `killPaste` doesn't intercept and xterm's built-in paste writes too. Result: two writes to the PTY. |
| **Wrong text pasted** | `navigator.clipboard.readText()` is async. Between the `keydown` and the promise resolving, the clipboard contents can change (fast copy-then-paste sequences, clipboard managers, or a different app's sync hook). Browser synchronous paste gets the "old" text; `readText()` gets the "new" text; you get two different strings or an unexpected one. Also: `readText` only returns the `text/plain` flavor — rich content (e.g. URL with title) comes out stripped of newline normalization that the sync path preserves. |
| **Paste doesn't fire** | `navigator.clipboard.readText()` rejects silently in a few cases (no document focus, cross-origin iframe restrictions, Tauri webview permission denial). The `.then(…).catch(() => {})` implicitly swallows; no feedback to user. Also: if focus is on the `.floating-terminal` header (after dragging), the custom key handler in `attachCustomKeyEventHandler` is not reached because xterm only forwards events when its textarea has focus. |

### Additional cruft

- `rightClickSelectsWord: true` (`XTerminal.tsx:167`) — interacts with the OS right-click menu differently per platform. On macOS it conflicts with the system "services → paste" handling. Low priority but worth auditing.
- `killPaste` captures a ref to `xtermTA` at init time (`XTerminal.tsx:206-208`). If xterm internally re-creates the helper textarea (it does during some dispose/reinit flows), the listener is orphaned — so the blocker only works for the lifetime of the first textarea.
- `mod(event) && event.key === "a"` → `term.selectAll()` (`XTerminal.tsx:244-247`). Under the scale bug, `selectAll()` is fine (it doesn't use mouse coords), but the selection *overlay* that xterm draws is positioned using those same broken coords — so the highlight will look offset from the actual selected cells.

### Fix direction

- **Single source of truth for paste.** Drop the `Ctrl+V` branch from `attachCustomKeyEventHandler`. Replace with one capture-phase `paste` listener on the `.xterminal` container (not the hidden textarea) that:
  1. Calls `e.preventDefault(); e.stopImmediatePropagation()`.
  2. Reads `e.clipboardData?.getData('text/plain')` — **synchronous**, no race.
  3. Normalizes CRLF → CR (bracketed paste if `term.modes.bracketedPasteMode`).
  4. Writes to PTY.
- **Let xterm handle Ctrl+C natively** when there's a selection, drop the custom handler — xterm already copies with `Ctrl+Shift+C` or `rightClickSelectsWord` helper. Current custom `Ctrl+C` path (`XTerminal.tsx:234-241`) is redundant with xterm's defaults on macOS.
- **Remove the hidden-textarea paste blocker** once the root-level capture listener is in place.

---

## 3. Focus/drag overlay — minor contributors

### `FloatingTerminal.tsx:298` — `onMouseDown={handleFocus}` on panel root

Every mousedown *inside* the terminal body also bubbles here and triggers `bringToFront` + `setActive`. `bringToFront` writes to `useCanvasStore`, which re-renders all subscribers of `terminals` or `activeTerminalId`. Mid-drag (native xterm selection drag), this fires on mousedown only, which is fine for selection but causes:
- A Zustand re-render of *every* `FloatingTerminal` on click (they all subscribe to `terminals`).
- React reconciliation pass during the very first frame of an xterm drag. Usually harmless, but when combined with `will-change: transform` on the panel (`FloatingTerminal.css:10`), Safari/WebKit occasionally throws away and recomposites the terminal's compositor layer between frames 0 and 1 of the drag, which can drop xterm's drag start.

Fix: gate `bringToFront` behind "only if not already top", same as existing `bringToFront` early-out (`canvasStore.ts:355`). Already done in store — but the *re-render from subscription churn* still happens because `setActive` is always called. Guard `setActive` too.

### `XTerminal.tsx:359` — `onMouseDown={focus}` on host div

Duplicates the focus call. Remove this; let `FloatingTerminal.handleFocus` do the job. xterm focuses itself on `mousedown` inside its own screen element — we only need the outer bookkeeping.

### `.ft-resize` hit areas

`FloatingTerminal.css:211-226`. Top `.ft-resize--n` is `top: 0; height: 8px`. Sits 8px *above* the header, not inside the terminal body, so it doesn't steal xterm mouse events. Clean.

### `.ft-dragging iframe` blocker

`FloatingTerminal.css:267-270`. Only affects iframes/webviews (widgets, browser panels). Does not touch terminals. Clean.

### `contain: layout paint` + `isolation: isolate` + `translateZ(0)` on `.floating-terminal`

`FloatingTerminal.css:10-14`. Creates a promoted compositor layer per panel. Under the parent `scale()` transform, WebKit can choose to rasterize the layer at the unscaled size then up/down-scale the bitmap — the terminal's text gets blurry and xterm's selection overlay (drawn inside the layer) drifts by subpixels relative to the parent. Suggest removing `will-change: transform` and `contain: layout paint` on panels that host xterm; keep them on widget/browser panels if paint perf demands it.

---

## 4. Re-mount / listener leakage

### Good

- `XTerminal.tsx:334-352` cleanup on unmount is thorough: ResizeObserver disconnect, `clearTimeout` for both resize and focus timers, unlisten tauri events, dispose WebGL, dispose term, clear refs.
- `initializedRef` guards against the React-strict-double-invoke pattern — even though StrictMode isn't enabled (`main.tsx:4`), the guard is correct defense-in-depth.
- Tauri `unlistenOutput`/`unlistenExit` are captured via the IIFE and cleaned up; no stale event listener accumulation.

### Concerns

1. **Theme effect churn** (`XTerminal.tsx:63-106`). On any change to `theme` OR `bgAlpha`, the effect runs, potentially disposes WebGL, recreates WebGL, and calls `term.refresh(0, term.rows - 1)`. When the user drags the alpha slider, this thrashes WebGL contexts at up to 60Hz. Burns through the `MAX_WEBGL_CONTEXTS` budget (it's correctly decremented on dispose, but rapid churn still stresses the GPU). Debounce to ~100ms or compare previous `bgAlpha` against current before recreating.
2. **`useCallback(focus, [terminalId, onFocus])`** — `onFocus` is a prop. Parent (`FloatingTerminal`) wraps `handleFocus` in `useCallback` deps `[term.id, term.terminalId, bringToFront, setActive]`. These are all stable store refs + stable string IDs. Stable. Good.
3. **`onTerminalOutput` listener body** at `XTerminal.tsx:269-278` does two regex matches on *every* output chunk (including high-volume streams like `yarn install`). The OSC 7 regex `\x1b\]7;file:\/\/[^/]*\/(.*?)(?:\x07|\x1b\\)` can pathologically backtrack on chunks that contain stray `\x1b]` without terminator. Under heavy output this can hitch the main thread, which serialized with React reconciliation can look like dropped input / missed selection drags. Consider moving CWD detection to a lighter-weight check (e.g. `indexOf('\x1b]7;')` prefilter) or throttle to ~10Hz.

---

## 5. Ranked rewrite targets

| # | Priority | Target | Fix |
|---|---|---|---|
| 1 | **CRITICAL** | `src/components/canvas/Canvas.tsx:89` | Stop applying `scale(z)` to the common ancestor of xterm. Use translate-only on `.canvas-content`; apply zoom per-panel (size + font-size for terminals). |
| 2 | **CRITICAL** | `src/components/terminal/XTerminal.tsx:204-262` | Rewrite paste pipeline: one synchronous `paste` listener on `.xterminal` root using `clipboardData.getData('text/plain')`. Drop `attachCustomKeyEventHandler` Ctrl+V branch. Drop `killPaste` on hidden textarea. |
| 3 | HIGH | `src/components/terminal/XTerminal.tsx:234-247` | Remove custom Ctrl+C / Ctrl+A handlers; let xterm defaults handle them (they already work). Keep only Ctrl/Option+Backspace word-delete. |
| 4 | HIGH | `src/components/terminal/XTerminal.tsx:63-106` | Debounce the theme/alpha effect. Don't dispose+recreate WebGL on every intermediate alpha value. |
| 5 | MEDIUM | `src/components/canvas/FloatingTerminal.css:10-14` | Remove `will-change: transform`, `contain: layout paint`, `isolation: isolate` from panels that host `XTerminal` (parametric class or separate selector). Keeps WebKit from promoting a compositor layer that rasterizes at the wrong scale. |
| 6 | MEDIUM | `src/components/canvas/FloatingTerminal.tsx:298` and `src/components/terminal/XTerminal.tsx:359` | Pick one of the two `handleFocus`/`focus` mousedown paths. Guard `setActive` with "only if not already active" so clicks inside a focused terminal don't churn store subscribers. |
| 7 | MEDIUM | `src/components/terminal/XTerminal.tsx:273-276` | Move OSC-7 and PS1 CWD detection behind a cheap prefilter (`data.indexOf('\x1b]7;') >= 0`); skip regex on every chunk. |
| 8 | LOW | `src/components/terminal/XTerminal.tsx:167` | Re-evaluate `rightClickSelectsWord: true` on macOS — it can conflict with system Services menu. |
| 9 | LOW | `src/components/terminal/XTerminal.tsx:306-329` | Add a subscribe on `useCanvasStore` for `zoom` changes if fix #1 uses the "scale via font-size" strategy — otherwise fit won't re-run on zoom. |

---

## 6. Suggested minimal rewrite outline

A clean interaction layer would look like:

```
Canvas ─┬── pan-only translate on .canvas-content
        └── FloatingTerminal (each)
              ├── style.left = x * zoom    ──┐
              ├── style.top  = y * zoom     │ zoom-scaled positioning
              ├── style.width  = w * zoom   │ in real CSS pixels
              ├── style.height = h * zoom  ──┘
              └── XTerminal
                    ├── fontSize = BASE * zoom  (re-fit on change)
                    ├── single paste listener on root (capture, sync)
                    ├── keydown: only Option+Backspace word-delete
                    └── everything else via xterm defaults
```

Estimated diff: ~150 lines removed from `XTerminal.tsx`, ~40 lines changed in `Canvas.tsx`, ~20 lines changed in `FloatingTerminal.tsx`, ~10 lines of CSS. No Rust changes required — this is entirely frontend/interaction.

---

## 7. Things that are NOT bugs (ruled out)

- Tauri IPC latency on `write_terminal` — not in the interaction path for selection.
- React StrictMode double-mount — not enabled (`main.tsx:4`).
- xterm font metrics — correct under normal DPR; only wrong relative to ancestor CSS transforms.
- Resize observer debounce (50ms) — fine.
- Canvas pan handler (`Canvas.tsx:136-158`) — only fires on empty-canvas clicks (`e.target !== canvasRef.current` early-out), doesn't interfere with terminal drag.
- Widget iframe pointer blocker (`ft-dragging`) — doesn't apply to terminals.

---

**File references used:**
- `src/components/canvas/Canvas.tsx` (pan/zoom transform)
- `src/components/canvas/Canvas.css` (canvas-content styling)
- `src/components/canvas/FloatingTerminal.tsx` (drag/resize/focus)
- `src/components/canvas/FloatingTerminal.css` (layer promotion, resize hit zones)
- `src/components/terminal/XTerminal.tsx` (xterm lifecycle, keys, paste)
- `src/components/terminal/XTerminal.css`
- `src/stores/canvasStore.ts` (zoom/pan state)
- `src/hooks/useKeybindings.ts` (global keybinding capture)
- `src/lib/keybindingEngine.ts` (default bindings — no Ctrl+V/C conflict)
- `src/main.tsx` (no StrictMode)
