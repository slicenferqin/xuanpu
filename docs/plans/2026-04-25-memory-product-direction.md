# 玄圃记忆系统：产品形态与 1.4.x 路线图

**日期**：2026-04-25
**作者**：用户 + Claude（pre-release worktree 讨论）
**触发**：1.4.0 RC 真机测试中发现 PR #32（Phase 22B.2 Haiku compactor）实际未运行，复盘时把记忆系统的产品逻辑重新走了一遍。
**状态**：路线图（非 PRD），待逐项展开为独立 PRD/PR。

---

## 0. 背景：为什么写这个文档

PR #32 把"情景压缩器"换成了 Claude Haiku，预期效果是用户感受到 "agent 越用越懂我"。1.4.0 RC.5 真机测试后用户反馈"感知不强"，排查后发现：

- **直接原因**：`src/main/index.ts` 调用了 `getEpisodicMemoryUpdater()` 但**从未 import**，shutdown 时抛 `ReferenceError` 被 try/catch 吞掉，updater 单例从未实例化，event bus listener 从未注册，压缩根本没跑。已由 PR #34 修复。
- **更深的产品问题**：即使 Haiku 跑起来，当前实现也只是"6 小时活动滚动摘要"，距离用户期待的"持久化、跨 agent、可编辑的工作记忆"仍有差距。

本文档把后续要做的事按价值排序，并明确哪些**不在 1.4.0**、放到 1.4.x 渐进发布。

---

## 1. 当前状态盘点（1.4.0 RC.6 出包前）

### 1.1 已具备的能力

