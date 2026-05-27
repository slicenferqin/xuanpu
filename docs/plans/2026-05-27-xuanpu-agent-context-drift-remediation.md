# xuanpu-agent 上下文稳态漂移审计与修复方案

日期：2026-05-27
分支：`feat/xuanpu-agent-oh-my-pi`
面向读者：继续实现 `xuanpu-agent` 的 agent / reviewer

本文是当前 `xuanpu-agent` 上下文稳态工作的修正基线。它不替代
`2026-05-27-xuanpu-agent-progress-and-roadmap.md`，但覆盖其中已经被实现漂移证明不准确的
“M0-M6 已完成 / production-ready”类结论。

## 结论

当前不能放行 `xuanpu-agent` 的上下文稳态能力为 production-ready。

2026-05-27 M7 CR 后结论：M7 **未通过验收**。本轮实现加入了若干有用的局部构件，
但没有解决最关键的 active prompt 控制权问题。`xuanpu-agent` 主执行路径仍然通过
`buildMessages(packet, appendOnlyLog, text)` 把 XFP packet 和 priorTurns 交给 runtime，
Context Packer 没有成为 `piSession.prompt()` 前的唯一装配入口。

可以相对放心声明的能力：

- 命令输出压缩 / 归档已经有可用基础。
- 受控工具、field tools、memory proposal、checkpoint、claim verifier、harness metrics 等局部能力有实现与测试。
- M7 新增的 `FieldTurn.messageId`、episode metadata schema、compaction model resolver、
  model summarizer、settings 中的 compaction model 字段可以作为后续修复起点。

不能声明完成的能力：

- 稳态上下文管理。
- 自动模型摘要压缩。
- Context Budget 作为“模型实际看到什么”的黑盒记录器。
- prefix cache 稳态。
- xuanpu-agent 侧完整 tool-call repair 四件套。

核心问题不是缺一个 UI 或一个表，而是实现把若干审计/展示/局部模块当成了真实上下文控制。真实送进
`agent.prompt()` 的 messages 仍没有按设计文档的 Context Packer 闭环生成。

## 需求基线

后续实现必须回到这些文档的共同约束：

- `docs/architecture/xuanpu-agent-architecture.md`
  - 单轮链路：XFP compiler -> gated retrieval -> Context Packer -> runtime -> tool repair -> Episode Freezer -> Context Budget。
  - 旧 Working Set 轮次必须 freeze 成 episode，并从 active prompt 移除。
  - episode freeze 应使用轻量模型生成结构化摘要，RuleBased 只能兜底。
- `docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.md`
  - Context is compiled, not appended.
  - Context Budget 是 agent 到底看了什么的黑盒记录器。
  - Large context windows are a fallback, not a goal.
- `docs/plans/2026-05-23-xuanpu-agent-oh-my-pi-runtime.md`
  - 默认上下文区：Anchor / Frozen Episodes / Retrieved Episodes / Working Set / Current Field。
  - Balanced 应落在 80K-150K，200K 是 hard cap，不是目标。
  - compaction model resolution：显式压缩模型 -> 主模型 provider 的便宜模型 -> RuleBased。
- `docs/architecture/xuanpu-agent-invariants.md`
  - 每个非平凡 section 必须有 raw refs。
  - `buildMessages()` / Context Packer 必须保证 cache-friendly 顺序。
  - Context Budget 必须 durable、可追溯、跨 runtime。
  - tool repair 必须可观测并进入 Context Budget。
- `docs/plans/2026-05-25-reasonix-comparison-and-borrowings.zh-CN.md`
  - 40%/80% shrink 必须走 XFP packet rebuild，不是裸 prompt 截断。
  - prefix hash / cache hit / auto-compaction trigger buckets 都是 M3-M6 需要复盘的指标。

## 当前真实链路

当前主链路大致是：

```text
prompt()
  -> FieldProvider.getPriorTurns()
  -> XfpPacketCompiler.compile()
  -> new SessionAppendOnlyLog(priorMessages, packetId)
  -> buildMessages(packet, appendOnlyLog, userText)
  -> piSession.prompt(harnessMessages, modelRef)
  -> createContextPackage(...)  // after model response
  -> freezeOldConversationTurns(...)
```

