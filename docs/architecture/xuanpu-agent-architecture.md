# 玄圃 Agent 架构设计

日期：2026-05-27
状态：正式设计（implement-against）
替代：`docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md`（原规划仍保留为历史参考，本文档为最终实现依据）

---

## 目录

1. [定义与定位](#1-定义与定位)
2. [认知框架](#2-认知框架)
3. [三层架构总览](#3-三层架构总览)
4. [第一层：现场感知层](#4-第一层现场感知层)
5. [第二层：上下文工程层](#5-第二层上下文工程层)
6. [第三层：Runtime 层](#6-第三层runtime-层)
7. [成本地形设计](#7-成本地形设计)
8. [Memory 系统](#8-memory-系统)
9. [治理层](#9-治理层)
10. [执行计划](#10-执行计划)
11. [不做的事](#11-不做的事)
12. [参考项目与借鉴关系](#12-参考项目与借鉴关系)

---

## 1. 定义与定位

### 1.1 玄圃 Agent 是什么

玄圃 Agent（`xuanpu-agent`）是以**开发现场为操作系统**、以**上下文稳态为核心竞争壁垒**的 AI coding agent。它不是一个 Claude Code 的壳，也不是一个通用 ChatBot。它是玄圃工作台的**原生 Agent 运行时**——第一个完整实现 XFP（玄圃现场协议）的 Agent。

### 1.2 三句话定义

**1. 它以"开发现场"为操作系统。**
Worktree、分支、文件、终端、测试、session 历史——不是拼成一段 prompt 前缀，而是通过 XFP 协议结构化暴露为 agent 可消费的"操作系统接口"。

**2. 它的上下文窗口被当作一个有固定容量的缓存来管理。**
工具输出压缩 → 旧对话卸载为 episode block → 按需检索 → 稳态维持在 ~300K token。不追求 byte-level prefix-cache 命中率（那需要绑死单一模型），追求"上下文不膨胀、注意力不稀释"的稳态效果。

**3. 它把"成本地形"做进了 harness 而不是 prompt。**
不是让 LLM 变勤快，是让调工具比偷懒更便宜、让输出天然结构化、让错误被自动拦截和修复。约束来自外部工程层，不来自 prompt 的道德说教。

### 1.3 玄圃 Agent 不是什么

| 不是 | 原因 |
|------|------|
| **Claude Code 替代品** | Claude Code 仍然是玄圃支持的一等公民 runtime。xuanpu-agent 是新增的原生 Agent 选项，与 Claude Code / Codex / OpenCode 并存。 |
| **Reasonix 的竞品** | Reasonix 围绕 DeepSeek 字节级 prefix-cache 设计，追求 99.82% cache hit。玄圃 provider-agnostic，追求上下文稳态而非极致 cache hit。两条技术路线，不同赛道。 |
| **通用 ChatBot** | 玄圃 Agent 是 Field-bound 的——它的上下文、工具、权限、记忆全部绑定到具体的 project + worktree + session。脱离玄圃现场它无法工作。通用化是 2.0.0 之后的事。 |
| **又一个大模型 API wrapper** | 玄圃 Agent 的核心产品不是"调模型"，而是"管理上下文质量"。模型可替换，harness 才是产品。 |

### 1.4 用户价值

```
玄圃负责提供现场。
xuanpu-agent 负责实现协议、理解现场、推进任务。
```

不是"再做一个 AI 聊天窗口"，而是让 agent 真正理解你当前的 worktree 状态、文件、终端输出、测试结果、历史决策、长期记忆——然后用最少的 token、最准的注意力完成任务。持续运行 50 轮、100 轮，上下文不退化，注意力不稀释。

---

## 2. 认知框架

### 2.1 五层模型

把 AI 工程的所有概念放进一个五层框架，每一层有独立的演进逻辑：

```
L5  元能力层    评估的评估、工具的工具
     ↑
L4  治理层      预算控制、模型路由、复盘、自迭代
     ↑
L3  编排层      Workflow / Agent / 混合形态
     ↑
L2  接入层      Function Call / MCP / Skills
     ↑
L1  能力层      LLM 认知能力（理解、推理、生成、规划）
```

### 2.2 玄圃在五层中的位置

| 层级 | 玄圃已有 | 玄圃待建 |
|------|---------|---------|
| **L1 能力层** | 支持 Claude / GPT / Gemini / Codex | 通过 oh-my-pi 扩展到 40+ provider |
| **L2 接入层** | MCP server（Token Saver bash 命令压缩）、oh-my-pi 32 tools（依赖可用，待 M2 集成调度） | 工具输出沙箱化、按命令类型差异化压缩 profile |
| **L3 编排层** | Claude Code SDK / Codex RPC / OpenCode agent loop | **xuanpu-agent harness loop**（本文档核心） |
| **L4 治理层** | Context Budget（雏形）、Session HQ token 展示 | 预算感知、结构化复盘报告、模型路由 |
| **L5 元能力层** | 无 | 无（2.0.0 之后的事） |

玄圃的独特之处：**在 L2 和 L3 之间插入了一个独占的"现场层"**——这是三个参考项目（RTK / context-mode / Reasonix）都不具备的能力。

### 2.3 编排层的核心 trade-off

所有 Agent 设计最终都落在同一个光谱上：

```
确定性（workflow） ←————————————————→ 自主性（agent）
    ↑                                    ↑
  人在设计时控制                     LLM 在运行时决策
  可预测、可审计                     灵活、能处理开放任务
```

玄圃 Agent 的选择：**Agent 生成 workflow，而非 Agent 完全自由发挥。** LLM 先把计划写出来（生成结构化执行计划），再按计划执行。规划与执行解耦。

---

## 3. 三层架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    玄圃 Agent 三层架构                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Layer 3: 现场感知层（Field Layer）                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ XFP Packet Compiler                                 │   │
│  │   gitState · focus · terminal · tests · goal        │   │
│  │   commandTrace · anchor · budget                    │   │
│  │                                                      │   │
│  │ Field Events → Context Budget → Audit Trail         │   │
│  │ Memory (六层 scope)                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                   │
│  Layer 2: 上下文工程层（Context Engineering Layer）            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Command Compression (RTK-style 命令 profile)         │   │
│  │ Tool Output Sandbox (结构化 + raw ref)               │   │
│  │ Context Budget Manager (稳态 ~300K token)            │   │
│  │ Episode Freezer (旧对话卸载)                          │   │
│  │ Gated Retrieval (按需召回历史)                        │   │
│  │ Tool-Call Repair (flatten / scavenge / trunc / storm) │   │
│  │ Post-Response Claim Verifier                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                   │
│  Layer 1: Runtime 层（Model Runtime Layer）                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ oh-my-pi Agent                                      │   │
│  │   transformContext ← Context Packer 在此注入          │   │
│  │   convertToLlm     ← Cache 友好排序                   │   │
│  │   agent.prompt()   ← 模型调用                         │   │
│  │   40+ providers    ← OpenAI / Anthropic / Gemini ... │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 数据流（单轮 turn）

```
用户输入
  │
  ├─→ [Field Layer] XFP Compiler 编译当前现场 packet
  │     ├── gitState / focus / terminal / tests
  │     ├── anchor (pinned facts + rules)
  │     └── budget profile
  │
  ├─→ [Context Layer] Gated Retrieval 判定本轮需要的历史
  │     ├── 关键词匹配触发 episode retrieval
  │     ├── 错误签名匹配触发 memory page 加载
  │     └── 无匹配 → 只带 Working Set
  │
  ├─→ [Context Layer] Context Packer 装配最终上下文
  │     ├── Anchor Zone (byte-stable, ~15K)
  │     ├── Current Field (~10K)
  │     ├── Working Set (~120K, 最近 8-12 轮)
  │     ├── Retrieved Context (~100K, 按需加载)
  │     └── Current Request (~20K)
  │     └── Buffer (~35K 余量)
  │     总计: ~300K 稳态
  │
  ├─→ [Runtime Layer] oh-my-pi transformContext 注入
  │
  ├─→ [Runtime Layer] oh-my-pi convertToLlm cache 友好排序
  │
  ├─→ [Runtime Layer] agent.prompt() → LLM API
  │
  ├─→ [Context Layer] 模型返回 → Tool-Call Repair 四件套
  │     ├── flatten: 拍平嵌套参数 → rehydrate
  │     ├── scavenge: 从 reasoning 捞回遗漏的 tool call
  │     ├── truncation: 修复被截断的 JSON
  │     └── storm: 抑制重复工具调用
  │
  ├─→ [Context Layer] Tool Dispatcher 执行工具
  │     ├── Command Compression: 按 profile 压缩输出
  │     ├── Raw output → command_traces 表
  │     └── 压缩摘要 → 返回模型
  │
  ├─→ [Context Layer] Episode Freezer
  │     ├── 旧对话 → frozen episode block
  │     └── 从 Working Set 卸载，进入 Retrieved 区
  │
  └─→ [Context Layer] Context Budget 记录
        ├── included sections + reasons
        ├── omitted sections
        ├── compression ratio
        └── cache hit ratio (如有)
```

### 3.2 核心边界

```
玄圃拥有：现场、上下文、权限、事件、记忆、治理
模型运行时只做：消费编译好的 messages，返回文本或工具调用
```

这个边界是玄圃 Agent 和所有其他 Agent 的本质区别。模型是**可替换的**，harness 是**产品**。

### 3.3 Session HQ 集成

xuanpu-agent harness 的事件需要进入 Session HQ timeline，让用户看到 agent 的运行时行为。集成通过 `CanonicalAgentEvent` 桥接：

```
harness event (运行时)
  │
  ├─→ events/index.ts 转换为 CanonicalAgentEvent
  │
  ├─→ IPC → renderer → useSessionRuntimeStore
  │
  └─→ Session HQ timeline 渲染
        ├── tool_call_flattened        — 工具 schema 被展平
        ├── tool_call_scavenged        — 从 reasoning 捞回工具调用
        ├── tool_call_truncation_repaired — 截断 JSON 被修复
        ├── tool_call_storm_suppressed — 重复工具调用被抑制
        ├── tool_call_storm_gave_up    — storm 放弃，升级给用户
        ├── episode_frozen             — 旧对话被卸载为 episode
        ├── memory_proposed            — 建议写入新 memory
        ├── checkpoint_created         — 创建可恢复检查点
        └── budget_snapshot            — Context Budget 快照
```

**关键约束：**
- harness 不直接操作 UI store。harness → `CanonicalAgentEvent` → IPC → store 是单向数据流。
- 修复事件（scavenge / truncation / storm）在 timeline 中必须标注"玄圃介入"，不伪装成模型自发行为。
- Context Budget 快照每轮结束时 emit 一次，供 Session HQ 顶栏实时更新。

详见 `docs/plans/2026-05-26-session-hq-timeline-refactor-plan.md`（Timeline 重构）和 `docs/plans/2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md`（修复事件定义）。

---

## 4. 第一层：现场感知层

### 4.1 XFP 协议

XFP（Xuanpu Field Protocol）是玄圃向 agent 提供现场的协议。它是结构化 packet，不是 prompt 前缀。

详见 [`docs/architecture/xfp-packet-v1.md`](./xfp-packet-v1.md)。

**v1 packet 结构：**

| Section | 必填 | Cache | 内容 |
|---------|------|-------|------|
| `version` | ✓ | stable | 字面量 `1` |
| `identity` | ✓ | stable | packetId / project / worktree / session id |
| `anchor` | 可空 | stable | pinned facts + worktree notes |
| `gitState` | ✓ | volatile | 分支、HEAD、upstream、dirty 状态 |
| `focus` | ✓ | volatile | 当前文件和选区 |
| `terminal` | 可空 | volatile | 最近终端命令 head/tail 摘要 |
| `tests` | 可空 | volatile | 测试结果状态、失败摘要 |
| `commandTrace` | 可空 | mixed | 最近 N 条压缩后的 command trace |
| `currentGoal` | ✓ | volatile | 用户当前请求的目标描述 |
| `budget` | ✓ | mixed | Context Budget 决策记录 |

**核心原则：**

- 每个非平凡 section 必须携带 `rawRefs`（INV-XFP-2）。没有 raw refs 的总结只是传说。
- raw bytes 不内联，只放 pointer（INV-XFP-7）。consumer 通过 pointer 拉取。
- packet 由 compiler 单一出口生成，禁止手工拼接（INV-XFP-3）。
- packet 一旦生成即不可变（INV-XFP-4），下游只读。

### 4.2 XFP Packet Compiler

```
XfpPacketCompiler.compile(sessionId) → XfpFieldPacket

数据源：
  ├── git-service.ts         → gitState
  ├── worktree state         → identity, focus
  ├── terminal history       → terminal
  ├── test result cache      → tests
  ├── command_traces 表      → commandTrace
  ├── field_pinned_facts 表  → anchor
  ├── user message           → currentGoal
  └── context budget state   → budget
```

compiler 是单一出口。IPC handler、UI store、runtime adapter 禁止手工拼接 `XfpFieldPacket`。

### 4.3 Field Events 与 Context Budget

Context Budget 是 agent 的"黑盒记录器"——每轮记录 agent 到底看到了什么、为什么、哪些被省略了。

详见 [`docs/architecture/xuanpu-agent-invariants.md`](./xuanpu-agent-invariants.md) INV-BUDGET-* 系列。

**v1 记录：**
- included sections 列表
- omitted section names
- token 估算
- compression ratio

**v2 记录（以后）：**
- 每个 omitted section 的省略原因
- privacy policy 决策

---

## 5. 第二层：上下文工程层

这是玄圃 Agent 的核心工程壁垒。上下文工程层的目标不是"压缩 prompt"，而是**把上下文窗口当作一个有固定容量的缓存来管理**。

### 5.1 上下文稳态模型

目标：上下文窗口稳定在 ~300K token，注意力不稀释，持续运行不退化。

```
┌──────────────────────────────────────┐
│         上下文窗口 (~300K token)       │
├──────────────────────────────────────┤
│                                      │
│ [Anchor Zone]           ~15K token   │  ← 目标估算，待 M3 实测校准
│   system prompt                       │
│   pinned facts (稳定前缀 → cache 友好) │
│   project rules (memory.md)           │
│   tool catalog (flattened schema)     │
│                                      │
│ [Current Field]         ~10K token   │  ← 目标估算，待 M3 实测校准
│   XFP packet volatile sections        │
│   gitState / focus / terminal / tests │
│                                      │
│ [Working Set]           ~120K token  │  ← 目标估算，待 M3 实测校准
│   最近 8-12 轮原文保留（高保真）       │
│                                      │
│ [Retrieved Context]     ~100K token  │  ← 上限，本轮无匹配时为空
│   按需加载（gated retrieval）          │
│   episode blocks / memory pages       │
│   command traces (压缩摘要)            │
│                                      │
│ [Current Request]       ~20K token   │  ← 用户输入 + 本轮 scratch
│   用户输入 + 本轮 scratch              │
│                                      │
│ [Buffer]                ~35K token   │  ← 余量，防溢出
│   余量，防溢出                        │
│                                      │
└──────────────────────────────────────┘
```

**三种 budget profile：**

| Profile | 目标窗口 | 适用场景 |
|---------|---------|---------|
| Focused | ~150K | 明确的小任务，快速完成 |
| Balanced（默认） | ~300K | 常规开发任务 |
| Extended | ~500K | 复杂重构、多文件操作 |

300K 是默认稳态目标，不是硬限制。当上下文超过阈值时，触发卸载而非截断。

### 5.2 上下文卸载（Context Offload）

旧对话不是被遗忘，是被卸载成结构化、可检索、可追溯的 durable state。

```
Working Set 中的旧轮次
  │
  ├── 触发条件: Working Set 超过 120K 或轮次超过 12 轮
  │
  ├── Episode Freezer
  │     ├── 提取: 任务目标、关键决策、touched files、工具调用摘要
  │     ├── 压缩: 用轻量模型（Haiku/Flash）生成结构化摘要
  │     ├── 存储: episode block → field_episodes 表
  │     └── 链接: raw refs → 原始 messages / command traces
  │
  └── 从 Working Set 移除，标记为"已冻结"
        │
        └── 后续通过 Gated Retrieval 按需召回
```

**卸载 ≠ 遗忘。** 每条 episode 都能追溯回原始 message 和 command trace。用户可以在 Session HQ 里展开查看。

### 5.3 按需检索（Gated Retrieval）

不是"每轮都做 RAG"，而是**带触发条件的被动召回**。

```
本轮是否需要历史 context？
  │
  ├── 用户消息包含 "上次/之前/那个方案/还记得" → 触发
  ├── 错误签名匹配已知 memory → 触发
  ├── 文件路径命中 episode 的 touched files → 触发
  ├── 项目约束命中 → 触发
  └── 都不匹配 → 不加载任何额外历史
```

**检索优先级：**

```
结构化匹配 > 关键词匹配 > 语义向量检索
  路径          错误码        相似度
  函数名        时间范围
  git SHA
```

coding 场景下，结构化匹配（文件名、函数名、错误码）远比向量相似度可靠。

**Context Budget 必须记录每条被检索 memory 的 retrievalReason（INV-MEM-4）。**

### 5.4 命令输出压缩（Command Compression）

这是上下文稳态的**第一道防线**。命令输出是上下文污染的最大来源。

玄圃已经有一个 Token Saver MCP server（`src/main/services/token-saver/`），为 Claude Code 提供 bash 命令输出压缩。当前 pipeline 有 5 级策略：

```
AnsiStrip → ProgressDedup → NdjsonSummary → FailureFocus → StatsExtraction
```

转到 xuanpu-agent 之后，控制能力更强——不需要通过 MCP server 拦截，直接在 tool dispatcher 层做内嵌压缩。

**新架构：Command Profiler + Compressor**

```
Tool Dispatcher 执行命令
  │
  ├─→ CommandProfiler.identify(command, cwd)
  │     识别命令类型: vitest / tsc / eslint / git diff / cargo test / ...
  │
  ├─→ CommandCompressor.compress(output, profile)
  │     按 profile 策略压缩:
  │
  │     测试类 (vitest / jest / pytest / cargo test):
  │       - 折叠 PASSED → "N passed"
  │       - 保留 FAILED + 错误行 + 文件路径
  │       - 保留测试摘要行 (Test Suites / Tests / Snapshots)
  │       - 目标压缩率: 85-95%
  │
  │     Lint 类 (tsc / eslint / ruff / clippy):
  │       - 按文件/规则分组
  │       - 去重相同错误
  │       - 保留前 20 条错误
  │       - 目标压缩率: 70-85%
  │
  │     Git 类 (status / log / diff):
  │       - git status → compact 格式
  │       - git log → one-line format, 限制 N 条
  │       - git diff → 文件级摘要 + hunk 统计
  │       - 目标压缩率: 70-90%
  │
  │     构建类 (tsc --build / cargo build / next build):
  │       - 只保留 error，warning 截断
  │       - 目标压缩率: 80-95%
  │
  │     文件类 (cat / ls / read):
  │       - head 500 + tail 500 lines
  │       - 目标压缩率: 50-80%
  │
  │     搜索类 (rg / grep / find):
  │       - 按目录分组
  │       - 每目录限制匹配数
  │       - 目标压缩率: 60-80%
  │
  ├─→ raw output → command_traces 表 (full bytes + exit code + duration)
  │
  └─→ 压缩摘要 → 返回模型 (通常 < 1K token)
```

**Phase 1 覆盖高频 10 命令：** `git status/log/diff`、`pnpm test`、`vitest`、`tsc`、`eslint`、`rg`、`cat`、`ls`。这 10 个命令覆盖了 80% 的工具调用。

#### 5.4.1 压缩模型策略

命令输出的压缩摘要生成、episode freeze 时的对话压缩——这些需要轻量 LLM 调用。压缩模型的选择遵循三级降级链路：

```
Level 1: 用户显式配置的压缩专用模型
  settings.compactionModel = { url, key, modelId }
  适用：需要精确控制成本的团队/企业用户

Level 2: 复用 Agent session 的 provider（默认，零配置）
  如果 Agent 用 Anthropic → 压缩自动用同 key 调 Haiku
  如果 Agent 用 OpenAI   → 压缩自动用 gpt-5.1-nano / gpt-5-flash
  如果 Agent 用 Gemini    → 压缩自动用 gemini-2.5-flash
  适用：大多数用户

Level 3: 内置 RuleBasedCompactor（兜底）
  如果没有任何可用的 LLM → 降级到确定性提取（正则 + 规则）
  适用：所有用户的兜底保障
```

**不捆绑本地小模型。** 包体积 2-4GB + 跨平台 GPU 适配 + 压缩质量风险，投入产出比不划算。Haiku 的 ~$0.0025/轮压缩成本在工程上比本地模型 0 成本 + 高风险更划算。压缩成本不是瓶颈，压缩质量才是。用户可以自配 Ollama endpoint（oh-my-pi 原生支持 OpenAI 兼容协议），但玄圃不捆绑。

详见 `docs/plans/2026-05-23-road-analysis.md` §九 压缩模型策略。

**reference:**
- RTK (`rtk-ai/rtk`): 100+ command profile，<10ms 延迟，60-90% token 节省。玄圃借鉴其 profile 分类法，但做内嵌实现而非 CLI proxy。
- context-mode (`mksglu/context-mode`): 工具输出沙箱化，98% 削减，FTS5 索引。玄圃借鉴其"raw data 不进上下文"的理念。

### 5.5 上下文装配（Context Packer）

每轮对话，Context Packer 按 cache 友好顺序装配最终 prompt：

```typescript
// 装配顺序（cache 友好：稳定的在前，变化的在后）
function packContext(input: PackerInput): Message[] {
  return [
    // Zone 1: Anchor（byte-stable，prefix cache 受益）
    ...renderAnchorSystemPrompt(input.anchor),       // system prompt + pinned facts + rules
    ...renderToolCatalog(input.flattenedTools),       // flattened tool schemas

    // Zone 2: Frozen Episodes（生成后不可变，prefix cache 受益）
    ...input.episodes.map(renderEpisodeAsUserMsg),

    // Zone 3: Current Field（每轮变，但结构固定）
    renderFieldContext(input.fieldPacket),            // XFP volatile sections

    // Zone 4: Working Set（最近 N 轮原文）
    ...input.workingSet,                               // user/assistant/tool messages

    // Zone 5: Retrieved Context（按需加载）
    ...input.retrievedMemory.map(renderMemoryAsContext),
    ...input.commandTraceSummaries.map(renderTraceAsContext),

    // Zone 6: Current Request
    renderUserMessage(input.currentRequest)
  ]
}
```

这个顺序保证了 stable 内容在前、volatile 内容在后，最大化各 provider 的 cache 收益（Anthropic explicit cache_control / OpenAI auto prefix / DeepSeek byte-level）。

### 5.6 工具调用修复（Tool-Call Repair）

在工具循环中，模型会产出各种畸形 tool call。这一层在 harness 边界拦截修复，不依赖模型自身。

详见 `docs/plans/2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md`。

**四件套：**

| 修复器 | 问题 | 策略 |
|--------|------|------|
| **flatten** | 模型不理解深嵌套 schema | 编译期展平 → 模型产出平铺 args → rehydrate 回原结构 |
| **scavenge** | 模型把 tool call 写进 reasoning 忘了输出 | 从 reasoning_content 正则扫描捞回 |
| **truncation** | 流式 JSON 被截断 | 本地补全 → 请求续传 → 标记 MALFORMED |
| **storm** | 模型反复调同一工具同一参数 | 滑动窗口去重检测 → 注入 reflection turn → 超出阈值 give up |

**与错误分类的映射：**

| 四件套 | 成功事件 | 失败错误码 |
|--------|---------|-----------|
| flatten (rehydrate) | — | `MALFORMED_TOOL_CALL` |
| scavenge | `tool_call_scavenged` | —（捞不到就当没调） |
| truncation | `tool_call_truncation_repaired` | `MALFORMED_TOOL_CALL` |
| storm (suppress) | `tool_call_storm_suppressed` | —（成功路径） |
| storm (give up) | `tool_call_storm_gave_up` | `REPEATED_TOOL_CALL_GIVE_UP` |

所有的修复事件都进 Session HQ timeline，并被 Context Budget 记账。

### 5.7 Post-Response Claim Verifier（未来）

Agent 输出涉及具体文件名、API、命令名时，用正则 + FTS5 快速验证这些实体是否真的存在于当前 worktree / command trace 中。验证失败 → 注入纠正 turn。

这是"改造成本地形"的第四种方法（事后惩罚）。在 M6 之后实现。

---

## 6. 第三层：Runtime 层

### 6.1 oh-my-pi 集成

玄圃 Agent 使用 [oh-my-pi](https://github.com/can1357/oh-my-pi)（MIT license，TypeScript + Rust）作为模型运行时。oh-my-pi 嵌入玄圃主进程作为 npm library，而非 subprocess。

**集成方式：** 利用 oh-my-pi `Agent` 类的两个 hook 实现上下文注入。

```typescript
// oh-my-pi Agent 的两个关键 hook
interface AgentOptions {
  /**
   * 每轮 LLM 调用前，对内部 AgentMessage[] 进行变换。
   * 玄圃在此做上下文装配（Context Packer）。
   */
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal
  ) => Promise<AgentMessage[]>

  /**
   * 将 AgentMessage[] 转换为 LLM Message[]。
   * 玄圃在此控制最终发送格式和 cache 友好排序。
   */
  convertToLlm?: (
    messages: AgentMessage[]
  ) => Message[] | Promise<Message[]>
}
```

**玄圃在这两个 hook 中的操作：**

```
transformContext:
  1. 加载 XFP packet（当前现场）
  2. Gated retrieval 判定本轮需要的历史
  3. 裁剪 Working Set，冻结旧轮次为 episode block
  4. 注入 Anchor Zone（pinned facts + rules）
  5. 注入命令输出摘要（而非 raw output）
  6. 注入检索到的 memory pages 和 episode blocks

convertToLlm:
  1. 将 Xuanpu 自定义 message 类型转为 LLM user message
  2. 按 cache 友好顺序排列：
     Anchor → Frozen Episodes → Field → Working Set → Retrieved → Current
```

**选择 oh-my-pi 而非 Claude Code SDK 的原因：**

| | Claude Code SDK | oh-my-pi library |
|---|---|---|
| Agent 形态 | 独立 subprocess | 嵌入主进程的 npm 包 |
| 消息控制 | SDK 内部黑盒 | Xuanpu 完全控制 Message[] |
| 上下文裁剪 | 不可行 | `transformContext` 中实现 |
| 压缩触发 | SDK 自动 / 用户手动 `/compact` | Xuanpu 控制 per-turn 触发 |
| 工具生态 | Claude Code 内置工具 | oh-my-pi 32 工具 + MCP |
| 模型支持 | Anthropic only | 40+ providers |

### 6.2 oh-my-pi 的 Rust 核心

oh-my-pi 的 `crates/` 目录包含 Rust 实现的性能敏感部分：
- token counting（native）
- ripgrep in-process
- LSP client

玄圃不需要修改这部分，直接受益于其性能优势。当前代码 `src/main/services/xuanpu-agent/pi-agent-core-loader.ts` 已实现动态加载。

### 6.3 Runtime 契约

oh-my-pi 作为 Runtime 的职责边界：

```
Runtime MUST:
  - receive compiled messages (system + user + context)
  - stream assistant text + tool calls back
  - abort mid-stream
  - feed tool results back into conversation

Runtime MUST NOT:
  - compile context
  - select tools
  - make permission decisions
  - manage memory
  - decide budget
```

---

## 7. 成本地形设计

### 7.1 什么是"成本地形"

这个概念来自"约束 LLM"问题的工程化回答：

> **不是约束 LLM 不偷懒，是改造成本地形——让偷懒变贵、让勤变便宜。LLM 的"偷懒"不是道德问题，是统计问题。它在"延续语言流畅性"和"做高能耗动作（调工具）"之间做权衡。训练数据里前者的回报远高于后者。**

玄圃 Agent 通过四层机制改造成本地形：

```
Layer A: 降低工具成本（让"勤"更便宜）
  ├── 工具输出压缩（命令 profile，<1K token 摘要）
  ├── 工具输出结构化（模型不需要自己 parse）
  └── 工具签名高可发现性（一眼看出"这个能解决我的问题"）

Layer B: 提高偷懒成本（让"懒"更贵）
  ├── Post-response claim verifier（事实声明需可验证）
  ├── 输出 schema 要求 raw refs（不能凭空描述）
  └── Episode freeze 时校验关键实体完整性

Layer C: 绕过"要不要调工具"的选择
  ├── 任务结构化——高风险问答强制走 sub-agent
  └── sub-agent 输出 schema 要求 evidence 字段

Layer D: System prompt 自利框架
  ├── "偷懒会污染你自己的 reasoning context"
  └── 成本最低，效果不稳定，仅作兜底
```

Layer A 是基础设施（M2-M3），Layer B 和 C 在 M5-M6 逐步加入，Layer D 一开始就写进 system prompt。

### 7.2 工具输出的"成本地形"改造

这是最重要的一层。改造前后对比：

```
Before: 成本地形 = 调工具很贵
  read_file("src/foo.ts")
    → 800 行源码原封不动返回
    → 占了 4K token
    → 下次模型宁愿猜也不想调工具

After: 成本地形 = 调工具很便宜
  read_file("src/foo.ts")
    → head 100 + tail 100 + function signatures only
    → 占了 400 token
    → raw 可展开
    → 模型"理性选择"更倾向调工具
```

### 7.3 parallelSafe 调度

借鉴 Reasonix 的 `parallelSafe` 属性。完整不变量定义见 [INV-TOOL-5](./xuanpu-agent-invariants.md) 和 [INV-TOOL-6](./xuanpu-agent-invariants.md)。此处仅摘要：

- Read-only 工具 → `parallelSafe: true`，`Promise.allSettled` 并发执行
- 触及 worktree filesystem 的工具一律 `parallelSafe: false`，进串行屏障
- MCP 工具默认 `false`
- 环境变量 `XUANPU_AGENT_PARALLEL_MAX` 默认 3，上限 8

---

## 8. Memory 系统

### 8.1 六层 Scope

```
user → project → worktree → session → episode → command
 全局    项目级     分支级      单次对话    单段任务    单条命令
```

| Scope | 存储 | 生命周期 | 示例 |
|-------|------|---------|------|
| user | SQLite + memory.md | 跨项目持久 | "我偏好函数式风格" |
| project | SQLite + project memory.md | 项目级持久 | "这个仓库的架构是 monorepo" |
| worktree | SQLite | 分支存活期 | "在 feat/x 分支上做过某决策" |
| session | SQLite | 会话存活期 | 当前对话的上下文状态 |
| episode | SQLite (field_episodes) | 持久，可检索 | "上次修 auth bug 的决策链" |
| command | SQLite (command_traces) | 持久，可检索 | "npm test 的输出和退出码" |

### 8.2 Memory 写入策略

- **Proposal-based**：harness 提议写入，用户确认后落库。不允许静默写入（INV-MEM-5）
- **必须有 raw refs**：无 raw refs 的总结不能写入 memory（INV-MEM-1）
- **分类型**：每条 memory 必须标注类型——事实 / 决策 / 假设 / 约束（INV-MEM-6）
- **用户可编辑、可删除**：memory 不是黑盒（INV-MEM-3）

### 8.3 Trace 物化（M5-M6）

Agent 跑过一次的 execution trace，不应蒸发。Trace 物化是 episode freeze 的下一阶段：

| | Episode Freeze | Trace 物化 |
|---|---|---|
| **存什么** | 对话内容（压缩摘要 + raw refs） | 执行路径的结构（工具调用序列、分支决策、参数模式） |
| **用途** | 回忆"上次发生了什么" | 复用"上次怎么做的" |
| **检索方式** | 语义匹配 + 关键词 | 结构化匹配（路径 > 函数名 > 错误签名 > 时间） |
| **复用形式** | LLM 读取 episode 作为参考 | 参数化 workflow 模板 → LLM 改写执行（比从零规划容易 10 倍） |
| **产出物** | `field_episodes` 行 | `.agent/workflows/` 下的参数化模板 |

**具体路径：**

```
Agent 跑完任务 → 生成 execution trace（工具调用 DAG + 分支决策 + 参数）
      ↓
结构化存储（与 episode block 同一行，额外字段）
      ↓
高频路径检测（同一 project/worktree 下相似 trace 出现 ≥3 次）
      ↓
凝固成参数化 workflow 模板 → .agent/workflows/<name>.json
      ↓
新任务进来 → 检索相似模板 → LLM 改写复用
```

这是 Opus 对话中"下一步最确定的方向"的玄圃落地形态。M5 做基础存储和高频检测，M6 做模板生成和改写复用。详细设计见后续 Trace 物化设计文档（M5 前夕起草）。

---

## 9. 治理层

### 9.1 Context Budget 黑盒记录器

每轮必须记录（INV-BUDGET-1）：
- included sections + section 名称
- omitted section names
- budget profile 选择
- token 估算（input / output / retrieval）
- compression ratio
- retrieved episodes 数量 + retrieval reason
- cache hit / miss 状态（如有）

### 9.2 预算感知（M5-M6）

```
用户给任务设定（通过 Session HQ 任务卡 UI）:
  - 预算上限（token 或估算成本）
  - 超时限制
  - 验收标准（可选的测试/检查）

Agent 运行时:
  - 规划阶段预估 token 消耗
  - 执行中实时追踪消耗（Context Budget 已有基础）
  - 超预算时降级策略（换更便宜的模型 / 砍掉验证步骤）
  - 完成后生成复盘报告
```

M5 做规划阶段 token 预估 + 超预算告警（不自动降级），M6 做自动降级 + 模型路由决策。

### 9.3 结构化复盘（M4 起积累数据，M6 闭环）

每次任务完成后生成结构化复盘：
- 实际 token / 步数消耗 vs 预估
- 哪些步骤是浪费的
- 哪些工具调用被 storm 抑制
- 如果重来会怎么规划
- 可沉淀的 memory 建议

**实施路径：**
- **M4 起**：Agent 每次执行后自动生成复盘 JSON（只记录，不展示完整 UI）。调用栈：harness 的 turn 结束事件 → 复盘生成器 → `field_task_postmortems` 表。
- **M5-M6**：Session HQ 任务卡展示复盘摘要 + Context Budget 联动。用户可查看"这次任务实际消耗 vs 预算"。
- **1.7.0+**：积累足够复盘数据后，Agent 在规划阶段读取历史复盘数据，避免重复踩坑（人机混合迭代闭环，不要求 Agent 全自动自我改进）。

---

## 10. 执行计划

### 10.1 里程碑总览

```
M0:  Runtime 收口（已在进行）
     → 修 session 重取 bug、稳定 no-tools runtime
     → 加入 max-lines ESLint 规则

M1:  XFP v1 + Command Profiler 接口预留
     → XFP packet compiler / validator
     → CommandProfiler + CommandCompressor 接口定义（不实现）
     → 成本地形不变量（INV-COST-*）写入 invariants 文档

M1.5: Tool-Call Repair 接口
     → flatten / scavenge / truncation / storm 四件套 interface
     → flatten 和 storm 出 working implementation
     → 单元测试覆盖

M2:  只读 Harness + 压缩 MVP
     → git_status / git_log / git_diff / read_file / rg_search / list_files
     → 高频 10 命令压缩 profile（git / vitest / tsc / eslint / rg / cat / ls）
     → parallelSafe 调度
     ★ 压缩 MVP 必须与只读工具同期上线，否则上下文稳态直接崩

M3:  压缩 profile 扩展 + Context Budget 可视化
     → 扩展到 30+ 命令 profile
     → Context Budget UI 展示压缩比、included/omitted、token 估算
     → per-turn auto-compaction（单条 tool result >3000 token 自动压缩 + 上下文窗口填充率达 40% 触发主动 shrink / 80% 紧急 shrink）
     → 300K 稳态验证

M4:  受控写入 Harness
     → apply_patch / write_file / edit_file / run_test / format_file
     → diff preview + trust mode
     → 写入工具压缩 profile
     → Session HQ 顶栏暴露 cache hit / budget 使用率 / 压缩比

M5:  Memory Graph + Trace 物化
     → 六层 scope memory page schema
     → memory write proposal → 用户确认 → 落库
     → episode retrieval 增强
     → 高频路径 → 参数化 workflow 模板
     → NEEDS_TIER 自报升级协议

M6:  高级 Harness
     → MCP / subtask delegation / checkpoint-resume
     → multi-worktree awareness
     → Post-response claim verifier
     → 度量指标复盘
```

### 10.2 版本边界

| 版本 | 形态 | 关键能力 | 不做 |
|------|------|---------|------|
| 1.5.0 | Field-bound | XFP packet 编译、Context Budget、只读 harness、命令压缩 MVP、工具调用修复 | MinimalField CLI、跨 provider 适配器抽象、sub-agent delegation |
| 1.6.0 | Field-bound 加固 | 命令压缩 profile 库扩展、错误分类完整闭环、Context Budget 全 runtime 覆盖 | 写入工具扩展 |
| 1.7.0 | Field-bound + write | 受控写入 harness、Memory Graph、checkpoint/resume | MinimalField CLI |
| 2.0.0+ | 双形态 | MinimalField CLI standalone、provider 适配器抽象、sub-agent delegation | — |

### 10.3 代码目录结构

```
src/main/services/xuanpu-agent/
  runtime/                  # oh-my-pi 模型运行时适配
    pi-agent-core-loader.ts # 动态加载 oh-my-pi
    runtime.ts              # XuanpuPiAgentSession
    model-config.ts         # provider 配置解析
    bun-compat.ts           # Bun 兼容层
    pi-natives-compat.ts    # Rust native 兼容

  harness/                  # 玄圃自己的 agent loop
    error-taxonomy.ts       # HarnessError 类型
    build-messages.ts       # Context Packer
    compiler.ts             # Packet Compiler
    budget.ts               # Context Budget Manager
    tool-call-repair/       # 工具调用修复四件套（M1.5）
      index.ts
      types.ts
      flatten.ts
      scavenge.ts
      truncation.ts
      storm.ts

  xfp/                      # XFP packet 类型、校验
    types.ts                # XfpFieldPacket, MinimalFieldPacket
    schema.ts               # Zod schema
    fixtures.ts             # 测试 fixtures

  context/                  # 上下文打包、预算、卸载（M1-M3）
    compressor.ts           # [M2 新建] Command Profile + Compressor
    compactor.ts            # [M3 新建] Context Compactor（per-turn auto-compaction）

  tools/                    # git / shell / file / rg 工具（M2-M4）
    registry.ts             # [M2 新建] 工具注册 + parallelSafe 元数据
    dispatcher.ts           # [M2 新建] 工具调度

  memory/                   # 长期记忆（M5）
    memory-graph.ts         # [M5 新建]
    episodic-retrieval.ts   # [已有] M5 增强

  permissions/              # 权限策略
    tool-policy.ts          # [已有] M4 增强

  events/                   # harness event → CanonicalAgentEvent
    index.ts                # [M1.5 新建] 修复事件 + tool 事件 → CanonicalAgentEvent 桥接
  checkpoints/              # checkpoint/resume（M6）
    index.ts                # [M6 新建]
```

---

## 11. 不做的事

### 11.1 1.5.0 的明确边界

| 不做 | 原因 |
|------|------|
| **追求 byte-level prefix-cache 命中率** | 需要绑死单一模型（DeepSeek），违背 provider-agnostic 原则。玄圃做上下文稳态，不做极致 cache hit。 |
| **MinimalField CLI 入口** | 1.5.0 只做 Field-bound（玄圃内嵌）。CLI standalone 推到 2.0.0。类型已在 `xfp/types.ts` 留位。 |
| **跨 provider 适配器抽象** | 提前抽会拉变形 XFP packet 设计。先让 packet 服务 oh-my-pi runtime，2.0.0 再抽象。 |
| **写入工具的自由执行** | M4 之前，写入工具不开放。trusted worktree 由用户显式标记。 |
| **全自动记忆写入** | 记忆写入是 proposal-based，用户确认后落库。不允许 harness 静默写入长期记忆。 |
| **向量检索作为记忆主要入口** | coding 场景下结构化匹配（路径、函数名、错误码）远比向量相似度可靠。优先结构化，语义检索作为 fallback。 |

### 11.2 长期非目标

| 非目标 | 原因 |
|--------|------|
| **变成 Reasonix 的竞品** | Reasonix 的 DeepSeek-only 缓存策略是另一条技术路线。玄圃的 Field 一等公民路线是不同赛道。 |
| **闭源 / SaaS 计费** | 玄圃是开源桌面应用，不自建模型服务，不按 token 收费。 |
| **替代 Claude Code** | Claude Code 仍然是一等公民 runtime。xuanpu-agent 是新增选项，不是替代。 |
| **解决评估的评估（L5）** | L5 元能力层（评估的评估、工具的工具）是 2.0.0 之后的事。1.5.0 聚焦 L2-L4。 |

---

## 12. 参考项目与借鉴关系

| 项目 | 从中学什么 | 不学什么 |
|------|-----------|---------|
| **RTK** (`rtk-ai/rtk`, 54K⭐) | 100+ 命令 profile 分类法、压缩策略（Smart Filtering / Grouping / Truncation / Deduplication）、<10ms 开销、tee 模式存储 raw output | CLI proxy 形态（玄圃做内嵌压缩，不拦截 shell）、Rust 二进制（玄圃在 Node.js 主进程内实现） |
| **context-mode** (`mksglu/context-mode`, 15.7K⭐) | 工具输出沙箱化（raw data 不进上下文）、FTS5 索引、15 平台 hook 集成架构、"Think in Code" 理念 | MCP server 形态（玄圃在 tool dispatcher 层实现，不需要额外进程）、30MB 包体积 |
| **Reasonix** (`esengine/DeepSeek-Reasonix`, 9K⭐) | 三段式 prompt 分区思想、Tool-call repair 四件套（flatten/scavenge/truncation/storm）、parallelSafe 调度、per-turn auto-compaction 阈值、cache hit 指标暴露 | DeepSeek-only 绑定、反 RAG 立场、单进程 CLI 形态、Tauri 桌面方案 |
| **oh-my-pi** (`can1357/oh-my-pi`, 6.6K⭐) | `transformContext` + `convertToLlm` 双钩子（完美的上下文注入点）、40+ provider 支持、Rust 核心性能、MIT license | oh-my-pi 内置的 compaction 逻辑（玄圃在 transformContext 自己做，更精细） |

---

## 设计原则总结

1. **玄圃拥有现场。** Worktree / branch / selection / terminal / Hub / Mobile 必须在 XFP packet 里有独立 slot。
2. **XFP 是协议，不是 prompt 模板。** Packet 化、raw refs、audit trail 都是协议级保证。
3. **上下文是编译出来的，不是追加出来的。** 每轮从持久化状态重新编译有限、干净、相关的上下文。
4. **旧工作要卸载，不是遗忘。** Episode freeze + raw refs + gated retrieval。
5. **没有 raw refs 的总结不能叫记忆。** 每条 episode / memory / command summary 都必须能追溯到原始消息。
6. **命令输出进入模型前必须被压缩和结构化。** 按命令类型使用差异化压缩 profile。
7. **记忆必须分 scope、可编辑、可追溯。** Proposal-based 写入，用户确认后落库。
8. **大上下文窗口是 fallback，不是目标。** 默认 Balanced 300K，Focused 150K / Extended 500K 可选。
9. **模型可替换，harness 才是产品。** Provider-agnostic，所有 DeepSeek-specific 优化不渗透到 harness 层。
10. **我们优化用户工作，不优化模型厂商 token 消耗。** 上下文质量 > 上下文体积，注意力密度 > cache hit 率。
11. **约束 LLM 靠改造成本地形，不靠 prompt 说教。** 让调工具比偷懒便宜，让错误被自动拦截，让输出天然结构化。
12. **Trace 是资产，不是废热。** Agent 跑过的每一轮执行轨迹都应该沉淀——从 episode freeze 开始，到 trace 物化结束。
