# Agent 1 — Best-in-class React Streaming Chat Scroll Patterns

Research-only. Four reference implementations studied, each with concrete code excerpts.
Goal: extract the precise techniques each uses for (a) detecting user intent to leave
bottom, (b) growth-during-streaming handling, (c) stick-to-bottom math, and (d) what
threshold/anchor definitions they use. End of file has a synthesized recommendation
for Terminal-64's ClaudeChat.

Repos consulted:
1. `stackblitz/use-stick-to-bottom` (the library that solves this exact problem — powers bolt.new)
2. `vercel/ai-chatbot` (official Next.js template; ships both a custom hook and a `use-stick-to-bottom` wrapper)
3. `mckaywrigley/chatbot-ui` (open ChatGPT-style clone)
4. `petyosi/react-virtuoso` — official `follow-output` examples + the dedicated `@virtuoso.dev/message-list` package (which Terminal-64 does NOT currently use)
5. `yasasbanukaofficial/claude-code` — inspected but is an Ink-based terminal UI, not a web chat panel. No applicable patterns; excluded from comparison.

---

## 1. `stackblitz/use-stick-to-bottom` — the gold standard

**Library:** none. Zero-dependency React hook over a native scroller + ResizeObserver.
Not compatible with virtualization libraries that own the scroll container — you use
it on a `div { overflow: auto }` that wraps the full rendered message list.

### 1.1 Stick-to-bottom math (no IntersectionObserver)

Anchor is computed imperatively, not via a sentinel:

```ts
// src/useStickToBottom.ts
const STICK_TO_BOTTOM_OFFSET_PX = 70;

get targetScrollTop() {
    if (!scrollRef.current || !contentRef.current) return 0;
    return scrollRef.current.scrollHeight - 1 - scrollRef.current.clientHeight;
},
get scrollDifference() {
    return this.calculatedTargetScrollTop - this.scrollTop;
},
get isNearBottom() {
    return this.scrollDifference <= STICK_TO_BOTTOM_OFFSET_PX;
},
```

The `-1` on `scrollHeight` is deliberate — browsers can't always land exactly on
`scrollHeight - clientHeight`, so the target is 1 px shy to guarantee a reachable
number. **Threshold: 70 px** near-bottom tolerance.

Note: **no IntersectionObserver anywhere** in the library despite the task brief
mentioning it. The "anchor" is purely a computed scrollTop number, watched via a
`ResizeObserver` on the content element.

### 1.2 Growth during streaming → ResizeObserver drives the re-scroll

```ts
state.resizeObserver = new ResizeObserver(([entry]) => {
    const { height } = entry.contentRect;
    const difference = height - (previousHeight ?? height);
    state.resizeDifference = difference;

    if (state.scrollTop > state.targetScrollTop) {
        state.scrollTop = state.targetScrollTop;          // un-overscroll
    }
    setIsNearBottom(state.isNearBottom);

    if (difference >= 0) {
        // content grew: if we're "stuck", animate back to bottom
        const animation = mergeAnimations(
            optionsRef.current,
            previousHeight ? optionsRef.current.resize : optionsRef.current.initial,
        );
        scrollToBottom({
            animation,
            wait: true,                       // queue behind any in-flight scroll
            preserveScrollPosition: true,     // don't force stickiness on if user escaped
            duration: animation === "instant" ? undefined : RETAIN_ANIMATION_DURATION_MS,
        });
    } else if (state.isNearBottom) {
        // content shrank & we ended up near bottom → re-lock
        setEscapedFromLock(false);
        setIsAtBottom(true);
    }
    previousHeight = height;
});
```

The **growth side** triggers a spring-animated catch-up scroll (defaults:
`{ damping: 0.7, stiffness: 0.05, mass: 1.25 }`). The **shrink side** re-locks if the
shrink brought content near the bottom. `preserveScrollPosition: true` is load-bearing:
it means "only scroll if we're already stuck; don't grab the user back."

### 1.3 User-intent-to-leave detection — belt + suspenders

Two independent signals, deliberately overlapping:

**Signal A — wheel event (catches the case the browser cancels our programmatic scroll):**
```ts
const handleWheel = ({ target, deltaY }: WheelEvent) => {
    let element = target as HTMLElement;
    while (!["scroll", "auto"].includes(getComputedStyle(element).overflow)) {
        if (!element.parentElement) return;
        element = element.parentElement;
    }
    if (
        element === scrollRef.current &&
        deltaY < 0 &&
        scrollRef.current.scrollHeight > scrollRef.current.clientHeight &&
        !state.animation?.ignoreEscapes
    ) {
        setEscapedFromLock(true);
        setIsAtBottom(false);
    }
};
```
Upward wheel → immediate unpin. No threshold, no debounce. Comment in code
explains why: *"The browser may cancel the scrolling from the mouse wheel if we
update it from the animation in meantime."* So wheel-up is authoritative.

**Signal B — scroll event with direction derivation + resize-event disambiguation:**
```ts
const handleScroll = ({ target }: Event) => {
    if (target !== scrollRef.current) return;
    const { scrollTop, ignoreScrollToTop } = state;
    let { lastScrollTop = scrollTop } = state;
    state.lastScrollTop = scrollTop;
    state.ignoreScrollToTop = undefined;

    if (ignoreScrollToTop && ignoreScrollToTop > scrollTop) {
        // animation-cancelled-by-user case: use the ignored value for direction
        lastScrollTop = ignoreScrollToTop;
    }
    setIsNearBottom(state.isNearBottom);

    setTimeout(() => {
        // IMPORTANT: the 1ms setTimeout lets a ResizeObserver event fire first
        // if one is pending. If `resizeDifference` is non-zero, this scroll
        // event was caused by a resize, not the user — ignore it.
        if (state.resizeDifference || scrollTop === ignoreScrollToTop) return;
        if (isSelecting()) { setEscapedFromLock(true); setIsAtBottom(false); return; }

        const isScrollingDown = scrollTop > lastScrollTop;
        const isScrollingUp = scrollTop < lastScrollTop;

        if (state.animation?.ignoreEscapes) { state.scrollTop = lastScrollTop; return; }
        if (isScrollingUp)   { setEscapedFromLock(true); setIsAtBottom(false); }
        if (isScrollingDown) { setEscapedFromLock(false); }
        if (!state.escapedFromLock && state.isNearBottom) setIsAtBottom(true);
    }, 1);
};
```

Three nuances that Terminal-64 probably isn't handling:
- **Resize-vs-user disambiguation via 1ms setTimeout + `resizeDifference` flag.** Scroll events fired as a side-effect of `ResizeObserver`-driven DOM growth look identical to user-initiated scroll events. They use the 1ms queue-yield trick so the ResizeObserver callback sets `resizeDifference` first, then the scroll handler sees it and bails.
- **Text-selection suppression.** `isSelecting()` checks global `mousedown` + `window.getSelection()` to treat click-drag-select as "user escaped the lock" (otherwise the selection anchor jumps during streaming).
- **`ignoreScrollToTop` reconciliation.** When we programmatically set `scrollTop`, we stash the value. If the next scroll event's `scrollTop` matches, it was ours → ignore. If the user scrolls up *during* the programmatic scroll, the direction comparison uses the ignored value instead of the last real user value so `isScrollingUp` is still correct.

### 1.4 Custom spring animation (not CSS smooth, not `scroll-behavior`)

Uses a per-frame velocity integrator instead of `element.scrollTo({ behavior: 'smooth' })`:

```ts
state.velocity =
    (behavior.damping * state.velocity +
     behavior.stiffness * state.scrollDifference) / behavior.mass;
state.accumulated += state.velocity * tickDelta;
state.scrollTop += state.accumulated;
if (state.scrollTop !== scrollTop) state.accumulated = 0;
```

README justification: *"Other libraries use easing functions with durations instead,
but these don't work well when you want to stream in new content with variable
sizing — which is common for AI chatbot use cases."* Duration-based smooth-scroll
stutters when the target (`scrollHeight`) keeps moving mid-animation; a velocity
spring with a constantly recomputed `scrollDifference` chases a moving target
smoothly.

### 1.5 CSS guard baked in