这导致两个事实：

1. `buildMessages()` 返回的是 `XFP packet + 全量 priorTurns + currentRequest`。
2. `createContextPackage()` 和 episode retrieval 是模型调用后才记录/计算的，不能代表模型实际看到的上下文。

只要这两个事实存在，Context Budget 就不能叫黑盒记录器，episode retrieval 也不能算 active prompt 的一部分。

## 2026-05-27 M7 CR 结果

CR 基线：mimo 声称完成 M7 后的当前工作树。

已验证：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-context-packer.test.ts \
  test/phase-24/xuanpu-agent-context-package.test.ts \
  test/phase-24/xuanpu-agent-compaction-model.test.ts \
  test/phase-24/xuanpu-agent-episode-summarizer.test.ts \
  test/phase-24/xuanpu-agent-soft-shrink.test.ts \
  test/phase-24/xuanpu-agent-runtime.test.ts \
  test/phase-24/xuanpu-agent-ipc-smoke.test.ts

pnpm vitest run \
  test/phase-24/xuanpu-agent-auto-freeze.test.ts \
  test/phase-24/field-episode-block-repository.test.ts \
  test/phase-24/xuanpu-agent-context-transform.test.ts

pnpm build
```

结果：

- Focused M7 tests 通过：7 files / 46 tests。
- 追加 freeze/schema/context-transform tests 通过：3 files / 10 tests。
- `pnpm build` 通过。
- 这些结果只能证明新增模块和局部测试自洽，不能证明 M7 达成目标。

CR findings：

| Finding | 严重级别 | 证据 | 影响 | 处理要求 |
| --- | --- | --- | --- | --- |
| M7-CR-1 active prompt 仍未走 Context Packer | P0 | `xuanpu-agent-implementer.ts` 仍在主路径调用 `buildMessages(compileResult.packet, appendOnlyLog, text)` 后传给 `piSession.prompt()` | 旧漂移 D1 未修，模型仍可能看到全量 priorTurns | 用 `packContext()` 取代该主路径；测试必须 spy `piSession.prompt()` 入参 |
| M7-CR-2 `context-transform.ts` 的 packer path 不覆盖 harness path | P0 | `buildXuanpuAgentPromptMessages()` 中 `harnessContext` 分支优先走 `buildHarnessMessages()`；新增 packer 分支只有传 `episodeRecords + workingSet` 才触发 | 测试能过，但真实 harness path 不变 | 删除或重写 harnessContext 的 full-log path，让 harness 也走 packer |
| M7-CR-3 Context Package 仍是 response 后重算 | P0 | `createContextPackage()` 内部仍调用 `field.retrieveEpisodes(userText, episodeCandidates, priorMessages, ...)` | Context package 仍不能代表模型实际所见 | `createContextPackage()` 改为消费 `ContextPackerOutput`，禁止内部二次 retrieval |
| M7-CR-4 `freezeEpisodes()` pre-flight 使用 stale priorMessages | P0 | `prompt()` 先读取 `priorMessages`，随后 pre-flight freeze，再用旧的 `priorMessages` 创建 `SessionAppendOnlyLog` | 即使 freeze 成功，本轮 prompt 仍可能包含刚被冻结的 raw turns | freeze 后重新读取 turns，或彻底改为 packer 基于 rawRefs 去重 |
| M7-CR-5 model summarizer fallback 可能重复落库 | P0 | `summarizeEpisode()` fallback 调用 `createRuleBasedEpisodeFromTurns()`，该函数会直接 `createFieldEpisodeBlock()`；`IdeFieldProvider.freezeEpisodes()` 随后又 `createFieldEpisodeBlock(episode)` | RuleBased fallback 路径会写入重复 episode block | 拆出纯 `buildRuleBasedEpisodeFromTurns()`，summarizer 只返回 create data，不落库 |
| M7-CR-6 compaction metadata 未写入 | P1 | `field_episode_blocks.metadata_json` 加了列，但 `summarizeEpisode()` model 成功和 fallback 都没有填 `compactorKind/providerId/modelId/promptVersion/fallbackReason` | 摘要不可审计，无法判断 model vs rule-based | summarizer 所有路径必须填 provenance |
| M7-CR-7 soft shrink 仍不是真 offload/repack | P1 | `ContextBudgetManager` 注释和代码仍写 40% no-op；`context-packer` 只是按 zone budget 选择内容 | 没有 40% 主动 freeze/offload/repack 行为 | 实现 fillRatio>=0.4 触发 freeze/repack，并持久化 omitted decisions |
| M7-CR-8 budget profile 仍是 150K/300K/500K | P1 | `context-packer.ts` 默认 300K；`budget-manager.ts` 仍是 150K/300K/500K | 与 80K-150K Balanced 设计冲突 | 先拍定 canonical budget，然后统一 compiler/packer/manager/tests |
| M7-CR-9 retrieved episodes 没进 packer | P1 | `packContext()` 只有 `frozenEpisodes`，没有 `retrievedEpisodes` 入参和 retrieval reason | 用户显式提历史时，召回仍只在 package 里，不在 active prompt | packer 输入拆分 frozen/retrieved，并记录 reasons |
| M7-CR-10 explicit compaction model 不可用时静默降级 | P2 | `resolveCompactionModel()` 对显式模型 probe 失败后直接走 provider-default/fallback | 用户以为用的是显式模型，实际不是 | resolution 返回 degraded reason，并进入 Context Budget / episode metadata |
| M7-CR-11 Settings UI 使用硬编码中文且未进 i18n | P2 | `SettingsModels.tsx` 新增 “压缩模型 / 自动 / 当前：自动推导” 硬编码 | 破坏现有 i18n 约定 | 补 `messages.ts` 文案并通过 `t()` 调用 |

当前 M7 状态判定：

| 子项 | 状态 | 说明 |
| --- | --- | --- |
| M7.0 冻结对外 claim | 未完成 | 需要同步 roadmap/handoff/UI 状态口径 |
| M7.1 唯一 Context Packer active path | 未完成 | 最大 P0，主路径仍是 `buildMessages()` |
| M7.2 Context Package 从 packer 派生 | 未完成 | 仍 response 后重算 retrieval |
| M7.3 双模型配置与 summarizer | 部分完成 | settings/resolver/summarizer 有草稿，但 fallback/metadata/主模型来源仍有问题 |
| M7.4 40%/80% shrink | 未完成 | 40% 仍 no-op，80% 仍是 emergency 裁剪 |
| M7.5 prefix/cache 稳态 | 未完成 | 无 prefixHash，无 stable/volatile split |
| M7.6 长会话 dogfood | 未完成 | 当前测试未证明长会话 active prompt 稳态 |

因此：M7 不能标 done，只能标 `partial implementation, CR failed on active-context invariants`。

## 漂移清单

| ID | 严重级别 | 需求 | 当前实现漂移 | 必须修复到 |
| --- | --- | --- | --- | --- |
| D1 | P0 | Context Packer 是 active prompt 唯一装配入口 | `buildMessages()` 仍直接 append 全量 log | `packContext()` 先于模型调用执行，`piSession.prompt()` 只接收 packer 输出 |
| D2 | P0 | Context Budget 记录模型实际所见 | `createContextPackage()` 在 response 之后重算 retrieval | Context package / Context Budget 从同一个 `ContextPackerOutput` 派生 |
| D3 | P0 | 旧轮次 freeze 后从 Working Set 移除 | `SessionAppendOnlyLog.toMessages()` 全量返回 priorTurns | `FieldTurn` 必须携带 messageId，packer 用 episode rawRefs 去重 |
| D4 | P0 | 历史摘要由轻量模型生成，RuleBased 兜底 | episode block 主要由 `createRuleBasedEpisodeFromTurns()` 生成 | 引入 compaction model resolver + model summarizer + provenance metadata |
| D5 | P0 | 至少主模型和摘要模型两个模型配置 | settings 中有字段草稿，但主进程未闭环消费 | renderer 设置、持久化、IPC/main、runtime resolver 全链路打通 |
| D6 | P0 | 40% soft shrink 可用，80% emergency 是兜底 | 40% no-op，80% 裁 tool/assistant 文本 | 40% 触发 offload/repack，80% 只做最后降级并显式记账 |
| D7 | P1 | Anchor / prefix 稳定，packet 有 prefixHash | packet 每轮含 capturedAt，anchor `updatedAt` 可变，整包作为一个 user blob | stable prefix 与 volatile field 拆段，计算并展示 prefixHash |
| D8 | P1 | Context Budget durable / cross-runtime | 当前 recorder 是内存 Map，且只覆盖 harness 局部 | 持久化 per-turn budget record，后续接 Codex/Claude/OpenCode |
| D9 | P1 | tool repair 四件套可观测 | 目前主要只有 storm + output truncation | flatten / scavenge / JSON truncation / storm 均有事件、开关、预算记录 |
| D10 | P1 | 错误 taxonomy 有策略闭环 | enum 有了，TIMEOUT/BUDGET/RUNTIME 等处理不足 | retry/offload/feedback/reconnect 按 invariants 落实 |
| D11 | P2 | Gated retrieval 避免误召回 | historical/short referential 可能给所有 episode 加分 | 加 working-set-insufficient 判断和 overlap 下限 |
| D12 | P2 | 不过度声明 MCP/subtask | 当前是 MCP-like field tools，subtask 是 extraction pass | 产品/文档中只声明 scoped field tools / synthetic subtask |

## 当前 M7 草稿的审计要求

当前工作树里已经出现了一些 M7 草稿文件，例如：

- `src/main/services/xuanpu-agent/context/context-packer.ts`
- `src/main/services/xuanpu-agent/context/compaction-model.ts`
- `src/main/services/xuanpu-agent/context/episode-summarizer.ts`

这些文件可以作为起点，但不能仅因存在就视为完成。继续实现时必须重点审计：

1. `context-packer.ts` 是否真的替换了 `buildMessages()` 的 active path，而不是只被测试或 legacy path 调用。
2. packer 是否同时支持 `frozenEpisodes` 和 `retrievedEpisodes`，并记录 included / omitted / raw refs / reasons。
3. Balanced budget 是否仍错误使用 300K。除非设计重新拍板，否则应按 80K-150K 实现。
4. `compaction-model.ts` 的显式模型不可用时，不能静默降级；必须产生 degraded reason，Context Budget 可见。
5. `episode-summarizer.ts` 不能在“生成 block create data”和“直接落库 record”之间混用接口。
6. model summarizer fallback 必须记录 provenance：`compactorKind`、`providerId`、`modelId`、`promptVersion`、`fallbackReason`。
7. packer 决策必须进入 `field_context_packages` / Context Budget，并且测试要验证 `piSession.prompt()` 实际收到的 messages。

## M7：上下文稳态修复计划

M7 的目标不是再堆功能，而是把“真实 prompt 控制权”收回来。

### M7.0：冻结对外 claim

先改状态口径，不继续误导后续开发：

- `xuanpu-agent`：experimental / dogfood。
- RTK/命令压缩：可标局部 production-ready。
- Context steady-state：not ready。
- Auto model compaction：not ready。
- Context Budget black-box recorder：not ready。
- MCP：只读 scoped field tools，不是外部 MCP integration。
- Subtask：timeline-visible synthetic subtask，不是真 child agent。

验收：

- README / handoff / roadmap 中不再出现 “M0-M6 全部完成即可放行” 的表述。
- Session HQ 如展示能力状态，必须区分 partial / experimental / ready。

### M7.1：建立唯一 Context Packer active path

新增或修正 `ContextPacker`，并让它成为模型调用前唯一入口：

```text
CompilerResult + FieldSnapshot + EpisodeCandidates + MemoryRetrieval + PriorTurns + CurrentRequest
  -> ContextPacker.pack(...)
  -> { messages, decisions, contextPackageSections, budgetRecord }
  -> piSession.prompt(messages, modelRef)
