# 评审：Xuanpu 应用层上下文压缩中间件方案

## 一、方案核心

方案提出将 Xuanpu 定位为 **Agent 的上下文管理中间件**，通过"每轮即压缩"维持上下文在 200K 以下的稳态，包含四个核心组件：

1. **Anchor Zone**（稳定前缀，享受 Prompt Cache）
2. **Frozen Episodes**（追加式压缩历史片段，不可变）
3. **Working Set**（最近 N 轮原始对话，动态窗口）
4. **Cold Storage**（SQLite 原始事件流，按需召回）

## 二、总体判断：方向正确，但现有架构无法直接落地

方案中描述的"上下文物化视图系统"在架构思想上是优雅且正确的，但**当前 Xuanpu 的代码架构与方案所假设的前提之间存在一个根本性 gap**：

**Xuanpu 目前是"现场注入者"，不是"上下文宿主"。**

这意味着 Xuanpu 可以往 Agent 的 prompt 里**加东西**（Field Context），但无法**减东西**（裁剪 Agent 内部的对话历史）。

## 三、现有基础设施对齐度

### 已经就绪的部分（可以直接复用）

| 方案组件 | 现有代码 | 就绪度 |
|---------|---------|--------|
| **Token 计量/成本追踪** | `useContextStore`, `ContextIndicator`, `SessionCostPill`, usage analytics | 90% |
| **原始事件流 (Cold Storage)** | `field_events` 表（SQLite, append-only），`emit.ts` → `sink.ts` | 85% |
| **Episodic Memory 压缩** | `episodic-updater.ts` + `ClaudeHaikuCompactor` / `RuleBasedCompactor` | 70% |
| **Pinned Facts (Anchor Zone)** | `field_pinned_facts` 表，`PinnedFactsCard` UI，注入到 Field Context | 80% |
| **Semantic Memory (memory.md)** | `semantic-memory-loader.ts`，项目级 + 用户级 memory.md | 75% |
| **预算感知的上下文截断** | `context-formatter.ts`（8 级递进截断，token 预算） | 80% |
| **Token Saver 输出压缩** | `token-saver/strategies.ts`（5 级压缩 pipeline），`xuanpu-tools-mcp.ts` | 85% |
| **Session Checkpoint** | `field_session_checkpoints` 表，crash 后恢复 | 70% |
| **Field Context Debug 面板** | `FieldContextDebug.tsx`（4 标签页） | 构建可视化所需 UI 框架已就绪 |

### 缺失的关键能力

| 方案要求 | 当前状态 | 缺失度 |
|---------|---------|--------|
| **控制 Agent 的消息列表** | Xuanpu 不控制 Claude Code/Codex 的内部 history。`agent:prompt` 只是把 Field Context 拼接在用户消息前面传进去。SDK 自己管理对话历史。 | **根本性缺失** |
| **Per-turn 触发压缩** | Episodic updater 是基于防抖 + 阈值的（8s debounce, 20 event min, 10min interval），不是每轮触发。 | 中等 |
| **Frozen Episodes（追加式不可变摘要块）** | 目前只有一个 `summary_markdown` 文本字段，覆盖式更新。不支持多段追加。 | 中等 |
| **分类型差异化压缩** | Haiku compactor 和 RuleBased compactor 都是对事件流做统一处理，不区分"对话"vs"代码"vs"工具输出"。 | 需要新实现 |
| **Gated retrieval（被动召回）** | 不存在。没有任何根据用户输入判断是否需要历史上下文的路由逻辑。 | **完全缺失** |
| **Context Packer（按预算装配 prompt）** | 不存在。Field Context formatter 只处理注入的现场信息，不处理对话历史。 | **完全缺失** |
| **压缩质量审计** | 没有。Episodic summary 生成后无校验。 | 完全缺失 |

## 四、核心架构矛盾：Agent SDK 的黑盒问题

这是方案能否成立的最大约束。分三种情况讨论：

### 情况 A：Claude Code（通过 `@anthropic-ai/claude-agent-sdk`）

```
Xuanpu 调用: sdk.query({ prompt: "[Field Context]\n[User Message]", options: { resume: sessionId } })
SDK 内部:  自己维护完整的 message[] 数组，我们看不到也不能改
Compaction: SDK 自己触发 /compact，Xuanpu 只接收 compact_boundary 事件通知
```

