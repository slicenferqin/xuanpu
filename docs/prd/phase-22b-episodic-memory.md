# Xuanpu — Phase 22B Product Requirements Document

## Episodic Memory（短期记忆：worktree 滚动摘要）

---

## Overview

Phase 22A 让 Agent 能看到**最近 5 分钟的现场**。Phase 22B 让 Agent 能看到**过去几小时到一天的 worktree 近况** —— 通过一段由便宜模型压缩的 markdown 摘要，覆盖"当前焦点 / 最近工作 / 遗留问题"三个问题。

这直接解锁 VISION §4.1.4 的 **瞬间 2 "继续上次任务"** 和 **瞬间 3 "切走 20 分钟回来"**。

> **设计修订说明**：本 PRD 经 oracle 评审后调整 3 处硬核问题：
>
> **必改**：（1）去掉 `Current Focus (inferred)` 和 `Open Problems (heuristic)` 段，22B.1 只做**客观事实的 recap**，不做 inference —— 避免 rule-based 伪装成 LLM 推理结果误导 Agent；（2）trigger 真正 debounce（per-worktree `dirty/scheduled/inFlight` 状态机，5-10s 合并），`file.selection` 不计入 20 事件阈值以避免 drag-select 风暴；（3）明确 shutdown 协议 + 写入前 validation + "不降级覆盖" 策略（Haiku 摘要不会被 rule-based 静默覆盖）。
>
> **补强**：（4）schema 加 `compactor_id` 列跟踪摘要来源（rule-based / claude-haiku），让 formatter 能渲染 provenance（"source: rule-based heuristic"）；（5）`log.debug` 全文输出 gated 在 dev flag 后 + 简单 secret redaction（API key / password 字样的行替换）。

### Scope split: 22B.1 vs 22B.2

Episodic Memory 的工程风险 **绝大部分来自 "调 LLM"**（超时 / 配额 / 输出质量 / 成本）。为了让 PR 有清晰的可合并单元，本期拆成两个 PR：

- **Phase 22B.1（本 PRD，~3 工作日）**：结构层 + 事件流摘要的 "stub 实现"
  - 新 schema `field_episodic_memory`
  - 定时 + 关键事件触发的 updater 框架
  - Compactor 用 **基于规则的事件流格式化**（不调 LLM）—— 足够把最近几小时活动压成可读 markdown
  - Formatter 加 `## Worktree Summary` 子块
  - 完整的工程机关：失败回退、节流、隐私、debug UI
  - **链路是活的**：Agent 从本期起就能看到比 5 分钟窗口长得多的上下文
- **Phase 22B.2（下一个 PR，~1 工作日）**：把 compactor 换成真 LLM
  - 复用 `claude-session-title.ts` 的 Claude Haiku codepath
  - 超时 / 重试 / 成本监控
  - Stub 作为 LLM fail 时的降级路径保留

**为什么这个拆分值得**：22B.1 结束时用户已经能感受到 "Agent 记得几小时前在干嘛" 的价值感。22B.2 是质量升级，不是从 0 到 1 的跃迁。

### Non-Goals（明确不做）

- ❌ Semantic Memory / `.xuanpu/memory.md` → Phase 22C
- ❌ LLM 摘要的真实实现 → Phase 22B.2（下一 PR）
- ❌ 多种压缩策略 / 可配置 compactor → 永远不做，坚持单一 convention
- ❌ Summary 的用户可编辑 UI → Phase 22B.2 或以后
- ❌ 按 session 而非 worktree 的摘要（VISION 明确是 worktree 维度）
- ❌ 跨 worktree 的聚合视图（Phase 24+）

---

## Technical Additions

