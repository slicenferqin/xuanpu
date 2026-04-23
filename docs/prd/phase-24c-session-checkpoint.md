# Xuanpu — Phase 24C Product Requirements Document

## Session Checkpoint（让"续上次任务"从理想变成事实）

---

## Overview

Phase 22A 让 Agent 看到**最近 5 分钟的现场**，22B 让它看到**过去几小时的 worktree 近况**。但玄圃还缺一块能决定 VISION §4.1.4 "瞬间 2 / 瞬间 3" 成败的能力：**session 切换时的工作态延续**。

今天的情况：用户在 worktree A 用了 40 分钟把 OAuth 重构到一半，关掉 session 去吃饭；回来新建 session，Agent 完全冷启动，只能靠 5 分钟窗口（里面全是吃饭前关电脑的零散事件）拼凑上下文。用户必须再打一遍"我们刚才在改 auth/refresh.ts 的退避逻辑…"。

**Phase 24C 的目标**：在 session 结束 / 上下文压缩 / 异常终止的那一刻，自动生成一份**结构化的工作态快照**；下一个 session 启动时，读取并校验这份快照，把"上次做到哪了 / 下一步想做什么 / 热文件是哪些 / 分支和 HEAD 有没有漂移"注入到 Field Context 里。

---

## 为什么先做 24C（而不是 Claim Store / Outcome / Activation Engine）

经过 oracle 严格评审（见 `phase-24-claim-store.md` 的作废记录），我们把原本打包的 Phase 24 拆开，**24C 第一个发**，理由：

1. **用户感知价值最高**：这是 VISION 里"瞬间 2 继续上次任务"的直接兑现，Demo 友好
2. **LLM 风险最低**：整个 24C **纯 rule-based + 确定性校验**，不调任何模型
3. **信念污染风险为零**：不产生任何结构化"信念"（Claim）。如果 checkpoint 过时，标为 `stale` 并在 UI 里警告用户；不会让 Agent 自信地说错话
4. **真独立**：不依赖 Claim Store、Activation Engine、Outcome Loop，单独 merge 即可上线价值
5. **帮后续阶段收集真实数据**：checkpoint 日志会告诉我们"用户真实的续窗场景是什么"，为未来的 24A/B/D 设计提供实证

**与 PMR 的关系**：参考了 `project-memory-runtime` 的 `SessionCheckpoint` contract 字段命名（`hot_files / repo_head / packet_hash / stale_reason`），但**去掉**了 `hot_claim_ids`（我们还没有 Claim Store）、`evidence_refs`（我们还没有 Evidence 概念）、`project_id`（玄圃是 worktree 维度）。不照搬，只借形状。

---

## Non-Goals（明确不做）

- ❌ **不做 Claim Store / Outcome Loop / Activation Engine**（作废的 Phase 24 范围，等真实使用数据）
- ❌ **不调 LLM 生成 summary**（rule-based 就够了；未来如果确实差，再考虑 Haiku 升级版）
- ❌ **不做用户编辑 Checkpoint UI**（readonly debug 视图足够）
- ❌ **不做跨 worktree 的 checkpoint 聚合**（严格 per-worktree）
- ❌ **不做 checkpoint 版本历史**（每个 worktree 只保留最新一条 `active` + 若干 `stale`）
- ❌ **不替换 Phase 22A 的 5 分钟 raw dump**（Resumed 子块是**补充**注入，不是替换）
- ❌ **不自动跑 git log / git diff 之外的 shell 命令**（校验只用 `git rev-parse HEAD` 和文件 sha1）

---

## Technical Additions

