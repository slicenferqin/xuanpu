# Session HQ Overlay Composer Refactor Plan

Date: 2026-05-28

## Context

Session HQ currently uses a mixed layout model:

- The transcript and composer are separated by a grid layout with a physical bottom row.
- The composer still behaves visually like a floating surface through veil, shadow, and blur.
- Timeline scrolling adds extra bottom padding, clear-screen filler, resize compensation, and FAB offsets to compensate for the visual overlap.

This hybrid model made sense as an incremental fix for "streaming output appears under the composer", but it now creates two competing spatial models:

- CSS layout says the composer owns real vertical space.
- Visual design says the composer floats over the transcript.
- Scroll logic then has to reconcile both with heuristics.

The preferred direction is to intentionally move to a Claude/Gemini-like model:

> The timeline is a full-height scroll viewport. The composer and dock are an absolute bottom overlay. Content may pass behind the overlay, but the real content tail must land inside the readable area when sticky-bottom is active, and a jump-to-bottom affordance appears whenever the tail is not readable.

## Product Decision

Do not keep hard boundaries between the main transcript area and the composer area.

Adopt a single overlay model:

- The transcript fills the whole Session HQ stage.
- The composer, interrupt dock, context debugger, and bottom veil are a measured bottom overlay.
- Timeline content gets bottom padding equal to the measured readable inset.
- The scroll system owns `tailReadable` / `showJumpToBottom`.
- The arrow appears when the real tail is not readable, regardless of unread count.
- Unread count is only a badge, not the visibility condition for the arrow.

The goal is not to prevent content from visually passing behind the composer. The goal is to ensure the actual tail is readable at rest and that the user has an immediate, reliable affordance to return to the tail.

## Target Layout

Replace the current two-row grid with a single full-height stage:

```tsx
<div className="relative h-full min-h-0 overflow-hidden">
  <AgentTimeline
    bottomReadableInset={bottomReadableInset}
    scrollContainerRef={timelineScroll.scrollContainerRef}
    timelineContentRef={timelineScroll.timelineContentRef}
    tailSentinelRef={timelineScroll.tailSentinelRef}
    ...
  />

  <ScrollToBottomFab
    visible={timelineScroll.showJumpToBottom}
    count={timelineScroll.unreadCount}
    style={{ bottom: `${bottomReadableInset + 16}px` }}
  />

  <div
    ref={bottomOverlayRef}
    className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
  >
    <div
      className="crisp-composer-veil pointer-events-none absolute inset-x-0 bottom-0"
      style={{ height: `${bottomOverlayHeight + 24}px` }}
    />

    <div className="pointer-events-auto">
      <InterruptDock />
      <ContextBudgetDebugger />
      <ComposerBar />
    </div>
  </div>
</div>
```

Important constraints:

- `AgentTimeline` must not be constrained by a separate composer row.
- The bottom overlay must not alter the scroll container's `clientHeight`.
- Overlay height changes should update `bottomReadableInset`, not shrink the viewport.
- The overlay wrapper is `pointer-events-none`; interactive children are `pointer-events-auto`.

## Bottom Inset Model

The current `getTimelineSafeBottomPadding(bottomFloatingHeight)` is a hybrid-mode heuristic. In the overlay model, replace it with a measured inset.

Suggested model:

```ts
const bottomOverlayHeight = measuredHeight(bottomOverlayRef)
const bottomReadableInset = bottomOverlayHeight + 24
```

The `+24` is breathing room between the last readable content and the visual top of the composer/veil.

This value should drive:

- `AgentTimeline` content `paddingBottom`
- tail sentinel IntersectionObserver `rootMargin`
- jump-to-bottom FAB vertical position
- round-focus filler computation

Avoid deriving the core scroll geometry from partial ratios such as `0.3 * composerHeight`. The overlay height is measurable, so the scroll model should use the measured value.

## Tail Sentinel

Add a real tail sentinel in `AgentTimeline`.

Placement:

```tsx
{preludeNodes}
{rounds}
{inflightCompaction}
{finalTodoTasks}
{streamingNodes}
{emptyStreamingPulse}
{ephemeralStatusRows}

<div ref={tailSentinelRef} data-timeline-tail-sentinel="true" />

{focusFillerHeight > 0 && <div data-clear-screen-spacer="true" />}
```

The sentinel represents the real content tail. It must be before the clear-screen/focus filler, because filler is a layout affordance, not real content.

## Clear-Screen Compatibility

This refactor touches the same geometry that powers the recently fixed clear-screen behavior, so it is a risk area. The goal is to preserve the clear-screen interaction, not replace it.

The current behavior to preserve:

- After a new user message is appended, that round is aligned near the top of the viewport.
- A tail filler gives the content enough scrollable height so the user message can remain near the top while assistant output grows below it.
- During `round-focus`, normal sticky-bottom auto-follow is suppressed.
- If the user manually scrolls during `round-focus`, mode changes to `history`, but the filler continues shrinking as real content grows.
- Clicking jump-to-bottom clears focus/filler/manual lock and returns to normal sticky-bottom behavior.

The clear-screen formula should remain the same conceptually:

```ts
fillerHeight = max(
  0,
  viewportHeight - topGap - bottomReadableInset - heightFromRoundTopToRealContentEnd
)
```

The migration changes only one input:

- Hybrid mode used `safeBottomPadding`.
- Overlay mode should use measured `bottomReadableInset`.

Do not compute clear-screen filler from the overlay visual height and also add a second safe padding. That would double-count the bottom area and make the user message sit too high or leave too much phantom scroll space.

Clear-screen-specific invariants:

- `focusFillerHeight` remains a tail spacer after real content.
- The tail sentinel must be before `focusFillerHeight`, so filler is not treated as real content.
- `scrollToBottom()` must subtract/clear focus filler depending on intent:
  - Normal sticky-bottom: no focus filler.
  - Round-focus: filler is kept and shrinks.
  - Explicit FAB click: clear focus filler and return to normal bottom.
- `round-focus` must not exit before the target round has been measured at least once.
- Overlay height changes during `round-focus` should recompute filler, not force sticky-bottom.

Recommended migration guard:

1. Keep current clear-screen state machine tests before changing layout.
2. Introduce `bottomReadableInset` as a parameter while still in the old grid layout.
3. Make clear-screen filler consume `bottomReadableInset`.
4. Only then switch SessionShell from grid rows to overlay layout.
5. After the switch, verify the same clear-screen tests still pass.

## Tail Readability

Introduce `tailReadable` as a first-class scroll state.

Recommended implementation:

```ts
const observer = new IntersectionObserver(
  ([entry]) => {
    setTailReadable(entry.isIntersecting)
  },
  {
    root: scrollContainer,
    rootMargin: `0px 0px -${bottomReadableInset}px 0px`,
    threshold: 0
  }
)
```

Meaning:

- `root` is the timeline scroll container.
- Negative bottom `rootMargin` removes the overlay area from the readable viewport.
- `tailReadable=true` means the real tail is above the overlay and can be read.

If IntersectionObserver is not used, the fallback must observe timeline content height changes, not only scroll container resize. Streaming output changes `scrollHeight`, but does not always resize the container.

## Jump-To-Bottom Visibility

Split visibility and count:

```ts
tailReadable: boolean
unreadCount: number
showJumpToBottom = !tailReadable || scrollMode === 'history'
```

Rules:

- The arrow appears whenever the tail is not readable.
- The arrow also appears when the user is in history mode.
- `unreadCount` only controls the numeric badge.
- `unreadCount === 0` must not hide the arrow if the tail is not readable.

This matches the Claude/Gemini affordance: the arrow is about position, not unread state.

## Scroll State Machine

Keep the three-state model, but make each state about ownership:

```ts
type TimelineScrollMode = 'sticky-bottom' | 'history' | 'round-focus'
```

Transitions:

```text
send user message
  -> round-focus

round-focus + user wheel/pointer
  -> history
  filler continues shrinking

round-focus + measured + filler === 0
  -> sticky-bottom

history + user scrolls until tailReadable
  -> sticky-bottom

FAB click
  -> clear focus/filler/manual lock
  -> sticky-bottom
  -> scrollToBottom

bottom overlay height changes
  sticky-bottom: update inset and scrollToBottom instant
  history: update inset and arrow only
  round-focus: update inset and recompute filler
```

## Scroll-To-Bottom Semantics

`scrollToBottom()` should land the real content tail inside the readable area.

With overlay mode:

- `paddingBottom = bottomReadableInset`
- normal bottom has no filler
- round-focus uses tail filler separately

The existing formula can remain conceptually:

```ts
scrollTop = scrollHeight - clientHeight - focusFillerHeight
```

But the correctness check should be tail readability, not only equality with max scroll.

After programmatic scroll:

- `tailReadable` should become true
- `scrollMode` should become `sticky-bottom`
- `manualScrollLocked` should be false
- focus filler should be cleared when the user explicitly jumps to bottom

## Remove Hybrid Compensation

The current bottom-area resize compensation exists because composer height changes shrink the transcript grid row. In overlay mode, composer height changes do not change timeline `clientHeight`.

Delete or simplify this class of logic:

- `bottomAreaRef` / `composerRef` resize compensation that scrolls because row height changed
- heuristics based on `BOTTOM_AREA_COMPENSATE_THRESHOLD`
- independent FAB visibility driven by unread count
- AgentTimeline's separate streaming indicator based on `showBottomGradient`

Replacement behavior:

- Overlay resize updates `bottomReadableInset`
- sticky-bottom scrolls to bottom instantly
- history does not force-scroll
- round-focus recomputes filler
- tail observer updates the arrow

## Single Jump Affordance

Use one canonical jump-to-bottom control.

Preferred:

- Keep `ScrollToBottomFab`
- Position it above the measured overlay
- Make it visually closer to Claude: compact circular arrow
- Display count only when `unreadCount > 0`

Remove the AgentTimeline-local streaming indicator, or make it a pure rendering variant of the same state. Do not keep two separate visibility conditions.

## Migration Plan

1. Add `bottomOverlayRef` measurement in `SessionShell`.
2. Replace the grid row split with a full-height `relative` stage and absolute bottom overlay.
3. Pass `bottomReadableInset` to `AgentTimeline` and the scroll controller.
4. Add `tailSentinelRef` in `AgentTimeline`, before clear-screen filler.
5. Move tail readability into `useTimelineScrollController` or a dedicated hook.
6. Change `showScrollFab` into `showJumpToBottom`; do not require unread count.
7. Update `scrollToBottom` to clear focus/manual state and validate tail readability.
8. Delete the AgentTimeline-local streaming indicator or wire it to the same canonical state.
9. Remove bottom-row resize compensation that only exists for the hybrid layout.
10. Update tests around overlay height, tail readability, round-focus, and FAB visibility.

## Tests

Required focused tests:

- Sticky-bottom streaming keeps tail readable above the overlay.
- Composer/overlay height growth while sticky-bottom scrolls to bottom instantly.
- Composer/overlay height growth while history mode does not force-scroll.
- `showJumpToBottom` becomes true when tail sentinel is outside the readable root.
- `showJumpToBottom` can be true when unread count is zero.
- FAB click clears focus filler, manual lock, and mode, then makes tail readable.
- Round-focus computes filler using `bottomReadableInset`.
- Round-focus filler keeps shrinking even after manual scroll changes mode to history.
- Tail sentinel is before clear-screen filler.

## Acceptance Criteria

- During long streaming output, the latest tail remains readable when sticky-bottom is active.
- If the user is not at the readable tail, the down arrow appears immediately.
- The arrow does not depend on unread count.
- The composer can expand with attachments, voice capture, interrupts, or debug panels without changing timeline viewport height.
- User history scrolling remains smooth and is not pulled back unless the user clicks the arrow or scrolls to the tail.
- New-turn clear-screen behavior still pins the user message near the top of the viewport.
- The implementation has one scroll geometry model: full-height timeline plus measured bottom overlay.