| Component | Technology |
|---|---|
| Schema migration v15 | `field_episodic_memory` 表：`worktree_id PRIMARY KEY`, `summary_markdown`, `version`, `compacted_at`, `source_event_count`, `source_since`, `source_until` |
| Database layer | `DatabaseService.upsertEpisodicMemory / getEpisodicMemory / deleteEpisodicMemory` |
| Compactor interface | `src/main/field/episodic-compactor.ts` —— 定义 `EpisodicCompactor` 接口 + `RuleBasedCompactor` 实现 |
| Updater orchestrator | `src/main/field/episodic-updater.ts` —— 定时 (30 min) + 事件触发 + 节流 + 失败回退 |
| Bootstrap | `src/main/index.ts` 在 sink 之后 eager init updater |
| Formatter 子块 | `context-formatter.ts` 在 `## Current Focus` 之前插入 `## Worktree Summary` （截断优先级：中等偏上，排在 Worktree Notes 之前被砍） |
| Context builder | `context-builder.ts` 读 `field_episodic_memory` 并放进 snapshot |
| Debug IPC | `field:getEpisodicMemory(worktreeId)` —— 让 debug UI 也能显示 |
| Debug UI | `FieldContextDebug` 扩展：现场注入 preview 旁边加个 tab "Episodic Memory"（可选，本期如果 UI 改动太大可延后） |
| Dump script | 支持 `pnpm field:dump --episodic <worktreeId>` 直接看一个 worktree 的摘要 |

---

## Features

### 1. Schema v15: `field_episodic_memory`

```sql
CREATE TABLE IF NOT EXISTS field_episodic_memory (
  worktree_id TEXT PRIMARY KEY,

  -- The markdown summary. Intentionally unbounded but will be capped at
  -- generation time. Consumers should respect the formatter's char budget.
  summary_markdown TEXT NOT NULL,

  -- Which compactor produced this summary. Used by formatter to render
  -- provenance and by updater to enforce "don't downgrade" policy.
  -- Values: 'rule-based', 'claude-haiku' (Phase 22B.2).
  compactor_id TEXT NOT NULL,

  -- Semver-ish integer bumped when a compactor's contract changes.
  -- Each compactor_id has its own version space.
  version INTEGER NOT NULL,

  -- When was this summary last compacted? (ms)
  compacted_at INTEGER NOT NULL,

  -- How many field_events went into this summary?
  source_event_count INTEGER NOT NULL,

  -- Event time window covered (both ms).
  source_since INTEGER NOT NULL,
  source_until INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_field_episodic_memory_compacted
  ON field_episodic_memory(compacted_at DESC);
```

**Design decisions**:

- **One row per worktree**（VISION 明确指定）。没有历史版本 —— 需要历史查原始 `field_events`
- **无外键到 worktrees**：和 `field_events` 一致，删 worktree 后摘要还能作为历史保留（或手动清）
- **`compactor_id` + `version` 字段**：Haiku 摘要不会被 rule-based 静默覆盖（见 §3 "不降级" 策略）；compactor 升级时 updater 识别并重新压缩
- **`source_*` 字段**：让 debug UI / 未来的 analytics 知道"这个摘要来自哪段事件"

### 2. `EpisodicCompactor` 接口

```ts
// src/main/field/episodic-compactor.ts

export interface CompactionInput {
  worktreeId: string
  worktreeName: string
  branchName: string | null
  events: StoredFieldEvent[] // asc order
  since: number
  until: number
}

export interface CompactionOutput {
  markdown: string
  compactorId: string
  version: number
}

export interface EpisodicCompactor {
  readonly id: 'rule-based' | 'claude-haiku' | string
  readonly version: number
  compact(input: CompactionInput): Promise<CompactionOutput>
}
```

**本期实现：`RuleBasedCompactor` (id = 'rule-based', version = 1)**

**关键约束**（per oracle 评审）：**22B.1 的 rule-based 只做客观事实的 recap，绝不做 inference**。所有段落都是"观察到的事件"的字面重述，不猜用户意图。22B.2 的 LLM 才做真正的"理解"。

规则：

