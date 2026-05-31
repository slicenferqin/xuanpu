# Session HQ Visual System v2

Date: 2026-05-29

Status: Proposal for implementation

Owner: Session HQ / Renderer UI

## Goal

Reduce long-session visual fatigue in Xuanpu by redesigning Session HQ as a reading-first
workspace instead of a uniformly dense operations dashboard.

This is intentionally a root-level redesign plan. The goal is not to tune a few colors. The goal is
to create a durable visual system where:

- assistant prose is easy to read for long periods;
- markdown semantics are rendered according to meaning, not just markdown syntax;
- tool output, diffs, terminal text, and telemetry remain dense where density is useful;
- right-side metrics stop competing with the conversation unless a threshold actually needs
  attention;
- the recent Claude-like overlay composer and clear-screen scroll behavior are preserved.

## Decision

Adopt a three-layer visual model:

1. **Reading layer**: assistant prose, user messages, summaries, conclusions, and narrative
   markdown. This layer optimizes for line length, spacing, calm contrast, and scan rhythm.
2. **Operations layer**: tool calls, shell output, file writes, diffs, todos, permission prompts, and
   diagnostics. This layer can stay compact and technical because users inspect it differently.
3. **Telemetry layer**: cost, token usage, context usage, cache hit rate, worktree/session metadata,
   and health indicators. This layer is secondary by default and only becomes colorful when there
   is a warning, failure, or explicit success state.

The current UI mixes these layers. That is the root problem. Prose, inline identifiers, tool-like
cards, and metrics all use similar visual weight, so the user's eye has to constantly decide what is
important.

## Research Inputs

This plan is based on product patterns from mainstream IDEs and markdown-heavy tools:

- VS Code separates theme color roles for workbench UI, text documents, code blocks, links,
  widgets, action lists, contrast borders, and more. The relevant lesson is not to use one generic
  `foreground/card/muted` vocabulary for everything in Session HQ.
  Reference: https://code.visualstudio.com/api/references/theme-color
- JetBrains explicitly separates IDE interface themes from editor color schemes, and frames color
  and font settings around different text resources such as editor text, search results, debugger
  information, console input, and output. Xuanpu needs the same separation between reader text,
  operations output, and telemetry.
  Reference: https://www.jetbrains.com/help/idea/configuring-colors-and-fonts.html
- Obsidian exposes "Readable line length" as a first-class reading preference. It accepts that less
  content may fit onscreen, but long text becomes more readable.
  Reference: https://obsidian.md/help/settings
- GitHub Primer uses functional and component tokens instead of raw base colors in code, and its
  typography primitives distinguish body, code block, and inline code styles.
  References:
  - https://primer.style/foundations/color/overview
  - https://primer.style/product/primitives/typography/
- Apple HIG's color guidance is directly relevant to the right-side metrics panel: use color
  consistently, avoid relying only on color, and reserve strong color for elements that benefit from
  emphasis such as status indicators or primary actions.
  Reference: https://developer.apple.com/design/human-interface-guidelines/foundations/color/
- WCAG contrast should remain the floor for accessibility, not the only design target. Xuanpu still
  needs AA contrast for text, but the product should avoid making every surface compete at maximum
  contrast.
  Reference: https://www.w3.org/TR/WCAG22/

## Current Code Evidence

Verified in the belgian-malinois worktree on 2026-05-29.

### Markdown Rendering

File: `src/renderer/src/components/sessions/MarkdownRenderer.tsx`

Current behavior:

- all inline backtick content uses the same heavy chip style:
  `rounded border border-border/70 bg-agent-card-muted px-1.5 py-0.5 font-mono text-sm text-ink`;
- block code goes through `CodeBlock`, which is fine as an operations/code surface;
- inline code has no semantic classification, so paths, ids, metrics, natural-language phrases,
  flags, commands, and real code symbols all look equally important.

This is why assistant messages with lots of paths, ids, and markdown tokens become visually noisy.

### Assistant Text Card

File: `src/renderer/src/components/session-hq/cards/TextCard.tsx`

Current behavior:

- assistant prose is wrapped in `rounded-xl bg-agent-card/80 px-4 py-3`;
- markdown is rendered in `prose prose-sm ... max-w-none text-sm`;
- ordinary assistant text therefore still reads like a card-like surface, and it can span the full
  available timeline width.