**结论**：对 Claude Code session，Xuanpu **不能裁剪其内部上下文**。最多能做到：
- 通过 Field Context 注入结构化现场信息（已在做）
- 当上下文过大时，提示用户手动触发 `/compact`（已在做）
- 在 UI 层展示上下文使用量（已在做）
- **不能**做的：裁剪旧 message、注入压缩摘要替代原始历史、控制 SDK 内部的 message 组装

### 情况 B：Codex（通过 RPC/appserver）

代码探索中看到 Codex 通过 `codex-app-server-manager.ts` 交互，有 `thread/compacted` 通知。具体协议是否允许外部控制 message list 需要进一步确认，但从 `codex-implementer.ts` 的 prompt 调用模式来看，**同样是将用户输入转发进去，不控制内部 history**。

### 情况 C：如果 Xuanpu 自建 Agent loop

如果 Xuanpu 不通过 Claude Code SDK，而是：
1. 直接调用 Anthropic API（`@anthropic-ai/sdk`）
2. 自己维护 `messages[]` 数组
3. 每轮组装 prompt = System + Anchor + Frozen Episodes + Working Set + User Input
4. 调用 API → 处理 tool_use → 执行工具 → 追加结果到 messages → 触发压缩 → 下一轮

**这种情况下，方案可以完整落地。** 但这是自建 Agent runtime，工作量巨大。

### 方案中对这个矛盾的认知

方案原文在"最大前提"一节明确指出了这个问题：

> "不要在黑盒 Agent 原生会话里承诺完整上下文压缩收益。要把完整能力优先做在可控 Agent loop / SDK / appserver 模式下。"

这是诚实的，但也意味着：**如果 Xuanpu 继续作为 Claude Code/Codex 的"壳"，则方案的核心价值（省 token + 防降智）无法完全兑现。**

## 五、对方案各要点的逐一评审

### 5.1 Prompt Cache 兼容策略 — ✅ 正确且关键

方案提出 "Append-only compaction" + "稳定前缀 + 动态后缀" 的布局：

```
[System Prompt]     ← 永不变（cache hit）
[memory.md]         ← 跨 session 稳定（cache hit）
[Pinned Facts]      ← 用户编辑时才变（cache hit）
[Frozen Ep 1..N]    ← 生成后不修改（cache hit）
[Working Set]       ← 每轮变化（无 cache）
[User Input]        ← 新内容（无 cache）
```

这个设计在理论上正确。但有一个细节方案没提到：**Anthropic 的 Prompt Cache 有 TTL（~5 分钟）**，如果用户思考 6 分钟才发下一轮，前面的 cache 就过期了，需要重新 Prefill。这意味着"持续快速对话"时 cache 收益最大，"间歇性对话"时收益会打折扣。这个细节应该被纳入设计。

### 5.2 分类型差异化压缩 — ✅ 正确，已有部分基础

方案提出的对不同内容类型采用不同压缩策略（自然语言 10:1，代码块原样保留，工具调用只保留签名和退出码等）是正确的。Xuanpu 的 Token Saver（`token-saver/strategies.ts`）已经在做类似的事——对 Bash 输出按类型做不同策略压缩。这个经验可以直接迁移。

但需要注意：Token Saver 压缩的是**单次工具输出**，而方案需要的压缩是**跨轮次的对话历史压缩**，后者对语义保真度的要求远高于前者。

### 5.3 异步压缩 pipeline — ✅ 正确但有工程复杂度

方案提出的异步压缩 pipeline（每轮结束后后台触发）是正确的。需要解决的问题：

1. **Dirty write**：用户发下一条消息时压缩还没完成 → 方案提出了 versioned materialization，这在 Xuanpu 的 Episodic updater 已有雏形（`version` 字段 + "不降级"策略）
2. **Summary Tax**：异步压缩需要额外 LLM 调用 → 方案的成本核算已证明净节省（$9.25 vs $30+），前提是 cache 命中率能保持

### 5.4 被动召回 (Gated Retrieval) — ✅ 方向正确，实现需谨慎

方案提出的"不是每轮都做 RAG，而是带触发条件的召回"是正确的。在当前代码库中完全没有这部分能力。需要注意：

