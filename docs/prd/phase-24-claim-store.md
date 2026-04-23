> ⚠️ **作废 / Superseded**
>
> 本文档经 oracle 严格评审后判定为**过度设计**：在零真实使用数据的情况下一次性引入 Claim 身份模型、Outcome 归因、Activation 排序、Checkpoint 续窗四个不确定系统。核心问题：
> - `canonical_key` 用 free-form LLM 输出做唯一键不可靠
> - ±10min outcome 关联制造虚假权威
> - rank 权重无 ablation 数据支撑
> - 直接替换 5 分钟 raw dump 违反 VISION §6
>
> **新方案**：拆出最小可发的子集，仅 Checkpoint 一段先发。
> 见 `phase-24c-session-checkpoint.md`。
>
> 24A（Claim Store Lite，闭合 taxonomy）/ 24B（Outcome Capture Honest）/ 24D（Activation Shadow）等真实使用数据再回炉，**不再保留本文档的 schema 设计**。
>
> 本文档保留作设计探索记录，**不要据此实现**。

---

# Xuanpu — Phase 24 Product Requirements Document

## Claim Store + Outcome Loop + Session Checkpoint（从"事件压缩"升级为"证据 → 信念 → 结果"）

---

## Overview

Phase 21 给玄圃装上了 **Evidence Ledger**（`field_events`），Phase 22A/B/C 让 Agent 能看到现场 + 滚动摘要 + 手写 memory.md。但这层记忆有三个硬伤：

1. **Episodic 摘要是自由文本** —— 没有 key，没有置信度，新摘要直接覆盖旧的，无法判断 "用 SQLite 作存储" 这个决策是否还成立、是否被新决策 supersede。
2. **没有 Outcome 反馈** —— 玄圃采集了 `terminal.output` 和 git 状态，但测试通过 / 构建失败 / commit 回滚这些**工程结果**从未反哺回记忆。Agent 看到的是"我说过什么"，不是"什么被验证过"。
3. **没有 Session 续窗** —— worktree 切换 / session 结束 / PreCompact 时没有工作态快照，新 session 还是冷启动，只能靠 5 分钟窗口重新拼凑。