| 模块 | 描述 | 状态 |
|---|---|---|
| Field Events 采集 | agent.bash_exec / file_read / file_write / session.message / terminal.output 等 | ✓ Phase 21 |
| Field Context 注入 | 每个非 slash command 用户消息前注入 `[Field Context …]\n…\n[User Message]\n` | ✓ Phase 22A |
| Episodic Memory 表 | `field_episodic_memory(worktree_id, summary_md, compactor_id, compactor_version, …)` | ✓ Phase 22B.1 |
| Rule-based Compactor | 纯本地、永远兜底 | ✓ Phase 22B.1 |
| Claude Haiku Compactor | 真 LLM 摘要、超时/重试/回退 | ✓ Phase 22B.2 (PR #32) |
| Updater wiring 修复 | eager init + No-Claude 探测 | ✓ PR #34 |
| 跨 agent 注入 | 注入在统一 `prompt` handler 入口，路由到 Claude/Codex/OpenCode/Amp 之前 | ✓（管道层通） |

### 1.2 还缺的能力

| 缺口 | 影响 | 优先级 |
|---|---|---|
| **Pinned Facts**（用户编辑的长期事实） | 没有真正的"长期记忆"；6h 滚动摘要无法表达 "这个项目用 pnpm 不是 npm" 这种永恒事实 | P0 |
| **Memory 面板**（看见 + 编辑 + 重置） | 用户不知道玄圃记住了什么，无法纠错、钉住、清除；闭环不合 | P0 |
| **跨 agent 注入质量验证** | Codex / OpenCode / Amp 收到 markdown prefix 后是否真的会用？还是当垃圾忽略甚至复述？没人测过 | P1 |
| **成本/隐私可见性** | Haiku 静默消耗用户 Claude Code 配额；events 含命令行/源码可能含密钥；用户没有任何提示 | P1 |
| **多 provider 配置** | Codex-only / OpenAI-only 用户希望用 gpt-mini 而不是 haiku | P2 |
| **真正的衰减/合并** | 当前每次压缩重头来过；用户休假 2 天回来记忆全空白；不是"越用越懂" | P1 |

---

## 2. 产品形态：目标长这样

```
┌─────────────────────────────────────────────────────────────┐
│  Worktree Memory · pre-release                       [⚙]   │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  📌 Pinned Facts (你写的，永不被覆盖)                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • 这个项目使用 pnpm，不要 npm/yarn                  │   │
│  │ • 主分支是 pre-release 不是 main                    │   │
│  │ • 单引号 / 无分号 / 100 char print width            │   │
│  └─────────────────────────────────────────────────────┘   │
│  [+ 添加 Fact]                                             │
│                                                             │
│  🧠 What I Observed (auto · 5 分钟前刷新)                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Working on Hub mobile polish + episodic memory     │   │
│  │ wiring bug. Touched src/main/field/*.ts, ran       │   │
│  │ pnpm vitest, opened PR #34.                        │   │
│  │                                                     │   │
│  │ Observed:                                           │   │
│  │   • episodic-updater.ts:450 wiring fix              │   │
│  │   • Test: 40 fails (ABI mismatch, env-only)         │   │
│  │   • Discussed multi-provider compactor design       │   │
│  └─────────────────────────────────────────────────────┘   │
│  [✏ 编辑] [🔄 重新生成] [🗑 清除]                          │
│                                                             │
│  📊 本月：47 次压缩 · ~$0.14 · 平均 1.2 KB/次              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 三层结构

1. **Pinned Facts**（用户写的）— 永久层
   - 用户在 Memory 面板手敲，或在会话中触发 `/remember "这个项目用 pnpm"` 一键钉住
   - 注入到 `[Field Context]` 顶部，在 Worktree / Recent Activity 之前
   - 永不被 LLM 压缩覆盖；只能用户自己删
   - 跨 session 跨 agent 永久生效

2. **Observed**（LLM 生成）— 滚动层
   - 当前 Phase 22B 已实现的部分
   - 6h 窗口 / 30min 重压（可调）
   - 用户可见、可编辑、可重置

3. **Cost & Privacy**（元信息层）
   - 本月压缩次数 / 预估成本
   - 隐私开关（哪些 event 类型可被发给 LLM）

---

## 3. 1.4.x 路线图

### 1.4.0（当前 RC，即将出包）

包含：
- ✅ PR #32：Claude Haiku Compactor
- ✅ PR #33：Hub 移动端打磨（重复气泡 + 系统消息泄漏）
- ✅ PR #34：Updater wiring fix + No-Claude 探测

**不**包含 Pinned Facts、Memory 面板、成本可见性、多 provider 配置。

### 1.4.1：Pinned Facts（P0）

**为什么这个最先做**：
- Haiku 只能在"6h 滚动观察"层卷，无法表达永恒事实
- 用户感受到"agent 更懂我"的最强信号，是它记住了**用户主动告诉它的事实**
- 实现成本比 Memory 面板低：先做最小可用（一个 textarea + 一个 IPC + 注入到 context 顶部）

**MVP 范围**：
- DB schema 加 `field_pinned_facts(worktree_id, content_md, created_at, updated_at)` 单行
- Settings 或 Worktree Detail 页面里加一个 textarea（markdown，最多 2000 chars）
- `formatFieldContext` 把 pinned facts 渲染到 Worktree 之后、Recent Activity 之前
- Token budget 单独划，不挤占 Observed 那部分预算

**先不做**：
- `/remember` slash command（1.4.2 加）
- 多 facts 列表 UI（先一个大 textarea，用户自己用 markdown 列表）
- 跨 worktree 共享（先 worktree-scoped）

**估时**：1 天

### 1.4.2：Memory 面板 + 自动化 facts（P0）

**为什么紧跟 1.4.1**：
- Pinned Facts 没有可视面板会被遗忘
- 需要看见 Observed 才能判断质量、纠错

**范围**：
- 新建 `MemoryPanel.tsx`（在 Worktree Detail 或独立 modal）
- 显示 Pinned + Observed 两层
- Observed 旁边加 [Edit] [Regenerate] [Clear] 三个按钮
- `/remember <fact>` slash command：在会话里直接钉一条 fact
- `/forget <fact>` 类似
- FieldContextDebug 退化为 dev-only

**估时**：1 天

### 1.4.3：成本 & 隐私可见性（P1）

**范围**：
- DB 加 `compactor_cost_log`（次数 + token 估算 + provider）
- Memory 面板 / Settings 里展示本月汇总
- 隐私开关细化：每种 event 类型可单独 opt-out 是否进入 LLM prompt
- 默认仍开启所有，仅作"用户能看见、能关"

**估时**：半天

### 1.4.4：跨 agent 注入质量验证（P1）

**为什么必须做**：
- 当前管道是通的，但 Codex/OpenCode/Amp 实际是否会"读懂"prefix 没人验证过
- 最坏情况：Codex 把 `[Field Context …]` 当用户消息内容复述出来，污染输出

**范围**：
- 写一个对比测试脚本：同 prompt 同事件，分别在 Claude / Codex / OpenCode / Amp 上跑
- 评估指标：① 是否在回复中"复述"context；② 是否真用上了 context（对比有/无 context 的回复）
- 如有需要，给非 Claude agent 用不同的 prefix 格式（XML tags / system 消息 / etc）

**估时**：1 天（含调研）

### 1.4.5：多 provider 配置（P2）

**前置条件**：1.4.4 验证下来 Codex 用户**真的**有需求

**范围**：
- 新建 `compactors/codex-gpt-mini.ts`（复用 CodexImplementer，强制 `--model gpt-5-mini`）
- Settings 加下拉：Auto / Claude Haiku / Codex GPT-mini / Rule-based / Off
- Auto 探测优先级（待定）：Codex (gpt-mini) > Claude (haiku) > RuleBased

**估时**：半天

### 1.5+：真正的长期记忆（P1，独立大版本）

**愿景**：Observed 不再是 6h 滚动覆盖，而是衰减+合并：
- 每次压缩读取上一次的 summary + 新窗口 events
- LLM 任务变成"merge old summary with new observations, keep what's still relevant, drop stale"
- 类似 ChatGPT memory 但 worktree-scoped
- 配合 Pinned Facts 形成"用户写的硬事实 + LLM 维护的软记忆"双层

需要独立 PRD（建议开 phase-22d-decaying-memory.md），不在 1.4.x 范围。

---

## 4. 关键决策记录

### 4.1 不在 1.4.0 加多 provider 配置

**理由**：
- 配置 UX 是 nerd 配置，普通用户不在乎
- "没装 Claude 用户白等 60s" 通过 No-Claude 自动探测已解决（PR #34）
- 真正的需求 "Codex 用户想用 gpt-mini" 价值不高（成本差 < $5/月，体验差异不可感）

### 4.2 跨 agent 共享是核心定位，不是附属

讨论中用户明确："玄圃的记忆是用户使用这个软件的记忆，不只是让 Claude 更懂用户，而是让 agent 更懂他，只要在玄圃里，agent 就能更懂他。"

实现层 PR #32 已经把注入放在统一 prompt handler 入口，跨 agent 管道是通的。但**质量未验证**（1.4.4）。

### 4.3 6h 滚动摘要 ≠ 持久记忆

当前 PR #32 的 Haiku 输出本质是"今天上午到现在做了啥"，不是 "Claude 越来越懂这个项目"。要做到后者必须：
- Pinned Facts（用户写）— 1.4.1
- 衰减/合并机制（LLM 维护）— 1.5+

---

## 5. 度量：怎么知道这套东西真的起作用了

为后续每个版本提前定义验收信号，避免重蹈 1.4.0 RC.5 的覆辙（"装了但没跑"）。

| 信号 | 阈值 | 工具 |
|---|---|---|
| 压缩在跑 | `field_episodic_memory` 表近 24h 至少一行新写入（per active worktree） | sqlite 查询 |
| Haiku 在工作 | `compactor_id = 'claude-haiku'` 行数占今日压缩 ≥ 80% | sqlite 查询 |
| Fallback 不爆 | `compactions_fallback_used / compactions_attempted < 5%` | counter dump IPC |
| 用户看见记忆 | Memory 面板 7 日内打开率 > 30% | telemetry（待实现） |
| 用户钉过 fact | 至少 1 条 pinned fact / active worktree 占比 > 20% | sqlite 查询 |
| Agent 真用了 | 抽样 20 个 session，盲评 with/without context 的回复差异（人工） | 1.4.4 评估 |

---

## 6. Open Questions

- [ ] Pinned facts 是 worktree-scoped 还是 project-scoped？（同 project 多 worktree 时，硬事实应该共享？）
- [ ] `/remember` 触发的 fact 要不要走一次 LLM 改写（去口语化、统一格式）？还是原样存？
- [ ] Memory 面板是 Worktree Detail 子区域还是独立页面？
- [ ] Cost 计费是按官方 token price 算还是按用户实际订阅类型动态展示？
- [ ] 没有 Claude binary 时，要不要在 Memory 面板里**主动提示**"安装 Claude Code 可获得更好的记忆"？还是默不作声？

---

## 7. 相关文档

- `docs/prd/phase-21-field-events.md` — 事件采集
- `docs/prd/phase-22a-working-memory.md` — Field Context 注入
- `docs/prd/phase-22b-episodic-memory.md` — 情景压缩（含 22B.2 Haiku 附录）
- `docs/prd/phase-22c-semantic-memory.md` — 语义记忆（未实现）
- PR #32：Phase 22B.2 实现
- PR #33：Hub 移动端打磨
- PR #34：Updater wiring 修复 + No-Claude 探测
