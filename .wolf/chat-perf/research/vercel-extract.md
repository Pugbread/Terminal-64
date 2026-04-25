# Vercel ai-chatbot scroll extract + port plan

Source commits in `/tmp/vercel-ai-chatbot` (master 2026-04) and `/tmp/vercel-ai-chatbot-history` (full history). Library source in `/tmp/use-stick-to-bottom`.

## TL;DR (strategy)

Vercel ships **two parallel scroll systems** and the main chat uses the **custom one**, not the library:

1. **Current main `Chat`** (`components/chat/messages.tsx`) uses a hand-rolled `useScrollToBottom` hook — a single native scroll container plus `MutationObserver` + `ResizeObserver` that re-scrolls to bottom only when `isAtBottomRef && !isUserScrollingRef`. No Virtuoso. No `use-stick-to-bottom`.
2. **`use-stick-to-bottom` wrapper** exists as a generic AI-elements building block (`components/ai-elements/conversation.tsx`) — `<StickToBottom>` + `<StickToBottom.Content>`. The polished chat does **not** use it. They ship it as an opt-in primitive only.

Their auto-scroll lives entirely outside React reconciliation: DOM observers fire → a `requestAnimationFrame` sets `scrollTop`. No per-token re-render of the scroll logic.

## 1. Current Vercel chat code (canonical extract)

### 1.1 `hooks/use-scroll-to-bottom.tsx` (full hook, 124 lines)

`/tmp/vercel-ai-chatbot/hooks/use-scroll-to-bottom.tsx:1-124`

Core state:
```ts
const containerRef = useRef<HTMLDivElement>(null);
const endRef      = useRef<HTMLDivElement>(null);
const [isAtBottom, setIsAtBottom] = useState(true);
const isAtBottomRef      = useRef(true);  // mirror, read from observers
const isUserScrollingRef = useRef(false); // debounced 150ms on scroll event
```

Bottom detection (`:14-20`):
```ts
const checkIfAtBottom = useCallback(() => {
  const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
  return scrollTop + clientHeight >= scrollHeight - 100;   // 100px tolerance
}, []);
```

User-scroll debouncer (`:40-51`):
```ts
const handleScroll = () => {
  isUserScrollingRef.current = true;
  clearTimeout(scrollTimeout);
  const atBottom = checkIfAtBottom();
  setIsAtBottom(atBottom); isAtBottomRef.current = atBottom;
  scrollTimeout = setTimeout(() => { isUserScrollingRef.current = false; }, 150);
};
```

The auto-scroll pump — the part worth stealing (`:60-97`):
```ts
const scrollIfNeeded = () => {
  if (isAtBottomRef.current && !isUserScrollingRef.current) {
    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
      setIsAtBottom(true);
      isAtBottomRef.current = true;
    });
  }
};
const mutationObserver = new MutationObserver(scrollIfNeeded);
mutationObserver.observe(container, { childList: true, subtree: true, characterData: true });
const resizeObserver = new ResizeObserver(scrollIfNeeded);
resizeObserver.observe(container);
for (const child of container.children) resizeObserver.observe(child);
```

Exports: `{ containerRef, endRef, isAtBottom, scrollToBottom, onViewportEnter, onViewportLeave, reset }`.

### 1.2 `hooks/use-messages.tsx` (streaming glue)

`/tmp/vercel-ai-chatbot/hooks/use-messages.tsx:1-40` — forwards everything plus a `hasSentMessage` flag that flips true on `status === "submitted"`. Used only to enable a `requiresScrollPadding` hint on the last assistant message. **In current main that prop is ignored** (`components/chat/message.tsx:33` destructures it as `_requiresScrollPadding`).

### 1.3 The original `min-h-96` padding trick (scrapped, still relevant)

