# Agent Runtime Stability Hardening Plan

目标：在继续做 durable queue 之前，先把 Claude Code / Codex 在玄圃里的 runtime 底座收稳。这里的重点不是 UI 视觉，而是 turn 生命周期、stream ingress、abort/steer 边界、durable transcript 和热路径是否能支撑 TUI/CLI 级别的高频交互。

配套文档：

- Queue / composer 语义：`docs/plans/2026-05-18-agent-runtime-tui-parity.md`
- Session HQ 架构计划：`docs/plans/2026-04-11-session-ui-agent-hq-lite-replan.md`
- Codex transcript 归一化：`docs/plans/2026-03-31-codex-transcript-normalization.md`
- Claude Code SDK docs: https://docs.claude.com/en/docs/claude-code/sdk/sdk-typescript
- Codex CLI features: https://developers.openai.com/codex/cli/features
- Codex App Server docs: https://developers.openai.com/codex/app-server

## Why This Comes Before More UX Work

当前最危险的问题不是聊天页观感，而是 runtime 状态没有形成可靠的事务边界。

如果 `CodexImplementer.prompt()`、`abort()`、`waitForTurnCompletion()`、`readThread()` 仍然只按 `threadId` 工作，那么任何更好的 queue UI、快捷键、steer 菜单都会建立在不稳定的底座上：

- stop 后立刻 send，旧 turn 的 late `turn/completed` 可能让新 prompt 提前完成
- 旧 turn 的 late `thread/read` snapshot 可能整体替换新 turn 的 `session.messages`
- abort 清掉 live draft 后，用户刚看到的 partial output / running tool 可能从 durable timeline 消失
- renderer runEpoch guard 可以挡住 stale stream event，但挡不住 main process 自己的 stale `readThread()` 写库

因此本计划优先级高于 durable queue 的完整实现。queue PR 可以和本计划并行设计，但落地顺序应先修 Codex lifecycle。

## Current Architecture Snapshot

Main process:

- `src/main/services/agent-runtime-types.ts` 定义 provider 抽象。
- `src/main/services/agent-runtime-manager.ts` 管理 runtime implementer。
- `src/main/services/claude-code-implementer.ts` 使用 Claude Code SDK `query()` async generator。
- `src/main/services/codex-implementer.ts` 使用 `CodexAppServerManager`，接收 JSON-RPC event，转换为 canonical stream event，并在 turn 完成后 `thread/read`。
- `src/main/services/codex-app-server-manager.ts` 负责 `codex app-server` child process、`turn/start`、`turn/steer`、`turn/interrupt`、`thread/read`。
- `src/main/services/session-timeline-service.ts` 负责 main-side durable timeline 合成。

Renderer:

- `src/renderer/src/hooks/useAgentEventBridge.ts` 是目标上的唯一 raw stream ingress。
- `src/renderer/src/stores/useSessionRuntimeStore.ts` 保存 lifecycle、streaming buffer、interrupt queue、pending messages。
- `src/renderer/src/components/session-hq/SessionShell.tsx` 是默认 Session HQ UI。
- `src/renderer/src/components/sessions/SessionView.tsx` 是旧 UI fallback，但仍维护独立 streaming 重建逻辑。
- `src/renderer/src/hooks/usePRDetection.ts` 仍然直接订阅 `window.agentOps.onStream`，绕过 runtime guard。

## Risk Register

### P0: Codex Prompt/Abort Are Not Turn-Scoped

Affected files:

- `src/main/services/codex-implementer.ts`
- `src/main/services/codex-app-server-manager.ts`
- `src/main/ipc/agent-handlers.ts`

Symptoms:

- `prompt()` 内部 event listener 只按 `threadId` 过滤。
- `waitForTurnCompletion()` 看到同 thread 的任意 `turn/completed` 就 resolve。
- `abort()` 只调用 `turn/interrupt`，然后清 `liveAssistantDraft` 并 emit idle。
- `readThread()` 后直接 `session.messages = parsed`，然后 destructive `replaceSessionMessages()`。
- `stop_and_send` 在 renderer 侧固定 sleep 100ms，不能保证旧 prompt 已 finalized。

Target behavior:

- 每次 `prompt()` 都有本地 `runId`，并绑定 expected `turnId`。
- 旧 run 的 event 不能更新当前 run 的 live draft / status / messages。
- 旧 run 的 `thread/read` 结果不能覆盖新 run 的 synthetic user message 或 canonical transcript。
- abort 是一个 terminal transition：必须先 materialize live draft，再清理 current run。
- interrupted turn 必须显式 settle，不能等 300 秒 timeout。

Implementation sketch:

```ts
interface CodexActiveRun {
  runId: string
  expectedTurnId: string | null
  state: 'starting' | 'running' | 'aborting' | 'finalizing' | 'settled'
  startedAt: number
  abortController: AbortController
}
```

Changes:

- Add `activeRun: CodexActiveRun | null` and `settledRunIds: Set<string>` to `CodexSessionState`.
- In `prompt()`, generate `runId` before `beginSessionRun(session.hiveSessionId)`.
- Bind the `turnId` returned by `manager.sendTurn()` to the active run.
- Event handler accepts lifecycle/content events only when:
  - `event.threadId === session.threadId`
  - active run still has the same `runId`
  - if the event has `turnId`, it matches `expectedTurnId`
- `waitForTurnCompletion()` takes `runId`, `expectedTurnId`, and `AbortSignal`.
- `turn/interrupted` for the expected turn settles as aborted.
- On abort:
  - mark active run as aborting
  - call `manager.interruptTurn(session.threadId, expectedTurnId)`
  - materialize `liveAssistantDraft` into an assistant message with `aborted: true`
  - convert running tools to terminal `cancelled` or `error` state with end time
  - persist canonical messages
  - emit terminal tool update events and idle
  - clear active run only if it is still the same run
- On `thread/read` completion:
  - only replace `session.messages` if the run is still current and the snapshot contains the expected turn/user message
  - otherwise log stale snapshot and skip replacement

Tests:

- `test/phase-22/session-5/codex-prompt-streaming.test.ts`
  - prompt A starts, abort A, prompt B starts, A late `turn/completed` does not complete B
  - wrong turn completion does not resolve current prompt
  - `turn/interrupted` settles the interrupted run
- `test/phase-22/session-6/codex-abort-getmessages.test.ts`
  - abort preserves live text/tool draft in `getMessages()`
  - running tool becomes terminal aborted/cancelled
  - stale A `thread/read` cannot overwrite B synthetic user message
- `test/phase-22/session-4/codex-lifecycle.test.ts`
  - reconnect after interrupted/finalizing run reports idle only after finalization state is coherent

Acceptance criteria:

- No overlapping prompt loop can write stale messages into the current session.
- `abort()` is idempotent and safe if called multiple times.
- Stop + immediate send is safe without renderer sleep.
- Partial output after abort remains visible in durable timeline.

### P1: Renderer Has More Than One Raw Stream Ingress

Affected files:

- `src/renderer/src/hooks/useAgentEventBridge.ts`
- `src/renderer/src/hooks/usePRDetection.ts`
- `src/renderer/src/stores/useSessionRuntimeStore.ts`

Symptoms:

- `useAgentEventBridge` claims to be the sole `window.agentOps.onStream` subscriber.
- `usePRDetection` also subscribes directly and bypasses `acceptSessionEvent()`.
- PR detection can observe stale duplicate events that runtime mirror already rejected.

Target behavior:

- Only `useAgentEventBridge` subscribes to `window.agentOps.onStream`.
- PR detection receives guarded per-session events from `useSessionRuntimeStore.subscribeToSessionEvents(...)`.
- Backstop transcript polling may remain, but stream path must be guarded.

Implementation sketch:

- Move stream scanning logic in `usePRDetection` behind runtime store callbacks:
  - subscribe only when `prCreation.creating` and `prCreation.sessionId` exist
  - use the same event payload scanner for `message.part.updated` and `message.updated`
  - unsubscribe when PR creation ends
- Add a test or source assertion that `rg "agentOps.onStream" src/renderer/src` only finds `useAgentEventBridge.ts`.
- Keep polling fallback scoped to active PR creation, but avoid JSON-stringifying huge transcripts on every tick if the event path already found a URL.

Tests:

- `test/phase-23/pr-detection-stream-ingress.test.tsx`
  - stale run event rejected by bridge does not attach PR
  - accepted event attaches PR
  - polling fallback still attaches PR when stream shape misses URL
- `test/phase-23/agent-event-bridge-run-epoch.test.ts`
  - extend to cover side-effect subscriber ordering if needed

Acceptance criteria:

- `window.agentOps.onStream` has one renderer subscriber.
- All stream-driven side effects see only accepted runEpoch/sessionSequence events.

### P1: SessionShell And SessionView Still Reconstruct Streams Differently

Affected files:

- `src/renderer/src/components/session-hq/SessionShell.tsx`
- `src/renderer/src/components/sessions/SessionView.tsx`
- `src/renderer/src/stores/useSessionRuntimeStore.ts`
- `src/shared/lib/timeline-mappers.ts`
- `src/renderer/src/lib/codex-timeline.ts`

Symptoms:

- `SessionShell` renders `durable timeline + runtime mirror`.
- `SessionView` still maintains local `streamingPartsRef`, `streamingContentRef`, own finalization and provider-specific event parsing.
- This creates drift: bug fixes in one path do not necessarily affect the other.

Target behavior:

- `SessionShell + useSessionRuntimeStore` is the active, authoritative path.
- `SessionView` remains a fallback only and stops receiving new provider-specific logic.
- Shared parsing/classification stays in `src/shared/lib/*` and main-side timeline services.

Implementation stages:

1. Add comments and tests that freeze `SessionView` as fallback.
2. Move remaining reusable mapping helpers out of `SessionView` into shared utilities if still needed by `SessionShell`.
3. Avoid changing `SessionView` for new Codex/Claude behavior unless it is a compatibility patch.
4. Eventually remove the `sessionUiV2Enabled` fallback after a separate release gate.

Tests:

- `test/phase-23/session-shell-runtime-mirror.test.tsx`
  - stale run does not reappear after remount
  - new run clears old overlay while preserving durable messages
  - compaction/status rows do not duplicate
- `test/phase-23/session-timeline-service.test.ts`
  - durable timeline remains provider-independent
- Existing `test/session-8/session-view.test.tsx`
  - keep as fallback regression only

Acceptance criteria:

- New Codex/Claude runtime features are tested against `SessionShell`.
- Old `SessionView` does not become a second active runtime implementation.

### P1: Stop And Steer Need Event-Driven Boundaries

Affected files:

- `src/renderer/src/lib/session-send-actions.ts`
- `src/renderer/src/components/session-hq/SessionShell.tsx`
- `src/main/services/codex-implementer.ts`
- `src/main/services/claude-code-implementer.ts`

Symptoms:

- `stop_and_send` does `abort()` then sleeps 100ms before `prompt()`.
- `SessionShell` calls `resetLiveOverlay(true)` for `send`, `stop_and_send`, and `steer`.
- For Codex, `steer` semantically injects into the active turn; clearing overlay makes active output disappear.

Target behavior:

- Stop without content interrupts and finalizes the active run.
- Stop with content waits for an explicit abort boundary, then starts a new turn.
- Steer never clears current assistant overlay; it may render a small user intervention marker, but the output continues.

Implementation sketch:

- Extend `SendContext` with optional boundary waiters:

```ts
type SendContext = {
  waitForAbortBoundary?: (sessionId: string, previousRunEpoch: number) => Promise<void>
  waitForRunAdvance?: (sessionId: string, previousRunEpoch: number) => Promise<void>
}
```

- Replace fixed sleep with:
  - call abort
  - wait for main process abort finalization event or runtime store idle with advanced/settled run boundary
  - then prompt
- In `SessionShell`, only call `resetLiveOverlay(true)` for new-turn actions, not `steer`.
- Add optimistic steer marker separately from queued/sent user message.

Tests:

- `test/phase-23/session-send-actions.test.ts`
  - `stop_and_send` calls wait boundary instead of sleeping
  - boundary failure restores composer content
- `test/phase-23/session-shell-composer-actions.test.tsx`
  - steer does not clear overlay
  - pure stop flips lifecycle idle only after abort success/finalization
  - stop-and-send waits before prompt
- `test/phase-22/session-6/codex-abort-getmessages.test.ts`
  - abort emits enough state for renderer boundary wait

Acceptance criteria:

- No fixed timer is needed to sequence abort -> next prompt.
- Steer feels like a continuous TUI interaction, not a reset.

### P2: Hot Path Needs Throttling And Log Hygiene

Affected files:

- `src/renderer/src/hooks/useAgentEventBridge.ts`
- `src/renderer/src/stores/useSessionRuntimeStore.ts`
- `src/renderer/src/components/session-hq/SessionShell.tsx`
- `src/renderer/src/components/sessions/SessionView.tsx`
- `src/main/services/codex-app-server-manager.ts`
- `src/main/services/codex-implementer.ts`

Symptoms:

- Every accepted event writes streaming buffer, dispatches callbacks, and touches activity.
- `touchActivity()` clones the sessions map per event.
- Session callbacks can run heavier side effects synchronously.
- Runtime buffer stores both structured `parts` and continuously concatenated `streamingContent`.
- Codex manager still has debug-style notification logging in the hot path.
- `SessionShell` event subscription depends on many changing values, creating resubscribe windows.

Target behavior:

- Token/tool delta path does minimal work.
- Heavy work only runs on lifecycle transitions, idle, or debounced frames.
- Logging is either debug-gated or sampled.

Implementation plan:

- Throttle `touchActivity()` per session, e.g. once per animation frame or every 250ms.
- Keep `writeEventToStreamingBuffer()` as the only hot-path mutation.
- Move usage refresh, timeline refresh, mission extraction, queue drain and notification side effects to idle/transition microtasks.
- Convert `SessionShell` event effect dependencies to stable refs where safe, so stream callbacks do not unsubscribe when composer options change.
- Remove or downgrade `DEBUG handleServerNotification` and provider title debug logs.
- Gradually stop appending full `streamingContent` on every delta; prefer structured `parts` and derive text where needed.

Tests:

- `test/phase-23/use-session-runtime-store.test.ts`
  - many delta events coalesce into bounded notifications
  - `touchActivity` throttle preserves latest timestamp
- `test/phase-23/session-shell-runtime-mirror.test.tsx`
  - changing goal/composer options does not drop idle/drain event
- logger smoke tests only if existing pattern supports it

Acceptance criteria:

- High-frequency token/tool output does not trigger synchronous heavy side effects per delta.
- Codex app-server logs do not spam notification payload snapshots in normal runs.

## PR Split

### PR A: Codex Lifecycle Correctness

Must land first.

Files:

- `src/main/services/codex-implementer.ts`
- `src/main/services/codex-app-server-manager.ts`
- `test/phase-22/session-5/codex-prompt-streaming.test.ts`
- `test/phase-22/session-6/codex-abort-getmessages.test.ts`

Exit criteria:

- stop -> immediate send is safe
- stale completion/readThread cannot overwrite new run
- abort preserves partial assistant output

### PR B: Stop/Steer Event Boundary

Files:

- `src/renderer/src/lib/session-send-actions.ts`
- `src/renderer/src/components/session-hq/SessionShell.tsx`
- main runtime event support if PR A does not already expose enough state
- `test/phase-23/session-send-actions.test.ts`
- `test/phase-23/session-shell-composer-actions.test.tsx`

Exit criteria:

- no fixed `setTimeout(100)` sequencing
- steer keeps live overlay
- pure stop / stop-and-send behavior is test-covered in mounted SessionShell

### PR C: Single Stream Ingress

Files:

- `src/renderer/src/hooks/usePRDetection.ts`
- `src/renderer/src/hooks/useAgentEventBridge.ts`
- `src/renderer/src/stores/useSessionRuntimeStore.ts`
- `test/phase-23/pr-detection-stream-ingress.test.tsx`
- `test/phase-23/agent-event-bridge-run-epoch.test.ts`

Exit criteria:

- only one raw `window.agentOps.onStream` subscriber in renderer
- PR detection observes only guarded events

### PR D: SessionShell Runtime Mirror Tests

Files:

- `test/phase-23/session-shell-runtime-mirror.test.tsx`
- targeted fixes in `SessionShell` / runtime store as needed

Exit criteria:

- mounted SessionShell validates runEpoch isolation
- remount does not resurrect stale overlay
- source-code smoke tests are no longer the only guard

### PR E: Hot Path Cleanup

Files:

- `src/renderer/src/hooks/useAgentEventBridge.ts`
- `src/renderer/src/stores/useSessionRuntimeStore.ts`
- `src/renderer/src/components/session-hq/SessionShell.tsx`
- `src/main/services/codex-app-server-manager.ts`
- `src/main/services/codex-implementer.ts`

Exit criteria:

- activity touches and heavy side effects are throttled/deferred
- debug logs are gated
- no behavior regressions in runtime mirror tests

## Test Gate Before Merging Each PR

Minimum targeted tests:

```bash
pnpm vitest run test/phase-22/session-5/codex-prompt-streaming.test.ts
pnpm vitest run test/phase-22/session-6/codex-abort-getmessages.test.ts
pnpm vitest run test/phase-23/agent-event-bridge-run-epoch.test.ts
pnpm vitest run test/phase-23/session-send-actions.test.ts
```

When touching SessionShell behavior:

```bash
pnpm vitest run test/phase-23/session-shell-composer-actions.test.tsx
pnpm vitest run test/phase-23/session-shell-runtime-mirror.test.tsx
```

When touching stream ingress:

```bash
pnpm vitest run test/phase-23/pr-detection-stream-ingress.test.tsx
```

Before shipping a stacked batch:

```bash
pnpm lint
pnpm test
```

## Done Criteria

- Codex runtime has run/turn-scoped state transitions.
- Abort finalizes partial output instead of deleting it.
- Stop-and-send has no fixed sleep.
- Steer is continuous and does not clear active output.
- Renderer has one raw stream ingress.
- SessionShell behavior is covered by mounted tests.
- Old SessionView is treated as fallback, not an active expansion surface.
- Hot-path logs and updates are bounded enough for high-frequency Codex/Claude output.
