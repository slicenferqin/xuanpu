# Xuanpu Agent Task Run Clean-Room Test Plan

Date: 2026-06-09

Scope: validate xuanpu-agent task-run autonomy, pause/resume, continuation binding, and terminal
completion behavior from a clean session. Do not use older sessions that already contain paused
task runs, manual pending messages, or pre-fix rows.

## Why A New Session

The previous live session mixed several states:

- a pre-fix `long` task run paused with `error_message = no progress`
- a manual resume pending message
- a later plain prompt that created a separate `short` task run

That history is valid forensic evidence, but it is not a reliable acceptance fixture. It makes UI
state hard to read because the task-run panel prefers active `running` / `paused` runs even if a
newer short run completed.

## Test Layers

### 1. Automated Regression

Run these before any manual check:

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-implementer-prompt-path.test.ts \
  test/phase-24/xuanpu-agent-task-run-policy.test.ts \
  test/phase-24/xuanpu-agent-task-run-panel.test.tsx

pnpm lint
pnpm build
```

`test/phase-24/xuanpu-agent-task-run-repository.test.ts` exercises the native
`better-sqlite3` binding under Vitest/Node. If local `node_modules` was rebuilt for Electron, this
test may require a Node-target rebuild first:

```bash
pnpm rebuild better-sqlite3
pnpm vitest run test/phase-24/xuanpu-agent-task-run-repository.test.ts
pnpm run rebuild:electron:mac
```

Always run `pnpm run rebuild:electron:mac` before launching the Electron app after any native
Node-target rebuild. Otherwise app startup can fail with a `NODE_MODULE_VERSION` mismatch.

Required automated assertions:

- `long` prompt creates one task run with `autonomy = long`.
- checkpoint or incomplete response queues continuation with the same `taskRunId`.
- final completion text does not become `paused / no progress`.
- a continuation prompt such as `继续跑完剩下的` reuses a paused active task run.
- unrelated prompts do not accidentally bind to a paused task run.
- eligible long task runs renew expired leases across multiple yield boundaries.
- long task runs that exceed policy gates still pause / ask instead of renewing blindly.
- task-run panel pause/resume buttons call the dedicated IPC operations.

### 2. Clean Manual Session

Create a new xuanpu-agent session from the schnauzer worktree after restarting the app from the
latest build. Record the new runtime session id and Hive session id before testing:

```bash
rg -n "Connected xuanpu-agent session" ~/.xuanpu/logs/xuanpu-2026-06-09.log
```

If the date changed, use the current log file.

Use a prompt that is deterministic enough to drive multiple stages but small enough to finish:

```text
请按 long task run 执行一次干净测试，不要一次性给最终结论。
每个阶段只做一个小检查，然后继续下一个阶段，至少完成 4 个阶段。

阶段范围：
1. src/main/services/xuanpu-agent/task-run-policy.ts
2. src/main/db/task-run-repository.ts
3. src/renderer/src/components/session-hq/XuanpuAgentTaskRunPanel.tsx
4. test/phase-24/xuanpu-agent-task-run-policy.test.ts

要求：
- 不修改文件。
- 每阶段说明检查对象和结果。
- 完成 4 个阶段后明确写：任务已完成，不继续新增工作。
```

Expected live behavior:

- bottom task-run panel shows one `running /long` run while active
- it does not create a second `short` task run
- completion should settle as `completed`, not `paused / no progress`
- if it pauses, pressing the panel play button should resume the same task run
- directly typing `继续跑完剩下的` should also resume the same task run

### 3. DB Acceptance Queries

Replace `<SESSION_ID>` with the Hive session id.

```bash
sqlite3 -header -column ~/.xuanpu/xuanpu.db "
SELECT id, status, autonomy, epoch_count, completed_at, error_message,
       substr(objective, 1, 80) AS objective
FROM agent_task_runs
WHERE session_id = '<SESSION_ID>'
ORDER BY started_at ASC;

SELECT id, status, task_run_id, epoch_id, started_at, completed_at, error_message
FROM agent_turns
WHERE session_id = '<SESSION_ID>'
ORDER BY started_at ASC;

SELECT id, task_run_id, ordinal, status, provider_call_count, close_reason, started_at, closed_at
FROM agent_epochs
WHERE session_id = '<SESSION_ID>'
ORDER BY started_at ASC;

SELECT id, status, prompt_options_json, substr(content, 1, 120) AS content
FROM session_pending_messages
WHERE session_id = '<SESSION_ID>'
ORDER BY enqueued_at ASC;
"
```

Pass criteria:

- exactly one `agent_task_runs` row for the clean scenario
- that row has `autonomy = long`
- latest task run status is `completed`, unless the run is genuinely still running
- every `agent_turns.task_run_id` equals that single long task run id
- no `short` row with objective `继续跑完剩下的`
- pending continuation rows are either absent or `sent`; none remain `pending` after idle

### 4. Lease Renewal Stress Case

The quick clean-room prompt proves task-run completion, but not long-duration lease behavior. Use a
separate run for lease renewal, because the default lease window is 20 minutes and real-provider
testing can spend money.

Preferred automated coverage:

- `evaluateLeaseAtBoundary` renews at successive lease boundaries.
- `XuanpuAgentImplementer` renews an expired running long task run on `onBeforeYield`, updates the
  in-memory lease deadline, and can renew again at the next boundary.
- the same path must not call `updateTaskRunStatus(..., 'paused')`.

Manual lease stress, only when needed:

```text
请按 long task run 执行一次长时续租测试。
保持任务打开，不要快速总结完成；每轮只做一个只读检查。
如果你认为当前 lease 可以续期，请继续下一轮；不要修改文件。
```

Because wall-clock lease testing is slow, do not wait 20 minutes as the default acceptance path.
Prefer the automated fake-clock test, then use manual testing only to confirm UI wiring around a
real paused/resumed task run.

### 5. Failure Classification

Use these buckets before changing code:

- `extra short run`: continuation binding failed; inspect prompt options and
  `shouldResumeActiveTaskRunFromPromptText`.
- `paused/no progress after completion text`: completion detection failed; inspect final assistant
  text and `isCompleteLongTaskResponse`.
- `lease boundary paused unexpectedly`: inspect `evaluateLeaseAtBoundary` inputs for
  `noProgressCalls`, `costSinceStart`, and risky write flags before assuming renewal is broken.
- `lease renews only once`: inspect the implementer-local `leaseExpiresAt` update after
  `renewLease(...)`.
- `pending row stuck`: renderer queue hydration or `onResumeQueued` failed; inspect
  `session_pending_messages.status` and `usePendingInitialMessageSender`.
- `panel stale but DB correct`: renderer refresh issue; inspect `XuanpuAgentTaskRunPanel.load` and
  lifecycle / pending-count dependencies.
- `resume button works but typed continue does not`: implementer implicit continuation binding failed.

## Do Not Use As Acceptance

Do not use `xuanpu-agent-ed34b684-bddf-4a89-a1f4-0e0581c3d5be` as the primary pass/fail fixture.
It is useful only for regression forensics because it already contains pre-fix rows.