1. 输入：过去 **6 小时** 内该 worktree 的所有事件（默认；可调）
2. 产出固定模板的 markdown：

    ```md
    ## Observed Recent Work (last 6 hours)
    - 14:00-14:20 ran 3 terminal commands, focused 2 files
    - 14:20-14:30 selected code in src/auth/login.ts, ran `pnpm test auth`
    - 13:45-14:00 sent 2 prompts mentioning "login refactor"

    ## Most-Touched Files
    - src/auth/login.ts (4 focus/selection events)
    - src/auth/session.ts (2 events)

    ## Recent Failures / Signals
    - 14:24:30 `pnpm test auth` exited with code 1
    - 13:45:12 `pnpm build` exited with code 2
    ```

3. **"Observed Recent Work"**：按 10-20 分钟时间段分组，每段给出**事件统计**（不做语义推理）："ran N commands, focused N files, sent N prompts"。若该段有代表性事件（如失败的 command），可直接列
4. **"Most-Touched Files"**：按 file path 聚合 focus/selection/open 事件次数，取前 3
5. **"Recent Failures / Signals"**：只列有 `exitCode != 0` 或 `exit != null && exit != 0` 的 `terminal.output` 事件。不做"因果推断"（删除了"selection 紧跟着失败测试 = 问题相关"这类启发）
6. 字符上限：**2500 chars**（比之前的 4000 更紧，因为去掉了 inferred 段）
7. **空/稀疏**：事件数 < 5 → 抛 `INSUFFICIENT_EVENTS` error，updater 跳过本次压缩不写入

**去掉**（相比初稿）：

- ❌ `## Current Focus (inferred)` —— 和 22A Working Memory 重复，且"inferred"暗示智能
- ❌ `## Open Problems (heuristic)` —— rule-based 根本做不出靠谱的 problem 分析
- ❌ "选中代码后测试失败"这类跨事件启发

**Version = 1**。22B.2 的 Haiku compactor 是 `id = 'claude-haiku'` version = 1（独立 version space）。compactor_id 不同时不覆盖。

### 3. `EpisodicMemoryUpdater`

`src/main/field/episodic-updater.ts` —— 单例。

**Per-worktree 状态机**（per oracle 评审；防止 drag-select 风暴）：

```ts
interface WorktreeState {
  dirty: boolean              // 有新事件还没被摘要
  scheduled: NodeJS.Timeout | null  // debounce timer pending
  inFlight: Promise<void> | null    // 当前正在跑的 update
  eventsSinceCompaction: number
}
```

**触发条件**（任一满足）：

- **定时兜底**：每 30 分钟遍历所有"最近 24 小时有事件"的 worktree，`dirty === true` 或 `compacted_at` 过期（> 2 小时）的 mark dirty → schedule
- **阈值触发**：每次 `emitFieldEvent` 后：
  1. **跳过** `file.selection`（drag-select 风暴保护 —— 不计入事件数）
  2. `eventsSinceCompaction++`
  3. 如果 `eventsSinceCompaction > 20` 且 `compacted_at` 距今 > 10 分钟 → mark dirty + schedule

**Schedule 逻辑**（真 debounce，不是 Promise map）：

```ts
function schedule(worktreeId: string): void {
  const state = states.get(worktreeId) ?? initState()
  states.set(worktreeId, state)
  state.dirty = true

  if (state.inFlight || state.scheduled) return  // 已经在路上,等它

  state.scheduled = setTimeout(() => {
    state.scheduled = null
    state.inFlight = runUpdate(worktreeId).finally(() => {
      state.inFlight = null
      // 跑完后如果 dirty 又被标脏,再 schedule 一次
      if (state.dirty) schedule(worktreeId)
    })
  }, DEBOUNCE_MS) // 默认 8 秒
}
```

这样 100 个 `file.selection` 秒内涌入也**最多触发一次 compaction**。

**"不降级覆盖" 策略**（per oracle）：