```

实现要求：

- `FieldTurn` 必须包含稳定 `messageId`。
- old turns 选择必须基于 Working Set 预算，而不是全量 append。
- 被 episode raw refs 覆盖的 messageId 不得再进入 Working Set 原文。
- current request 永远最后，且不可被压缩。
- packer output 必须包含：
  - actual prompt message ids / zone names
  - included sections
  - omitted sections
  - dropped old turn ids
  - retrieved episode ids and reasons
  - raw refs
  - estimated tokens
  - fill ratio

验收测试：

- 构造 20 轮对话，前 12 轮已 frozen，实际传给 `piSession.prompt()` 的 messages 不包含这些 raw turn 文本。
- 当前 user message 是最后一条。
- Context package 记录的 included/dropped 与 actual messages 一致。
- 不允许测试只断言 repository 写入，必须 spy `piSession.prompt()` 入参。

### M7.2：Context Package 从 packer output 派生

修正 `createContextPackage()` 的职责：

- 不能在 response 之后重新做 episode retrieval。
- 不能生成和实际 prompt 不一致的 section。
- 只能接收 `ContextPackerOutput`，把其 decisions/rendered sections 落库。

建议接口：

```ts
interface ContextPackerOutput {
  messages: XuanpuPiPromptMessage[]
  sections: FieldContextPackageSection[]
  decisions: ContextPackerDecision[]
  budgetRecord: ContextBudgetRecord
}
```

验收：

- `field_context_packages.sections` 中的 retrieved episodes 与 active prompt 中的 retrieved episode 文本一致。
- package 中的 omitted turn ids 能在 session messages 里找到。
- package 里不能出现 “model did not see but package says included” 的 section。

### M7.3：双模型配置与 episode model summarizer

新增 compaction model 全链路：

```text
settings.xuanpuAgentCompactionModel
  -> persisted app settings
  -> main process selected compaction model
  -> resolveCompactionModel(mainModelRef, explicitCompactionModel)
  -> summarizeEpisode(...)
  -> field_episode_blocks metadata