| Component | Technology |
|---|---|
| Schema migration v19 | `field_session_checkpoints` 表（单表，独立 migration） |
| Repository | `src/main/field/checkpoint-repository.ts` —— CRUD + packet_hash 幂等 |
| Generator | `src/main/field/checkpoint-generator.ts` —— 从 field_events 构建 snapshot（rule-based） |
| Verifier | `src/main/field/checkpoint-verifier.ts` —— branch / HEAD / file digest 校验 |
| Hook points | 扩展 `src/main/ipc/agent-handlers.ts`：`agent:abort` / `cleanupAgentHandlers` 后触发 generate；`agent:connect` 首 prompt 前触发 verify + inject |
| Context integration | `FieldContextSnapshot.checkpoint?: ResumedCheckpointBlock`（新字段）+ `formatFieldContext` 在现有结构前插入 `## Resumed from previous session` |
| Debug UI | `FieldContextDebug` 新 tab "Session Checkpoint"，展示最新快照 + warnings |
| Dump script | `pnpm field:dump --checkpoint <worktreeId>` |

---

## Schema v19

```sql
CREATE TABLE IF NOT EXISTS field_session_checkpoints (
  id TEXT PRIMARY KEY,                         -- UUID
  created_at TEXT NOT NULL,                    -- ISO8601

  worktree_id TEXT NOT NULL,                   -- scope 根
  session_id TEXT NOT NULL,                    -- Xuanpu sessions.id（生成 checkpoint 时所属 session）

  -- Git 环境快照（best-effort；获取失败留 NULL）
  -- branch 若为字面 "HEAD"（detached HEAD 状态）一律归一化为 NULL
  branch TEXT,
  repo_head TEXT,                              -- 完整 SHA

  -- 触发来源（V1 只有 2 个；未来若 SDK 暴露 lifecycle 再扩）
  source TEXT NOT NULL CHECK (source IN (
    'abort',             -- 用户 abort
    'shutdown'           -- app before-quit（兜底）
  )),

  -- 内容（rule-based 生成，见下方"Generator 逻辑"）
  summary TEXT NOT NULL,                       -- 1–3 行，人类可读
  current_goal TEXT,                           -- 最近的用户 session.message 第 1 行 (heuristic)
  next_action TEXT,                            -- 关键词启发式或 NULL (heuristic)
  blocking_reason TEXT,                        -- 仅 source='abort' 时填充

  -- 热文件集（按编辑/聚焦频次降序）
  hot_files_json TEXT NOT NULL,                -- JSON array of relative paths
  hot_file_digests_json TEXT,                  -- {"path": "sha1_hex"} —— 同步计算，失败留 NULL

  -- 幂等（见"Generator 步骤 7"）
  packet_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_field_session_checkpoints_worktree_created
  ON field_session_checkpoints(worktree_id, created_at DESC);

-- 同一 worktree 同 packet_hash 只记一次（幂等；重复触发时跳过）
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_session_checkpoints_worktree_hash
  ON field_session_checkpoints(worktree_id, packet_hash);
```

> **设计说明**：**不设 `status` / `stale_reason` 列**。"是否过时"由 verifier 作为纯函数在读时判断（基于 branch / HEAD / digest / 时效），不落库——避免并发 `agent:connect` 时两个 verifier 互踩写入。checkpoint 被"自然淘汰"的方式：下次 generate 产生新行，新 session 启动时 verifier 只读 `created_at DESC LIMIT 1`。

**迁移策略**：migration v19 单表，`CURRENT_SCHEMA_VERSION = 19`。不回填历史数据（冷启动可接受）。

---

## Generator 逻辑（rule-based, 无 LLM）

输入：`worktreeId` + `sessionId` + `source`。输出：`field_session_checkpoints` 一行。

### 步骤 1：查询事件窗口

从 `field_events` 拉取"该 session 期间 + 该 worktree"的所有事件（按 session_id 过滤；fallback：最近 2 小时）。

### 步骤 2：算 hot_files（top 5）

对窗口内事件按文件路径统计得分：

- `file.edit`: +3 分
- `file.focus`: +1 分
- `file.selection`: +2 分
- `terminal.command` 的 cwd 命中文件：+1 分

取 top 5，过滤不存在的文件。

### 步骤 3：算 hot_file_digests