```ts
const COMPACTOR_PRIORITY = { 'claude-haiku': 2, 'rule-based': 1 }

async function runUpdate(worktreeId: string): Promise<void> {
  const existing = db.getEpisodicMemory(worktreeId)
  const currentCompactor = this.compactor  // 'rule-based' 在 22B.1

  // 22B.2 场景：如果现有摘要是 Haiku, 本次只有 rule-based 可用 → 跳过
  if (existing && COMPACTOR_PRIORITY[existing.compactor_id] > COMPACTOR_PRIORITY[currentCompactor.id]) {
    log.debug('Skipping compaction: existing summary is higher-priority', { worktreeId })
    return
  }

  // ... compact 逻辑
}
```

**写入前 validation**（per oracle）：

```ts
function isValidOutput(output: CompactionOutput): boolean {
  if (!output.markdown || output.markdown.trim().length < 20) return false
  if (output.markdown.length > 10000) return false  // 硬上限, rule-based 应该 < 2500
  if (!output.compactorId || !output.version) return false
  return true
}
```

不合格 → 保留旧摘要，`compactions_failed` 计数器 +1。

**失败回退**：

- compactor throws (含 `INSUFFICIENT_EVENTS`) → log.warn，保留旧摘要
- validation fail → 同上
- DB 写入失败 → log.error + 计数器
- **永远不覆盖更高优先级的 compactor 产出**

**Shutdown 协议**（per oracle，显式化）：

```ts
class EpisodicMemoryUpdater {
  private isShuttingDown = false

  async shutdown(): Promise<void> {
    this.isShuttingDown = true
    // 1. 清所有 pending timer
    for (const state of this.states.values()) {
      if (state.scheduled) { clearTimeout(state.scheduled); state.scheduled = null }
    }
    if (this.periodicTimer) clearInterval(this.periodicTimer)

    // 2. 取消 sink emit listener(不再响应新事件)
    this.unsubscribeEmit?.()

    // 3. 不启动新的 update; 等 in-flight 跑完或让进程 teardown
    // 不阻塞 quit 等它 —— episodic memory 不是关键数据, 丢一次 update 可接受
  }

  private runUpdate(worktreeId: string): Promise<void> {
    if (this.isShuttingDown) return Promise.resolve()
    // ...
  }
}
```

在 `src/main/index.ts` 的 `will-quit` handler 里（sink.shutdown() 之前）调 `getEpisodicMemoryUpdater().shutdown()`。

**隐私 gate**：`isFieldCollectionEnabled() === false` → updater 不运行；existing 摘要不删（用户可能只是临时关闭）

**与 sink 协作**：`runUpdate` 开始前调 `sink.flushNow()` 保证读最新事件

**Log 策略**（per oracle 安全修订）：

- `log.info` 每次压缩：`{ worktreeId, eventCount, durationMs, compactorId, version, wasFallback }`
- `log.debug` 压缩产出的 markdown 全文：**仅在 `process.env.XUANPU_FIELD_DEBUG_BODIES === 'true'` 时输出**，并跑一次 secret redact（`api.?key|password|token|secret|authorization` 行替换为 `[REDACTED]`）
- 永远不 `log.info` 全文（防 secrets 泄漏到默认日志）

**Bootstrap 顺序**（`src/main/index.ts`）：

```
app.whenReady()
  ↓
getDatabase()              // schema v15 migration 已跑
  ↓
getFieldEventSink()        // Phase 21
  ↓
getEpisodicMemoryUpdater() // ★ 新增
```

**Shutdown 顺序**（`will-quit`）：

```
will-quit
  ↓
getEpisodicMemoryUpdater().shutdown()   // ★ 新增（不阻塞,不 await in-flight）
  ↓
getFieldEventSink().shutdown()         // 已存在
  ↓
closeDatabase()
```

### 4. Context Builder 集成

`FieldContextSnapshot` 加一个字段：

```ts
/** Episodic memory for this worktree, if available. */
episodicSummary: {
  markdown: string
  compactedAt: number
  sourceEventCount: number
} | null
```

`buildFieldContextSnapshot` 里，在 worktree lookup 后读 `field_episodic_memory`（本期无需 await anything LLM，纯 DB 读）。