The comment says text should not look like a card action, but the component still renders a rounded
card surface. The implementation and intent have drifted.

### Theme Tokens

Files:

- `src/renderer/src/styles/globals.css`
- `src/renderer/src/lib/themes.ts`

Current light theme is already softer than pure black on pure white:

- `--background: #f1f5f9`
- `--foreground: #4b526b`
- `.crisp-readable { line-height: 1.72; }`

So the fatigue is not caused by only "black on white" or only "line-height too small". The stronger
causes are:

- no reader-specific tokens;
- high-chroma `neon-*` tokens reused in normal telemetry;
- too many surfaces competing through cards, borders, shadows, and chips;
- inline code chips occupying too much visual area.

### Right Context Panel / Metrics

File: `src/renderer/src/components/context-panel/ContextPanelHost.tsx`

Current behavior:

- `OverviewHeroMetric` renders cost with `bg-neon-pink` and `text-neon-pink`;
- token total uses `bg-neon-mint` and `text-neon-mint`;
- values use `font-mono text-[24px] font-semibold`;
- token rows use mint/violet progress bars even for normal, non-alerting data.

This makes ordinary telemetry louder than the assistant's message body. Cost and token totals are
not errors. They should not borrow red/green status vocabulary in the normal state.

### Scroll Boundary

File: `docs/plans/2026-05-28-session-hq-overlay-composer-refactor.md`

The overlay composer plan should remain the scroll architecture boundary:

- timeline is a full-height scroll viewport;
- composer/dock are measured bottom overlays;
- bottom readable inset controls timeline padding, tail sentinel, and jump-to-bottom FAB;
- content may pass behind the overlay visually, but the real tail must land inside the readable
  area.

This visual-system work must not reintroduce a separate composer row or a hybrid scroll model.

## Root Cause

The problem is not just "too many rows" or "the color palette is harsh".

The root cause is that Session HQ has no semantic visual hierarchy:

- markdown syntax is treated as visual hierarchy, so every backtick becomes a strong chip;
- assistant prose is rendered as a card, even though it is the main reading surface;
- tool cards and text cards use adjacent surface vocabulary;
- telemetry values use warning-like chroma in normal state;
- worktree-level and session-level metrics appear in the same high-importance panel;
- there is no density mode or focus mode, so one layout is forced to serve reading, debugging,
  monitoring, and inspecting.

The durable fix is to make rendering meaning-aware and to separate reader, operations, and telemetry
systems at the token and component level.

## Target Experience

### Default Session View

- Assistant prose is the visual anchor.
- Ordinary assistant text is unframed or nearly unframed.
- Reader line width is limited to approximately `780px` to `860px`, with `820px` as the first
  implementation target.
- Body text uses `15px` by default, with line-height around `1.72` to `1.78`.
- Paragraph, list, and heading spacing use a reading rhythm instead of compact dashboard rhythm.
- Inline code is quiet by default. Only real code symbols and commands keep monospace emphasis.
- Code blocks, tables, diffs, and tool output may break out wider than prose.
- Completed tool cards collapse to one-line operation summaries by default.
- The right panel remains available but visually secondary.

### Focus Mode

Add a user-facing focus mode for long reading or long agent output:

- right context panel collapses to a narrow rail or low-emphasis inspector;
- completed tools render in compact summaries;
- assistant prose max width remains stable;
- telemetry is still accessible but not always visible as large numbers;
- jump-to-bottom and overlay composer behavior remains identical to normal mode.

Focus Mode should not be a separate route. It should be a display mode of Session HQ.

### Density Modes

Add a `readingDensity` preference:

- `comfortable`: default for long reading; wider spacing, `15px` body, softer telemetry;
- `standard`: current-density compromise for users who prefer more rows;
- `compact`: dense operations mode; useful for reviewing tool-heavy runs.

Do not make all surfaces obey one global density value. Reading, operations, and telemetry should
map density differently.

## Proposed UI Placement

### Center Timeline

Assistant prose:

- render inside a `ReadableMessage` flow, not a card-like `TextCard`;
- use `max-width: var(--xp-reader-measure, 820px)`;
- align consistently with the timeline column;
- keep `WideBlock` children for tables, code blocks, diffs, and large tool outputs.

