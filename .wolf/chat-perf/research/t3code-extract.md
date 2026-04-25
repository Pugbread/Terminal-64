# t3code Chat Scroll / Streaming Extract

Source repo: `/tmp/t3code` (pingdotgg/t3code).
Relevant files:
- `apps/web/src/components/chat/MessagesTimeline.tsx` (list owner)
- `apps/web/src/components/ChatView.tsx` (scroll state owner, send handler)
- `apps/web/src/components/chat/ChatComposer.tsx` (composer resize → pump)

## Architecture at a glance

1. **Scroll state lives OUTSIDE the list.** ChatView owns two refs only: `legendListRef` (imperative) and `isAtEndRef` (a boolean mirror). That's it. No "stickyRef", no wheel listeners, no touch listeners, no ResizeObserver on the scroll viewport. **All bottom-detection is delegated to `@legendapp/list`.**
2. **Streaming growth is NOT pumped from the consumer.** Streaming text is part of the same row's data; LegendList's `maintainScrollAtEnd` + `maintainVisibleContentPosition` handle follow natively. No `claudeStore.subscribe` pump.
3. **User-send proactively snaps to bottom BEFORE appending the optimistic message.** This is the load-bearing trick — it flips the list into "at-end" mode so the built-in follow re-engages even if the user had scrolled away.
4. **Debounced "show pill" only.** The scroll-to-bottom pill waits 150ms before appearing (avoids thread-switch flash). Hiding is immediate.

## Code excerpts

### ChatView state (refs only — no ResizeObserver, no wheel)
`apps/web/src/components/ChatView.tsx:710-711`
```tsx
const legendListRef = useRef<LegendListRef | null>(null);
const isAtEndRef = useRef(true);
```

### onIsAtEndChange + debounced pill
`ChatView.tsx:1983-2018`
```tsx
const scrollToEnd = useCallback((animated = false) => {
  legendListRef.current?.scrollToEnd?.({ animated });
}, []);

const showScrollDebouncer = useRef(
  new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
);
const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
  if (isAtEndRef.current === isAtEnd) return;
  isAtEndRef.current = isAtEnd;
  if (isAtEnd) {
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  } else {
    showScrollDebouncer.current.maybeExecute();
  }
}, []);

useEffect(() => {
  isAtEndRef.current = true;
  showScrollDebouncer.current.cancel();
  setShowScrollToBottom(false);
  // ...
}, [activeThread?.id]);
```

### The send — snap BEFORE appending
`ChatView.tsx:2502-2509` (and duplicated at 2902-2906)
```tsx
// Scroll to the current end *before* adding the optimistic message.
// This sets LegendList's internal isAtEnd=true so maintainScrollAtEnd
// automatically pins to the new item when the data changes.
isAtEndRef.current = true;
showScrollDebouncer.current.cancel();
setShowScrollToBottom(false);
await legendListRef.current?.scrollToEnd?.({ animated: false });

setOptimisticUserMessages((existing) => [...existing, /* new msg */]);
```

### LegendList props — the whole follow contract
`apps/web/src/components/chat/MessagesTimeline.tsx:252-266`
```tsx
<LegendList<MessagesTimelineRow>
  ref={listRef}
  data={rows}
  keyExtractor={keyExtractor}
  renderItem={renderItem}
  estimatedItemSize={90}
  initialScrollAtEnd
  maintainScrollAtEnd
  maintainScrollAtEndThreshold={0.1}
  maintainVisibleContentPosition
  onScroll={handleScroll}
  className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
  ListHeaderComponent={<div className="h-3 sm:h-4" />}
  ListFooterComponent={<div className="h-3 sm:h-4" />}
/>
```

### Reading isAtEnd out of the list
`MessagesTimeline.tsx:167-190`
```tsx
const handleScroll = useCallback(() => {
  const state = listRef.current?.getState?.();
  if (state) onIsAtEndChange(state.isAtEnd);
}, [listRef, onIsAtEndChange]);

const previousRowCountRef = useRef(rows.length);
useEffect(() => {
  const previousRowCount = previousRowCountRef.current;
  previousRowCountRef.current = rows.length;
  if (previousRowCount > 0 || rows.length === 0) return;
  onIsAtEndChange(true);
  const frameId = window.requestAnimationFrame(() => {
    void listRef.current?.scrollToEnd?.({ animated: false });
  });
  return () => window.cancelAnimationFrame(frameId);
}, [listRef, onIsAtEndChange, rows.length]);
```

