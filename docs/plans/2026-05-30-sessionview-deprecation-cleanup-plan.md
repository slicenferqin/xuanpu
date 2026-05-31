# SessionView Deprecation Cleanup Plan

Date: 2026-05-30

## Decision

Do not delete `src/renderer/src/components/sessions/SessionView.tsx` immediately.

The right cleanup window is open, but the correct first step is to remove
`SessionShell` and Session HQ dependencies on the legacy `SessionView` module.
Only after the live product path no longer imports or exposes the legacy UI
should the repository delete `SessionView.tsx` and the old session components.

In short:

- Good now: remove dead timeline UI such as old `RoundRail`, and begin
  `SessionView` dependency extraction.
- Not good now: delete `SessionView.tsx` in the same change set as active Session
  HQ interaction work.

## Current Evidence

The current default UI path is Session HQ, but legacy `SessionView` remains wired
as an explicit fallback.

- `src/renderer/src/components/layout/MainPane.tsx`
  - lazy imports legacy `SessionView`
  - lazy imports `SessionShell`
  - switches between them with `sessionUiV2Enabled`
- `src/renderer/src/components/settings/SettingsGeneral.tsx`
  - exposes the "新版 Session UI" switch
  - copy still says disabling it falls back to old `SessionView`
- `src/renderer/src/stores/useSettingsStore.ts`
  - persists `sessionUiV2Enabled`
  - default is currently `true`
- `src/renderer/src/components/session-hq/ComposerBar.tsx`
  - imports `BUILT_IN_SLASH_COMMANDS` from legacy `SessionView`
- `src/renderer/src/components/session-hq/ThreadPane.tsx`
  - imports `DroidMessage` and `StreamingPart` from legacy `SessionView`
- `src/renderer/src/components/sessions/index.ts`
  - re-exports `SessionView`
  - re-exports `OpenCodeMessage`, `SessionViewState`, and `StreamingPart` from
    `SessionView`

This means the file is still part of the public renderer module graph, not just
an unused file.

## Why Immediate Deletion Is Risky

Deleting `SessionView.tsx` now would combine too many concerns:

1. Remove a user-visible fallback switch.
2. Rewrite module ownership for slash commands and session timeline types.
3. Update tests that still import legacy `SessionView`.
4. Validate that every old fallback behavior already exists in `SessionShell`.
5. Keep current active Session HQ UI work reviewable.

That is too large for the current anchor/navigation refactor window. The delete
would be easy mechanically, but hard to trust behaviorally.

## Target End State

`SessionShell` should become the only production session UI for non-terminal
agent sessions.

Legacy session code should no longer be a source of shared constants, shared
types, or fallback behavior.

The desired final shape:

- `MainPane` renders `SessionShell` for non-terminal sessions.
- legacy `sessionUiV2Enabled` is migrated away from product settings.
- slash command constants live in a neutral module.
- timeline/message types live in shared timeline modules.
- old `SessionView` tests are replaced by `SessionShell` tests.
- `SessionView.tsx` can be deleted without touching live UI behavior.

## Cleanup Strategy

### Phase 0: Keep Current UI Work Separate

Finish and verify the current Round Navigator / Session HQ interaction change
first. Do not mix `SessionView` deletion with anchor wheel or visual-system
work.

Allowed in this phase:

- Delete truly unused Session HQ dead code, such as the old `RoundRail`
  component once tests have moved to `RoundNavigator`.
- Keep changes narrowly scoped to the active interaction work.

Do not:

- remove `SessionView`
- remove the fallback setting
- rewrite shared message types

### Phase 1: Extract Shared Constants

Move built-in slash command definitions out of `SessionView.tsx`.

Recommended target:

- `src/renderer/src/lib/session-commands.ts`

Move:

- `BUILT_IN_SLASH_COMMANDS`
- any related command metadata helpers that are UI-neutral

Then update:

- `src/renderer/src/components/session-hq/ComposerBar.tsx`
- legacy `SessionView.tsx`
- tests that import `BUILT_IN_SLASH_COMMANDS`

This removes the most visible bad dependency: Session HQ importing constants
from the legacy UI component.

### Phase 2: Extract Shared Types

Stop importing types from `SessionView.tsx`.

Preferred direction:

- use `@shared/lib/timeline-types` for durable timeline/message/streaming types
- add a renderer-local neutral type module only if shared types cannot express
  an existing UI-only shape

Candidates to migrate:

- `OpenCodeMessage`
- `StreamingPart`
- `DroidMessage`
- `SessionViewState`

Potential target modules:

- `src/shared/lib/timeline-types.ts`
- `src/renderer/src/lib/session-types.ts`
- `src/renderer/src/lib/session-view-state.ts`

