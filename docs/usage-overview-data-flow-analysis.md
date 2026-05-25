# Usage 统计概览：完整数据链路分析

> 2026-05-25, 针对 Worktree 概览面板 token 统计问题的全链路诊断

## 一句话结论

**`OverviewPanel` 对 worktree 下所有会话（含 opencode/terminal/xuanpu-agent 等）统一调用 `fetchSessionSummary`，但后者只支持 `claude-code` 和 `codex`，不支持的类型静默返回空，导致聚合数据不完整。** 同时 `syncClaudeSession` 采用"先删后插"的破坏性同步策略，transcript 文件缺失时已有数据全部丢失。

---

## 一、完整数据链路图

```
┌─────────────────────────────────────────────────────────────────────┐
│  Stage 1: 会话 ID 获取 (ContextPanelHost.tsx)                        │
│                                                                     │
│  Source A: useSessionStore.sessionsByWorktree                       │
│    → loadSessions() → getActiveByWorktree()                         │
│    → SELECT * FROM sessions WHERE worktree_id=? AND status='active' │
│    → 仅活跃会话（不含已归档），所有 agent_sdk 类型                      │
│                                                                     │
│  Source B: 直接 DB 查询 (async useEffect)                            │
│    → window.db.session.getByWorktree()                               │
│    → SELECT * FROM sessions WHERE worktree_id=?                     │
│    → 全部会话（含已归档），所有 agent_sdk 类型                          │
│                                                                     │
│  结果: overviewSessionIds = 所有会话 ID                              │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ 传给 OverviewPanel 作为 sessionIds prop
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Stage 2: 逐会话获取 Summary (OverviewPanel, line 278-287)           │
│                                                                     │
│  for each sessionId:                                                │
│    window.usageAnalyticsOps.fetchSessionSummary(sessionId)           │
│                                                                     │
│  【问题点 1】这里对 ALL sessionIds 调用 fetchSessionSummary，         │
│  包括 opencode/terminal/xuanpu-agent 会话，但没做 agent_sdk 过滤      │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ IPC: usageAnalytics:fetchSessionSummary
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Stage 3: fetchSessionSummary (usage-analytics-service.ts:388)      │
│                                                                     │
│  3a: getUsageAnalyticsSessions(['claude-code','codex'], 'all')       │
│      → WHERE s.agent_sdk IN ('claude-code','codex')                 │
│      → 若 sessionId 对应 opencode/terminal 会话，find() 返回 undefined│
│      → return { success: false, error: 'Session not found' }        │
│      → 【问题点 1 后果】非 Claude/Codex 会话静默失败，贡献值为 0     │
│                                                                     │
│  3b: syncSession(session, force=true)  ← 每次调用都强制同步          │
│      │                                                              │
│      ├─ agent_sdk === 'claude-code' → syncClaudeSession()           │
│      │   1. 读取 ~/.claude/projects/<encoded>/<id>.jsonl             │
│      │   2. 【问题点 2】DELETE 全部已有 usage_entries                │
│      │   3. 若 transcript 不存在 → 数据全丢，标记 partial            │
│      │   4. 若 transcript 存在 → 重插全部条目                        │
│      │                                                              │
│      └─ 其他 → syncCodexSession()                                    │
│          1. 不删除已有条目（只统计 count，标记 synced）              │
│          2. 运行时由 persistCodexTurnUsage 增量写入                  │
│                                                                     │
│  3c: 遍历 usage_entries，手动累加全部字段                             │
│      summary.total_cost    += entry.cost                            │
│      summary.total_tokens  += entry.total_tokens                     │
│      summary.input_tokens  += entry.input_tokens                     │
│      summary.output_tokens += entry.output_tokens                    │
│      summary.cache_read_tokens  += entry.cache_read_tokens           │
│      summary.cache_write_tokens += entry.cache_write_tokens          │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ 返回 UsageAnalyticsSessionSummary
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Stage 4: 解析每会话 Token 值 (usage-token-totals.ts:60)             │
│                                                                     │
│  resolveUsageTokenTotals(summary, fallbackTokens):                   │
│                                                                     │
│  优先级链:                                                           │
│    1. summary 存在且 total_tokens > 0 → 使用 summary 值             │
│    2. fallbackTokens (live 运行时) 有值 → 使用 live 值               │
│    3. 全零                                                            │
│                                                                     │
│  【问题点 3】Cost 和 Token 使用不同策略:                             │
│    - Cost: Math.max(summary.total_cost, liveCost)  ← MAX of both    │
│    - Token: resolveUsageTokenTotals(summary, tokens) ← 二选一        │
│    这种不对称会导致 cost 可能来自 live 而 token 来自 summary          │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ 逐会话 ResolvedUsageTokenTotals
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Stage 5: 跨会话聚合 (ContextPanelHost.tsx:331-354)                   │
│                                                                     │
│  sessionIds.reduce(acc, sessionId => {                               │
│    acc.totalCost      += max(summary.total_cost, liveCost)           │
│    acc.totalTokens    += resolved.totalTokens                        │
│    acc.inputTokens    += resolved.inputTokens                        │
│    acc.outputTokens   += resolved.outputTokens                       │
│    acc.cacheReadTokens  += resolved.cacheReadTokens                  │
│    acc.cacheWriteTokens += resolved.cacheWriteTokens                 │
│  })                                                                  │
│                                                                     │
│  【问题点 1 后果】非 Claude/Codex 会话 summary 为 undefined，         │
│  若无 live token 则贡献全零 → 聚合数据偏低                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、已发现的问题

### 问题 1：agent_sdk 过滤缺失（直接影响数据准确性）

| 位置 | ContextPanelHost.tsx line 278-287 |
|------|-----------------------------------|
| 严重度 | **高** |
| 影响 | 非 Claude/Codex 会话静默不贡献任何数据，聚合总量偏低 |

`OverviewPanel` 对 worktree 下所有会话 ID 调用 `fetchSessionSummary`，但后者在 `getUsageAnalyticsSessions` 中加了 `WHERE s.agent_sdk IN ('claude-code', 'codex')` 过滤。opencode、terminal、xuanpu-agent 类型的会话会返回 `{ success: false }`，被 `OverviewPanel` 在 line 281 静默 catch 掉。

**对比：** `SessionView.tsx` line 839 已有正确的 guard：
```typescript
const supportsUsageAnalytics = sessionAgentSdk === 'claude-code' || sessionAgentSdk === 'codex'
```
`OverviewPanel` 没有等价逻辑。

**数据流中的影响：**
```
sessionIds: [claude-1, claude-2, codex-1, opencode-1, terminal-1, xuanpu-agent-1] 共6个
                      ↓ fetchSessionSummary 逐条调用