### Composer height change → re-pin (ONLY pump they keep)
`ChatComposer.tsx:1101-1124`
```tsx
const observer = new ResizeObserver((entries) => {
  const [entry] = entries; if (!entry) return;
  // ...footer compactness...
  const nextHeight = entry.contentRect.height;
  const previousHeight = composerFormHeightRef.current;
  composerFormHeightRef.current = nextHeight;
  if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
  if (!shouldAutoScrollRef.current) return;
  scheduleStickToBottom();
});
observer.observe(composerForm);
```

**That is the full scroll logic.** No wheel, no touch, no MutationObserver, no streaming pump.

## Porting plan for Virtuoso-based ClaudeChat

### Directly portable (no translation)
1. **Snap-before-append on send.** Drop into `handleSend` at `ClaudeChat.tsx:901` right before `addUserMessage`: set `stickyRef.current = true`; call `scrollToBottom()`; await one rAF. Works unchanged.
2. **Debounced pill show.** Replace the current immediate `setIsScrolledUp` with: hide immediate, show debounced 150ms. Cancel debouncer on session switch.
3. **Session-switch flow.** Already close: keep `stickyRef.current = true` + rAF scrollToBottom at `ClaudeChat.tsx:581-586`; also cancel the show-debouncer there.

### Needs translation (Virtuoso ≠ LegendList)

| t3code (LegendList) | Virtuoso equivalent |
|---|---|
| `maintainScrollAtEnd` | `followOutput={() => stickyRef.current ? "auto" : false}` — we already have this |
| `maintainScrollAtEndThreshold={0.1}` | Set `atBottomThreshold={BOTTOM_TOLERANCE_PX}` (default 4px — raise to ~60) |
| `maintainVisibleContentPosition` | Virtuoso does this implicitly via `followOutput` + measurement |
| `initialScrollAtEnd` | `initialTopMostItemIndex={visualRows.length - 1}` — already have |
| `getState().isAtEnd` | `atBottomStateChange={(atBottom) => ...}` callback |

### Concrete patches to `ClaudeChat.tsx`

**Patch 1 — delete the custom wheel/touch/scroll listeners (lines 385-437).** Replace with a lean scroll-progress commit (we still want the prompt-island ring). Keep the `commitState` math but remove `onWheel`, `onTouchStart`, `onTouchMove` — let Virtuoso's `atBottomStateChange` be the single source of truth for `stickyRef`. This is the biggest behavior change.

**Patch 2 — wire Virtuoso callbacks (line 2193 block).** Add:
```tsx
atBottomThreshold={60}
atBottomStateChange={(atBottom) => {
  if (stickyRef.current === atBottom) return;
  stickyRef.current = atBottom;
  if (atBottom) {
    showScrollDebouncer.current.cancel();
    setIsScrolledUp(false);
  } else {
    showScrollDebouncer.current.maybeExecute();
  }
}}
```
Add a `showScrollDebouncer` ref in the component body (line ~568 near `stickyRef`).

**Patch 3 — delete the streaming pump at `ClaudeChat.tsx:598-619`.** This is the biggest simplification. Virtuoso's `followOutput` handles same-item growth too as long as we don't fight it — their doc-promise is that it re-measures on data-ref change and ours does change (`streamingText` lives in the row descriptor). If follow lags, fall back to `followOutput={(isAtBottom) => stickyRef.current ? "smooth" : false}` and trust Virtuoso. The t3code bet: the consumer should NEVER manually manipulate scrollTop during streaming.

**Patch 4 — snap before send.** In `handleSend` at line 901, before any `addUserMessage`:
```tsx
stickyRef.current = true;
showScrollDebouncer.current.cancel();
setIsScrolledUp(false);
virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
await new Promise(requestAnimationFrame);
```

**Patch 5 — delete `BOTTOM_TOLERANCE_PX` duplication** (line 558). It becomes `atBottomThreshold` only.

### The philosophical shift
t3code trusts the virtual-list library's bottom-detection completely. Our current ClaudeChat explicitly distrusts Virtuoso (comments at 560-564 document a past bug). The port is essentially: **stop distrusting it, but keep snap-before-send as belt-and-braces**, and replace our wheel/touch intent-detection with the library's own `atBottomStateChange` + a 60px threshold so tapping the scrollbar re-engages sticky.

### Risk
Our commit history (`5017cef9`, `a73095fb`, `a212e08b`, `7b03c89c`, `7e2ce47e`) explicitly moved *toward* owning sticky state because Virtuoso's `atBottomStateChange` flipped false mid-stream. t3code dodges this because LegendList's threshold (0.1 of viewport) is much larger than Virtuoso's default 4px. **The port hinges on `atBottomThreshold={60}` being large enough to survive a single row-height growth mid-stream.** If it isn't, keep the current streaming pump but drop the wheel/touch listeners and use `atBottomStateChange` as the only source for `stickyRef`.
