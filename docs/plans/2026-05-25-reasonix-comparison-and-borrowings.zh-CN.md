# Reasonix 借鉴清单与玄圃应对

日期：2026-05-25
状态：规划中
起草人 / Reviewer：OpenClaude
目标版本：玄圃 1.5.0
相关分支：`feat/xuanpu-agent-oh-my-pi`
相关文档：

- [`2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md`](./2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md)
- [`2026-05-24-xuanpu-agent-1.5.0-plan-review.md`](./2026-05-24-xuanpu-agent-1.5.0-plan-review.md)
- `2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md`（即将起草，本文 A 级清单 A-1 详见此文）

本文是 5 月 24 号 1.5.0 plan 的**补充**，不重写原 plan 的判断。

---

## 1. 判定（Verdict）

Reasonix（[esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)）是同期、同方向、独立判断的另一份产品设计，已发布到 npm 并有真实生产数据（单用户单日 435M tokens、99.82% cache hit、$12/day）。

两边核心信念高度同构：**上下文质量 > 上下文体积**。但执行路径不同：

- **Reasonix** 押 DeepSeek 字节级 prefix-cache —— model-bound、可量化、已落地、有真金白银的成本数据背书。
- **玄圃** 押 XFP 结构化现场协议 —— model-agnostic、可解释、还在规划，但是产品形态（IDE workbench + Field + 多 Agent runtime）注定无法绑死单一模型。

结论：**思路同构、执行路径不同、可有节制地借鉴具体落地，但不能放弃自己的差异化护城河**。Reasonix 已经踩过的工程坑、已经验证过 ROI 的具体机制（cache-first 循环、tool-call repair、turn-end compaction、parallel-safe 调度），玄圃应该**抄具体实现**；但 Reasonix 的产品边界（DeepSeek-only、反 RAG、单进程 CLI）和玄圃的"现场一等公民 + 模型可替换 + 记忆图谱"路线根本冲突，**不能为了 cache hit 数字而妥协**。

---

## 2. 借鉴清单

每条均给出：名字 + Reasonix 出处、落地玄圃模块、收益判断、改造点、建议里程碑。里程碑沿用 5 月 24 号 plan 的 M0–M6 划分。

### 2.1 A 级（高优先、决定要抄）

#### A-1. Pillar 2 — Tool-Call Repair 四件套

- **Reasonix 出处**：`src/repair/`（flatten / scavenge / truncation / storm）
- **落地玄圃模块**：`src/main/services/xuanpu-agent/repair/`（新建）+ harness error taxonomy（5 月 24 号 plan AI-3）
- **收益判断**：极高。tool-call 错误是 model-agnostic 的硬伤，DeepSeek、GPT-5、Claude 全部会犯。Reasonix 把这一层做成独立 pipeline 是工程上的优雅解。
- **改造点**：玄圃要把四件套写成 provider-agnostic interface，不依赖 DeepSeek 的具体错误格式。
- **里程碑**：M2 同期落地，作为读类工具上线的前置基建。
- **不在本文展开**：详细 TypeScript interface、错误分类、重试策略见 `2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md`。

#### A-2. `parallelSafe` 工具属性 + 串行屏障 + `MAX_PARALLEL` 环境变量

- **Reasonix 出处**：工具声明 `parallelSafe?: boolean`，read-only 工具走 `Promise.allSettled`，mutating 工具起串行屏障；`REASONIX_PARALLEL_MAX` 默认 3、硬上限 16；MCP 工具默认 `false`。
- **落地玄圃模块**：`src/main/services/xuanpu-agent/tools/registry.ts`（工具注册元数据扩展）+ `xuanpu-agent` runtime tool dispatcher。
- **收益判断**：高。玄圃 M2 之后会接入大量读类工具（`git_log`、`grep_files`、`read_file`），并发执行能直接降延迟。Reasonix 已验证 ROI。
- **改造点**：
  - 环境变量改名 `XUANPU_AGENT_PARALLEL_MAX`，默认值 3、上限 8（玄圃单用户并发会话 ≤5，再高没意义，留 token rate-limit 余地）。
  - 串行屏障要尊重玄圃 Field 一等公民语义：触及 worktree filesystem 的工具一律 `parallelSafe: false`，不留例外。
  - MCP 工具默认 `false` 这条直接沿用。
