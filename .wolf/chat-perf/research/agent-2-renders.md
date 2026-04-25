# Agent 2 — ClaudeChat render hot-path audit

**Scope:** Per-token re-renders during streaming in `src/components/claude/ClaudeChat.tsx` (2380 lines) and collaborators. Verified store semantics in `src/stores/claudeStore.ts`. Verified canvas/pan-zoom does NOT re-render chat.

---

## TL;DR — the single highest-leverage fix

`ClaudeChat.tsx:357`

```ts
const session = useClaudeStore((s) => s.sessions[sessionId]);
```

subscribes to the **entire session object**. The store's `appendStreamingText` reducer (`claudeStore.ts:462-467`) spreads a **new session object** on every token:

```ts
appendStreamingText: (sessionId, text) => {
  set((s) => {
    const session = s.sessions[sessionId];
    if (!session) return s;
    return { sessions: updateSession(s.sessions, sessionId, { streamingText: session.streamingText + text }) };
  });
}
```

`updateSession` (`claudeStore.ts:182-190`) is `{ ...session, ...update }`. Reference changes every token. Zustand's default `Object.is` equality check flips, and the **entire `ClaudeChat` function body re-runs per token** — every memo is reevaluated, every render reaches children whose props are re-created inline.

Fix: delete line 357. Replace each `session.foo` read with a fine-grained selector subscribing only to that slice. Where several slices are read together, use `useShallow`. The heavy `<ChatInput>` branch already has fine-grained `StreamingBubbleBody` for streaming text — but the outer re-render still forces ChatInput and the topbar to re-render.

Estimated effect: ~80% of parent-driven churn eliminated. Remaining cost = only the rows Virtuoso actually shows.

---

## Confirmed: pan/zoom does NOT re-render ClaudeChat

`src/components/canvas/Canvas.tsx:76-101` applies pan/zoom with **direct DOM writes** (`canvas.style.backgroundPosition`, `content.style.transform`), subscribing to the canvas store via `useCanvasStore.subscribe` and mutating outside React. React never rerenders on pan/zoom.

`src/components/canvas/FloatingTerminal.tsx:30` is `memo`-wrapped and re-renders only when `activeTerminalId === term.terminalId` flips. Its props (`term`) change only when the panel moves/resizes, not on streaming.

Not a contributor to streaming jitter. ✅

---

## Confirmed-stable primitives (no fix needed)

| Symbol | File:Line | Why it's fine |
|---|---|---|
| `StreamingBubbleBody` | `ClaudeChat.tsx:162-175` | Dedicated component with a fine-grained `useClaudeStore((s) => s.sessions[sessionId]?.streamingText)` selector. Only it re-renders per token. Good. |
| `ChatFooter` | `ClaudeChat.tsx:183-280` | Fine-grained selectors on `pendingQuestions`/`error`. Identity-stable across parent renders because Virtuoso `components` prop is memoized below. Good. |
| `virtuosoComponents` | `ClaudeChat.tsx:1763-1776` | Memoized with stable deps (`[sessionId, effectiveCwd, permMode.id, selectedModel, selectedEffort]`). None flip per token. ✅ |
| `renderRow` | `ClaudeChat.tsx:1649-1696` | `useCallback` with stable deps. ✅ |
| `setChatBody` | `ClaudeChat.tsx:364-387` | `useCallback([])`. Stable ref — scrollerRef doesn't reattach every render. ✅ |
| `ChatMessage` | `ChatMessage.tsx:666` | `React.memo(ChatMessageInner)`. Props (`message`, `onRewind`, `onFork`, `onEditClick`) all identity-stable once the parent subscription is fixed. ✅ |
| `Canvas` pan/zoom | `Canvas.tsx:76-101` | Direct DOM writes, no React path. ✅ |
| `FloatingTerminal` | `FloatingTerminal.tsx:30` | `memo` + narrow active-terminal-id selector. ✅ |

---

## Ranked re-render offenders (per streaming token)

### **1. Whole-session subscription — root cause** 🔥

`ClaudeChat.tsx:357`

```ts
const session = useClaudeStore((s) => s.sessions[sessionId]);
```

Triggers ClaudeChat re-render on every token because `appendStreamingText` spreads a new session object (`claudeStore.ts:462-467`). Cascades:

- `ChatInput` (941 lines, NOT memoized — see #3) re-renders
- Topbar + MCP/model/effort dropdowns re-render (their subtrees are cheap but still churn)
- `Virtuoso` receives a new `data={visualRows}` (a freshly allocated array, see #2) and forces an internal diff pass
- All the inline-callback/inline-object props on `Virtuoso` get new identities (see #5)
- Every `useMemo`/`useCallback` is reevaluated (cheap in isolation, not cheap at 30–60 Hz)
- `extractAffectedFiles`, `buildToolSummary`, `handleRewind`, `handleFork`, `spawnDelegation` all recreate closures (stable deps, harmless individually)

**Fix:** Replace line 357 with individual slice reads. Grep confirms all `session.*` usages (already listed at `ClaudeChat.tsx:163, 196, 197, 407, 454-456` for other subs). The main-body reads are:

| Field | Read at (approx) |
|---|---|
| `session.messages` | `visualRows` memo, `userPrompts` memo, `planScanFrom` effect, delegation-detect effect |
| `session.isStreaming` | streaming-end effects, ChatInput prop, plan-finished UI |
| `session.streamingText` | `visualRows` memo (boolean), `hasMessages`, StreamingBubbleBody |
| `session.streamingStartedAt` | ChatInput prop |
| `session.activeLoop` | loop-drain effect, loop-banner UI |
| `session.planModeActive` | plan-mode effect |
| `session.autoCompactStatus`, `.autoCompactStartedAt` | `visualRows` memo |
| `session.tasks` | `activeTasks` memo, side panel |
| `session.pendingQuestions` | ChatFooter only (already sliced) |
| `session.pendingPermission` | footer UI |
| `session.promptQueue` | queue overlay, ChatInput |
| `session.modifiedFiles` | `actualSend` (uses `getState()` — good) |
| `session.cwd` | `effectiveCwd` fallback |
| `session.contextUsed`, `.contextMax` | ChatInput contextPct |
| `session.name` | ChatInput sessionName |
| `session.draftPrompt` | ChatInput draftPrompt |

Rewrite as:

```ts
const messages = useClaudeStore((s) => s.sessions[sessionId]?.messages);
const isStreaming = useClaudeStore((s) => s.sessions[sessionId]?.isStreaming ?? false);
const hasStreamingText = useClaudeStore((s) => !!s.sessions[sessionId]?.streamingText); // boolean only
const streamingStartedAt = useClaudeStore((s) => s.sessions[sessionId]?.streamingStartedAt ?? null);
// ...etc
```

Only one of these (`hasStreamingText`) is affected by the per-token update, and it flips exactly twice per turn. Everything else is stable during streaming.

---

### **2. `visualRows` recomputes per token** 🔥

`ClaudeChat.tsx:1552-1647`

```ts
const visualRows: VisualRow[] = useMemo(() => { ... }, [
  session?.messages,
  session?.autoCompactStatus,
  session?.autoCompactStartedAt,
  session?.isStreaming,
  session?.streamingText,   // ← flips per token
]);
```

The memo depends on `session?.streamingText`. A new array is allocated per token. Virtuoso's `data` prop sees a new reference and performs a shallow diff across all N rows.

The **only** reason `streamingText` is in the deps is to toggle whether the final `{ kind: "streaming", key: "__streaming__" }` row is appended (`ClaudeChat.tsx:1637-1639`). That's a boolean decision.

**Fix:** change the dep to a boolean:

```ts
const hasStreamingText = useClaudeStore((s) => !!s.sessions[sessionId]?.streamingText);
...
const visualRows = useMemo(() => { ... }, [
  messages, autoCompactStatus, autoCompactStartedAt, isStreaming, hasStreamingText,
]);
```

`hasStreamingText` transitions only on turn-start / turn-end. `visualRows` then becomes stable during streaming — Virtuoso stops diffing the whole list on every token.

The streaming bubble content still updates in real time via `StreamingBubbleBody`'s own fine-grained subscription — that's already architected correctly (note the comment at `ClaudeChat.tsx:1632-1636`).

---

### **3. ChatInput is not memoized** 🔥

`src/components/claude/ChatInput.tsx:70`

```ts
export default function ChatInput({ onSend, onCancel, ... 25+ props }) { ... }
```

941 lines, 25+ props, heavy internal state (voice dictation, textarea auto-resize, slash command menus, image previews). Today it re-renders on every token because its parent does.

**Fix:** `export default React.memo(function ChatInput(...){})`. Verify all callback props reaching it are `useCallback`-stabilized (they are: `handleSend`, `handleCancel`, `handleAttach`, `handleRewrite`, `onInitialTextConsumed`, `onCyclePerm`, `onDraftChange`, `onPasteImage`, `onRegisterVoiceActions`). After #1 fixes the parent subscription, this memo will save re-running ChatInput's 900-line function body whenever non-ChatInput state changes.

Note: `ChatInput` takes `isStreaming` (flips at turn boundary, not per token) and `streamingStartedAt` (set once per turn). Neither changes per token after fix #1.

---

### **4. Redundant session-backed subscriptions create false updates**

`ClaudeChat.tsx:454-456`

```ts
const hookEventLog = useClaudeStore((s) => s.sessions[sessionId]?.hookEventLog ?? []);
const toolUsageStats = useClaudeStore((s) => s.sessions[sessionId]?.toolUsageStats ?? {});
const compactionCount = useClaudeStore((s) => s.sessions[sessionId]?.compactionCount ?? 0);
```

The `?? []` / `?? {}` fallbacks create **new empty containers on every store emission** if the real value is undefined. Zustand's `Object.is` check flips, and this subscription fires per token even though the underlying value hasn't changed.

Impact is small (the session has these fields defined after `createSession`, so the fallback rarely triggers). But after fix #1 these become the only session subscribers, so cost them correctly.

**Fix:** Keep the selector returning the raw value (can be `undefined`), and do the fallback outside the selector:

```ts
const hookEventLog = useClaudeStore((s) => s.sessions[sessionId]?.hookEventLog);
const log = hookEventLog ?? [];
```

Same pattern for `toolUsageStats` and `compactionCount`. Or pre-seed these in the session template so they're never undefined and drop the `??` entirely.

`totalToolCalls` at line 457 — `useMemo(() => Object.values(toolUsageStats).reduce(...), [toolUsageStats])`. If #4 is fixed, `toolUsageStats` becomes identity-stable and this memo stops re-computing.

---

### **5. Inline props on `<Virtuoso>`**

`ClaudeChat.tsx:2089-2107`

```tsx
<Virtuoso<VisualRow>
  ref={virtuosoRef}
  className="cc-messages"
  data={visualRows}
  computeItemKey={(_idx, row) => row.key}           // ← inline, new per render
  itemContent={renderRow}                            // ok (useCallback)
  scrollerRef={setChatBody}                          // ok (useCallback)
  followOutput="auto"                                // primitive
  atBottomStateChange={(atBottom) => setIsScrolledUp(!atBottom)}  // ← inline, new per render
  atBottomThreshold={BOTTOM_TOLERANCE_PX}
  initialTopMostItemIndex={Math.max(0, visualRows.length - 1)}    // ← inline expr
  components={virtuosoComponents}                    // ok (useMemo)
/>
```

- `computeItemKey` — a fresh function per render. Virtuoso will call it on every measurement; a stable ref avoids one allocation per render, but more importantly Virtuoso's internal `useEffect`-style dependency tracking won't churn.
- `atBottomStateChange` — likewise inline. Less critical (only fires on at-bottom transitions) but still wasteful.
- `initialTopMostItemIndex` — only read on first mount, so the inline expression is OK once but does cost reallocating per render (Virtuoso should ignore it after mount).

**Fix:**

```ts
const computeItemKey = useCallback((_i: number, row: VisualRow) => row.key, []);
const onAtBottom = useCallback((atBottom: boolean) => setIsScrolledUp(!atBottom), []);
```

Small win in isolation; combined with #1 + #2 it keeps Virtuoso's internal prop-change detection from firing on parent re-renders.

---

### **6. `renderRow` wraps every item in a fresh `<div className="cc-row">`**

`ClaudeChat.tsx:1693`

```tsx
return <div className="cc-row">{inner}</div>;
```

Every visible row gets a brand-new wrapper element per render. For the `"message"` case the `inner` is a memoized `<ChatMessage />` — React diffs the outer `<div>` (same type+props, cheap) and skips descending into the memoized child. Net cost: small but non-zero per visible row per render.

If #1 lands, the parent stops re-rendering and this cost disappears on its own. No targeted fix needed unless the visible-row count is large (>50).

---

### **7. `userPrompts` memo re-runs on messages change (acceptable)**

`ClaudeChat.tsx:1699-1717`

```ts
const userPrompts = useMemo(() => { ... }, [session?.messages]);
```

Only re-runs when `messages` changes (turn boundaries, not per token). After fix #1 + #2 this memo is correctly dormant during streaming. ✅

---

### **8. Effects triggered per token via current subscription**

Several `useEffect`s key off `session?.isStreaming`, `session?.streamingText`, `session?.messages`. Under the current (broken) subscription model, each `set`/emit causes the parent to re-render and React runs *all* effects whose deps changed. Most use refs and bail early, but the work is non-zero:

- `ClaudeChat.tsx:564-580` plan-completion effect → deps `[session?.isStreaming, session?.planModeActive, sessionId, planContent, planFinished]`. `isStreaming` doesn't flip per token, so this is fine once #1 fixes the cascade.
- `ClaudeChat.tsx:584-611` plan-file scan effect → dep `[session?.messages]`. Stable during streaming (messages aren't appended until the assistant turn finalizes). ✅
- `ClaudeChat.tsx:651-682` auto-drain-queue effect → dep `[session?.isStreaming]`. Same. ✅
- `ClaudeChat.tsx:1506-1524` delegation-detect effect → dep `[session?.messages, spawnDelegation]`. Same. ✅

None of these are a problem by themselves — they're only cheap *because* React bails when deps haven't changed. The current subscription model doesn't cause these to *run* per token, it causes the *commit* phase to reach them. Still, less re-committing after #1 is a latency win for React scheduler.

---

## Ordered fix plan (for the orchestrator)

1. **Split `const session = ...` into slice subscriptions** (`ClaudeChat.tsx:357`). Biggest win. Touch every `session.X` read site; most already read from `getState()` anyway.
2. **Change `visualRows` memo dep `session?.streamingText` → `hasStreamingText: boolean`** (`ClaudeChat.tsx:1552-1647`). Eliminates per-token array churn into Virtuoso.
3. **Wrap `ChatInput` in `React.memo`** (`ChatInput.tsx:70`). Gives it a stable identity gate once the parent re-render cascade is gone.
4. **Stabilize inline Virtuoso callbacks**: `computeItemKey`, `atBottomStateChange` → `useCallback` (`ClaudeChat.tsx:2093, 2103`).
5. **Drop `?? []` / `?? {}` inside selectors** (`ClaudeChat.tsx:454-456`) or seed those fields in `createSession`.

Steps 1 + 2 alone should eliminate the perceived jitter. Steps 3-5 remove residual GC pressure during long streaming sessions.

---

## What to NOT touch (already optimal)

- `StreamingBubbleBody` — the single-field selector is exactly right. Keep it.
- `ChatFooter` — same. The comment at `ClaudeChat.tsx:1755-1762` captures why this works.
- `renderRow` / `virtuosoComponents` memoization.
- `Canvas` direct-DOM pan/zoom path.
- `FloatingTerminal` memo + narrow selector.
- `ChatMessage` `React.memo` wrapping.

---

## References (file:line)

- `ClaudeChat.tsx:357` — whole-session subscription (ROOT CAUSE)
- `ClaudeChat.tsx:454-456` — `?? []` / `?? {}` in selectors
- `ClaudeChat.tsx:1552-1647` — `visualRows` memo with `streamingText` dep
- `ClaudeChat.tsx:1637-1639` — streaming row append (boolean-only use of streamingText)
- `ClaudeChat.tsx:1649-1696` — `renderRow`
- `ClaudeChat.tsx:1699-1717` — `userPrompts` memo
- `ClaudeChat.tsx:1763-1776` — `virtuosoComponents` memo
- `ClaudeChat.tsx:2089-2107` — `<Virtuoso>` props
- `ClaudeChat.tsx:2276-2301` — `<ChatInput>` usage (many props derived from `session.*`)
- `ChatInput.tsx:70` — not memoized
- `ChatMessage.tsx:666` — `React.memo(ChatMessageInner)`
- `claudeStore.ts:182-190` — `updateSession` spreads new object
- `claudeStore.ts:462-467` — `appendStreamingText` mutates session per token
- `Canvas.tsx:76-101` — direct DOM pan/zoom
- `FloatingTerminal.tsx:30` — `memo` wrapper