```ts
useIsomorphicLayoutEffect(() => {
    if (!scrollRef.current) return;
    if (getComputedStyle(scrollRef.current).overflow === "visible") {
        scrollRef.current.style.overflow = "auto";
    }
}, []);
```

Also sets `scrollbar-gutter: stable both-edges` on the Content wrapper, which
eliminates a reflow at the moment scrollbars appear/disappear — a subtle but real
source of jitter.

---

## 2. `vercel/ai-chatbot` — ships TWO approaches in the same repo

Two files, two philosophies. Interesting because Vercel evidently decided the
community library wasn't quite enough and wrote a lighter custom hook too.

### 2.1 `components/ai-elements/conversation.tsx` — just wraps the library

```tsx
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
export const Conversation = ({ className, ...props }) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);
// Scroll-to-bottom button gated on isAtBottom
const { isAtBottom, scrollToBottom } = useStickToBottomContext();
return !isAtBottom && <Button onClick={() => scrollToBottom()}>…</Button>;
```

Used for the AI-elements published component library.

### 2.2 `hooks/use-scroll-to-bottom.tsx` — their hand-rolled hook

Used by `components/chat/messages.tsx`. This is the simpler pattern. No library.

```ts
// growth handling: MutationObserver + ResizeObserver, NOT scroll events
const checkIfAtBottom = () => {
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollTop + clientHeight >= scrollHeight - 100;  // 100 px threshold
};

// user intent: scroll event sets `isUserScrollingRef` true, cleared 150ms later
const handleScroll = () => {
    isUserScrollingRef.current = true;
    clearTimeout(scrollTimeout);
    const atBottom = checkIfAtBottom();
    setIsAtBottom(atBottom);
    isAtBottomRef.current = atBottom;
    scrollTimeout = setTimeout(() => { isUserScrollingRef.current = false; }, 150);
};

// growth: if we're at bottom AND the user isn't actively scrolling, stick.
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

Key differences vs. `use-stick-to-bottom`:
- **Threshold: 100 px** (vs. 70).
- **User-intent signal is time-based.** "User scrolled → 150 ms grace → allowed to auto-scroll again." Simpler than the resize-vs-user disambiguation the library does, but it means the 150 ms window after every scroll event blocks stickiness. Works fine when scroll events aren't constantly firing from programmatic scrolls.
- **Growth is detected via `MutationObserver` *and* `ResizeObserver`.** `MutationObserver` fires on `characterData` changes — so streaming text updates that don't change layout *do* fire the observer. `ResizeObserver` catches layout-changing growth (new blocks, images loading). Both funnel into the same `scrollIfNeeded` callback.
- **`behavior: "instant"`**, not smooth. No spring animation. Content appends at the bottom of the viewport every frame, no catch-up animation.
- **Uses an `endRef` element** for IntersectionObserver-style viewport-enter/leave detection — but the hook only wires the ref; the consumer currently doesn't pass them to any framer-motion `whileInView` anymore. Vestigial.

### 2.3 Consumer-side — `messages.tsx`

The consumer adds one extra flag:

```tsx
const [hasSentMessage, setHasSentMessage] = useState(false);
useEffect(() => { if (status === "submitted") setHasSentMessage(true); }, [status]);

