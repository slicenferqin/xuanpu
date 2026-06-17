# Xuanpu Agent Task Run Clean-Room Test Plan

Date: 2026-06-09

Updated: 2026-06-17

Scope: validate the xuanpu-agent unified task-run lifecycle, pause/resume, continuation binding,
lease renewal, and terminal completion behavior from a clean session. The runtime no longer exposes
or honors `short` / `long` / `overnight` task-run modes; user text such as "长任务执行" is ordinary
prompt content, not a control directive.

## Why A New Session

The previous live session mixed several historical states:

- a pre-fix task run paused with `error_message = no progress`
- a manual resume pending message
- a later prompt that created a separate task run because old mode classification and continuation
  binding interacted poorly

That history remains useful forensic evidence, but it is not a reliable acceptance fixture. It makes
UI state hard to read because the task-run panel prefers active `running` / `paused` runs even if a
newer run has completed.

## Test Layers

### 1. Automated Regression

Run these before any manual check:

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-implementer-prompt-path.test.ts \
  test/phase-24/xuanpu-agent-task-run-policy.test.ts \
  test/phase-24/xuanpu-agent-task-run-scheduler.test.ts \
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

- task-run scheduling does not infer runtime policy from prompt text.
- `createTaskRun()` payloads do not contain `autonomy`.
- `agent_task_runs` schema does not contain an `autonomy` column after migration.
- checkpoint or incomplete response queues continuation with the same `taskRunId`.
- pending continuation `prompt_options_json` contains `taskRunId` and mode only; it does not contain
  `taskRunAutonomy`.
- final completion text does not become `paused / no progress`.
- a continuation prompt such as `继续跑完剩下的` reuses a paused active task run.
- unrelated prompts do not accidentally bind to a paused task run.
- eligible task runs renew expired leases across multiple yield boundaries.
- task runs that exceed policy gates still pause / ask instead of renewing blindly.
- task-run panel pause/resume buttons call the dedicated IPC operations and do not show `/long` or
  any other mode suffix.

### 2. Realistic Manual Session

Create a new xuanpu-agent session from the schnauzer worktree after restarting the app from the
latest build. Record the new runtime session id and Hive session id before testing:

```bash
rg -n "Connected xuanpu-agent session" ~/.xuanpu/logs/xuanpu-2026-06-17.log
```

If the date changed, use the current log file.

Use a prompt that matches normal daily work. The user should not have to say any task-run mode:

```text
帮我基于当前仓库代码，整理一套 xuanpu-agent task-run 机制的内部工程文档包。文档要求：
- 先读取相关源码或测试文件，再写文档。
- 文档里要引用实际文件路径，例如 src/main/services/xuanpu-agent/task-run-policy.ts。
- 每份文档要包含：背景、关键流程、相关代码、常见故障、验证方式。
- 写完每份后更新 manifest.json，记录文件路径、主题、估算字符数、状态、引用过的源码文件。
- 如果某份还没写完，manifest.json 里要标记 partial，不要假装完成。
- 完成全部后，生成 README.md 作为入口索引。
```

Expected live behavior:

- bottom task-run panel shows one active `running` task run while work is active.
- panel status does not include `/long`, `/short`, or `/overnight`.
- the prompt does not need an intent directive, and adding text such as `长任务执行` must not change a
  hidden runtime mode.
- if the first response budget is reached before files are complete, the runtime should queue or
  preserve continuation under the same task run instead of closing as completed.
- completion should settle as `completed`, not `paused / no progress`, only after the README and
  manifest indicate the package is complete.
- if it pauses, pressing the panel play button should resume the same task run.
- directly typing `继续跑完剩下的` should also resume the same task run.
- expected files should appear under the target path chosen by the assistant, and `manifest.json`
  should not claim `completed` for files that do not exist or are only partial.

Use the old four-stage prompt only as a small sanity fixture. It is not sufficient as the primary
manual acceptance case because users do not naturally write prompts around artificial numbered
lease stages.

### 3. DB Acceptance Queries

Replace `<SESSION_ID>` with the Hive session id.

```bash
sqlite3 -header -column ~/.xuanpu/xuanpu.db "
PRAGMA table_info(agent_task_runs);

SELECT id, status, epoch_count, completed_at, error_message,
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

- `PRAGMA table_info(agent_task_runs)` has no `autonomy` column.
- exactly one `agent_task_runs` row for the clean scenario.
- latest task run status is `completed`, unless the run is genuinely still running.
- every `agent_turns.task_run_id` equals that single task run id.
- no additional task run is created for objective `继续跑完剩下的`.
- pending continuation rows are either absent or `sent`; none remain `pending` after idle.
- no pending row contains `taskRunAutonomy` inside `prompt_options_json`.

### 4. Lease Renewal Stress Case

The quick clean-room prompt proves task-run completion, but not long-duration lease behavior. Use a
separate run for lease renewal, because the default lease window is 20 minutes and real-provider
testing can spend money.

Preferred automated coverage:

- `evaluateLeaseAtBoundary` renews at successive lease boundaries.
- `XuanpuAgentImplementer` renews an expired running task run on `onBeforeYield`, updates the
  in-memory lease deadline, and can renew again at the next boundary.
- the same path must not call `updateTaskRunStatus(..., 'paused')`.

Manual lease stress, only when needed:

```text
执行一次长时续租测试。
保持任务打开，不要快速总结完成；每轮只做一个只读检查。
如果你认为当前 lease 可以续期，请继续下一轮；不要修改文件。
```

Because wall-clock lease testing is slow, do not wait 20 minutes as the default acceptance path.
Prefer the automated fake-clock test, then use manual testing only to confirm UI wiring around a
real paused/resumed task run.

### 5. Failure Classification

Use these buckets before changing code:

- `extra task run`: continuation binding failed; inspect `taskRunId` propagation and
  `shouldResumeActiveTaskRunFromPromptText`.
- `mode suffix visible`: UI still exposes removed task-run mode state; inspect
  `XuanpuAgentTaskRunPanel`.
- `taskRunAutonomy in pending row`: renderer/main pending-message path is still carrying removed
  prompt options.
- `paused/no progress after completion text`: completion detection failed; inspect final assistant
  text and `isCompleteTaskResponse`.
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