对每个 hot_file **同步**读取并算 sha1（hot_files ≤ 5，总大小 bounded；同步安全）。读取失败的留 `null`（不是空字符串，让 verifier 能区分"文件不存在"和"digest 缺失"）。

### 步骤 4：抽 current_goal / next_action

从窗口内的 `session.message`（role='user'）里取**最后 3 条**，:
- `current_goal` = 倒数第 1 条的第 1 行，截断到 120 字符
- `next_action` = 倒数第 1 条如果包含"待办/next/然后/接下来/TODO"关键词的行；否则 NULL

这是 V1 的粗糙启发式。命中率不高也没关系——**用户会在 UI 里看到**，不准就忽略即可。

### 步骤 5：写 summary

模板化 1-3 行：

```
Worked on {branch} for {duration}. {edit_count} files edited, {command_count} commands run.
Last user message: "{current_goal_truncated}"
{blocking_reason ? "Aborted with: " + blocking_reason : ""}
```

### 步骤 6：获取 git 环境

- `git rev-parse HEAD` → `repo_head`（失败留 NULL）
- `git rev-parse --abbrev-ref HEAD` → `branch`
  - 若返回字面 `"HEAD"`（detached HEAD 状态） → 归一化为 NULL
  - 若命令失败（非 git 目录） → NULL
- 均 5 秒超时

### 步骤 7：算 packet_hash

`sha1(canonical_json({session_id, created_at_minute, summary, current_goal, next_action, hot_files, branch, repo_head}))`

- `created_at_minute` = `created_at` 截断到分钟（`YYYY-MM-DDTHH:MM`）
- 加入 `session_id` 后，shutdown 场景下不同 session 即使内容相似也各自落一行
- 加入 `created_at_minute` 后，同 session 同一分钟内重复触发才会被 IGNORE（真正的幂等语义）

### 步骤 8：写入

带 `INSERT OR IGNORE`（因为 `(worktree_id, packet_hash)` 是 UNIQUE）。幂等：短时间重复触发不产生重复行。

---

## Verifier 逻辑（纯函数 / 只读）

输入：`worktreeId` + 当前 `cwd`。输出：`ResumedCheckpointBlock | null` + `warnings[]`。

**不写 DB**。过时判定只在返回值里体现；旧 checkpoint 靠下次 generate 自然被覆盖为最新行。

### 步骤 1：取最新 checkpoint

```sql
SELECT * FROM field_session_checkpoints
WHERE worktree_id = ?
ORDER BY created_at DESC LIMIT 1;
```

### 步骤 2：时效性

模块顶部常量：

```ts
const CHECKPOINT_EXPIRY_MS = 24 * 60 * 60 * 1000  // 24h 硬编码, 不做 Settings
const CHECKPOINT_STALE_WARN_MS = 2 * 60 * 60 * 1000  // 2h 开始加 warning
```

- `age > CHECKPOINT_EXPIRY_MS` → 返回 null（不注入；debug UI 仍能看到原始行）
- `CHECKPOINT_STALE_WARN_MS < age ≤ CHECKPOINT_EXPIRY_MS` → 注入，warnings += "checkpoint {N}h old"

### 步骤 3：branch 校验

- 当前 `branch`（按步骤 6 的归一化规则取得）== `checkpoint.branch` → 继续
- 两边都是 NULL（都是非 git 或 detached HEAD） → 跳过 branch 校验，继续看 digest
- 不一致 → 返回 null（不注入），debug UI 可见原因 `branch_changed`

### 步骤 4：HEAD drift

- `checkpoint.repo_head` 为 NULL → 跳过
- 当前 HEAD == `checkpoint.repo_head` → 无事
- 不相等 → 用 `git rev-list --count checkpoint.repo_head..HEAD` 数 commit；失败则 warnings += "checkpoint HEAD unreachable"

### 步骤 5：file digest drift