- **里程碑**：M2，与读类工具同期。

#### A-3. Turn-end auto-compaction（>3000 token 阈值）+ 40% / 80% 双触发

- **Reasonix 出处**：
  - 单条 tool result > 3000 token 自动压缩，留原文 ref，模型按需 re-read。
  - 40% context-ratio 触发主动 shrink、80% 紧急 shrink。
- **落地玄圃模块**：`src/main/services/xuanpu-agent/context/budget.ts`（Context Budget 模块）+ `src/main/services/xuanpu-agent/context/compactor.ts`（新建）。
- **收益判断**：极高。这是 Reasonix 99.82% cache hit 的底层支柱之一。玄圃如果不做，对话长 50 轮后 prefix cache 必然失效。
- **改造点**：
  - 3000 token 阈值要可配置（不同 provider 的 tokenizer 差异大），玄圃用归一化字符数 / 估算 token 两套指标并行。
  - 压缩后必须写入 `Context Budget` 的 omitted 记录，保证可解释性（玄圃黑盒记录器要求）。
  - 40%/80% 双触发条件保留，但触发动作要走 XFP packet 重组、不是裸 prompt 截断。
- **里程碑**：M3 压缩层落地时同步实现。

#### A-4. Cache hit 计费指标暴露

- **Reasonix 出处**：成本染色（turn-level $ 计费、session-level $ 汇总），cache hit ratio 直接显示。
- **落地玄圃模块**：Session HQ 顶栏 + `useSessionRuntimeStore` + `usage-analytics-service.ts`。
- **收益判断**：高。Reasonix 公开数据已经证明，让用户看见 cache hit 数字会**改变用户行为**（让他们更愿意复用上下文）。玄圃即使没有计费 SaaS 需求，也应该把这个指标做出来作为产品可信度信号。
- **改造点**：玄圃不暴露 $ 金额（暂无计费场景），但暴露 cache hit ratio、prefix invariant 命中数、context budget 使用率。三个指标都在 Session HQ 顶栏。
- **里程碑**：M4，与 Context Budget UI 同期。

### 2.2 B 级（值得抄但需要明显改造）

#### B-1. `<<<NEEDS_PRO>>>` 自报升级协议

- **Reasonix 出处**：模型在输出里写 `<<<NEEDS_PRO>>>` 或 `<<<NEEDS_PRO: reason>>>`，harness 检测后切到 pro 模型重跑当前 turn。不是路由器猜测，是模型自报"我搞不定"。
- **落地玄圃模块**：`src/main/services/xuanpu-agent/runtime.ts` + harness escalation handler（新建）。
- **收益判断**：中高。这个协议比"自动路由"诚实，避免了 harness 替模型做决策。玄圃如果支持多 provider，必须解决"什么时候用大模型"的问题。
- **改造点**：
  - 玄圃要支持多 tier，不只是 pro/flash 二选一。设计为 `<<<NEEDS_TIER: <tier-name>, reason: ...>>>`，tier 名由项目级配置定义（例如 `default` / `reasoning` / `large-context` / `vision`）。
  - 升级动作要 Field-aware：触发升级时把 XFP packet 完整带过去，不重新编译上下文。
  - 用户可以在设置里禁用某些 tier（成本控制）。
- **里程碑**：M5，多 provider 支持稳定后再做。

#### B-2. 三段式 prompt 分区思想

- **Reasonix 出处**：
  - IMMUTABLE PREFIX（system + tool_specs + few_shots）—— 一次哈希钉死
  - APPEND-ONLY LOG —— 永不重写、序列追加
  - VOLATILE SCRATCH —— 每轮重置，进 log 前必须经 Pillar 2 蒸馏
- **落地玄圃模块**：XFP 协议规范文档 + `src/main/services/xuanpu-agent/context/compiler.ts`。
- **收益判断**：高。玄圃当前 XFP 已经有"五区"概念，但"不变前缀必须哈希钉死、变更必须触发显式 invalidate"这条 invariant 之前没有写死。Reasonix 的实践证明这是 cache-first 的必要条件。
- **改造点**：
  - 玄圃保留五区结构（identity / field / memory / current task / scratch），不缩成三段。
  - 把"前两到三区必须 byte-stable、变更必须显式 invalidate"这条 invariant 加进 XFP 规范。
  - compiler 输出每个 packet 时附带 prefix hash，供 cache layer 校验。
