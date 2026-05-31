# Codex reasoning effort propagation fix plan

Date: 2026-05-31
Branch: `feat/xuanpu-agent-oh-my-pi`

## Problem

In Xuanpu, a Codex session can store or select `model_variant = xhigh`, but the request sent through
`CodexAppServerManager.sendTurn()` falls back to `medium`.

Observed call chain:

- Session/model selection persists the intended variant, for example `xhigh`.
- `CodexImplementer.setSelectedModel()` stores `selectedVariant`.
- `CodexImplementer.prompt()` resolves the model, but calls `manager.sendTurn()` without
  `reasoningEffort`.
- `CodexAppServerManager.sendTurn()` then defaults
  `collaborationMode.settings.reasoning_effort` to `medium` when no explicit effort is provided.

The visible effect is that the UI/session says `xhigh`, while the downstream Codex relay records
`medium`.

## Root Cause

`src/main/services/codex-implementer.ts` has the real prompt call:

```ts
const turnStart = await this.manager.sendTurn(session.threadId, {
  text: turnText,
  model,
  ...(options?.codexFastMode ? { serviceTier: 'fast' } : {}),
  interactionMode
})
```

It omits `reasoningEffort`.

`src/main/services/codex-app-server-manager.ts` is behaving consistently with its contract:

```ts
reasoning_effort: input.reasoningEffort ?? 'medium'
```

So the fix should be in the implementer path that knows the selected session/model variant, not by
changing the manager default.

## Fix Scope

Change only the Codex runtime path:

- `src/main/services/codex-implementer.ts`
- focused Codex tests under `test/phase-22`

Do not touch the in-progress xuanpu-agent config changes in phase 24 as part of this fix.

## Resolution Rule

Before calling `manager.sendTurn()`, resolve a single `reasoningEffort` with this precedence:

1. `modelOverride.variant`
2. DB session `model_variant`
3. `this.selectedVariant`
4. Codex config `model_reasoning_effort`, if available through `getCodexConfiguredReasoningEffort()`
5. undefined, letting `CodexAppServerManager` keep its existing `medium` default

Rationale:

- Explicit per-call override should win.
- Persisted session choice should survive process/session reconstruction.
- In-memory selected variant covers the normal "user selected model then prompt" path.
- Codex config remains a fallback default, not stronger than an explicit Xuanpu session choice.
- Manager default remains the compatibility fallback.

## Implementation Steps

1. Import `getCodexConfiguredReasoningEffort` from `codex-config` in
   `src/main/services/codex-implementer.ts`.
2. In `CodexImplementer.prompt()`, fetch the DB session once near the existing interaction-mode
   logic and reuse it for both:
   - `interactionMode = 'plan'`
   - `dbSession.model_variant`
3. Compute:

```ts
const reasoningEffort =
  modelOverride?.variant ??
  dbSession?.model_variant ??
  this.selectedVariant ??
  getCodexConfiguredReasoningEffort() ??
  undefined
```

4. Pass it into `sendTurn()` only when truthy:

```ts
const turnStart = await this.manager.sendTurn(session.threadId, {
  text: turnText,
  model,
  ...(reasoningEffort ? { reasoningEffort } : {}),
  ...(options?.codexFastMode ? { serviceTier: 'fast' } : {}),
  interactionMode
})
```

5. Keep `CodexAppServerManager.sendTurn()` unchanged. Its `medium` default is still correct when no
   upstream effort has been selected.

## Tests

Extend existing tests instead of adding a new phase directory.

### `test/phase-22/session-5/codex-prompt-streaming.test.ts`

Add cases that inspect the mocked `sendTurn()` input:

- `modelOverride.variant = xhigh` sends `reasoningEffort: 'xhigh'`.
- DB session `model_variant = xhigh` sends `reasoningEffort: 'xhigh'` when no override is present.
- `setSelectedModel(... variant: 'xhigh')` sends `reasoningEffort: 'xhigh'` when DB has no variant.
- Codex config fallback sends configured effort when neither override, DB, nor selected state has one.
- Existing behavior still sends no explicit `reasoningEffort` when all sources are absent.

### `test/phase-22/session-5/codex-app-server-manager.test.ts`

Keep the current default test:

- no `reasoningEffort` => `collaborationMode.settings.reasoning_effort === 'medium'`

Keep or strengthen the current explicit-effort test:

- `reasoningEffort: 'low'` => both:
  - `params.settings.reasoningEffort === 'low'`
  - `params.collaborationMode.settings.reasoning_effort === 'low'`

This proves the manager already serializes explicit effort correctly and should not be changed.

## Verification Commands

Run the narrow Codex suite first:

```bash
pnpm vitest run \
  test/phase-22/session-5/codex-prompt-streaming.test.ts \
  test/phase-22/session-5/codex-app-server-manager.test.ts \
  test/phase-22/session-7/codex-model-selection.test.ts
```

Then run typecheck:

```bash
pnpm exec tsc --noEmit --pretty false
```

If this fix is batched with the xuanpu-agent config work, also run the existing phase-24 checks after
the Codex tests. Do not use phase-24 failures to block this Codex reasoning-effort fix unless the
changed Codex files caused them.

## Acceptance Criteria

- A Codex session stored as `model_variant = xhigh` sends `reasoningEffort: 'xhigh'` to
  `CodexAppServerManager.sendTurn()`.
- The app-server request includes:
  - `settings.reasoningEffort = 'xhigh'`
  - `collaborationMode.settings.reasoning_effort = 'xhigh'`
- Existing sessions without a selected/stored/configured effort still default to `medium`.
- The fix is isolated from xuanpu-agent config loader work.

## Risk Notes

- Do not globally change the manager default from `medium`; that would alter behavior for every
  caller that intentionally omits reasoning effort.
- Do not rely only on `this.selectedVariant`; that value is in-memory and can be lost after process
  restart or session reconstruction.
- Do not make Xuanpu read Codex CLI config at runtime for this bug. The only relevant Codex config
  hook is the existing internal `codex-config` fallback, and it must be weaker than the explicit
  Xuanpu session variant.