对 `hot_file_digests` 每条：
- 文件不存在 → drift count +1
- 当前 sha1 ≠ 记录 sha1 → drift count +1
- 相同 → 无事

阈值：`drift_ratio = drift_count / len(hot_file_digests)`
- `drift_ratio ≥ 0.5` → 返回 null（不注入）
- `drift_ratio > 0` → warnings += "{drift_count}/{total} hot files changed outside session"

### 步骤 6：返回

`ResumedCheckpointBlock` + warnings[]。读路径全程无写操作——天然抗并发 `agent:connect`。

---

## Context Integration

### 新类型

```ts
// src/shared/types/field-context.ts
export interface ResumedCheckpointBlock {
  createdAt: number
  ageMinutes: number
  source: 'abort' | 'shutdown'
  summary: string
  /** Heuristic guess; UI/formatter MUST mark with "(heuristic)" tag */
  currentGoal: string | null
  /** Heuristic guess; UI/formatter MUST mark with "(heuristic)" tag */
  nextAction: string | null
  blockingReason: string | null
  hotFiles: string[]
  warnings: string[]
}

export interface FieldContextSnapshot {
  // ... 现有字段
  /** Phase 24C: resumed work state from the previous session on this worktree. */
  checkpoint: ResumedCheckpointBlock | null
}
```

### Formatter 渲染

在 `formatFieldContext` 现有输出的**最前面**插入（如果 checkpoint 存在）：

```markdown
## Resumed from previous session

> Last session ended 42min ago (source: abort).

**Current goal** (heuristic): Make `refreshAccessToken` retry on 401
**Next action** (heuristic): Add exponential backoff in src/auth/refresh.ts
**Hot files**: src/auth/refresh.ts, test/auth/refresh.test.ts, src/auth/index.ts

⚠ 2 commits landed since checkpoint — verify before resuming
⚠ 1/3 hot files changed outside session
```

> `(heuristic)` 标记是**强制**的，不是可选。诚实地告诉 Agent 这两条信息可能不准。

**截断优先级**：比 Working Memory 高，比 Semantic Memory 低。如果总预算告急，Resumed 子块优先保留 summary/warnings，其次 goal/next_action，最后 hot_files。

---

## Hook Points（代码集成）

### 生成 trigger（V1 只做 2 个）

**Hook 1: `agent:abort`**
```ts
// src/main/ipc/agent-handlers.ts
handler: async ([worktreePath, runtimeSessionId], c) => {
  // ... existing abort logic
  setImmediate(() =>
    generateCheckpoint({ worktreePath, runtimeSessionId, source: 'abort' })
      .catch((err) => log.warn('checkpoint generate (abort) failed', { err }))
  )
}
```

**Hook 2: `app.before-quit`（shutdown 兜底）**

在 `FieldEventSink.shutdown` 完成后、app 退出前，对**每个 active session** 生成 checkpoint（source=`shutdown`）。2 秒总超时；超时直接放弃——app 正在退出，数据安全性 > 完整性。

> **不做** session 正常结束 hook：Xuanpu 当前没有显式的 "session ended" lifecycle 事件。强行加这个 hook 需要先在 sessions 模型上做一层解耦，超出 24C 范围。等真有用户反馈 "abort + shutdown 漏了哪些场景" 再加。

### 校验 + 注入 trigger

**Hook: `agent:connect` 第一个 prompt 之前**

当前 `agent-handlers.ts` 里有 `injectedWorktrees: Set<string>` 控制 worktree 首次 context 注入。在这个逻辑紧邻之后，由 `context-builder` 自动读 `field_session_checkpoints` 并通过 `verifier.verifyCheckpoint(worktreePath)` 拿到 `ResumedCheckpointBlock`，merge 进 `FieldContextSnapshot.checkpoint` 字段。

完全 read-only，不需要在 `agent-handlers` 里加特殊 hook，让 builder 自然处理。

---

## 隐私 & 降级