- **里程碑**：M1 末期完成 XFP 规范补充，M3 compiler 落地时执行。

#### B-3. 文件大小自约束（App.tsx ≤ 2K LOC、slash handler ≤ 200 LOC、hook ≤ 310 LOC）

- **Reasonix 出处**：模块布局亮点之一，写在 ARCHITECTURE.md。
- **落地玄圃模块**：`.eslintrc` + 项目规约文档 + CI lint 步骤。
- **收益判断**：中。玄圃当前有几个 component 接近或已经超过 1K LOC（`SessionShell.tsx`、`AgentTimeline.tsx`），早晚要拆。早做规约可以省后续重构成本。
- **改造点**：
  - 玄圃用更宽松的阈值起步：组件 ≤ 1500 LOC、hook ≤ 400 LOC、IPC handler 文件 ≤ 600 LOC。
  - 加 ESLint `max-lines` 规则，但用 warn 不是 error，避免一上来就阻塞合并。
  - 现有超标文件列入"技术债清单"，与 1.5.0 里程碑并行清理。
- **里程碑**：M0，作为分支整理动作的一部分。

### 2.3 C 级（仅参考、不直接抄）

#### C-1. flash-first 默认 + 模型显式切换

- **Reasonix 出处**：v4-flash 默认（v4-pro 的 1/12 价格），`/model` 命令显式切换并持久化。
- **不直接抄的原因**：玄圃 model-agnostic，没有"flash"这个模型层级概念，不同 provider 的廉价模型质量差异巨大。强行映射会误导用户。
- **可参考**：玄圃的项目级默认模型选择 UI 可以借鉴 Reasonix 的"显式 + 持久化 + 每次升级都公开"原则。
- **里程碑**：纳入设置 UI 改造（M4 之后）。

#### C-2. 成本染色（turn $0.05/0.20、session 汇总）

- **Reasonix 出处**：每次 turn 计算 $ 并 session 累计。
- **不直接抄的原因**：玄圃当前无计费 / 多租户场景，$ 金额对单用户意义不大。
- **可参考**：用 token 染色（input/output/cached 三色）替代 $ 染色，仍然给用户成本直觉。
- **里程碑**：M4，与 A-4 一并实现。

### 2.4 不抄

| 项目 | 不抄的理由 |
| --- | --- |
| DeepSeek-only 绑定 | 玄圃必须 provider-agnostic，Claude / GPT / Gemini / Codex / 本地模型都要能跑。 |
| 关闭 RAG / 向量检索 | 玄圃 memory graph + episode block + gated retrieval 路线明确依赖向量层。Reasonix 的反 RAG 立场是 DeepSeek 字节级 cache 时代的局部最优，不是普适真理。 |
| Tauri 桌面方案 | 玄圃用 Electron，已经落地、ecosystem 成熟。无切换 ROI。 |
| 单进程 CLI 形态 | 玄圃是 IDE workbench，三进程模型（main / preload / renderer）已经稳定，多 tab / 多 worktree / 多 session 并发是核心卖点。 |

---

## 3. 冲突点与玄圃的护城河

以下几条是**不能为了向 Reasonix 看齐而妥协**的玄圃差异化：

1. **Field 是一等公民**。worktree / branch / selection / terminal / Hub / Mobile 必须在 XFP packet 里有独立 slot，不能被压成"context blob"。Reasonix 没有这层，因为它是 CLI。玄圃不能丢。

2. **XFP 是协议，不是 prompt 模板**。packet 化、raw refs、audit trail 都是协议级保证。即使学了 Reasonix 的"三段式 + immutable prefix 哈希"，也只是把它内化进 XFP，不是用它替代 XFP。

3. **Context Budget 黑盒记录器**。included / omitted / why 必须可追溯。Reasonix 的 cache hit 数字是结果指标，玄圃的 Context Budget 是过程指标，两者不冲突，但**过程指标不能为了结果指标而被牺牲**（比如不能因为压缩省 token 就不记录 omitted）。

4. **记忆六层 scope**（user / project / worktree / session / episode / command）。Reasonix 是扁平 user + project，玄圃复杂度更高，但这是 IDE 工作流的真实需求，不能为了"对齐 Reasonix"而压扁。