User message:

- keep it visually distinct, but avoid making it a saturated bubble;
- use a compact surface only because user messages are input anchors, not because every timeline
  node needs a card;
- time/actions row can share the line under the message, and hover actions may reuse that row.

Tool cards:

- completed state: collapsed one-line summary by default;
- running state: visible progress and live output;
- expanded state: detailed dense operation view;
- failed state: clear status color and error affordance.

### Right Panel

Rename the mental model from "worktree stats panel" to "Inspector".

Normal default:

- top of panel shows neutral session/worktree identity and health;
- large red/green hero metrics are removed;
- cost/tokens/context appear as neutral rows or compact pills;
- strong colors are threshold-driven:
  - danger: failed run, budget exceeded, context over critical threshold;
  - warning: near limit, anomalous cost, stale telemetry;
  - success: explicit completed operation, not ordinary token usage;
  - info/accent: active selection or navigation.

Metric placement:

- session-level cost, tokens, context usage belong near the active session header or the Inspector's
  current-session section;
- worktree-level aggregate belongs in a separate "Worktree Aggregate" section and should be
  visually muted;
- provider/session breakdown belongs behind a drilldown, not in the top hero area;
- cache hit rate is useful only with scope and denominator, so it should be a row with tooltip or
  expandable details, not a large standalone visual claim.

### Top Right / Header Area

The top-right area should not use red/green monetary/token colors in the normal state.

Use this hierarchy:

- primary: active branch/session identity and run state;
- secondary: context percent and cost as neutral compact pills;
- hidden/drilldown: input/output/cache breakdown.

## Design Tokens

Introduce new semantic tokens without immediately deleting the existing theme variables.

Suggested first pass:

```css
:root {
  --xp-reader-canvas: #f5f6f3;
  --xp-reader-surface: #fcfcfa;
  --xp-reader-surface-muted: #f1f2ee;
  --xp-reader-text: #343a42;
  --xp-reader-secondary: #626b75;
  --xp-reader-muted: #8d949d;
  --xp-reader-border: #e1e4dd;
  --xp-reader-link: #526f9e;
  --xp-reader-selection: #dfe8f4;

  --xp-md-inline-code-bg: #f3f4f1;
  --xp-md-inline-code-border: #e2e5df;
  --xp-md-inline-code-text: #3e4650;
  --xp-md-path-text: #4d657f;
  --xp-md-id-text: #7a828b;
  --xp-md-metric-key: #6f7780;
  --xp-md-metric-value: #3e4650;

  --xp-ops-surface: #ffffff;
  --xp-ops-surface-muted: #f6f7f4;
  --xp-ops-border: #e1e4dd;
  --xp-ops-code-bg: #18202d;
  --xp-ops-code-text: #d9e1ea;

  --xp-telemetry-text: #4d5661;
  --xp-telemetry-muted: #858d96;
  --xp-telemetry-border: #e2e5df;
  --xp-telemetry-track: #edf0eb;

  --xp-intent-info: #526f9e;
  --xp-intent-success: #5d8e81;
  --xp-intent-warning: #b38345;
  --xp-intent-danger: #b35c66;
}
```

Add these as semantic overlays first. Existing `--background`, `--foreground`, `--agent-*`, and
`--neon-*` tokens can remain for compatibility while components migrate.

Recommended new theme preset:

```ts
{
  id: 'calm',
  name: 'Xuanpu Calm',
  type: 'light',
  colors: {
    background: '#F5F6F3',
    foreground: '#3A4048',
    card: '#FCFCFA',
    'card-foreground': '#3A4048',
    popover: '#FCFCFA',
    'popover-foreground': '#3A4048',
    primary: '#526F9E',
    'primary-foreground': '#FFFFFF',
    secondary: '#EEF0EB',
    'secondary-foreground': '#4E5660',
    muted: '#EEF0EB',
    'muted-foreground': '#737B84',
    accent: '#E7EDF4',
    'accent-foreground': '#364253',
    destructive: '#B35C66',
    'destructive-foreground': '#FFFFFF',
    border: '#E1E4DD',
    input: '#D6DBD2',
    ring: '#526F9E',
    sidebar: '#EEF0EB',
    'sidebar-foreground': '#5A626B',
    'sidebar-primary': '#526F9E',
    'sidebar-primary-foreground': '#FFFFFF',
    'sidebar-accent': '#FCFCFA',
    'sidebar-accent-foreground': '#3A4048',
    'sidebar-border': '#E1E4DD',
    'sidebar-ring': '#526F9E',
    'agent-canvas': '#F5F6F3',
    'agent-sheet': '#FAFAF7',
    'agent-card': '#FCFCFA',
    'agent-card-muted': '#F1F2EE',
    'agent-hover': '#E9ECE6',
    ink: '#343A42',
    steel: '#737B84',
    'tech-blue': '#526F9E',
    'tech-blue-soft': '#E7EDF4',
    'neon-mint': '#5D8E81',
    'neon-mint-soft': '#E7F0EC',
    'neon-pink': '#B35C66',
    'neon-pink-soft': '#F3E4E7',
    'neon-violet': '#6C668F',
    'neon-violet-soft': '#ECEAF3'
  }
}
```