- Coding 场景下，向量相似度检索经常不如**结构化匹配**（文件名、函数名、错误码、git 路径）可靠
- 方案中提到的 hybrid retrieval（路径 > symbol > 错误码 > 时间 > 向量）排序是正确的

### 5.5 200K 稳态目标 — ⚠️ 需要重新审视

方案提出将上下文稳定在 200K 的目标值。但评审中也提到一个重要观点：

> "200K 应该是上限，不应该是默认目标。很多任务在 40K～100K 的高质量上下文里反而更稳。"

这个观点值得重视。Xuanpu 应该提供多种 budget profile（Focused 32K, Balanced 80K, Extended 150K），而非盲目追求"填满 200K"。

### 5.6 压缩质量审计 — ✅ 必要但方案未给出足够细节

方案提到 Two-Pass Summarization（第一遍摘要，第二遍检查是否有遗漏），这虽然理论上可以提升质量，但引入的额外延迟和成本需要权衡。更务实的第一版方案可以是：

- 确定性提取文件路径、命令、退出码、关键错误（不需要 LLM）
- LLM 只负责提炼意图、决策、约束（输入量小，输出结构可控）
- 用正则 + 规则做 post-generation audit（检查关键实体是否遗漏）

## 六、推荐的 MVP 实施路径

基于代码库现状，建议分如下阶段：

### Phase 0：Context Budget Debugger（可视化先于压缩）

**不改任何 Agent 行为**，只做"如果由 Xuanpu 装配上下文，会装成什么"的模拟展示。

```
需要新建:
- Context Packer 模块（模拟装配，不实际注入）
- Context Debug 面板升级

可复用:
- FieldContextDebug.tsx（UI 框架已有）
- useContextStore（Token 数据源已有）
- context-formatter.ts（预算截断逻辑已有）
```

### Phase 1：Claude Code Session 的"软压缩"

对 Claude Code session，Xuanpu 仍然不能裁剪 SDK 内部历史，但可以：

- 当检测到上下文接近 80% 时，主动 UI 提示用户触发 `/compact`
- 在 compact 后展示"压缩前 vs 压缩后"的 Context 构成对比
- 确保 Pinned Facts 在 compact 后仍然生效（因为是注入到 Field Context 而非 SDK 内部）

**这一步不需要修改任何 SDK 交互逻辑，只做 UI 层的观测和提醒。**

### Phase 2：自建 Agent Loop（完整落地的前提）

如果要在 Xuanpu 内部实现完整的上下文压缩，需要：

1. 基于 Anthropic API 自建 Agent loop（不通过 Claude Code SDK）
2. 自己维护 message[] 数组
3. 实现 Context Packer：每轮从 Event Log → Frozen Episodes → Working Set → 组装 prompt
4. 实现异步压缩 pipeline（versioned materialization）
5. 实现 Gated retrieval

这是一个 **中等规模的新子系统**（预估 3000-5000 行），需要：
- 新的 `src/main/context-packer/` 模块
- 新的 `src/main/async-compactor/` 模块
- 新的 `src/main/episodic-retrieval/` 模块
- 扩展 `field_episodic_memory` 表支持多段追加
- 新的 UI 面板（Context Budget Debugger 升级版）

### Phase 3：XFP 协议化

如果 Phase 2 验证成功，将 Context Packer 的接口标准化为 XFP 协议的一部分，让其他 Agent 可以适配。

## 七、总结

| 维度 | 评估 |
|------|------|
| 方案方向 | ✅ 完全正确 |
| 与 Xuanpu 定位匹配度 | ✅ 极高（"Agent 现场提供者"→"上下文宿主"是自然演进） |
| 现有基础设施 | ⚠️ 40% 就绪（Event log、Token tracking、Memory 三层、Field Context、Pinned Facts 都是现成的） |
| 最大障碍 | ❌ Xuanpu 不控制 Agent SDK 内部 message list |
| 解决最大障碍的成本 | 🔴 需要自建 Agent loop（中等规模工程，3-5K 行） |
| MVP 建议 | 🟢 先做 Phase 0（Context Budget Debugger），再评估是否投入 Phase 2 |
| 差异化价值 | ✅ 如果做成，Xuanpu 从"工具"升级为"基础设施" |

## 八、破局路径：基于开源 Agent Runtime 自建 Xuanpu Agent