Older commit `45978c2` (2025-05-01, "refactor: update auto scroll mechanism") introduced a CSS hack: the last assistant bubble gets `min-h-96` so the new message always has room to scroll to. `/tmp/vercel-ai-chatbot-history` @ `45978c2:components/message.tsx:72`:
```tsx
<div className={cn('flex flex-col gap-4 w-full', {
  'min-h-96': message.role === 'assistant' && requiresScrollPadding,
})}>
```
Recent refactors (`f9652b4`) plumbed `requiresScrollPadding` through but stopped rendering it. Takeaway: the current pump is strong enough that they dropped the CSS padding.

### 1.4 `components/chat/messages.tsx` (how it's wired)

`/tmp/vercel-ai-chatbot/components/chat/messages.tsx:40-124`. Single native scroller, no virtualization:
```tsx
<div ref={messagesContainerRef}
     className="absolute inset-0 touch-pan-y overflow-y-auto">
  <div className="mx-auto flex min-h-full min-w-0 max-w-4xl flex-col gap-5 ...">
    {messages.map((m, i) => <PreviewMessage key={m.id} ... />)}
    {status === "submitted" && messages.at(-1)?.role !== "assistant" && <ThinkingMessage />}
    <div className="min-h-[24px] min-w-[24px] shrink-0" ref={messagesEndRef} />
  </div>
</div>
```
Streaming mutates an existing message object in place via `setMessages` from `useChat`; MutationObserver sees `characterData` changes and pumps scrollTop.

There is **no Stop/StopButton gating** of scroll behavior. `status === "streaming"` only marks the last message for a loading shimmer; scroll pumping is unconditional.

## 2. `use-stick-to-bottom` algorithm (library, decoupled summary)

`/tmp/use-stick-to-bottom/src/useStickToBottom.ts`.

- Near-bottom threshold: **`STICK_TO_BOTTOM_OFFSET_PX = 70`** (`:131`).
- Bottom detection uses getters on a live state object: `targetScrollTop = scrollHeight - 1 - clientHeight`, `scrollDifference = target - scrollTop`, `isNearBottom = scrollDifference <= 70` (`:210-260`).
- User-intent-to-leave is detected from **two** channels:
  - `wheel` listener: any `deltaY < 0` (`:468-496`) flips `escapedFromLock = true`, `isAtBottom = false`. Fires before scroll lands — beats the animation race.
  - `scroll` listener: compares `scrollTop` vs `lastScrollTop` (`:443-454`); only treats as user intent if `!state.resizeDifference` (resize events are ignored via `setTimeout(…, 1)` gate at `:429-463`).
- Mouse-text-selection escape hatch: listens to global mousedown/up and checks `window.getSelection()` within the scroller (`:137-174, 310-312`).
- Active scroll uses a **spring** (not smooth/instant): `damping 0.7, stiffness 0.05, mass 1.25` (`:41-64`); per-frame `velocity = (damping*v + stiffness*dx)/mass` (`:327-337`). An `instant` option exists.
- Resize disambiguation: `ResizeObserver` on content element sets `state.resizeDifference = newHeight - prevHeight`; scroll handler gates on `if (state.resizeDifference || ...) return;` so growth events don't get mis-read as user scrolls (`:514-576`).
- Overscroll correction: `if (scrollTop > targetScrollTop) scrollTop = targetScrollTop;` (`:524-525`).
- When the user scrolls up, `escapedFromLock` stays true until user scrolls down again or `preserveScrollPosition:false` reset fires.

### `<StickToBottom>` shape (library API)

`/tmp/use-stick-to-bottom/src/StickToBottom.tsx:54-173`. `<StickToBottom>` owns the outer div; `<StickToBottom.Content>` attaches `scrollRef` to the inner scroll div and `contentRef` to the growth wrapper. Context exposes `{ isAtBottom, scrollToBottom, stopScroll, escapedFromLock, state }`.

`StopButton`: not in the library. Vercel's `<ConversationScrollButton>` (`components/ai-elements/conversation.tsx:74-101`) is a trivial "jump to bottom" using `useStickToBottomContext`. No "is generating" gating.

## 3. Can we use `use-stick-to-bottom` directly with Virtuoso?

**No.** Three hard incompatibilities:

1. `<StickToBottom.Content>` hard-codes the DOM layout `scrollRef → contentRef` and writes `style.overflow = "auto"` on the scroller (`StickToBottom.tsx:124-132`). Virtuoso owns its own scroller via `scrollerRef` and refuses to share.
2. The library drives scroll via direct `scrollTop = X` writes on `scrollRef.current`. Virtuoso intercepts these; the library would fight Virtuoso's internal anchoring and produce exactly the jitter we already have.
3. `ResizeObserver` on the `contentElement` is meaningless under virtualization — the content div's size reflects only rendered rows, not the true list length. The library's growth-detection math breaks.

Verdict: **lift the algorithm, don't install the library.** Vercel came to the same conclusion for their own chat — they pair it only with a plain overflow-auto `<div>`.

## 4. Concrete port plan for ClaudeChat.tsx

Target file: `/Users/janislacars/Documents/Terminal-64/src/components/claude/ClaudeChat.tsx` (2496 lines).

Current model (lines 442–616): `stickyRef` is a boolean ref flipped false on wheel-up / touch-up, and a store-subscription pump calls `virtuosoRef.current.scrollToIndex('LAST')` on `streamingText` growth. That's structurally identical to `use-stick-to-bottom` minus the spring and minus the wheel→escape lock reset on scroll-down.

### Steal these four specific pieces:

1. **Stricter wheel-up escape + scroll-down re-lock** (library `:443-462`, ours only flips false and never re-arms mid-stream until user hits bottom). Replace the current wheel/touch handlers with:
   - `wheel` deltaY<0 → `stickyRef=false`.
   - `scroll` event: if `scrollTop > lastScrollTop` and `isNearBottom` → `stickyRef=true` (user scrolled down to catch up, re-engage).
   - Both guarded by `if (state.resizeDifference) return;` — a 1ms `setTimeout` on scroll handler to let a concurrent `ResizeObserver` land first.

2. **70px near-bottom tolerance instead of the current `BOTTOM_TOLERANCE_PX`** (ClaudeChat `:398`). Matches library; prior Vercel hook used 100px. Our current value should be cross-checked — if it's <40 we're seeing false-leave; if >120 we're seeing false-stick.

3. **Observe last-row resize, not the scroller.** Attach a single `ResizeObserver` to the live streaming row (the one `StreamingBubbleBody` renders at `ClaudeChat.tsx:162-175`). When its contentRect grows, if `stickyRef` is true and no user gesture has fired in ~50ms, call `virtuosoRef.current?.scrollToIndex({index:'LAST', align:'end', behavior:'auto'})`. This is the **same pump** already on line 600 but triggered by DOM growth instead of store subscription — catches KaTeX/mermaid layout passes that tokens don't account for.

4. **`finishedTail` reachability.** The reported "can't reach finishedTail divider" bug is the Virtuoso analog of Vercel's overscroll check (`useStickToBottom.ts:524-525`). After the stream ends (`hasStreamingText: true → false`), fire one final `scrollToIndex('LAST', align:'end')` in rAF; if the visible row count grew inside that same tick, fire a second one on the next rAF. Our current `pumpEnd` at commit `7b03c89c` already does this — verify it still runs after the commit that split follow (`5017cef9`).

### Do NOT port:
- Spring animation — 60fps instant scroll is what users expect in a streaming terminal-adjacent UI; spring adds visual lag.
- `<StickToBottom>` context wrapper — Virtuoso already supplies `atBottomStateChange`; use our own ref-based state.
- `use-stick-to-bottom` package dependency — adds ~5KB for zero functional gain under Virtuoso.

### Verification after port:
- Hold wheel-up during stream → island/"scroll to bottom" button appears within one frame.
- Release + scroll down past 70px-from-bottom → stickyRef re-arms, pump resumes without clicking the button.
- Stream finishes mid-long-message → clicking finishedTail divider area lands exactly on it (no bounce).
- KaTeX render during stream → no upward jitter, bottom stays pinned.