This is not a beige theme. It is a low-chroma, warm-neutral working theme with muted blue as the
main accent.

## Markdown Rendering v2

Create a meaning-aware renderer for Session HQ assistant prose.

Suggested files:

- `src/renderer/src/components/session-hq/readable/ReadableMarkdownRenderer.tsx`
- `src/renderer/src/components/session-hq/readable/MarkdownInlineCode.tsx`
- `src/renderer/src/components/session-hq/readable/markdown-inline-code-classifier.ts`

The existing `MarkdownRenderer` can remain for older surfaces. Use the new renderer first in
Session HQ assistant text.

### Inline Code Classification

Backticks should not automatically mean "render a heavy monospace chip".

Classify inline code into these kinds:

| Kind | Examples | Rendering |
| --- | --- | --- |
| `symbol` | `resolveUsageTokenTotals`, `TextCard`, `foo()` | quiet monospace, small background |
| `command` | `pnpm dev`, `git status`, `rg -n`, `--flag` | command chip or inline command style |
| `path` | `src/renderer/...`, `docs/plans/...`, `foo.tsx` | path style, lower background weight, optional copy on hover |
| `id` | UUID, hash, session id, turn id | muted monospace, truncation/copy where useful |
| `metric` | `page_count: 128`, `cost: $1.20` | key/value style, no heavy chip |
| `phrase` | natural-language phrase, Chinese phrase, product term | render as normal text with subtle emphasis, not monospace |
| `unknown` | fallback | quiet inline code style |

Classifier heuristics:

- contains `/`, `\`, known file extension, or starts with `~/`, `./`, `../` -> `path`;
- matches UUID/hash/session-id shape -> `id`;
- starts with common commands or contains shell flags/operators -> `command`;
- matches `^[a-zA-Z_][\\w.-]*:\\s+.+$` -> `metric`;
- matches function/class/member/code-symbol patterns -> `symbol`;
- contains CJK, spaces, and no code punctuation -> `phrase`;
- fallback -> `unknown`.

Important rule: do not mutate message content. Only change presentation.

### Markdown Layout

Reader markdown should use:

- `p`: `margin-block: 0 0.9em`, line-height `1.74`;
- `ul/ol`: list spacing `0.45em` to `0.65em` between items;
- headings: stronger top margin than bottom margin, but smaller than marketing headings;
- blockquote: quiet left border, secondary text, no large card;
- table/code/diff: wrapped in `WideBlock`;
- links: calm accent, underline only on hover or with subtle underline offset.

Avoid using `prose max-w-none` for ordinary assistant prose in Session HQ. The renderer should own
the exact reading rhythm.

## Component Refactor

### Replace TextCard With ReadableMessage

Create:

- `ReadableMessage`
- `ProseBlock`
- `WideBlock`
- `StreamingCursor`

Target structure:

```tsx
<ReadableMessage isStreaming={isStreaming}>
  <ReadableMarkdownRenderer content={content} />
  {isStreaming && <StreamingCursor />}
