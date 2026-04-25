# Agent 3 — Canvas Transform & Counter-Scale Impact on Chat Scroller

Research-only. No source modified. Focus: does the canvas `transform: scale(z)` + `--canvas-zoom` setup contribute to chat jitter and stick-to-bottom failures?

## Current layout chain (verified)

```
.canvas                              (overflow: hidden, flex: 1)
└── .canvas-content                  (transform: translate(px,py) scale(z), --canvas-zoom: z, pointer-events: none)
    └── .floating-terminal           (position: absolute; will-change: transform; transform: translateZ(0);
    │                                 backface-visibility: hidden; contain: layout paint; isolation: isolate)
    │   └── .ft-body.ft-body--claude (overflow: visible)
    │       └── ClaudeChat
    │           └── .cc-chat-col     (flex column, NO contain/isolation/will-change)
    │               └── .cc-scroll-frame
    │                   └── .cc-messages  (Virtuoso scroller — overflow-y: auto;
    │                                     overscroll-behavior-y: none; NO contain/isolation/
    │                                     will-change; NO layer promotion)
    │                       └── Virtuoso-generated item wrappers
    │                           └── .cc-row → .cc-message → .cc-bubble (streaming text here)
```

Transform is written **directly to DOM** (`Canvas.tsx:89`) bypassing React, so each gesture/wheel tick is a composite-only update (no React reconciliation). Good.

## Question-by-question audit

### Q1. Is `--canvas-zoom` bleeding into any `cc-*` rule?

**No.** Grep `--canvas-zoom` across `src/**` returns 4 hits, all in `XTerminal.css` (lines 13/14/15 — width/height/counter-scale) plus the setter in `Canvas.tsx:94`. No `cc-*` rule consumes the var. The counter-scale is *terminal-only*; chat is unaffected. ✅ clean.

### Q2. Do `will-change`, `contain`, or `isolation` appear on chat containers?

Grepped across the whole `src/` tree:

| Selector                   | will-change | contain         | isolation |
|----------------------------|-------------|-----------------|-----------|
| `.floating-terminal`       | transform   | layout paint    | isolate   |
| `.cc-chat-col`             | — none —    | — none —        | — none —  |
| `.cc-scroll-frame`         | — none —    | — none —        | — none —  |
| `.cc-messages` (scroller)  | — none —    | — none —        | — none —  |
| `.cc-row` / `.cc-message` / `.cc-bubble` | — none — | — none — | — none — |

Only the panel wrapper is a compositing boundary. The Virtuoso scroller and every row inside it share a paint context with the panel body. During token streaming, every DOM mutation inside `.cc-bubble` (streaming row) invalidates paint on that shared layer. The existing `contain: layout paint` on `.floating-terminal` caps **layout** invalidation from propagating *upward*, but does not sub-divide **paint** within the panel — so a token append inside the streaming bubble still repaints the whole composited texture of the panel body on that frame.

### Q3. Does Virtuoso receive correct bounding rects when an ancestor has fractional scale?

**Mostly yes, with one important caveat.**

Virtuoso measures item heights with `ResizeObserver`. The observer reports `contentRect` in the element's **own layout box coordinates** — ancestor transforms do **not** change the observed box. Verified by spec (CSS Resize Observer 1) and WebKit's impl. So the core measurement loop is insulated from `scale(z)`.

Scroll math is also layout-pixel based: `scrollTop`, `scrollHeight`, `clientHeight`, and Virtuoso's `atBottom = (scrollHeight - scrollTop - clientHeight) < atBottomThreshold` are all in the scroller's layout pixels, **unaffected by ancestor scale**. `atBottomThreshold={24}` and the `16px` `.cc-bottom-spacer` stay in proportion regardless of zoom. ✅

**Caveat — fractional sub-pixel positions:** when `.canvas-content` is at e.g. `scale(1.234)`, the floating panel's **post-composite** screen rect is fractional. Any code path inside Virtuoso that uses `getBoundingClientRect()` on the scroller for anchor computation (e.g. during programmatic `scrollToIndex` to align visible items) receives **post-transform** coordinates. Those are fractional-pixel values. React-virtuoso does internal rounding, so this is not directly the jitter source, but it's a real divergence between "what Virtuoso thinks the viewport edge is at" and "what the browser actually composited" — a known source of sub-pixel shimmer on long scrolls inside scaled parents.