```

resolution 顺序：

1. 用户显式配置的 compaction model。
2. 当前主模型 provider 的便宜模型：
   - Anthropic -> Haiku
   - OpenAI -> mini / nano 级别
   - Gemini -> Flash
3. RuleBased fallback。

数据要求：

- `field_episode_blocks` 增加 metadata 字段或等价列：
  - `compactorKind`: `model | rule-based`
  - `providerId`
  - `modelId`
  - `promptVersion`
  - `fallbackReason`
  - `sourceMessageIds`
- model summary 只负责 intent / decision / open-task prose。
- files / commands / failures / constraints 仍用确定性 extractor 校验或合并，不能完全相信模型。

验收：

- 显式 compaction model 可配置、可保存、重启后仍存在。
- 主模型为 OpenAI 时，compaction resolver 不默认继续用主模型本身。
- summarizer 失败时落 RuleBased，但 metadata 标明 fallback。
- 无 raw refs 的 summary 不能写入 episode block。

### M7.4：40% soft shrink 和 80% emergency shrink

soft shrink 不是裁剪字符串，而是主动 offload/repack：

```text
fillRatio >= 0.4
  -> select oldest Working Set segment
  -> summarize/freeze episode
  -> rebuild ContextPacker output
  -> record omitted old turns + new episode raw refs