</ReadableMessage>
```

`ReadableMessage` should not render a rounded card by default. It should be an aligned text flow:

```css
.xp-readable-message {
  max-width: var(--xp-reader-measure, 820px);
  color: var(--xp-reader-text);
  font-size: var(--xp-reader-font-size, 15px);
  line-height: var(--xp-reader-line-height, 1.74);
}
```

`WideBlock` can override the width:

```css
.xp-wide-block {
  width: min(100%, var(--xp-reader-wide-measure, 1120px));
  max-width: calc(100vw - var(--xp-shell-side-insets, 360px));
}
```

### Operations Cards

Keep card surfaces for actual operational objects:

- tool call;
- file write;
- diff;
- terminal output;
- permission;
- todo;
- diagnostics.

But add state-specific density:

- running: expanded enough to show progress;
- completed: collapsed summary;
- failed: expanded error summary with action;
- manually expanded: full detail.

## Telemetry Refactor

### Color Semantics

Replace normal-state red/green metric color with neutral typography.

Normal telemetry:

- `text-telemetry`
- `text-telemetry-muted`
- neutral track bars;
- no saturated top border.

Threshold colors:

- warning only when `context >= 75%`, cache data stale, or budget approaching;
- danger only when `context >= 90%`, cost budget exceeded, run failed, or metric source is invalid;
- success only when an explicit operation completes successfully;
- info/accent only for selected/active items.

### Scope Semantics

The current panel is worktree-level but includes input/output/cache values that are often
session/runtime-specific. That makes the numbers hard to interpret.

Split scopes:

- **Current Session**: active model, active provider, context usage, current-session cost/tokens,
  last request usage, cache read/write for this session.
- **Worktree Aggregate**: active sessions count, total cost across sessions, total tokens across
  sessions, last updated time, provider breakdown.
- **Diagnostics**: stale/missing/partial telemetry, source confidence, database/jsonl mismatch.

The default visible scope should be Current Session. Worktree Aggregate should be secondary.

## Implementation Plan

### Phase 0: Guard The Scroll Model

Before visual work, document and preserve these invariants:

- no reintroduction of a physical composer grid row;
- `bottomReadableInset` still controls tail readability;
- jump-to-bottom visibility remains based on tail readability, not unread count only;
- text width changes must not change scroll container height calculations except through normal
  content reflow.

Do not mix this refactor with another scroll rewrite.

### Phase 1: Add Semantic Tokens

Files:

- `src/renderer/src/styles/globals.css`
- `src/renderer/src/lib/themes.ts`

Work:

- add `--xp-reader-*`, `--xp-md-*`, `--xp-ops-*`, `--xp-telemetry-*`, and `--xp-intent-*`;
- add `Xuanpu Calm` as a light theme preset;
- keep old tokens for compatibility;
- map old high-chroma tokens to calmer values in the new preset only.

Validation:

- current themes still load;
- new preset is selectable;
- no hard-coded new color values in components except token definitions.

### Phase 2: Build Markdown Rendering v2

Files:

- new readable markdown renderer files under `session-hq/readable/`;
- focused unit test for inline code classification.

Work:

- implement `classifyInlineCode(content)`;
- render different inline kinds with separate classes;
- route code blocks through existing `CodeBlock`;
- support `WideBlock` for table/code/diff-like structures.

Validation:

- natural-language phrase in backticks no longer renders as a chip;
- paths and IDs are visually quieter than commands;
- real code symbols remain identifiable;
- code blocks are unchanged or improved.

### Phase 3: Replace Assistant Text Surface

Files:

- `src/renderer/src/components/session-hq/cards/TextCard.tsx`
- new `ReadableMessage` components.

Work:

- remove rounded card shell from assistant prose;
- apply reader width and typography tokens;
- keep streaming cursor;
- preserve existing timeline ordering and scroll behavior.

Validation:

- ordinary assistant text no longer spans the full middle panel;
- wide blocks still have enough horizontal space;
- no overlap with composer overlay;
- no regression in clear-screen behavior.

### Phase 4: Neutralize Telemetry UI

File:

- `src/renderer/src/components/context-panel/ContextPanelHost.tsx`

Work:

- replace `OverviewHeroMetric` with neutral `TelemetryMetricRow` or compact metric cards;
- remove red/green normal-state cost/token styling;
- add threshold-driven tone mapping;
- separate current-session and worktree-aggregate sections;
- make source/scope visible in labels or tooltips.

Validation:

- normal cost/token values are neutral;
- warning/danger colors appear only when thresholds are met;
- right panel no longer visually dominates assistant prose;
- aggregate values are clearly labeled as aggregate.

### Phase 5: Add Focus Mode And Density

Files:

- renderer settings/store for UI preferences;
- Session HQ shell/layout components;
- context panel host;
- tool cards.

Work:

- add `focusMode` boolean;
- add `readingDensity: comfortable | standard | compact`;
- drive CSS variables from these settings;
- collapse right inspector in Focus Mode;
- compact completed tool cards in Focus Mode.

Validation:

- Focus Mode changes visual priority without breaking timeline scroll;
- density modes affect reading rhythm predictably;
- compact mode does not become the default for long reading.

### Phase 6: Visual Regression Fixtures

Add a fixture session or Storybook-like test route containing:

- long Chinese/English mixed markdown;
- many inline paths, ids, metrics, commands, and natural-language backticks;
- bullet lists, nested lists, blockquotes, tables, code blocks, and diffs;
- completed/running/failed tool cards;
- right panel with normal, warning, and danger telemetry states;
- streaming tail near the overlay composer.

Validation should use screenshots at:

- desktop wide;
- desktop narrow;
- dark theme;
- Xuanpu Calm light theme;
- Focus Mode;
- compact density.

## Acceptance Criteria

This refactor is done only when all of the following are true:

- Inline code chip visual area is reduced by at least 50% on a screenshot similar to the reported
  dense markdown case.
- Natural-language phrases wrapped in backticks do not render as monospace chips.
- Assistant prose line width is capped around `820px` in default/comfortable mode.
- Code blocks, diffs, tables, and terminal output remain readable and can use wider layouts.
- Normal right-panel cost/token/context metrics are neutral, not red/green.
- Red/green appears only for explicit semantic states or configured thresholds.
- Worktree aggregate metrics and current-session metrics are visually and textually separated.
- Completed tool cards take meaningfully less vertical space than running/failed cards.
- Focus Mode makes assistant prose the clear first visual focus.
- The Claude-like overlay composer and clear-screen behavior still pass manual and automated checks.
- Main text contrast remains WCAG AA or better in light and dark themes.

## Rollout Strategy

Use a feature-flagged or route-scoped rollout:

1. Ship semantic tokens and `Xuanpu Calm` without changing default behavior.
2. Enable `ReadableMarkdownRenderer` only for Session HQ assistant text.
3. Replace assistant prose card shell.
4. Neutralize telemetry panel.
5. Add Focus Mode and density preferences.
6. Make `Xuanpu Calm` the recommended light theme after screenshots pass.

Avoid landing all changes as one undifferentiated patch. This is a large visual refactor and needs
reviewable checkpoints.

## Risks

- **Heuristic misclassification**: some inline code may be rendered too quietly. Mitigation: keep
  fallback `unknown` as quiet code, not plain text; add tests for known examples.
- **Width changes affect perceived scroll**: prose may reflow into more vertical height. Mitigation:
  preserve the overlay scroll model and validate sticky-bottom streaming after Phase 3.
- **Telemetry loses urgency**: users may miss real warnings. Mitigation: threshold colors and icons
  should become clearer precisely because normal state is neutral.
- **Theme churn**: token migration can become broad. Mitigation: add new semantic tokens first and
  migrate only Session HQ surfaces in this project.

## Non-Goals

- Do not redesign the whole app navigation in this pass.
- Do not replace the overlay composer scroll architecture.
- Do not remove existing theme presets immediately.
- Do not make telemetry disappear; demote it by default and make it clearer by scope.
- Do not make all markdown plain text; code, commands, paths, ids, and metrics still need distinct
  affordances.

## First Implementation Checklist

- [ ] Add semantic reader/markdown/operations/telemetry tokens.
- [ ] Add `Xuanpu Calm` theme preset.
- [ ] Add inline code classifier with tests.
- [ ] Add `ReadableMarkdownRenderer`.
- [ ] Add `ReadableMessage`, `ProseBlock`, `WideBlock`, and `StreamingCursor`.
- [ ] Swap Session HQ assistant `TextCard` to the readable renderer.
- [ ] Neutralize `OverviewHeroMetric` and token rows.
- [ ] Split Current Session vs Worktree Aggregate in the right Inspector.
- [ ] Add Focus Mode.
- [ ] Add reading density preference.
- [ ] Add screenshot fixture and Playwright visual checks.