### Q4. Does Virtuoso's ResizeObserver fire on every `--canvas-zoom` change?

**No for the scroller, no for item rows.** Verified:

- ResizeObserver fires when the **observed box's** border/content box dimensions change. Ancestor `transform` does not change those. I confirmed by reading the CSS Resize Observer spec §4.1.2 and cross-checking the Virtuoso `useSize` hook pattern.
- `.cc-messages` grows/shrinks only on panel resize (drag handle) or window resize. Zoom alone does not trigger it.
- `.cc-row` items are `width: 100%; max-width: 100%` of the scroller's content box. Zoom does not resize the content box (layout box is pre-transform), so per-item observers stay quiet too.

So the "every zoom tick fires N ResizeObservers" hypothesis is **disproved**. This is not where the cost is.

**However**, panel resize **does** trigger `N_items` observer callbacks in one microtask, each invalidating cached heights and potentially re-triggering Virtuoso's range calc. That's a real cost but it's orthogonal to canvas zoom.

### Q5. GPU compositing at fractional zoom — is the chat scroller's paint degrading?

**Yes, plausibly.** Three mechanisms stack up:

1. **Shared paint layer with panel body.** Because `.cc-messages` has no `will-change` / `contain: paint` / `isolation`, the scroller and its contents share the panel's single composited layer. During streaming, every token append invalidates a large sub-rect of that layer. At `scale(z != 1)` the rasterization target is the **scaled** layer, so the browser must re-rasterize text glyphs at a fractional device-pixel resolution each time. This is significantly more expensive than rasterizing at 1:1 and is a known source of frame drops in Tauri/WebKit.

2. **Scrolling inside a scaled ancestor.** When the user scrolls during streaming, two invalidations compete:
   - The scroll layer shifts (cheap — pure compositor translation), but only if the scroller has its own layer.
   - The paint invalidation from streaming re-rasterizes.
   Because `.cc-messages` is **not layer-promoted**, the scroll shift can't happen independently of the streaming paint, so both end up on the same layer's repaint budget each frame. Add the ancestor `scale(z)` and every repaint pays the fractional-scale rasterization tax.

3. **Text shimmer / subpixel anti-aliasing at fractional scale.** WebKit's text rasterizer uses subpixel AA by default; at non-integer effective scales, a growing text run (streaming token append) re-rasterizes glyphs at slightly different subpixel alignments each frame — **this matches the "jitter during streaming" symptom exactly**. Isolating the streaming bubble onto its own compositing layer fixes this by giving glyphs a consistent 1:1 raster target that the compositor then scales as a unit.

### Q6. Does the direct-DOM transform-write in `Canvas.tsx:89` cause React to re-render anything in chat?

