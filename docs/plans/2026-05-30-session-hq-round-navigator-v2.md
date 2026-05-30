# Session HQ Round Navigator v2

Date: 2026-05-30

Status: Proposal for implementation

Owner: Session HQ / Timeline Navigation

Prototype:

- `docs/mockups/2026-05-29-round-navigator-v2-demo.html`

## Goal

Replace the current RoundRail dot navigation with a low-noise conversation round navigator that
works for long sessions without competing with the main transcript.

The desired interaction has two layers:

1. **Default ghost handle**: almost invisible, shows only a few nearby round markers and one clean
   current-round marker.
2. **Hover wheel**: expands temporarily into a small wheel showing nearby rounds with only the round
   index and the first 10 characters of the user prompt.

The navigator must feel native to Xuanpu. The prototype proves the interaction direction, but its
temporary colors should not be copied directly into production.

## Current Problem

Current implementation:

- `src/renderer/src/components/session-hq/timeline/RoundRail.tsx`
- mounted from `src/renderer/src/components/session-hq/AgentTimeline.tsx`
- data comes from `TimelineRound` in `src/renderer/src/lib/session-timeline/view-model.ts`

Problems:

- It maps every round into one viewport-height rail. With many rounds, this becomes unreadable.
- It is mostly dots, so users cannot tell which turn a marker represents.
- Hover fisheye changes size/spacing but does not give enough semantic context.
- The active marker styling is visually too loud or too weird when trying to make it discoverable.
- It is easy to accidentally make the rail look like another right-side panel, conflicting with the
  Inspector.

The user feedback on the prototype is now the design constraint:

- do not default to dense small dots;
- do not keep a full wheel permanently visible;
- default state should be subtle like the competitor reference;
- expanded items should show only user input, max 10 characters;
- remove tools, time, status, and other metadata from the navigator rows;
- current-round marker must be a clean small black/foreground dot, not a custom hook-like glyph.

## Design Decision

Build `RoundNavigator` as a replacement for `RoundRail`.

### Default Ghost Handle

Default state is not a panel.

Rules:

- width: around `24px` to `32px`;
- no visible card background;
- no always-visible count such as `27 / 64`;
- no border or shadow in the resting state;
- show only current-neighborhood markers, not every round;
- recommended marker count: 7 visible markers, current round plus 3 before and 3 after;
- inactive markers are tiny muted dots;
- active marker is a clean small foreground dot;
- marker opacity fades by distance from the active round;
- appears only on desktop/tablet width where the timeline has enough horizontal room;
- should not overlap the right Inspector rail or composer overlay.

The default state should read as "there is navigation here if needed", not as "there is another
panel to inspect".

### Hover Wheel

On hover or focus, expand into a compact 10-slot wheel.

Rules:

- expanded width: around `168px` to `184px`;
- row count: 10 slots maximum;
- the focused/active round stays near the vertical center;
- rows above and below gradually reduce opacity and scale;
- a wheel scroll changes only the navigator focus, not the main transcript;
- clicking a row calls existing round navigation and scrolls the transcript;
- leaving hover collapses back to the ghost handle unless the component is explicitly pinned in a
  debug/prototype mode.

Each row must contain only:

```txt
<round index>  <first 10 chars of user input>
```

Examples:

```txt
27  Codex 你好发…
28  为什么没有停…
29  你直接上手修…
```

Do not show:

- tool counts;
- timestamps;
- cost/token/context metrics;
- status words like running/failed/question;
- assistant text;
- file names;
- tags, badges, or colorful state icons.

The navigator is for locating user turns, not for summarizing execution state.

## Visual System

Production colors must use Xuanpu tokens, not prototype hard-coded colors.

### Token Mapping

Use existing theme variables first:

| Purpose | Token guidance |
| --- | --- |
| resting inactive marker | `color-mix(in srgb, var(--muted-foreground) 28%, transparent)` |
| resting active marker | `var(--foreground)` or `var(--ink)` |
| hover panel background | `color-mix(in srgb, var(--agent-card) 88%, transparent)` |
| hover panel border | `color-mix(in srgb, var(--border) 86%, transparent)` |
| hover panel shadow | `rgb(var(--agent-shadow-rgb) / 0.10)` |
| row text | `var(--foreground)` / `var(--ink)` |
| row secondary index | `var(--muted-foreground)` |
| active row background | `color-mix(in srgb, var(--agent-hover) 45%, transparent)` |
| active row border | `color-mix(in srgb, var(--border) 70%, transparent)` |

If Session HQ visual-system v2 tokens are fully wired, these can be mapped to the reader layer:

| Purpose | Optional v2 token |
| --- | --- |
| panel background | `var(--xp-reader-surface)` with opacity |
| row text | `var(--xp-reader-text)` |
| muted index | `var(--xp-reader-muted)` |
| border | `var(--xp-reader-border)` |

Do not use:

- `neon-*` colors;
- blue glow for the active marker;
- red/green/amber statuses in navigator rows;
- demo colors copied as hex values.

### Shape And Motion

Resting marker:

- inactive dot: `3px` to `4px` circle;
- active dot: `6px` to `7px` circle;
- optional active halo: very weak foreground halo below `6%` opacity;
- no custom glyph.

Expanded panel:

- radius: `12px` to `16px`, not a large card;
- backdrop blur allowed but must be subtle;
- no decorative gradients or blobs;
- expand/collapse duration: `140ms` to `180ms`;
- row transition: opacity/scale only, no dramatic slide.

## Data Model

Current `TimelineRound.preview` is derived from the user node and currently truncates to 24
characters. For this component, introduce a navigator-specific preview.

Recommended type:

```ts
interface RoundNavigatorItem {
  id: string
  index: number
  preview: string
}
```

Preview rules:

- use the user message display content;
- normalize whitespace to a single space;
- strip mode prefixes through existing message display helpers;
- truncate to 10 visible characters, then append ellipsis if needed;
- empty prompt becomes `未命名`;
- do not include attachments, tool names, assistant summaries, timestamps, or status.

This keeps the core timeline model clean while allowing the navigator to have tighter display rules.

## Interaction Contract

Do not rewrite the main timeline scroll model.

The existing ownership boundary remains:

- `useTimelineScrollController` owns active round detection and `scrollToRound`;
- `AgentTimeline` passes `activeRoundId` and `onRoundAnchorNavigate`;
- `RoundNavigator` only renders navigation state and calls `onRoundAnchorNavigate(roundId)`;
- no direct `scrollTop` writes inside `RoundNavigator`;
- no changes to `bottomReadableInset`;
- no changes to clear-screen spacer behavior;
- no changes to jump-to-bottom visibility logic.

Wheel behavior:

- hover opens the wheel;
- wheel scroll updates `navigatorFocusIndex`;
- wheel scroll does not call `onRoundAnchorNavigate`;
- click/Enter calls `onRoundAnchorNavigate`;
- Esc collapses and resets `navigatorFocusIndex` to `activeIndex`;
- when `activeRoundId` changes from transcript scrolling, reset navigator focus to the active round
  unless the user is currently interacting with the wheel.

Keyboard behavior:

- Tab can focus the ghost handle;
- Enter/Space opens the wheel;
- ArrowUp/ArrowDown changes focused round;
- Enter jumps to focused round;
- Esc closes the wheel.

## Layout

Replace `RoundRail` with `RoundNavigator` in the same area currently mounted from
`AgentTimeline`.

Placement:

- keep it inside the timeline area, not inside the right Inspector;
- place it near the transcript's right edge;
- keep it left of the app's right tab rail / Inspector area;
- hide it under narrow breakpoints where it would cover content;
- ensure the composer overlay remains visually dominant near the bottom.

Recommended dimensions:

```txt
default width: 24-32px
expanded width: 168-184px
expanded height: min(460px, viewport - top/bottom breathing room)
visible resting markers: 7
visible expanded rows: 10
```

## Implementation Plan

### Phase 1: Replace Visual Shell Only

Files:

- `src/renderer/src/components/session-hq/timeline/RoundRail.tsx`
- optionally rename to `RoundNavigator.tsx` after the behavior is stable
- `src/renderer/src/components/session-hq/AgentTimeline.tsx`

Work:

- remove all-round viewport mapping;
- render only 7 resting markers around the active round;
- use the clean foreground active dot;
- remove default card background/count;
- expand on hover/focus into a 10-slot wheel;
- preserve existing `onRoundAnchorNavigate`.

Validation:

- 2 rounds: navigator is visible but subtle;
- 20 rounds: resting state still shows only nearby markers;
- 100 rounds: resting state still shows only nearby markers;
- active marker is visually clean and not a custom glyph.

### Phase 2: Add Navigator Preview Model

Files:

- `src/renderer/src/lib/session-timeline/view-model.ts`
- or new `src/renderer/src/lib/session-timeline/round-navigator.ts`

Work:

- derive `RoundNavigatorItem[]` from `TimelineRound[]`;
- generate index and 10-character preview;
- keep original `TimelineRound.preview` untouched if other surfaces still use it.

Validation:

- row text only contains user prompt preview;
- no tool metadata appears in the navigator;
- Chinese and English mixed prompts truncate predictably.

### Phase 3: Wheel Interaction

Work:

- add `navigatorFocusIndex`;
- wheel scroll changes `navigatorFocusIndex`;
- click/Enter navigates;
- Esc collapses;
- active round changes sync focus unless user is interacting.

Validation:

- wheel scrolling does not move the transcript;
- clicking a row moves transcript to the round;
- after transcript scroll, the ghost active marker follows `activeRoundId`;
- clear-screen and sticky-bottom tests remain green.

### Phase 4: Theme Integration

Work:

- replace prototype colors with theme tokens;
- verify light theme, dark theme, and Xuanpu Calm;
- remove hard-coded hex except where the theme token definition already owns the color.

Validation:

- marker contrast is visible but low-emphasis in light and dark modes;
- expanded wheel reads as Xuanpu UI, not a separate product;
- no neon/glow styling is introduced.

## Tests

Add focused renderer tests:

- `RoundNavigator` renders at most 7 resting markers for 100 rounds.
- `RoundNavigator` renders at most 10 wheel rows when expanded.
- expanded row text uses only round index plus first 10 characters of user prompt.
- wheel scroll updates focused item without calling `onRoundAnchorNavigate`.
- click calls `onRoundAnchorNavigate(roundId)`.
- active round update changes resting marker.

Keep existing scroll tests green:

- `test/phase-23/use-timeline-scroll-controller.test.tsx`
- `test/phase-23/agent-timeline-connector.test.tsx`
- `test/phase-23/session-shell-composer-layout.test.ts`

## Acceptance Criteria

This feature is done when:

- default state looks like a subtle ghost handle, not a panel;
- default state does not show dense dots or full session count;
- active marker is a clean small foreground dot;
- hover/focus opens a compact 10-slot wheel;
- wheel rows show only round index and user prompt preview capped at 10 characters;
- no tool/time/status/cost metadata appears in the navigator;
- wheel scrolling does not scroll the main transcript;
- clicking or keyboard Enter navigates through existing `scrollToRound`;
- colors are derived from Xuanpu theme tokens and work in light/dark themes;
- right Inspector and composer overlay are not visually or spatially affected;
- clear-screen, tail-readable, and jump-to-bottom behavior are unchanged.

## Non-Goals

- Do not redesign the right Inspector.
- Do not add session search in this pass.
- Do not show status summaries in the round navigator.
- Do not virtualize the full timeline.
- Do not replace `useTimelineScrollController`.
- Do not make the wheel permanently visible by default.