5. **模型可替换、harness 才是产品**。这条 5 月 24 号 plan 已经写死，Reasonix 的所有 DeepSeek-specific 优化都不能渗透到 harness 层。

---

## 4. 行动项（按里程碑）

把 A/B 级条目映射到 5 月 24 号 plan 的 M0–M6 时间表上：

### M0（分支整理 / 基线，已在进行）

- [ ] B-3：加入 `max-lines` ESLint 规则（warn），整理技术债清单。

### M1（XFP 规范 + runtime 契约）

- [ ] B-2：把"immutable prefix 必须 byte-stable + 显式 invalidate"加进 XFP 规范文档。
- [ ] B-2：runtime 契约里加 `prefixHash` 字段（呼应 5 月 24 号 plan AI-1）。

### M2（读类工具上线）

- [ ] A-1：tool-call repair 四件套基础设施落地（详见 `2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md`）。
- [ ] A-2：工具注册元数据加 `parallelSafe`，dispatcher 实现 `Promise.allSettled` 并发 + 串行屏障 + `XUANPU_AGENT_PARALLEL_MAX`。

### M3（压缩层 / Context Budget）

- [ ] A-3：turn-end auto-compaction（阈值可配置）+ 40%/80% 双触发，结果写入 Context Budget omitted 记录。
- [ ] B-2：XFP compiler 实现 prefix hash 输出。

### M4（Session HQ / UI 暴露）

- [ ] A-4：Session HQ 顶栏暴露 cache hit ratio / prefix invariant 命中数 / context budget 使用率。
- [ ] C-2：token 染色（input/output/cached 三色）。

### M5（多 provider 稳定 + escalation）

- [ ] B-1：`<<<NEEDS_TIER>>>` 自报升级协议（多 tier 版本）。
- [ ] C-1：设置 UI 加项目级默认模型选择，"显式 + 持久化 + 升级公开"原则。

### M6（收尾 + 度量验证）

- [ ] 复盘 cache hit ratio / parallel-safe ratio / auto-compaction 触发次数三项指标，对照 Reasonix 公开数据评估差距。

---

## 5. 度量指标补充

5 月 24 号 plan 已有指标（context size、token 节省率、retrieval 命中率等）基础上，新增三项：

| 指标 | 目标 | 采集方式 | 里程碑 |
| --- | --- | --- | --- |
| **Cache hit ratio** | 阶段目标 ≥ 70%（M4），长期目标对齐 Reasonix 99% 量级 | runtime 接 provider cache 字段或自维护 prefix hash 命中表 | M4 |
| **Parallel-safe ratio** | 读类 turn 中实际并发执行的工具调用占比 ≥ 50% | dispatcher 在 turn 结束写 metric | M2 末 |
| **Auto-compaction 触发次数** | 每 100 turn 中 turn-end / 40% / 80% 三类触发计数分桶 | compactor 内部计数器 + Session HQ 可视化 | M3 |

这三项加进 `usage-analytics-service.ts` 的指标流，供 M6 复盘使用。

---

## 6. 待决问题

1. **A-3 的 token 阈值如何在 provider 之间归一化？** OpenAI 系、Anthropic 系、本地模型的 tokenizer 差异显著，3000 token 在不同 provider 下含义完全不同。建议方案：M3 起步用字符数估算，等 M5 多 provider 稳定后再切到 per-provider tokenizer。

2. **B-1 的 tier 命名规范由谁定？** 应该是项目级还是 user 级？倾向项目级（不同项目用不同模型组合是常态），但需要 plan 评审确认。

3. **A-4 暴露 cache hit ratio 时，对不提供 cache 字段的 provider（例如自建模型）怎么显示？** 倾向显示 `n/a` + tooltip 说明，避免造假。

4. **C-2 的 token 染色与 5 月 24 号 plan 已有的 token 节省率指标如何统一展示？** 可能需要在 Session HQ 顶栏做一次完整的"成本与现场"信息架构梳理，避免堆指标。

5. **Reasonix 的"每个 pro 调用都公开"非静默升级原则**，玄圃是否要做成强约束（设置里无法关闭）？倾向"默认开启、可关闭但需明确同意"。

---

附：本文不包含 Reasonix 项目科普段落，假定读者已读过 [Reasonix README + ARCHITECTURE](https://github.com/esengine/DeepSeek-Reasonix)。Pillar 2 四件套的 TypeScript interface 拆到 `2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md`。