> 本章分析"能否基于开源 Claude Code 变体开发 Xuanpu Agent"，以解决第四章中"不控制 Agent SDK 内部 message list"的根本性矛盾。

### 8.1 候选项目概览

| 项目 | Stars | 语言 | 定位 |
|------|-------|------|------|
| [claude-code-best/claude-code](https://github.com/claude-code-best/claude-code) (CCB) | 18.7K | TypeScript (Bun) | Claude Code CLI 反编译/逆向还原，完整 TUI 应用 |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | 6.6K | TypeScript + Rust (~27K 行 Rust) | Pi Agent 增强分支，npm 包化设计 |
| [Dicklesworthstone/pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust) | 1.0K | Rust | Pi Agent 纯 Rust 重写，单二进制 |
| [lorryjovens-hub/claude-code-rust](https://github.com/lorryjovens-hub/claude-code-rust) | 1.6K | 标注 Rust 实为 TS | 信息不足，license 为空，不建议 |

### 8.2 核心发现：oh-my-pi 的两个钩子恰好是 Context Packer 所需的拦截点

这是整个可行性分析最关键的一点。oh-my-pi 的 `Agent` 类（`packages/agent/src/agent.ts`）暴露了两个 hook：

```typescript
export interface AgentOptions {
  /**
   * 在 convertToLlm 之前对上下文进行变换。
   * 用于上下文剪枝、注入外部上下文等。
   */
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal
  ) => Promise<AgentMessage[]>;

  /**
   * 每次 LLM 调用前将 AgentMessage[] 转换为 LLM Message[]。
   * 默认只过滤 user/assistant/toolResult。
   */
  convertToLlm?: (
    messages: AgentMessage[]
  ) => Message[] | Promise<Message[]>;
}
```

这两个钩子与 Xuanpu Context Packer 的映射关系：

```
每轮 LLM 调用前:

  oh-my-pi 内部 AgentMessage[]
        │
        ▼
  transformContext(...)    ← Xuanpu Context Packer 在此注入
    ├── 从 field_events 加载原始事件
    ├── 生成 Frozen Episodes（追加到 messages）
    ├── 裁剪 Working Set（保留最近 N 轮原文）
    ├── 注入 Pinned Facts / memory.md（Anchor Zone）
    └── 注入 Field Context（当前现场信息）
        │
        ▼
  convertToLlm(...)       ← Xuanpu 控制最终发送格式
    ├── 将 Xuanpu 自定义 message 类型转为 LLM user message
    ├── 按 Prompt Cache 友好顺序排列消息
    └── 返回标准 Message[] 给 LLM API
        │
        ▼
  streamSimple(messages)  ← 发给 Anthropic / OpenAI / 40+ providers
```

oh-my-pi 区分了 **`AgentMessage`**（内部表示，支持自定义类型如 compactionSummary、branchSummary、custom）和 **`Message`**（LLM 协议兼容类型：user / assistant / toolResult）。Xuanpu 可以在 `AgentMessage` 层面插入自己的消息类型（如 `frozenEpisode`），在 `convertToLlm` 中转换为标准格式——这个双层设计直接对应方案的"上下文物化视图"理念。

### 8.3 oh-my-pi 架构与方案需求的对照

| 方案需求 | oh-my-pi 现状 | 对齐度 |
|---------|-------------|--------|
| **Session Entry 模型** | `CompactionEntry` / `BranchSummaryEntry` / `CustomMessage` 是 first-class entry（`compaction/entries.ts`） | 直接对应 Frozen Episode |
| **Compaction Pipeline** | 4 种触发：手动 `/compact`、overflow 自动恢复、阈值自动维护、idle 维护 | 增加 per-turn 触发是配置级改动 |
| **Working Set 保留窗口** | `keepRecentTokens` + `firstKeptEntryId`，最近 N 轮原文保留不压缩 | 直接对应方案 Zone 3 |
| **压缩摘要格式** | 已有 compaction-summary / short-summary / handoff-document 三种 prompt 模板 | 可复用，增加 Episode 结构化模板 |
| **Memory 系统 (Hindsight)** | per-session 提取 → cross-session 合并 → 启动时注入 `memory_summary.md` | 对应方案 Semantic Memory 层 |
| **文件追踪** | `CompactionDetails` 自动追踪 readFiles / modifiedFiles | 可用于 Episode 结构化字段 |
| **Append-only 设计** | Compaction 生成新 entry 追加到末尾，旧 entry 不修改 | 符合 Prompt Cache 兼容要求 |
| **Token 计量** | `countTokens` native 函数 + `tokensBefore` 记录 | 已有基础设施 |
| **多 Provider** | 40+ 模型供应商（Anthropic / OpenAI / Gemini / Grok / 等） | 远超当前 Xuanpu 的 provider 覆盖 |

### 8.4 CCB（claude-code-best）为什么不太适合

CCB 是 Claude Code CLI 的反编译产物——它是一个**完整的独立 TUI 应用**，不是 library：

- Agent loop 与 TUI/CLI 框架（Ink/React）深度耦合
- 没有暴露类似 `transformContext` / `convertToLlm` 的 hook
- 要从中提取出 Xuanpu 可用的 Agent runtime，本质上等于做一次架构级解耦，工作量和风险远超 oh-my-pi 方案
- CCB 的优势在于其 compaction 三层体系（MicroCompact → Session Memory Compact → API 摘要）更成熟，可**作为设计参考**，但不需要直接 fork

### 8.5 推荐集成架构

```
Xuanpu (Electron main process)
  │
  ├── Field Context Builder    (已有)  ──→ 现场信息
  ├── Event Log (field_events) (已有)  ──→ 原始事件流
  ├── Episodic Compactor       (已有)  ──→ 压缩摘要 → 可改造为 Frozen Episode 生成器
  ├── Pinned Facts / memory.md (已有)  ──→ Anchor Zone
  │
  ├── [NEW] Context Packer ──────────────→ 每轮装配上下文
  │     ├── Anchor Zone Builder         (复用 Pinned Facts + memory.md)
  │     ├── Frozen Episode Manager      (复用 Episodic Compactor，改为追加式)
  │     ├── Working Set Manager         (利用 transformContext 裁剪)
  │     └── Gated Retrieval             (利用 Xuanpu 的 SQLite 事件流)
  │
  └── oh-my-pi Agent (嵌入为 npm library, 非 subprocess)
        │
        ├── transformContext ← Context Packer 在此注入
        ├── convertToLlm     ← 控制最终 Message[]
        │
        └── Anthropic API / OpenAI / Gemini / 40+ providers
```

与当前 Claude Code SDK 方案的关键区别：

| | 当前（Claude Code SDK） | 新方案（oh-my-pi library） |
|---|---|---|
| Agent 形态 | 独立 subprocess | 嵌入主进程的 npm 包 |
| 消息控制 | SDK 内部黑盒 | Xuanpu 完全控制 Message[] |
| Context 裁剪 | 不可行 | `transformContext` 中实现 |
| 压缩触发 | SDK 自动 / 用户手动 `/compact` | Xuanpu 控制 per-turn 触发 |
| 工具生态 | Claude Code 内置工具 | oh-my-pi 32 工具 + MCP |
| 模型支持 | Anthropic | 40+ providers |

### 8.6 风险和注意事项

1. **oh-my-pi 的 compaction 是阈值触发的，不是 per-turn 的。** 但它的 pipeline 已有 4 种触发模式，而且 Xuanpu 可以在 `transformContext` 中**主动做压缩**，不依赖 oh-my-pi 内置的 compaction 逻辑。oh-my-pi 的 compaction 可以作为 fallback 或互补机制。

2. **包装 vs Fork 的选择。** 建议两个阶段：
   - **验证阶段**：直接依赖 npm 包 `@oh-my-pi/pi-agent`，只在 `transformContext` / `convertToLlm` 中实现 Context Packer 逻辑。如果钩子够用就不 fork。
   - **深度阶段**：如果发现钩子粒度不够（比如需要在 tool execution 层面做分类压缩），再考虑 fork `packages/agent/` 做深度改造。oh-my-pi 是 MIT 协议，fork 无法律风险。

3. **工具生态差异。** oh-my-pi 有 32 个工具（hashline edit、ast_edit、LSP、DAP、browser 等），Xuanpu 当前通过 Claude Code SDK 获得类似的工具能力。切换到 oh-my-pi 后需要评估工具覆盖度。可能的差异：
   - oh-my-pi 有的、Claude Code 没有的：LSP rename、DAP debugger、haseline edit、ast_edit preview、conflict:// 协议
   - Claude Code 有的、oh-my-pi 可能没有的：部分 MCP 工具的兼容性需要验证

4. **oh-my-pi 的 Rust 核心**（`crates/` 目录）负责性能敏感部分（token counting、ripgrep in-process、LSP client），Xuanpu 不需要改这部分，直接受益于其性能优势。

5. **Prompt Cache 友好性已验证。** oh-my-pi 的 compaction 已经是 append-only 模式（新 CompactionEntry 追加，旧 entry 不修改），这对 Anthropic 的 prefix cache 天然友好。Xuanpu 在 `convertToLlm` 中只需要保证稳定内容（Anchor Zone + Frozen Episodes）排在动态内容（Working Set）前面即可。

6. **关于 pi_agent_rust 的说明。** 它是 oh-my-pi 在 Pi 系谱中的"表亲"——同样源于 Pi 但独立演进。它的优势是纯 Rust 单二进制（性能极致），但缺少 compaction/memory 基础设施。如果未来 Xuanpu 需要极致的启动性能或更小的资源占用，可以作为长期演进的参考方向。

### 8.7 结论

**基于 oh-my-pi 开发 Xuanpu Agent 完全可行，且是目前最务实的路径。**

它解决了第四章中"不控制 Agent SDK 内部 message list"的根本性矛盾——`transformContext` + `convertToLlm` 双重钩子恰好提供了实现 Context Packer 所需的全部拦截点。同时 MIT 协议、活跃开发（每日更新）、npm 包化设计、40+ provider 支持、成熟的 compaction/memory 基础设施都使得它作为基座的综合成本最低。

**不建议**基于 CCB 或 pi_agent_rust：前者是反编译 TUI 应用、架构改造难度大；后者缺少 compaction/memory 基础设施。

### 8.8 建议的验证步骤

```
Step 1: pnpm add @oh-my-pi/pi-agent (或 bun add) 到 Xuanpu 主进程
Step 2: 用 oh-my-pi Agent 替代一个 Codex session 的简单 prompt 调用
Step 3: 在 transformContext 中实现最小 Context Packer:
        - 保留最近 6 轮 Working Set
        - 第 7 轮之前的内容用 Haiku 压缩为一个 Frozen Episode
        - 注入 Pinned Facts 和 memory.md 作为 Anchor
Step 4: 在 convertToLlm 中按 Cache 友好顺序组装
Step 5: 对比"原生 Claude Code"和"Xuanpu + oh-my-pi + Context Packer"的成本和回答质量
```

验证通过后再决定是继续包装使用还是 fork 改造 `packages/agent/`。

---

## 九、压缩模型策略：要不要带本地小模型？

### 9.1 "Summary Tax"的实际量级

先锚定一个数字。方案的成本核算中，100 轮 session 每轮用 Haiku 做 5K→1K 压缩的总成本约 **$0.25**。折合每轮 **$0.0025**。这意味着压缩的模型成本不是主要矛盾——**压缩质量才是**。一次关键约束的丢失导致 Agent 写出 bug 代码，用户花 5 分钟修复，这 5 分钟的成本远超 $0.25。

### 9.2 本地小模型的真实问题

| 维度 | 本地小模型 (Qwen 3B / Llama 3.2 3B) | Haiku / Gemini Flash |
|------|--------------------------------------|---------------------|
| **结构化输出可靠性** | 差。对 JSON Schema 严格格式的遵循度低，容易丢字段或自行发挥 | 好。对结构化 prompt 的遵循度高 |
| **否定约束保留** | 高风险。`"不要改 auth.ts"` 容易被压成 `"讨论了 auth.ts"` | 低风险（配合 audit pass 基本可保） |
| **代码符号保真** | 容易幻觉出错误的函数名、行号、变量名 | 很少幻觉代码级符号 |
| **延迟** | 本地推理 ~1-3s（有 GPU 时 <500ms） | 网络 RTT ~1-3s |
| **成本** | 0（但占用内存/显存 2-4GB） | ~$0.0025/轮（100 轮 $0.25） |
| **工程投入** | 高。需要绑推理引擎 + 跨平台 GPU 适配 | 低。HTTP POST |
| **包体积影响** | 量化模型文件 2-4GB | 0 |

对 Xuanpu 的核心场景（Coding Agent 上下文压缩），**压缩质量的底线是"不能比未压缩更差"**。如果压缩后的摘要丢失了关键约束导致 Agent 行为退化，那压缩就产生了负价值。在这一点上，Haiku/Flash 远优于当前可用的本地小模型。

### 9.3 分层策略：不是所有内容都需要 LLM

```
Layer 0: 确定性提取（不需要任何模型）
  ├── 文件路径、命令、退出码、stderr 首尾
  ├── diff 的 hunk 范围 + 涉及文件列表
  ├── 用户 reject / abort / crash 事件
  └── 状态：Xuanpu 的 RuleBasedCompactor 已覆盖此层

Layer 1: 分类器（规则引擎，不需要模型）
  ├── "本轮用户输入是否需要历史上下文？"
  ├── 关键词匹配: "之前/上次/那个方案/还记得" → 触发召回
  └── 短指令匹配: "好的/继续/跑测试/提交" → 不触发召回

Layer 2: 轻度 LLM 压缩（需要模型，但输入量小）
  ├── 自然语言对话 → 提炼为决策记录（Decision Record）
  ├── 用户意图 → 提炼为结构化 goal / open question
  └── 否定约束 → 提升为 Pinned Facts candidate（原样保留或高亮标记）

Layer 3: 质量审计（同一模型做 second pass，可选）
  └── "以下约束/决策在摘要中是否被遗漏？列出遗漏项。"
```

- **Layer 0 + Layer 1 不需要任何模型**，实现为零依赖的纯代码逻辑。
- Layer 2 输入量小（只压缩自然语言部分，代码块/工具调用保原文），输出为结构化 JSON Schema。
- Layer 3 是可选的兜底，成本是 Layer 2 的 ~20%。

### 9.4 压缩模型的配置：三级降级链路

核心设计原则：**90% 用户零额外配置，高级用户可自定义，所有人有 fallback。**

```
Level 1: 用户显式配置的压缩专用模型
  settings.compactionModel = {
    url: "...",
    key: "...",
    modelId: "claude-haiku-4-5"
  }
  适用：需要精确控制成本的团队/企业用户

Level 2: 复用 Agent session 的 provider
  如果 Agent 用的是 Anthropic → 压缩自动用同一 key 调 Haiku
  如果 Agent 用的是 OpenAI   → 压缩自动用 gpt-5.1-nano / gpt-5-flash
  如果 Agent 用的是 Gemini    → 压缩自动用 gemini-2.5-flash
  适用：大多数用户（已有 Agent key，零额外配置）

Level 3: Xuanpu 内置 RuleBasedCompactor
  如果没有任何可用的 LLM（终端 session / 未配 key 的 Codex）
  → 降级到确定性提取，只做 Layer 0
  适用：所有用户的兜底保障
```

**不需要捆绑模型。**

### 9.5 要不要支持用户配置本地 Ollama？

**作为可选项，值得支持。** 但不是 Xuanpu 捆绑模型，而是让用户自己配置 Ollama endpoint：

```yaml
compactionModel:
  url: http://localhost:11434/v1
  key: ollama
  modelId: qwen3:4b
```

oh-my-pi 已原生支持 OpenAI 兼容的 API 协议，Ollama 的 `/v1` 端点完全兼容，所以这个能力**天然可用**，不需要额外开发。Xuanpu 只需要在设置 UI 里提供一个"压缩模型配置"入口即可。

### 9.6 结论

| 问题 | 结论 |
|------|------|
| 是否需要捆绑本地小模型？ | **否。** 包体积 2-4GB + 跨平台 GPU 适配 + 压缩质量风险，投入产出比不划算 |
| 是否支持用户自配本地模型？ | **是。** ollama 兼容 OpenAI 协议，天然支持，零额外开发 |
| 用户必须提供压缩模型吗？ | **否。** 三级降级确保 90% 用户零配置，100% 用户有 fallback |
| 默认压缩用什么模型？ | **复用 Agent 的 provider 的最便宜模型**（Anthropic key → Haiku，OpenAI key → nano，Gemini key → flash） |
| 为什么不用更便宜的本地模型？ | 压缩质量的底线是"不引入错误"。Haiku 的 $0.0025/轮 在工程上比 本地模型 0 成本 + 高风险 更划算。**压缩成本不是瓶颈，压缩质量才是。** |