```

emergency shrink 只在 soft shrink 无法完成或模型/DB失败时兜底：

```text
fillRatio >= 0.8
  -> try offload/repack
  -> if impossible, bounded emergency prune
  -> persist explicit degraded decision
```

验收：

- 40% 场景下 `shrinkCount` 增加，且 active prompt 的 old turns 减少。
- 80% 场景不得静默裁 assistant text；如果 emergency prune，Context Budget 必须有 degraded reason。
- command traces / episode raw refs 可追回被移除的原始内容。

### M7.5：prefix/cache 稳态

把当前“整包 JSON 作为一个 user message”的形态拆开：

```text
Stable prefix:
  - system prompt
  - tool catalog
  - stable anchor / pinned facts / project rules
  - immutable frozen episodes

Volatile context:
  - git state
  - focus / terminal / tests
  - current working set
  - retrieved context
  - current request
```

实现要求：

- Anchor 在同一 task lifetime 内 byte-identical。
- packet 或 packer output 生成 `prefixHash`。
- provider usage 有 cache 字段时记录 cache hit ratio。
- 无 provider usage 时记录 `source: unavailable`，不能假装命中。

验收：

- 同一 session 两次无现场变化的 packer output，stable prefix hash 一致。
- git dirty/focus 变化只影响 volatile section。
- Session HQ / context package 能展示 prefixHash 和 cache source。

### M7.6：真实长会话验证

完成上述实现后，跑一个 long-session dogfood：

```text
1. 创建 xuanpu-agent session。
2. 连续 20-30 轮，包含 read/search/test/write 工具输出。
3. 中途触发至少一次 episode freeze。
4. 后续用“继续上次那个失败”触发 gated retrieval。
5. 检查 actual prompt、context package、Context Budget 三者一致。
```

最低验收：

- active prompt 不随轮次线性增长。
- frozen old turns 不再以 raw transcript 形式进入 prompt。
- “上次那个失败”能召回相关 episode。
- 无关历史不会每轮被召回。
- model answer 仍能引用正确文件和失败原因。

## M8：生产化加固

M7 只解决上下文稳态主链路。M8 再补治理层完整度：

- durable Context Budget 表，覆盖 xuanpu-agent / Codex / Claude Code / OpenCode。
- tool-call repair 四件套完整实现：
  - flatten / rehydrate
  - scavenge
  - JSON truncation repair
  - storm detector
- HarnessError policy 闭环：
  - TIMEOUT retry once
  - MALFORMED_TOOL_CALL feedback
  - BUDGET_EXCEEDED offload
  - RUNTIME_ERROR reconnect once
  - COMPRESSION_FAILURE fallback + visible trace
- UI 能力状态和调试面板：
  - actual context size
  - budget profile
  - retrieved episode reasons
  - omitted old turns
  - compaction model and fallback reason
  - prefixHash / cache source / hit ratio

## 禁止项

后续实现不要再做这些事：

- 不要只新增 package / metric / UI，但不改变 `agent.prompt()` 的实际 messages。
- 不要把 `field_context_packages` 当作 active context 的替代品。
- 不要把全量 priorTurns 继续交给 `SessionAppendOnlyLog.toMessages()`。
- 不要把 40% shrink 做成 no-op。
- 不要把 80% emergency 做成静默裁文本。
- 不要让模型摘要无 raw refs、无 provenance 地进入 memory / episode。
- 不要对外宣称 full MCP integration 或 real subagent delegation。
- 不要用 300K/500K 当默认稳态目标，除非先更新需求文档并说明取舍。

## 验收命令

实现阶段每个子里程碑至少跑 focused tests。最终 M7 合并前跑：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-context-packer.test.ts \
  test/phase-24/xuanpu-agent-context-package.test.ts \
  test/phase-24/xuanpu-agent-compaction-model.test.ts \
  test/phase-24/xuanpu-agent-episode-summarizer.test.ts \
  test/phase-24/xuanpu-agent-soft-shrink.test.ts \
  test/phase-24/xuanpu-agent-runtime.test.ts \
  test/phase-24/xuanpu-agent-ipc-smoke.test.ts

pnpm build
```

如果上述某些 test file 尚不存在，需要先补测试再实现。测试必须覆盖 actual prompt 入参，不允许只覆盖事后落库。

## 放行标准

只有满足以下条件，才允许把上下文稳态从 not ready 改为 ready：

- `piSession.prompt()` 实际收到的是 Context Packer 输出。
- Context Budget / context package 与 actual prompt 一致。
- 旧 raw turns 在 freeze 后不再进入 active prompt。
- retrieved episodes 在模型调用前决定并进入 prompt。
- compaction model 与 main model 可独立配置，且 fallback 可审计。
- 40% soft shrink 真实可用。
- 80% emergency shrink 有 degraded decision 和 raw refs。
- prefixHash/cache source 可记录。
- focused tests 和 `pnpm build` 通过。