### 5. Formatter 集成

插入位置在 `## Current Focus` 之前（VISION §4.1.3 的结构暗示："先给大背景，再给具体焦点"）：

```md
[Field Context — as of 14:25:30]
(...untrusted data directive...)

## Worktree
feature/auth (feature/auth) (worktree id abc12345)

## Worktree Notes
<如有>

## Worktree Summary (source: rule-based heuristic, last 6h, compacted 5m ago)
<episodic memory markdown>

## Current Focus
- File: src/auth/login.ts
...
```

**Provenance header**（per oracle）：

- `compactor_id === 'rule-based'` → `(source: rule-based heuristic, last Nh, compacted Nm ago)`
- `compactor_id === 'claude-haiku'` → `(source: Claude Haiku summary, last Nh, compacted Nm ago)`

Agent 看到 "heuristic" 词能自动降低信任权重，看到 "Claude Haiku summary" 能信任更多。这是"诚实标签"的关键。

**字符上限**：默认 2000 chars（给 summary 的独立子预算）。超了 formatter 截断到句末。

**截断优先级（更新）**：

1. **永远保留**：Worktree、Current Focus、Command + exit
2. 先砍 Recent Activity
3. **然后砍 Worktree Summary（加在 22A 的优先级之上）**
4. 再砍 Worktree Notes
5. 再砍 Output tail
6. 再砍 Output head

**理由**：Worktree Summary 覆盖几小时，帮助 orient；但具体的"瞬间 1" 依赖终端输出。所以 Summary 比 Output 先被砍。

### 6. Debug / 可观测

- `field:getEpisodicMemory(worktreeId)` IPC：返回 `CompactionOutput | null`
- `FieldContextDebug.tsx` 新增 tab："Episodic Memory"（显示当前 worktree 的摘要 + compacted_at 时间）
- `pnpm field:dump --episodic <worktreeId>` 打印摘要 markdown
- Updater 暴露 counters：`compactions_attempted / compactions_failed / compactions_skipped / last_compaction_at`
- `log.info` 每次压缩：`{ worktreeId, eventCount, durationMs, version }`
- `log.debug` 压缩产出的 markdown 全文（防 secrets 泄漏）

### 7. 隐私

- `isFieldCollectionEnabled() === false`：
  - updater 不运行
  - builder 不读 `field_episodic_memory`
  - formatter 不渲染 `## Worktree Summary`
- 已有摘要不删 —— 用户重新开启即恢复可见

---

## Rollout Plan

### Task Breakdown（预估 3 工作日）

| # | Task | Est |
|---|---|---|
| 1 | Migration v15 + `DatabaseService` CRUD | 0.3d |
| 2 | `EpisodicCompactor` 接口 + `RuleBasedCompactor` 实现 | 0.6d |
| 3 | `RuleBasedCompactor` 单测（所有规则） | 0.4d |
| 4 | `EpisodicMemoryUpdater`（scheduler + 阈值触发 + 节流 + 失败） | 0.6d |
| 5 | `EpisodicMemoryUpdater` 单测（触发条件、并发、失败） | 0.4d |
| 6 | `FieldContextSnapshot` 加字段 + `context-builder` 读 DB | 0.2d |
| 7 | `context-formatter` 加 `## Worktree Summary` 子块 + 新截断 tier | 0.3d |
| 8 | Bootstrap + `getEpisodicMemoryUpdater()` eager init | 0.1d |
| 9 | Debug IPC `field:getEpisodicMemory` + preload + d.ts | 0.2d |
| 10 | `FieldContextDebug` tab 扩展（可选；单独提交） | 0.3d |
| 11 | `dump-field-events.ts` 加 `--episodic` flag | 0.1d |
| 12 | 端到端 + commit + PR 评论 | 0.3d |

### Definition of Done