Phase 24 借鉴 [`project-memory-runtime`](https://github.com/slicenferqin/project-memory-runtime)（同作者 V2 主线）的四层抽象，把玄圃的记忆层从"事件 + 文本摘要"升级为：

> **Evidence（已有） → Claim（新） → Outcome（新） → Activation（新） + Checkpoint（新）**

这是 VISION §4.1 里埋下的 "Crystallized Memory" 伏笔的第一次兑现，也是把玄圃的护城河从"看得见现场"升级到"记得住被验证的结论"的关键一步。

> **设计定位**：Phase 24 **取代** 原路线图里的 Phase 22B.2（Haiku 摘要）。与其把 rule-based 摘要升级成 Haiku 自由文本摘要，不如直接跳到结构化 Claim —— 避免两个月后再推翻一次。Phase 22B.1 的 rule-based episodic summary 保留作为 Claim 未建立时的兜底展示，最终会被完全替代。

### Scope split: 24A / 24B / 24C / 24D

记忆层是系统工程，**不能一 PR 打包**。拆成四个可独立合并的阶段，每阶段都让用户能感知到价值升级：

| 阶段 | 工期 | 核心产出 | 用户可感知的价值 |
|---|---|---|---|
| **24A: Claim Store** | ~3d | `field_claims` 表 + Haiku-based claim extractor + canonical_key 去重 + supersede 链 | Agent 能看到"结构化的项目决策列表"而非一坨文本 |
| **24B: Outcome Loop** | ~2d | 从 `terminal.output` 解析 test/build/lint 结果 → `field_outcomes` → 反哺 claim `outcome_score` | Context 里出现 `[✓ verified: 3 test passes]` 标记 |
| **24C: Session Checkpoint** | ~2d | Session 结束 / worktree 切换时生成 snapshot，下次启动时 branch+file digest 校验 + 注入 | "继续上次任务" 瞬间从理想变成事实 |
| **24D: Activation Engine** | ~2d | 把 Working Memory 的 raw dump 换成 eligibility + rank + token budget + ActivationLog | Context 质量肉眼可见提升，可解释"为什么这条记忆被带入" |

**总工期 ~9 工作日**，但 24A 单独合并就已经让 Agent 的记忆质量上一个台阶。

### Non-Goals（明确不做）

- ❌ 向量检索 / FTS5 —— 放在 Phase 25，不在 24 里塞
- ❌ 跨 worktree Claim 聚合 —— scope 严格按 `repo/branch/files`，不做"全局记忆"
- ❌ Claim 编辑 UI —— 本期只有 readonly debug 视图，编辑通过 `.xuanpu/memory.md` 手写
- ❌ 抽出独立包 `@xuanpu/memory-runtime` —— 等 24D 跑稳后作为 Phase 26 的独立任务
- ❌ MCP server 暴露 —— 协议对齐 PMR 是长远目标，本期不做
- ❌ Claim 多 Agent 共享 / 网络同步 —— Session Hub 的事，不是记忆层的事

---

## 核心抽象

```
┌───────────────────────────────────────────────────────────────────┐
│  Evidence Ledger（Phase 21 已有）                                 │
│  field_events: append-only, 原始事件, source of truth             │
└──────────────┬────────────────────────────────────────────────────┘
               │ Haiku extractor (24A)
               ▼
┌───────────────────────────────────────────────────────────────────┐
│  Claim Store（24A）                                               │
│  field_claims: 结构化信念 (fact / decision / thread)             │
│  - canonical_key: 单例去重 (singleton per scope)                  │
│  - confidence / importance / outcome_score                        │
│  - status: active / stale / superseded / archived                 │
│  - supersedes[]: 决策演进链                                       │
└──────────────┬────────────────────────────────────────────────────┘
               │ Outcome parser (24B) 监听 terminal.output / git
               ▼
┌───────────────────────────────────────────────────────────────────┐
│  Outcome Loop（24B）                                              │
│  field_outcomes: test_pass / build_fail / commit_kept / ...       │
│  → 反哺 claim.outcome_score (用指数平滑)                          │
│  → 生成 field_claim_transitions 审计轨迹                         │
└──────────────┬────────────────────────────────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────────────┐
│  Activation Engine（24D）                                         │
│  1. Eligibility: 按 scope 过滤 + status guard                     │
│  2. Rank: recency × outcome_score × importance × pin boost        │
│  3. Budget: 按字符预算 pack                                       │
│  4. 写 field_activation_logs（含 suppression_reason）            │
└──────────────┬────────────────────────────────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────────────┐
│  Session Checkpoint（24C）—— 续窗专用                            │
│  field_session_checkpoints: PreCompact / SessionEnd 快照         │
│  - hot_claim_ids[] + hot_files[] + file_digests{}                │
│  - 新 session 启动时校验 branch/file digest → stale / active      │
└──────────────┬────────────────────────────────────────────────────┘
               │
               ▼
        Field Context Snapshot
        （注入到 Agent prompt）
```

> **命名对齐**：字段名尽量对齐 PMR 的 `Claim / Outcome / ActivationLog / SessionCheckpoint` contract（见 `/tmp/xp-refs/project-memory-runtime/packages/runtime/src/types.ts`），为 Phase 26 抽独立包铺路。不盲目照搬：玄圃没有多 Agent 多 project_id，`project_id` 字段退化为 `worktree_id`。

---

## Phase 24A: Claim Store

### Schema v19: `field_claims` + `field_claim_transitions`

```sql
CREATE TABLE IF NOT EXISTS field_claims (
  id TEXT PRIMARY KEY,                        -- UUID
  worktree_id TEXT NOT NULL,                  -- scope 根
  created_at TEXT NOT NULL,                   -- ISO8601

  -- 分类 —— fact(事实) / decision(决策) / thread(未完待续)
  type TEXT NOT NULL CHECK (type IN ('fact', 'decision', 'thread')),
  assertion_kind TEXT NOT NULL,               -- fact/hypothesis/instruction/preference/todo

  -- 单例去重: 同 scope 同 key 只有一个 active claim
  -- e.g. "decision.persistence.backend" / "fact.test_runner" / "thread.refactor_auth"
  canonical_key TEXT NOT NULL,
  cardinality TEXT NOT NULL DEFAULT 'singleton' CHECK (cardinality IN ('singleton', 'set')),

  content TEXT NOT NULL,                       -- markdown 单行或短段落
  source_event_ids_json TEXT NOT NULL,         -- JSON array of field_event ids

  -- 置信度 / 重要度 / 结果分 (0..1)
  confidence REAL NOT NULL DEFAULT 0.5,
  importance REAL NOT NULL DEFAULT 0.5,
  outcome_score REAL NOT NULL DEFAULT 0.0,    -- -1..+1, 由 Outcome Loop 更新

  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN (
      'unverified', 'inferred', 'user_confirmed',
      'system_verified', 'outcome_verified', 'disputed'
    )),
  verification_method TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stale', 'superseded', 'archived')),
  pinned INTEGER NOT NULL DEFAULT 0,          -- 1 = 永不过期

  -- 决策演进: new claim 可以 supersede 旧的
  supersedes_json TEXT,                        -- JSON array of claim ids

  last_verified_at TEXT,
  last_activated_at TEXT,

  -- Scope 细化 (一般 = worktree_id 对应 repo+branch, 可选 files 限定)
  scope_json TEXT                              -- {files?: string[], cwd_prefix?: string}
);

CREATE INDEX IF NOT EXISTS idx_field_claims_worktree_status
  ON field_claims(worktree_id, status, last_activated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_claims_canonical_active
  ON field_claims(worktree_id, canonical_key)
  WHERE status = 'active' AND cardinality = 'singleton';

CREATE TABLE IF NOT EXISTS field_claim_transitions (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,              -- "superseded_by:<id>" / "user_override" / "outcome_negative" / ...
  trigger_type TEXT NOT NULL,        -- "extractor" / "outcome_loop" / "user" / "checkpoint"
  trigger_ref TEXT,
  actor TEXT NOT NULL                -- "claude-haiku" / "system" / "user"
);

CREATE INDEX IF NOT EXISTS idx_field_claim_transitions_claim_ts
  ON field_claim_transitions(claim_id, ts);
```

### Extractor: `src/main/field/claim-extractor.ts`

- **触发时机**：
  - Session 结束（`session:ended` hook）
  - Episodic updater tick（~30 min，复用 22B 的节流门禁）
  - Worktree 切换（用户手动停留在新 worktree >5 min 后）
- **输入**：最近一批 `field_events`（未被任何 claim 引用的，按 worktree 分组）
- **模型**：Claude Haiku，复用 `claude-session-title.ts` 的 `loadClaudeSDK` 路径 + `effort: 'low'` + `thinking: disabled` + 无 tools
- **输出**：结构化 JSON，schema 固定：

```ts
{
  claims: Array<{
    type: 'fact' | 'decision' | 'thread',
    assertion_kind: 'fact' | 'hypothesis' | 'instruction' | 'preference' | 'todo',
    canonical_key: string,  // kebab-case, dot-segmented: "decision.persistence.backend"
    content: string,         // ≤200 chars
    confidence: number,      // 0..1
    importance: number,      // 0..1
    source_event_ids: string[],
    supersedes_canonical_key?: string  // 仅当新决策覆盖旧决策
  }>
}
```

- **System prompt** 核心约束（硬塞在 prompt 里，非 tool call）：
  1. 不捏造 —— `source_event_ids` 必须是输入里真实存在的 id
  2. `canonical_key` 用固定 taxonomy，文档里提供 seed 列表
  3. 不做 `thread.*` 除非真有"待办/阻塞"证据
  4. 单个 worktree 一次 extractor 调用产出 ≤10 条 claim

### Upsert 逻辑（单例去重 + supersede）

```ts
// 伪代码
for (const candidate of extractedClaims) {
  const existing = getActiveClaimByKey(worktreeId, candidate.canonical_key)
  if (!existing) {
    insertClaim(candidate, { status: 'active', verification: 'inferred' })
    continue
  }
  if (candidate.content === existing.content) {
    // 幂等: 追加 source_event_ids + bump last_verified_at
    mergeEvidence(existing.id, candidate.source_event_ids)
    continue
  }
  // 内容变了 → 新 claim supersede 旧 claim
  const newId = insertClaim({
    ...candidate,
    supersedes: [existing.id],
    status: 'active'
  })
  markSuperseded(existing.id, `superseded_by:${newId}`)
}
```

### Fallback

- Haiku fail / 超时 / 返回 JSON 不合规 → **不抛错、不创建 claim**，降级到 Phase 22B.1 的 rule-based summary。Compactor priority 保持不变（rule-based 不会覆盖 Haiku 产出的 claim，因为走的是两条独立链）。

### Context Formatter 集成

在 `context-formatter.ts` 现有 `## Worktree Summary` 之前插入 `## Active Claims`：

```markdown
## Active Claims

**Decisions**
- `decision.persistence.backend`: Use SQLite as backend (confidence: 0.90, unverified)

**Facts**
- `fact.test_runner`: vitest with jsdom env for renderer, node for main

**Open Threads**
- `thread.refactor_auth`: Refactoring OAuth flow, stuck on Google provider (open 2d)
```

未来 24B 会给每条 claim 加 `[✓ verified: 3 test passes]` 尾标。

---

## Phase 24B: Outcome Loop

### Schema 补充: `field_outcomes`

```sql
CREATE TABLE IF NOT EXISTS field_outcomes (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  related_event_ids_json TEXT NOT NULL,      -- 触发该 outcome 的 field_event ids
  related_claim_ids_json TEXT,                -- 被影响的 claim ids (可选)
  outcome_type TEXT NOT NULL CHECK (outcome_type IN (
    'test_pass', 'test_fail',
    'build_pass', 'build_fail',
    'lint_pass', 'lint_fail',
    'commit_kept', 'commit_reverted',
    'human_kept', 'human_corrected',
    'manual_override'
  )),
  strength REAL NOT NULL DEFAULT 0.5,         -- 0..1, 比如 test_pass=0.8, lint_pass=0.3
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_field_outcomes_worktree_ts
  ON field_outcomes(worktree_id, ts DESC);
```

### Parser: `src/main/field/outcome-parser.ts`

输入 `field_events` (`terminal.output`, `git.status_change`)，输出 `field_outcomes`。用**纯正则**，不调 LLM：

| 事件类型 | 正则/启发式 | outcome_type | strength |
|---|---|---|---|
| `terminal.output` after `vitest` / `jest` / `pnpm test` | `Tests\s+\d+ passed` / `\d+ failed` | test_pass / test_fail | 0.8 |
| `terminal.output` after `tsc` / `pnpm build` / `cargo build` | `error TS\d+` / `compiled successfully` | build_pass / build_fail | 0.7 |
| `terminal.output` after `eslint` / `pnpm lint` | `problem \(\d+ error` | lint_pass / lint_fail | 0.3 |
| `git.status_change` 中出现 `git revert` | 解析 commit hash | commit_reverted | 0.9 |

失败时降级：parser 无法识别 → 不产生 outcome，不影响其他功能。

### 反哺 claim.outcome_score

指数平滑：

```
new_score = old_score + sign * strength * (1 - |old_score|)
  // sign = +1 for positive outcome, -1 for negative
  // 保证 score 收敛在 [-1, +1] 不溢出
```

关联逻辑：
- **Recent-claim heuristic** v1：outcome 产生后 ±10min 内、同 worktree 的 active claim 都被关联（按 recency 加权）
- 未来 v2：通过 claim.source_event_ids 反向追溯更精确的关联

### Context Formatter 渲染

```markdown
## Active Claims

**Decisions**
- `decision.persistence.backend`: Use SQLite [✓ verified: 3 test passes | confidence: 0.90]
- `decision.state_mgmt`: Use Zustand [⚠ 1 test fail after switch | confidence: 0.60]

**Open Threads**
- `thread.refactor_auth`: OAuth Google provider [⚠ no outcome yet | open 2d]
```

---

## Phase 24C: Session Checkpoint

### Schema 补充: `field_session_checkpoints`

```sql
CREATE TABLE IF NOT EXISTS field_session_checkpoints (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch TEXT,
  repo_head TEXT,                              -- git HEAD SHA
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale')),
  source TEXT NOT NULL CHECK (source IN (
    'precompact', 'session_end', 'postcompact', 'stop_failure'
  )),
  summary TEXT NOT NULL,                       -- 1-2 句话, 由 Haiku 生成或 rule-based 兜底
  current_goal TEXT,
  next_action TEXT,
  blocking_reason TEXT,
  hot_claim_ids_json TEXT NOT NULL,            -- JSON array
  hot_files_json TEXT NOT NULL,                -- JSON array of relative paths
  hot_file_digests_json TEXT,                  -- {"src/foo.ts": "sha1..."} 用于重建校验
  packet_hash TEXT NOT NULL,                   -- 快照内容 hash, 用于幂等
  stale_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_field_session_checkpoints_worktree_created
  ON field_session_checkpoints(worktree_id, created_at DESC);
```

### Generator: `src/main/field/checkpoint-generator.ts`

**触发点**（按 claude-code / codex / opencode 适配层分别接入）：
- `PreCompact` hook —— SDK 上下文即将被压缩前
- `SessionEnd` —— session 结束
- `StopFailure` —— session 异常终止

**Snapshot 内容**：
- `summary`：最近 20 个 `session.message` + 5 个 `file.edit` 的 one-liner（Haiku 生成，rule-based 兜底）
- `hot_claim_ids`：Activation Engine 最后一次激活的 top N claim
- `hot_files`：最近 30min 内 `file.edit` 或 `file.focus` 的文件集合
- `hot_file_digests`：对 `hot_files` 每个文件算 sha1（异步，不阻塞）
- `packet_hash`：对以上字段算 hash，相同 hash 不重复写入

### Verifier: `verifyCheckpointForSessionStart`

新 session 启动时（`agent:connect` 里注入，紧跟在 `injectedWorktrees` 逻辑之后）：

```ts
1. 取 worktree 最新 checkpoint
2. 若 branch !== 当前 branch → status = 'stale', warnings += "branch changed"
3. 若 repo_head !== 当前 HEAD → warnings += "N commits since checkpoint"
4. 对 hot_files 每个文件算当前 sha1 vs hot_file_digests
   → 若 ≥50% 文件变过 → status = 'stale', warnings += "working set shifted"
5. 把 summary / current_goal / next_action / warnings 注入 Field Context 的新子块
```

### Context Formatter 渲染

```markdown
## Resumed from previous session

> Last session ended 42min ago. Working on OAuth refresh token support.

**Current goal**: Make `refreshAccessToken` retry on 401
**Next action**: Add exponential backoff in `src/auth/refresh.ts`
**Hot files**: src/auth/refresh.ts, test/auth/refresh.test.ts

⚠ 2 commits landed since checkpoint — verify before resuming
```

---

## Phase 24D: Activation Engine

### Schema 补充: `field_activation_logs`

```sql
CREATE TABLE IF NOT EXISTS field_activation_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  session_id TEXT,
  claim_id TEXT NOT NULL,
  eligibility_result TEXT NOT NULL CHECK (eligibility_result IN ('passed', 'filtered')),
  suppression_reason TEXT,                     -- scope_mismatch / superseded / archived / expired / low_rank / token_budget
  rank_score REAL,
  packing_decision TEXT CHECK (packing_decision IN ('included', 'dropped')),
  activation_reasons_json TEXT                 -- ["recent_edit", "outcome_verified", "pinned"]
);

CREATE INDEX IF NOT EXISTS idx_field_activation_logs_session_ts
  ON field_activation_logs(session_id, ts DESC);
```

### Engine: `src/main/field/activation-engine.ts`

替换 `context-builder.ts` 里当前的 "最近 5 分钟原始事件 dump" 逻辑。三阶段管线：

**1. Eligibility（O(n)，纯 SQL + in-memory filter）**
- scope 匹配：claim.scope.files ∩ 当前 hot_files ≠ ∅，或 claim.scope 为空（worktree 级）
- status guard：排除 `superseded` / `archived`
- expired：`valid_to && valid_to < now()`

**2. Rank（O(n)，pure function）**

```
rank_score =
    0.35 * recency(last_activated_at, half_life=24h)
  + 0.25 * outcome_score_normalized                    // (-1..+1) → (0..1)
  + 0.20 * importance
  + 0.10 * confidence
  + 0.10 * pin_boost                                    // pinned ? 1 : 0
```

**3. Budget packing（greedy）**
- 按 rank_score 降序
- 目标字符预算：3000 chars（给 Active Claims 这一子块）
- 逐条 pack，超预算即 drop，写 `packing_decision='dropped', suppression_reason='token_budget'`

### Debug UI

`FieldContextDebug` 扩展一个新 tab "Activation Trace"，展示最新一次注入的完整 rank 表：

```
claim_id                                       rank  decision   reason
─────────────────────────────────────────────  ────  ─────────  ─────────────────────
decision.persistence.backend                   0.82  included   pinned, outcome_verified
thread.refactor_auth                           0.54  included   recent_edit
fact.test_runner                               0.41  included   -
decision.old_state_mgmt                        0.22  filtered   superseded
fact.unrelated_config                          0.18  dropped    token_budget
```

这是玄圃"现场可解释"叙事的**关键卖点** —— 用户第一次能看见"AI 为什么知道这件事"。

---

## Migration 策略

- 单一 migration **v19**，一次建齐四张表（SQLite 在小事务里性能无差别，拆四次反而增加 version drift 风险）
- `MIGRATIONS` 新增 entry，`CURRENT_SCHEMA_VERSION = 19`
- 各 Phase 24A/B/C/D 的代码可以**独立合并**；未启用的表即使存在也无副作用
- 上线顺序：代码 PR（24A 的 extractor）合并后，后端自然开始写 `field_claims`。不需要数据回填 —— 冷启动是可接受的

---

## 测试策略

| Phase | 核心测试 | 位置 |
|---|---|---|
| 24A | extractor 输出 schema 验证、canonical_key 去重、supersede 链、Haiku 失败回退 | `test/phase-24/claim-extractor.test.ts` |
| 24A | `field_claims` repository CRUD + 单例约束 | `test/phase-24/claim-repository.test.ts` |
| 24B | outcome parser 正则覆盖（vitest / jest / tsc / eslint / git revert） | `test/phase-24/outcome-parser.test.ts` |
| 24B | outcome_score 指数平滑边界（-1 / +1 饱和） | `test/phase-24/outcome-score.test.ts` |
| 24C | checkpoint 生成幂等（packet_hash）、stale 检测（branch change / digest drift） | `test/phase-24/checkpoint.test.ts` |
| 24D | rank 函数纯函数性、budget packing 正确性、activation log 完整性 | `test/phase-24/activation-engine.test.ts` |

**契约测试**：新建 `test/phase-24/field-context-end-to-end.test.ts`，跑"事件 → claim → outcome → activation → formatter 输出"的完整链路。

---

## Phase 23 的重新定义

原 Phase 23 是"60 秒 VISION 对比 demo 视频"。24 完成后，demo 剧本升级为：

> **瞬间**：用户两周前在 worktree A 里决定用 SQLite 做存储（Haiku 抽出 `decision.persistence.backend`）。之后跑了 3 次 test_pass、1 次 build_pass，outcome_score 升到 0.82。今天切回 worktree A，新建 session，**Agent 第一句话就说"我看你用 SQLite，测试之前通过过，要继续用 SQLite 实现 XXX 吗？"**。旁边打开 Cursor / Claude Code 原生 —— 一无所知。

这比"我看到你刚才的现场"**强一个数量级**，也正好呼应 VISION §1.4 "共同现场" 的终极形态：**不仅共享当下，还共享被验证过的历史**。

---

## 开放问题（需要用户决策）

1. **Haiku 成本**：extractor 每 30min 触发一次，粗估每个活跃 worktree 每日 ~0.01 USD。是否接受？是否加 settings 开关？
2. **Claim 可见度**：是否在主 UI 里暴露 "Active Claims" 列表（类似 sidebar 的 "Open Threads"），还是仅在 FieldContextDebug 里可见？前者更有感知度，后者 Phase 24 范围内更克制。
3. **与 `.xuanpu/memory.md` 的关系**：手写 memory.md 是否应该被 extractor 识别并转成 `pinned=1` 的 claim？本 PRD 倾向**不转**（保持两条独立链路），但可以让 formatter 把两者并列渲染。
4. **Phase 26 抽 `@xuanpu/memory-runtime` 独立包**：是否现在就把 24A 的 schema 设计**严格**对齐 PMR contract，为未来 bridge 铺路？本 PRD 倾向对齐，但不照搬（不要 `project_id`、`agent_id` 等多 agent 字段）。

---

## 非目标复核清单（每次实现前复读）

- ❌ 不做向量检索
- ❌ 不做 Claim 编辑 UI
- ❌ 不做 MCP server
- ❌ 不做多 Agent 共享
- ❌ 不自动跑 git log / PR scraping 拿 outcome —— 只从 field_events 流里看得见的东西出发
- ❌ 不替 Agent 决定"要不要相信这条 claim" —— 只负责呈现，决策权在 Agent 和用户