- **受 `isFieldCollectionEnabled()` 门禁管**：privacy 关闭时，generator 和 verifier 都 noop
- **git 命令失败不阻塞**：`branch/repo_head` 留 NULL，只是失去漂移警告能力
- **文件读取失败不阻塞**：`hot_file_digests` 对应 entry 留 NULL
- **整个 24C 失败都不影响主流程**：顶层 try/catch，失败只 `log.warn`；Agent 仍然能用 22A 的 5 分钟窗口工作
- **隐私面板新增一项**："Session resume hints"（默认 ON，可关闭）

---

## Testing

| 测试 | 位置 |
|---|---|
| Schema migration v19 up/down | `test/phase-24c/checkpoint-schema.test.ts` |
| Repository CRUD + packet_hash 幂等 | `test/phase-24c/checkpoint-repository.test.ts` |
| Generator: hot_files 排序、digest 计算、git 命令 mock、source 分支 | `test/phase-24c/checkpoint-generator.test.ts` |
| Verifier: branch 不匹配→stale、HEAD drift→warning、digest drift 阈值 | `test/phase-24c/checkpoint-verifier.test.ts` |
| Formatter: Resumed 子块渲染 + 截断优先级 | `test/phase-24c/checkpoint-formatter.test.ts` |
| 端到端：session 结束→生成→新 session 启动→注入 | `test/phase-24c/checkpoint-e2e.test.ts` |
| 隐私开关 noop | `test/phase-24c/checkpoint-privacy.test.ts` |
| 降级：git 不可用时生成仍成功 | `test/phase-24c/checkpoint-degraded.test.ts` |

**验收标准**：
1. 在一个真实的 worktree 上 abort 一个 session 然后新建 session，Resumed 子块能正确显示上次的 goal/hot_files
2. 修改 branch 后启动新 session，checkpoint 不注入（verifier 返回 null）
3. 修改 hot_file 超过一半后启动新 session，checkpoint 不注入
4. 并发两个 `agent:connect` 对同一 worktree，两次 verifier 调用返回一致的结果（纯读路径的验证）
5. 434 个现有测试仍然通过

---

## 工期估算

- Schema + Repository：0.5d
- Generator：0.5d
- Verifier：0.5d
- Hook points + Context integration：0.5d
- Formatter + Debug UI：0.5d
- 测试 + 打磨：0.5d

**总计 ~3 工作日**（oracle 估 1–2d 偏乐观，这里留了测试和集成 buffer）。

---

## 与未来 Phase 的关系

- **Phase 24A（重设计版的 Claim Store Lite）**：如果未来引入，checkpoint 的 `hot_claim_ids` 字段可以**后加**（schema migration v20），当前 schema 无需预留
- **Phase 24B（Outcome Capture Honest 版）**：独立通道，与 checkpoint 无直接耦合
- **Phase 24D（Activation Engine shadow 模式）**：checkpoint 是 activation 的**独立子块**，不进入 ranking

---

## 开放问题

1. **Shutdown hook 在 app before-quit 里生成 checkpoint 是否风险太大？**（被 quit 流程的 preventDefault 链影响）
   - 倾向：保留 `source='shutdown'`，但 2 秒硬超时；如果这条路径不稳，未来降级成只保留前两个 source。
2. **Hot_file_digests 同步 sha1 会不会阻塞？**
   - Top 5 文件，bounded size（renderer 代码单文件通常 <100KB）。可接受。如果实测发现阻塞，改成 `setImmediate` 异步补写。
3. **current_goal 启发式取"最后一条 user message 第一行"是否太粗？**
   - 倾向：V1 就这样。这是**注入给人看的信息**，用户能判断"准不准"。如果命中率实测 <30%，V2 升级 Haiku 一句话生成。
4. **是否在主 UI（非 debug）展示 Resumed 状态？**
   - 倾向：不做。Phase 24C 只走 prompt 注入 + debug UI。主 UI 曝光等有真实使用数据再评估。