After this phase, `SessionView.tsx` should no longer be imported by Session HQ,
old shared renderers, stores, or tests only for types.

### Phase 3: Retire the User-Visible Fallback

Remove the product-facing `sessionUiV2Enabled` switch from Settings.

Steps:

1. Remove the "新版 Session UI" toggle from
   `src/renderer/src/components/settings/SettingsGeneral.tsx`.
2. Keep `sessionUiV2Enabled` in persisted settings for one migration cycle if
   needed, but stop using it as a user-facing product choice.
3. Make `MainPane` render `SessionShell` for non-terminal agent sessions.
4. If a short-term emergency fallback is still needed, use a dev-only or
   environment-only kill switch, not a visible user setting.

Important: this phase should happen only after `SessionShell` covers the legacy
behaviors listed in the validation matrix below.

### Phase 4: Replace Legacy Tests

Audit and migrate tests that still import legacy `SessionView`.

Known import categories:

- tests importing `SessionView` directly
- tests importing `BUILT_IN_SLASH_COMMANDS`
- tests importing `StreamingPart` or `OpenCodeMessage` from `SessionView`
- tests asserting old virtualized list behavior that is no longer the production
  path

Keep tests when they assert product behavior that still matters. Move those to
`SessionShell`, `AgentTimeline`, `ComposerBar`, or shared pure functions.

Delete tests only when they validate implementation details of the old UI.

### Phase 5: Delete Legacy UI

Delete `SessionView.tsx` only when all of these are true:

- `rg "SessionView" src/renderer/src` shows no production import except maybe
  archived comments during the transition.
- `MainPane` no longer imports or renders `SessionView`.
- Settings no longer exposes a fallback switch.
- `ComposerBar` and Session HQ no longer import from `../sessions/SessionView`.
- all tests that still matter have moved to current Session HQ paths.
- the validation matrix below has passed.

Potential deletion set:

- `src/renderer/src/components/sessions/SessionView.tsx`
- old UI-only components under `src/renderer/src/components/sessions/` that are
  no longer used by Session HQ, terminal sessions, settings, history, or
  auxiliary panels

Do not delete shared or still-used session components just because they live in
`components/sessions/`.

Examples of components that may still be shared:

- `AttachmentButton`
- `AttachmentPreview`
- `SlashCommandPopover`
- `ScrollToBottomFab`
- `PlanReadyImplementFab`
- `SessionTerminalView`
- `SessionTabs`

## Validation Matrix Before Deleting SessionView

Manual/product checks:

- create a new OpenCode session
- create a new Claude Code session
- create a new Codex session
- send a prompt in each provider
- stop a running response
- resume or switch back to an existing session
- switch between multiple active sessions
- run a long streaming response
- verify bottom composer overlay and jump-to-bottom behavior
- verify `/clear`, `/undo`, and `/redo` or their supported equivalents
- verify plan-ready flow
- verify question/permission prompt handling
- verify file attachments and slash command popover
- verify tool rendering for bash/read/write/edit/search/task/todo
- verify context/usage panel remains accurate after session switch
- restart the app and reopen previous sessions

Automated checks:

- targeted Session HQ renderer tests
- timeline mapper tests
- command/filter tests
- session store close/remove tests
- smart scroll tests
- provider-specific timeline tests for Claude Code, Codex, and OpenCode

## Naming Cleanup

`src/renderer/src/lib/session-view-registry.ts` should not be deleted just
because the name contains `SessionView`.

It is currently used by Session HQ smart-scroll state. It should be renamed in a
separate low-risk cleanup once old `SessionView` is gone.

Possible new names:

- `session-scroll-registry.ts`
- `timeline-view-registry.ts`

This should include import updates and focused scroll-registry tests only.

## Recommended Commit Boundaries

1. `cleanup: remove unused round rail`
2. `refactor: move built-in slash commands out of SessionView`
3. `refactor: move session timeline types out of SessionView`
4. `refactor: make SessionShell the only product session UI`
5. `test: migrate legacy SessionView behavior coverage to SessionShell`
6. `cleanup: delete legacy SessionView`
7. `rename: session-view-registry to session-scroll-registry`

The first three commits are safe to do soon. Commits four through seven should
wait until current Session HQ interaction work is stable.

## Current Recommendation

Start now with dependency extraction, not deletion.

The immediate next practical task is:

1. Finish/commit the current Round Navigator cleanup separately.
2. Move `BUILT_IN_SLASH_COMMANDS` into a neutral command module.
3. Move `StreamingPart` / `OpenCodeMessage` / `DroidMessage` imports away from
   `SessionView.tsx`.
4. Remove the Settings fallback only after Session HQ passes the validation
   matrix.