// passed per-message as `requiresScrollPadding` for the LAST message only:
requiresScrollPadding={hasSentMessage && index === messages.length - 1}
```

The "scroll padding" is a min-height applied to the last message bubble during
streaming so the just-sent user message visually pushes to the top of the viewport
and there's room to stream into. This is a common ChatGPT-style detail and is
done at the message level, not the scroller level.

---

## 3. `mckaywrigley/chatbot-ui` — minimal, older pattern

No virtualization. Plain `div { overflow: auto }` + `messagesEndRef.scrollIntoView`.

```tsx
// components/chat/chat-hooks/use-scroll.tsx
export const useScroll = () => {
  const isAutoScrolling = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [userScrolled, setUserScrolled] = useState(false);

  useEffect(() => { setUserScrolled(false); }, [isGenerating]);
  useEffect(() => { if (isGenerating && !userScrolled) scrollToBottom(); }, [chatMessages]);

  const handleScroll: UIEventHandler<HTMLDivElement> = useCallback(e => {
    const target = e.target as HTMLDivElement;
    const bottom =
      Math.round(target.scrollHeight) - Math.round(target.scrollTop) ===
      Math.round(target.clientHeight);
    setIsAtBottom(bottom);
    if (!bottom && !isAutoScrolling.current) setUserScrolled(true);
    else setUserScrolled(false);
  }, []);

  const scrollToBottom = useCallback(() => {
    isAutoScrolling.current = true;
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
      isAutoScrolling.current = false;
    }, 100);
  }, []);
};
```

Notable flaws visible in this implementation (do NOT copy):
- **`=== clientHeight`** with `Math.round` → equality check of rounded numbers. No tolerance beyond 1 px. Fractional-pixel scroll positions on HiDPI displays break this constantly. Don't do `===`, use `>= scrollHeight - threshold`.
- **`isAutoScrolling` gated by a 100 ms setTimeout** — if a scroll event doesn't fire within 100 ms of `scrollIntoView`, `userScrolled` can get set by the next real event. Race-y.
- **Effect re-scrolls on every `chatMessages` change.** Fine for message append, but not for streaming partial-content updates (this codebase re-creates the message array reference, so effect fires). Works because it's a non-virtualized list; in a virtualized list this would fight the library.

Take-away: this is the pattern to avoid. Every bit of jank people describe in
Terminal-64 chat matches one of the bugs visible here — fractional-pixel equality,
time-based auto-scroll guard, re-scroll-on-content-change stomping user scroll.

---

## 4. `react-virtuoso` — Terminal-64's actual dependency

Three tiers of support, escalating in dedication to chat use cases:

### 4.1 Basic `followOutput` prop (what ClaudeChat uses)

```tsx
// packages/react-virtuoso/examples/follow-output.tsx
<Virtuoso
  followOutput={'smooth'}            // or 'auto' or (isAtBottom) => behavior|false
  initialTopMostItemIndex={99}
  itemContent={itemContent}
  totalCount={count}
  atBottomStateChange={(atBottom) => { /* ... */ }}