1. 真实跑玄圃 6 小时（或人造 6 小时历史事件）后 `field_episodic_memory` 表有一条记录
2. `pnpm field:dump --episodic <worktreeId>` 显示合理的 markdown（三段结构、命中 focus / work / problems）
3. 下一次 prompt 的 Debug UI 里 Field Context 有 `## Worktree Summary` 段
4. 隐私 off：updater 不触发，`## Worktree Summary` 不出现
5. **阈值触发**（emit 20+ 事件后）updater 异步跑完，新摘要写入
6. Compactor 抛错：log warn + 旧摘要仍可读
7. `pnpm test` 全过；`pnpm build` 成功
8. 294 → ~330+ phase-21 目录测试（新增约 40 个）
9. 3 个 SDK（Claude Code / Codex / OpenCode）的 prompt 都被 summary 覆盖

### Risks & Mitigations

| 风险 | 对策 |
|---|---|
| **Rule-based compactor 质量差, Agent 被误导** | 明示 "heuristic summary, observed only"。22B.2 换 LLM 时修 |
| **Summary 和 Working Memory (Field Context) 信息重复** | formatter 里 summary 放最上（大背景）、current focus 放后（细节）。Agent 容易学 |
| **每次 prompt 都触发更新导致 I/O** | 阈值触发：10 分钟 + 20 事件；定时 30 分钟兜底 |
| **并发更新破坏摘要** | Per-worktree Promise map。同一 worktree 同时最多一个 update |
| **空 worktree 的摘要生成** | 如果事件数 < 5 → 不生成 summary（避免"noop 摘要"）|
| **Compactor version 升级导致所有摘要同时失效** | Updater 发现 version mismatch 时惰性重新生成，不一次性清空 |
| **Rule-based 无法处理某些边缘输入（缺 output 的 command 等）** | compactor 所有地方 nullable safe；单测覆盖 |
| **24 小时后的事件仍被摘要（太老）** | 默认 6 小时窗口。超过窗口的事件不进 summary，但 `source_*` 字段记录真实范围 |

---

## File Inventory

### 新增

```
src/main/field/episodic-compactor.ts          — 接口 + RuleBasedCompactor
src/main/field/episodic-updater.ts            — 调度 / 触发 / 节流
docs/prd/phase-22b-episodic-memory.md         — 本文档
test/phase-21/field-events/episodic-compactor.test.ts
test/phase-21/field-events/episodic-updater.test.ts
```

### 修改

```
src/main/db/schema.ts                         — migration v15 + SCHEMA_SQL 追加
src/main/db/database.ts                       — ensureEpisodicMemoryTable + CRUD
src/shared/types/field-context.ts             — 加 episodicSummary 字段
src/main/field/context-builder.ts             — 读 field_episodic_memory
src/main/field/context-formatter.ts           — 加 Worktree Summary 子块 + 截断 tier
src/main/field/emit.ts                        — emit 后触发 updater（本期也可以用单独 listener）
src/main/ipc/field-handlers.ts                — field:getEpisodicMemory channel
src/preload/index.ts / index.d.ts             — fieldOps.getEpisodicMemory
src/main/index.ts                             — bootstrap updater
scripts/dump-field-events.ts                  — --episodic flag
test/phase-21/field-events/context-builder.test.ts  — 新增 episodic 读取测试
test/phase-21/field-events/context-formatter.test.ts — 新增 Worktree Summary 段测试
```

---

## Appendix: Phase 22B.1 → 22B.2 衔接

22B.1 结束时：

- `EpisodicCompactor` 接口就位
- `RuleBasedCompactor` version = 1
- Updater 的所有工程机关到位

22B.2 只需：

1. 新建 `src/main/field/claude-haiku-compactor.ts` 实现 `EpisodicCompactor`，version = 2
2. Updater 注入时换成 new compactor（老的 RuleBased 作为 Haiku 不可用时的降级保留）
3. 加 LLM 超时（比如 30s）+ 重试（最多 1 次）+ 配额失败的 exponential backoff
4. 单测 + 真机跑通

**这样的拆分让 22B 的每一步都能独立合并**。