claude-1:   ✓ 返回 summary（若有 transcript）
claude-2:   ✓ 返回 summary（若有 transcript）
codex-1:    ✓ 返回 summary（若有运行时写入的 entries）
opencode-1: ✗ error → null → 贡献 0 token / 0 cost
terminal-1: ✗ error → null → 贡献 0 token / 0 cost
xuanpu:     ✗ error → null → 贡献 0 token / 0 cost

聚合结果 = 6个会话的总数但只算了 3 个会话的数据
```

---

### 问题 2：syncClaudeSession 破坏性同步（数据安全隐患）

| 位置 | usage-analytics-service.ts line 589 |
|------|-------------------------------------|
| 严重度 | **高** |
| 影响 | Transcript 文件丢失时已有 usage 数据全部丢失 |

每次 `fetchSessionSummary` 都会强制同步（`force=true`），对 Claude 会话执行：
1. `DELETE` 全部已有 `usage_entries`（line 589）
2. 从磁盘重读 transcript JSONL
3. 若 transcript 不存在 → 数据全丢，标记 `partial`（line 574-586）
4. 若 transcript 存在 → 重插全部条目（line 590-608）

**为什么这是问题：**
- Transcript 文件在 `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
- 任何路径不匹配（worktree 移动、编码差异）都会导致 transcript 读不到
- 一旦读不到，已有的 usage 数据也全部被删除了
- 对比 Codex 的 `syncCodexSession`：它**不删除条目**，只做统计（line 626-651）

---

### 问题 3：Cost 与 Token 聚合策略不一致（展示一致性）

| 位置 | ContextPanelHost.tsx line 336-338 |
|------|-----------------------------------|
| 严重度 | **中** |
| 影响 | 同一会话的 cost 和 token 可能来自不同数据源 |

```typescript
// Cost: 取 MAX — 可能来自 live（运行时累积）
acc.totalCost += Math.max(summary?.total_cost ?? 0, liveCost)

// Token: 二选一 — 优先 summary，其次 live
const resolvedTokens = resolveUsageTokenTotals(summary, tokens)
```

这种不对称意味着：一个已结束的 Codex 会话可能有 `liveCost > summary.total_cost` 但 token 来自 summary，导致 cost/token 比例异常。

---

### 问题 4：Transcript 路径编码依赖（健壮性）

| 位置 | claude-transcript-reader.ts line 15-16 |
|------|----------------------------------------|
| 严重度 | **低**（正常情况匹配，边界情况可能不匹配） |

`encodePath(worktreePath)` 将所有 `/` 和 `.` 替换为 `-`。这必须与 Claude CLI 的编码方式完全一致。虽然目前一致，但如果 Claude CLI 改变编码方式或 worktree 路径中有特殊字符，可能导致 transcript 找不到。

---

## 三、为什么之前"一直修不好"

### 历史修复记录

`usage-token-totals.ts` line 54-58 的注释记录了之前的一次修复：

> 历史回归：之前这里有 "liveTotalTokens > 0 && summary.total_cost > 0 → 用 live" 的分支，对 codex 还额外放宽到 fallbackCost > 0。这会在 codex 会话每次新一轮对话时把 thread 累计值当作纯增量加到本就已经入库的 summary 上，造成开发版和打包版统计相差一个数量级。修法就是不要再做这种"智能合并"。

### 根因分析：为什么修了又坏

1. **数据源多样**：token 数据有三个来源（DB summary、live runtime、transcript file），彼此独立更新，没有 single source of truth
2. **边界条件多**：每个来源都可能处于不同状态（完整/部分/空/缺失），三种来源组合产生多种边界情况
3. **同步策略不一致**：Claude 用破坏性删除重插，Codex 用增量写入，两种策略的行为差异大
4. **渲染层与数据层脱节**：`SessionView` 正确处理了 agent_sdk 过滤，但 `OverviewPanel` 没有，说明 filter 逻辑分散、未集中抽象
5. **没有端到端测试覆盖**：现有测试 (`context-panel-host-tabs.test.tsx`) 只测试了 2 个 session 聚合的情况，没有覆盖混合 agent_sdk 类型、transcript 缺失、sync 失败等边界

### 建议的修复策略

1. **OverviewPanel 增加 agent_sdk 过滤**：参考 `SessionView` 的 `supportsUsageAnalytics` guard
2. **syncClaudeSession 改为增量模式**：用 `upsert` 替代 `deleteAll + insert`，避免数据丢失
3. **统一 Cost 和 Token 的分辨策略**：都使用 `resolveUsageTokenTotals` 的二选一逻辑，去掉 cost 的 MAX 逻辑
4. **增加边界测试**：覆盖混合 agent_sdk、transcript 缺失、live token 缺失等场景