/>
```

- `followOutput` accepts: `false | 'smooth' | 'auto' | ((isAtBottom: boolean) => boolean | 'smooth' | 'auto')`.
- `'auto'` means *"stick to bottom if we were already at the bottom when new data arrived; otherwise don't."*
- **Virtuoso auto-detects user scroll-up** — if a user scrolls upward, Virtuoso internally flips its pinned state, and subsequent `followOutput` growth will NOT drag the user back. This is exactly the behavior Terminal-64 wants.

### 4.2 Item-level resize (markdown/KaTeX reflow during stream)

```tsx
// packages/react-virtuoso/examples/follow-output-async-expanded.tsx
const virtuosoRef = React.useRef<VirtuosoHandle>(null);
// ...
React.useEffect(() => {
  ref.current!.addEventListener('customLoad', () => {
    virtuosoRef.current?.autoscrollToBottom();
  });
}, []);
```

**`autoscrollToBottom()`** on `VirtuosoHandle` is the imperative scroll that
*respects pinned-at-bottom state*. Call it when a single item grows post-mount
(image finished loading, code block finished mounting, KaTeX finished typesetting).
Virtuoso's `followOutput` handles the `totalCount` diff; it does NOT automatically
chase a single item that grew — that's what `autoscrollToBottom()` is for.

This is almost certainly a relevant miss in Terminal-64 if streaming markdown
causes mid-message reflow (KaTeX typesetting in particular adds several hundred
pixels post-commit).

### 4.3 `@virtuoso.dev/message-list` — the paid dedicated package

A separate package purpose-built for chat. Worth understanding even if Terminal-64
won't pay the license, because its API reveals what Petyosi (Virtuoso's author)
thinks the correct abstractions are for AI chat:

- **`shortSizeAlign="bottom-smooth"`** — when the list is shorter than the viewport, align to bottom edge with smooth animation. Solves the "new conversation sits at top" weirdness.
- **Scroll modifiers** on data updates:
  - `'prepend'` — loading older messages, preserve viewport anchor on first old item.
  - `'remove-from-start'` / `'remove-from-end'` — window trimming, preserve anchor.
  - `{ type: 'auto-scroll-to-bottom', autoScroll: ({ atBottom, scrollInProgress }) => ... }` — append new message; callback decides behavior per-update.
  - **`{ type: 'items-change', behavior: 'smooth' }` — THIS IS THE STREAMING CASE.** When the data array's *identity* changes (user replaces one message object with an updated copy mid-stream) but the array *length* stays the same, `items-change` tells the list to re-measure and re-pin to bottom if it was pinned.

Streaming example from `docs/3.examples/02.ai-chatbot.md`:

```tsx
setData((current) => ({
    data: (current?.data ?? []).map((message) =>
        message.key === botMessage.key
            ? { ...message, text: `${message.text} ${randPhrase()}` }
            : message
    ),
    scrollModifier: { type: 'items-change', behavior: 'smooth' },
}));
```

- **`autoScroll` callback receives `{ atBottom, scrollInProgress }`** — the `scrollInProgress` flag is important: "new message arrived mid-smooth-scroll → keep smooth-scrolling, don't restart." Matches the reason `use-stick-to-bottom` uses `wait: true`.

The plain `react-virtuoso` package **does not have a direct equivalent of `items-change`**. If ClaudeChat re-keys and replaces a message object on every streaming chunk, Virtuoso's per-item `ResizeObserver` catches the height delta, but there's no `followOutput`-equivalent for "re-pin because an existing item grew." That's the gap `autoscrollToBottom()` fills manually.

### 4.4 Sticky footer pattern for scroll-to-bottom button

From `docs/2.tutorial/04.scroll-to-bottom-button.md`:

```tsx
const StickyFooter = () => {
  const location = useVirtuosoLocation();
  const virtuosoMethods = useVirtuosoMethods();
  return (
    <div style={{ position: 'absolute', bottom: 10, right: 50 }}>
      {location.bottomOffset > 200 && (
        <button onClick={() => virtuosoMethods.scrollToItem({ index: 'LAST', align: 'end', behavior: 'auto' })}>
          ▼
        </button>
      )}
    </div>
  );
};
```

Only in the `message-list` package — Terminal-64 already mirrors this with
a `.cc-jump-bottom` div outside the Virtuoso. Same idea.

---

## Synthesis — per-axis comparison table

| Axis | use-stick-to-bottom | vercel/ai-chatbot hook | chatbot-ui | react-virtuoso (current ClaudeChat) |
|------|---------------------|------------------------|------------|-------------------------------------|
| Virtualization | none | none | none | yes (library-owned) |
| Anchor definition | computed `scrollHeight - 1 - clientHeight` | `scrollTop + clientHeight >= scrollHeight - 100` | `scrollHeight - scrollTop === clientHeight` (bad) | Virtuoso-internal bottom detection |
| Near-bottom threshold | **70 px** | **100 px** | 0 px (fractional bug) | `atBottomThreshold` prop (ClaudeChat uses `BOTTOM_TOLERANCE_PX`) |
| Growth detection | `ResizeObserver` on content | `ResizeObserver` + `MutationObserver` | effect on `chatMessages` change | per-item ResizeObserver internal to Virtuoso; `followOutput` triggered by `totalCount` change |
| Streaming text (same item grows) | ResizeObserver catches it, spring-catches up | MutationObserver(characterData:true) catches it | ref-change re-triggers effect | **gap: needs `autoscrollToBottom()` or `items-change` (paid pkg)** |
| User-intent-to-leave signal | wheel event (deltaY<0) + scroll direction + resize-event disambiguation via 1ms setTimeout | scroll event → `isUserScrollingRef` true for 150 ms | scroll event with `isAutoScrolling` 100ms gate (race-prone) | Virtuoso internal — flips when user scrolls above threshold |
| Programmatic-vs-user scroll disambiguation | `ignoreScrollToTop` stashed value + `resizeDifference` flag + 1ms yield | 150 ms timer | 100 ms timer | Virtuoso internal, not exposed |
| Selection suppression | yes, `window.getSelection()` + `mousedown` | no | no | no |
| Scroll animation | custom velocity spring (handles moving targets) | `behavior: "instant"` | `scrollIntoView({ behavior: "instant" })` | Virtuoso's built-in smooth |
| Scrollbar layout shift guard | `scrollbar-gutter: stable both-edges` on Content | none | none | none (Terminal-64 could add this) |

---

## Recommendations for Terminal-64 ClaudeChat

The current ClaudeChat already uses Virtuoso + `followOutput="auto"` — which is the
right primitive. Patterns worth adopting/investigating from the research (in order
of expected impact on the reported lag/jitter):

1. **Per-item growth: call `virtuosoRef.current?.autoscrollToBottom()` when markdown/KaTeX/code-block content reflows the streaming bubble after mount.** This is Virtuoso's explicit recommendation for images-load / async-expand, and streaming markdown has the exact same shape. `followOutput="auto"` alone does not re-pin for same-item growth; `atBottomThreshold` only matters on `totalCount` changes. ClaudeChat currently renders the streaming bubble as a real list item (good) — but if the item's height grows because of post-mount markdown tokenization, only `autoscrollToBottom()` will catch that. Wire a `MutationObserver` (characterData + childList subtree) or a per-item `ResizeObserver` on the streaming item's DOM node and call `autoscrollToBottom()` on growth.

2. **Wheel-up is authoritative (borrow from use-stick-to-bottom).** Even though Virtuoso owns scroll, a `wheel` listener on the scroller with `deltaY < 0` is a zero-ambiguity signal that the user wants out. Use it to set a ref the orchestrator consults before calling `autoscrollToBottom()`. Prevents the "fighting Virtuoso during streaming" failure mode the repo comment warns about.

3. **Disambiguate programmatic-scroll echoes from user scrolls.** Terminal-64's extra `scrollerRef` callback attaches a passive scroll listener for progress. If that listener infers user-intent from raw scroll events while Virtuoso is also programmatically scrolling during `followOutput`, they will fight. Either (a) gate the listener on a `resizeDifference`-style flag, or (b) drop the user-intent inference from that listener entirely and rely solely on `atBottomStateChange`.

4. **`scrollbar-gutter: stable both-edges`** on the scroller. Cheap fix, removes the small reflow at the moment a scrollbar appears (which happens the first few streamed tokens of any session). Current chat scroller almost certainly doesn't have it.

5. **Selection suppression.** If the user text-selects in the streaming bubble mid-stream, the selection jumps on every token. Check `mousedown` + `window.getSelection()` and treat active selection as "user escaped" — exactly what `use-stick-to-bottom`'s `isSelecting()` does.

6. **Threshold sanity check.** `BOTTOM_TOLERANCE_PX` should be ≥70 and probably ≥24 is too tight for a streaming list where height can change mid-frame — 70–100 px is the proven range in both `use-stick-to-bottom` and Vercel's hook. Terminal-64's `atBottomThreshold={24}` is likely a cause of the "trouble staying at bottom" symptom: a small `atBottomThreshold` combined with growing content means `atBottomStateChange(false)` fires mid-stream, which turns `followOutput="auto"` off, which prevents Virtuoso from re-anchoring on the next `totalCount` change.

7. **Do NOT switch to `use-stick-to-bottom`** for ClaudeChat. It's incompatible with virtualization — it expects to own the scrollable div and see the full content in the DOM. Mining its techniques (wheel listener, resize-vs-user disambiguation, selection guard) and applying them on top of Virtuoso is the right shape.

8. **Consider `@virtuoso.dev/message-list` for a future rewrite.** Its `items-change` scroll modifier is exactly the primitive missing from the free Virtuoso for streaming updates. Licensed product, out of scope for a fix today, but the architectural lesson is: *treat "same item grew mid-stream" as a first-class data update, not a layout accident.*

Short version for the orchestrator: the fix set most likely to make this perfect
is **(1) wire per-item growth → `autoscrollToBottom()`, (3) remove the duplicate
scroll-intent inference from the scrollerRef listener, (6) raise
`atBottomThreshold` to 64–100 px, and (4) add `scrollbar-gutter: stable both-edges`.**
Items 2 and 5 are polish that will eliminate the last of the jitter once the
structural fights are resolved.