**No.** The canvas store update triggers the `useCanvasStore.subscribe` callback registered in `Canvas.tsx:100`, which writes `content.style.transform` and `content.style.setProperty("--canvas-zoom", ...)` **directly** without going through React. Also `const zoom = useCanvasStore((s) => s.zoom);` in `Canvas.tsx:43` **does** re-render `Canvas` (for the zoom badge) but not `FloatingTerminal`/`ClaudeChat` (they don't read zoom). ✅ no React storm from zoom.

Verified by reading `Canvas.tsx:76-101` — the apply loop is a closed system; chat state never touches zoom.

## Ranked findings (most → least likely cause of chat jitter)

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | `.cc-messages` is not layer-promoted, so streaming text re-rasterization happens on the panel's shared layer *through* the ancestor `scale(z)` — fractional-scale subpixel AA → visible glyph shimmer during streaming. | **High** | Promote the scroller to its own compositing layer. |
| 2 | Scroll shift and stream repaint share the same layer, so scroll-to-bottom paints compete with streaming paints each frame. | **High** | Same fix as #1 — layer-promote the scroller. |
| 3 | Streaming bubble (`VisualRow` of kind `"streaming"`) mutates DOM every token and invalidates a large paint rect. With no paint containment on the row, invalidation escapes to the whole scroller. | **Medium** | `contain: content` (= `layout paint style`) on the streaming row only, toggled by a `.cc-row--streaming` class. |
| 4 | At fractional `scale(z)`, post-composite screen rects of the panel are fractional — any sub-pixel flicker from compositing can appear during scrolls. | **Low-medium** | Snap canvas zoom to integer device-pixel multiples when idle; OR accept and rely on fix #1. |
| 5 | Panel resize triggers N per-row ResizeObservers. Not a zoom issue, but amplifies jitter when the user resizes the floating panel during streaming. | **Low** | Out of this agent's scope — other agents may address. |

**Disproved concerns (do not spend budget fixing):**

- `--canvas-zoom` bleeding into chat styles — ruled out by grep.
- Virtuoso ResizeObserver firing on every zoom change — ruled out by spec. Only fires on actual layout box changes.
- React re-render storm from zoom — ruled out by reading the store-subscription path.

## Proposed CSS fixes (for orchestrator)

**All fixes are CSS-only, no JS needed.** In priority order:

### Fix A — promote `.cc-messages` to its own compositing layer (highest impact)

In `src/components/claude/ClaudeChat.css` at the `.cc-messages` rule (line 429):

```css
.cc-messages {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 64px 0 48px;
  min-height: 0;
  overscroll-behavior-y: none;
  scroll-behavior: auto;
  margin-right: 8px;

  /* ↓ Add these ↓ */
  /* Promote to own compositing layer: decouples scroll-shift from stream
     repaint and gives text glyphs a stable 1:1 raster target that the
     compositor then scales under the canvas transform. Fixes subpixel
     shimmer during streaming when canvas zoom != 1. */
  contain: layout paint;
  will-change: transform;
  transform: translateZ(0);
  isolation: isolate;
}
```

Rationale: mirrors the `.floating-terminal` treatment one level deeper. The `transform: translateZ(0)` is what actually forces layer promotion in WebKit; `will-change: transform` is the standards-compliant hint; `contain: layout paint` limits reflow propagation; `isolation: isolate` creates a new stacking context so z-index tricks inside the scroller don't leak.

**Memory cost:** one extra GPU texture sized to the scroller's viewport. For a typical 600×800 panel that's ~2 MB. Trivial.

### Fix B — contain the streaming row's paint

The streaming bubble is rendered as a real list item (`VisualRow` of kind `"streaming"` per commit `2f933cf3`). Add a class hook to that row so only **that** row gets paint containment — every other row can stay in the normal flow for selection, KaTeX reflow, etc.

In `ClaudeChat.tsx` where `.cc-row` is rendered for streaming items, add `cc-row--streaming` class. Then in `ClaudeChat.css`:

```css
/* Streaming row paints into its own sub-layer so token appends don't
   invalidate paint on adjacent rows. `contain: content` = `layout paint
   style`. Do NOT add `size` — the row must grow as tokens stream in. */
.cc-row--streaming {
  contain: content;
  will-change: contents;
}
```

Note: `will-change: contents` is cheap (hints text will change) — don't use `will-change: transform` here, that would pin an extra GPU layer per row.

### Fix C — optional: snap canvas zoom when idle

Lowest priority. After the wheel/gesture handler stops firing for 300ms, round zoom to the nearest multiple that makes the device-pixel ratio clean (`z' = Math.round(z * dpr) / dpr`). Would eliminate the remaining sub-pixel divergence between layout and composite rects. Only do this if A + B don't fully fix the jitter.

### Fix D — rejected

- **Do not** disable ancestor transform during streaming — that would visually snap the panel out of place.
- **Do not** add `contain: strict` to `.cc-messages` — it forces explicit size, breaking `flex: 1`.
- **Do not** add `will-change: transform` on every `.cc-row` — that would allocate N GPU layers.
- **Do not** remove the canvas `transform: scale()` — the whole app depends on it.

## Why this matches the user's symptoms

| Symptom | Explained by |
|---|---|
| Jitter during streaming | Fix A/B — fractional-scale glyph re-rasterization and paint-layer sharing |
| Trouble staying at bottom | Fix A — scroll-shift competes with stream repaint on same layer, so the auto-scroll frame sometimes loses the race against the next incoming token-append paint |
| "Fine at zoom = 1, bad at zoom ≠ 1" | Fractional-scale rasterization penalty only applies when z ≠ integer DPR multiples |
| Panel resize during streaming spikes | Panel-resize-triggered ResizeObserver storm (finding #5) — tracked for other agents |

## Confidence

- High confidence: findings 1, 2, 3, Q1–Q4 answers, Fix A, Fix B.
- Medium confidence: Fix A alone being sufficient — may need Fix B too for very long streams.
- Low confidence (speculation): Fix C helps. It's conservative and optional.
