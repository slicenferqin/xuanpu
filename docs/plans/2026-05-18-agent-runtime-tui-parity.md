# Agent Runtime TUI Parity Plan

目标：让玄圃内置 Claude Code / Codex 的会话体验接近各自 TUI/CLI 的稳定性和流畅度，尤其是 busy 状态下的输入、排队、steer、stop、恢复、可见反馈和测试覆盖。

## Source Documents

本计划以当前仓库实现和官方文档共同作为约束。

- Claude Code SDK TypeScript reference: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript
- Codex CLI features: https://developers.openai.com/codex/cli/features
- Codex App Server: https://developers.openai.com/codex/app-server
- Existing Xuanpu Session HQ plan: `docs/plans/2026-04-11-session-ui-agent-hq-lite-replan.md`
- Existing Codex transcript plan: `docs/plans/2026-03-31-codex-transcript-normalization.md`
- Runtime stability hardening plan: `docs/plans/2026-05-18-agent-runtime-stability-hardening.md`
- Legacy queued-message PRDs: `docs/prd/phase-06.md`, `docs/prd/phase-12.md`

## What The Official Docs Change

### Claude Code

Claude Code SDK `query()` accepts either a plain prompt string or an `AsyncIterable<SDKUserMessage>`. It returns a `Query` async generator. The `Query` object exposes `streamInput(...)`, `interrupt()`, `setModel(...)`, and related controls, but the docs mark several of those controls as only available in streaming input mode.

Current Xuanpu behavior is not a long-lived streaming-input session for normal prompts. `ClaudeCodeImplementer.prompt()` usually calls `sdk.query({ prompt: string, options })`. It only uses an async iterable as a single structured user message when file attachments are present. That means a true Claude TUI-like busy input channel is not currently modeled as "append input into the same open input stream"; Xuanpu mostly starts separate prompt calls and depends on renderer-side queueing.

Implication: for Claude Code, the safe first implementation is a local, durable next-turn queue plus robust interrupt/finalization. A future streaming-input upgrade can add true mid-turn input, but it must be explicit and tested separately.

### Codex

Codex CLI documents a distinct busy-state UX:

- `Enter` while Codex is running injects new instructions into the current turn.
- `Tab` while Codex is running queues follow-up input for the next turn.
- Queued input can be a normal prompt, a slash command, or a `!` shell command.

Codex App Server exposes the same split at protocol level:

- `turn/start` starts a new turn.
- `turn/steer` appends user input to the active in-flight turn without creating a new turn, and requires the expected active turn id.
- `turn/interrupt` requests cancellation; a successful interruption ends the turn with `status: "interrupted"`.
- `thread/read` reads stored thread history without resuming or subscribing to it.

Implication: Xuanpu should not treat "busy + text" as queue-first for Codex. TUI parity means "steer current turn" and "queue next turn" are separate first-class actions with separate shortcuts and state transitions.

## Current Gaps

### 1. Queue Semantics Are Provider-Agnostic In The Wrong Way

`session-send-actions.ts` currently models busy draft content as:

- primary: `queue`
- alternatives: `steer`, `stop_and_send`

That contradicts Codex CLI behavior, where the running-turn default is steer/inject and queue is an explicit next-turn action. It is also not fully correct for Claude Code because the current Claude implementation does not maintain a persistent streaming input channel for normal text prompts.

### 2. Queue Storage Is Too Weak

`useSessionRuntimeStore.pendingMessages` is an in-memory renderer `Map`. It is useful for immediate UI, but it is not a source of truth.

Problems:

- queued text can be lost on renderer reload, crash, or some remount paths
- queued attachments are not durable
- queue state only syncs a boolean to the main-process notification service
- `requeueMessageFront()` does not sync queued state back to true after a failed drain
- no explicit `pending -> sending -> sent/failed/cancelled` state

### 3. Queue Drain Is Not Transactional

`SessionShell` drains queued messages on idle:

1. refresh timeline
2. dequeue from runtime store
3. call `window.agentOps.prompt(...)`
4. requeue on failure

This has race and UX gaps:

- the queued bubble can disappear before the new prompt is accepted
- auto-drain can overlap timeline refresh from the previous turn
- failed send can briefly clear the native queued state
- no per-session drain lock prevents multiple idle events from racing
- the drained prompt is not represented as a "sending queued item" with stable UI identity

### 4. Codex Lifecycle Races Make Queue Unsafe

Before queue can be trusted, Codex `prompt()` / `abort()` / `readThread()` must become turn-scoped.

Current risks:

- prompt event listeners filter by `threadId`, not by local run id or expected `turnId`
- `waitForTurnCompletion()` accepts any `turn/completed` for the thread
- `abort()` clears live draft instead of materializing partial output
- `readThread()` can replace all `session.messages` with a stale non-empty snapshot
- `stop_and_send` waits a fixed 100ms before starting a new prompt

If those remain, auto-drained queued messages can be overwritten by late completions from older turns.

### 5. Renderer Event Ingress Is Still Not Single-Path

`useAgentEventBridge` is intended to be the only raw `window.agentOps.onStream` subscriber, but `usePRDetection` still subscribes directly. That bypasses the runEpoch/sessionSequence guard.

This matters for queue UX because PR detection, completion notification suppression, pending-message drain, and timeline refresh all depend on consistent event ordering.

## Target Composer Semantics

### Idle / Error

- `Enter`: start a new turn with `turn/start` or Claude `query()`
- primary button: `Send`
- pending queued items are visible and can be reordered/cancelled before drain

### Busy With Empty Composer

- primary button: `Stop`
- `Esc` or stop button: interrupt current turn
- no hidden "stop and send" because there is no content to send

### Busy With Draft Content

Provider-specific defaults:

- Codex: `Enter` = steer current turn via `turn/steer`
- Codex: `Tab` or explicit menu action = queue for next turn
- Codex: explicit destructive action = stop current turn, then send
- Claude Code MVP: `Enter` = queue for next turn, unless/until Claude runtime is upgraded to a real streaming-input channel
- Claude Code MVP: explicit stop action uses `query.interrupt()` plus draft flush, then optional send
- OpenCode: keep existing support, but route through the same durable queue state

The button label should describe the action that pressing Enter will take. Alternatives should remain visible in the dropdown, with shortcut hints.

## Durable Queue Model

Introduce a main-process-backed queue table instead of treating renderer memory as truth.

Suggested table:

```sql
CREATE TABLE session_pending_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_session_id TEXT,
  runtime_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  content TEXT NOT NULL,
  attachments_json TEXT,
  prompt_options_json TEXT,
  model_json TEXT,
  enqueued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sending_run_epoch INTEGER,
  sending_turn_id TEXT,
  error TEXT
);
```

Rules:

- enqueue writes to DB first, then mirrors into `useSessionRuntimeStore`
- dequeue does not remove the row; it transitions `pending -> sending`
- only after prompt acceptance and durable user message commit does it become `sent`
- failures transition to `failed` or back to `pending` depending on retry policy
- cancel transitions to `cancelled`
- renderer reload hydrates pending/sending/failed rows from DB
- notification suppression reads durable queued state, not a renderer boolean

## Drain State Machine

Per session, keep one drain lock:

```text
idle event for run N
  -> verify active session is not in interrupt/approval/plan-blocked state
  -> wait for durable timeline refresh for run N
  -> acquire drain lock
  -> load first pending item from DB
  -> mark sending
  -> render queued bubble as "sending"
  -> call provider send path
  -> on prompt accepted:
       keep item as sending until first user message / session.busy / runEpoch advanced
  -> on durable commit:
       mark sent
       release lock
  -> on failure:
       mark failed or pending
       release lock
```

Do not drain while:

- a question / permission / command approval / plan approval is pending
- the provider lifecycle is still materializing
- a previous queued item is `sending`
- Codex has an unresolved old prompt finalization

## Provider Runtime Contract

Add runtime capabilities that describe input behavior, not just availability.

```ts
type RuntimeInputSemantics = {
  canStartTurn: boolean
  canSteerActiveTurn: boolean
  canQueueNextTurn: boolean
  canInterruptTurn: boolean
  supportsExpectedTurnId: boolean
  supportsStreamingInput: boolean
}
```

Initial mapping:

- Codex: `canSteerActiveTurn=true`, `supportsExpectedTurnId=true`, `canQueueNextTurn=true`
- Claude Code current implementation: `canSteerActiveTurn=false`, `supportsStreamingInput=false`, `canQueueNextTurn=true`, `canInterruptTurn=true`
- Claude Code future implementation: enable `supportsStreamingInput=true` only after normal text prompts run through a persistent input iterable
- OpenCode: map existing behavior after a separate check

## Implementation Plan

### PR 1: Codex Turn Lifecycle Correctness

Scope:

- add local run/turn token to `CodexSessionState`
- bind prompt event handling to expected run and turn
- make `waitForTurnCompletion()` accept only the matching turn completion
- treat `turn/interrupted` as an explicit terminal state for the interrupted turn
- make `abort()` materialize live draft before clearing it
- prevent stale `thread/read` snapshots from replacing newer messages
- pass `expectedTurnId` when calling `turn/steer`

Tests:

- stop A -> start B -> A late completion does not complete B
- stale A `thread/read` does not overwrite B user message
- abort preserves partial assistant text/tool as aborted/cancelled
- wrong turn completion does not resolve current prompt
- `turn/interrupted` settles the interrupted run

### PR 2: Durable Pending Message Queue

Scope:

- add DB migration and IPC for pending messages
- hydrate pending queue on session mount
- render queued/sending/failed bubbles with stable ids
- replace renderer-only `pendingMessages` truth with durable queue mirror
- sync notification suppression from durable pending count

Tests:

- enqueue persists and survives store reset
- failed drain does not lose content or attachments
- cancel marks row cancelled and removes visible bubble
- notification suppression follows durable pending state

### PR 3: Composer Semantics Aligned With Runtime Docs

Scope:

- update `determineComposerActions()` to use runtime input semantics
- Codex busy `Enter` steers; `Tab` queues next turn
- Claude Code busy `Enter` queues until streaming input is implemented
- stop-with-content becomes explicit destructive menu action, not hidden default
- steer no longer clears live overlay
- stop-and-send no longer sleeps 100ms; it waits on an explicit lifecycle boundary

Tests:

- Codex busy + draft -> primary steer
- Codex busy + Tab -> queue
- Claude busy + draft -> queue
- steer keeps live overlay
- stop-and-send waits for abort boundary instead of fixed timer

### PR 4: Single Renderer Event Ingress

Scope:

- move PR URL detection behind `useAgentEventBridge` / session event callbacks
- ensure `rg "agentOps.onStream" src/renderer/src` only finds `useAgentEventBridge`
- throttle hot-path activity touches
- keep `SessionShell + runtime mirror` as the active path
- stop expanding old `SessionView` provider-specific logic

Tests:

- stale run events are invisible to PR detection
- duplicate stream events are dropped before side effects
- tab switch/remount does not resurrect stale live overlay

### PR 5: Claude Code Streaming Input Spike

Scope:

- prototype a real persistent `AsyncIterable<SDKUserMessage>` channel for normal Claude prompts
- verify `streamInput()` behavior with the current SDK version
- only if stable: add Claude steer-like mid-turn input capability
- otherwise keep Claude on durable next-turn queue and document the limitation

Exit criteria:

- no overlapping Claude `query()` loops per session
- interrupt still flushes in-flight draft
- queued messages preserve order and do not duplicate SDK user echoes

## Acceptance Criteria

- Busy-state behavior matches each provider's documented semantics.
- Queued messages are visible, cancellable, durable, and not lost on reload.
- A queued item is not removed until the provider accepts it.
- Auto-drain never starts a new turn until the previous turn is durably committed or safely finalized.
- Codex late events and stale snapshots cannot overwrite newer turns.
- Renderer has one raw stream ingress path.
- Tests cover service-level races and mounted `SessionShell` behavior, not only source-code smoke checks.

## Work Not To Do Yet

- Do not remove `SessionView` in the same PR as queue/lifecycle fixes.
- Do not implement Claude mid-turn steering until the SDK streaming-input path is proven with tests.
- Do not rely on fixed sleep intervals for stop/abort/send sequencing.
- Do not make queued messages renderer-only again.
- Do not conflate "queue next turn" and "steer current turn" in the UI copy.
