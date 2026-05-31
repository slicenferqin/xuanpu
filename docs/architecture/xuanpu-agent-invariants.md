---
日期: 2026-05-25
状态: 草案
关联分支: feat/xuanpu-agent-oh-my-pi
关联文档:
  - docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md
  - docs/plans/2026-05-24-xuanpu-agent-1.5.0-plan-review.md
  - docs/plans/2026-05-25-reasonix-comparison-and-borrowings.zh-CN.md
  - docs/plans/2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md
  - docs/architecture/xfp-packet-v1.md
代码: src/main/services/xuanpu-agent/xfp/{types.ts,schema.ts,fixtures.ts}
---

# xuanpu-agent Harness 不变量清单（INVARIANTS）

## 为什么需要 INVARIANTS

这份文档不是规划，是契约。

1.5.0 的主规划文档解释了「我们要做什么」，plan-review 解释了「我们为什么这么排
里程碑」，Reasonix 对比文档解释了「我们抄什么、不抄什么」。这些都是设计意图。

但 Reasonix 比我们密的地方在另一处：它在 `src/loop.ts` 里把不变量做进了代码。
`readonly` 字段、`buildMessages()` 单一出口、`appendAndPersist()` 单一写口，
这些不是注释里的建议，是类型系统和代码结构强制约束。规划再漂亮也会随时间漂，
代码里的不变量不会。

玄圃在 1.5.0「最后一公里」里要做同样的事：先把所有规划/代码里隐含的不变量提
取成可枚举、可 grep、可在 code review 时引用 ID 的清单，再回到代码里逐条对齐
（类型 / Zod / 运行时断言 / code review checklist）。

本文档的写作准则：
- 每条不变量必须能被 `grep INV-XXX-N` 命中
- 每条不变量必须是「短句、可执行、可证伪」
- 一旦发布，INV-* ID 不可重用（废弃只标 deprecated）
- 这是 M1 阶段产物，M2-M6 落地新功能时新增 INV-* 编号

## 不变量清单

### XFP Packet 不变量（INV-XFP-*）

- INV-XFP-1：每个 packet 必须有顶层字面量 `version`，v1 packets 必须 `version === 1`。schema 升级靠这个字段判别（types.ts:283 / schema.ts:206）。
- INV-XFP-2：每个非平凡 section（gitState / focus / terminal / tests / commandTrace / currentGoal / anchor）必须携带 `rawRefs: XfpRawRef[]`，无 raw refs 的总结不能进入 packet。
- INV-XFP-3：packet 必须由 packet compiler 生成。业务代码（IPC handler、UI store、runtime adapter）禁止手工拼接 `XfpFieldPacket`。compiler 是单一出口（呼应 Reasonix 的 `buildMessages()` 单一出口）。
- INV-XFP-4：packet 一旦被 compiler 返回即视为不可变（readonly 或 deepFreeze）。任何下游消费者（runtime / Session HQ / Context Budget）只读、不改、不补字段。
- INV-XFP-5：packet 在所有 trust boundary（IPC 入参、磁盘读、CLI stdin、跨进程消息）必须过 `XfpFieldPacketSchema.parse()` 或 `MinimalFieldPacketSchema.parse()`，不允许 `as XfpFieldPacket` 类型断言绕过。
- INV-XFP-6：每个 section 的 `@cacheStability` 注解必须如实反映其变化频率。`stable` 段在同一 task lifetime 内 byte-identical；`volatile` 段每轮可变；`mixed` 段由 compiler 按字段决策。
- INV-XFP-7：raw bytes 不内联——所有 raw refs 只放 pointer（id / byteRange / meta），consumer 需要原始字节时通过 pointer 拉取。
- INV-XFP-8：`MinimalFieldPacket` 不是 `Pick<XfpFieldPacket>`，是 structurally narrower 的独立类型。XfpFieldPacket → MinimalFieldPacket 必须经 `narrowToMinimal()`，反向转换不允许。
- INV-XFP-9：packet `identity.packetId` 在 packet 生命周期内是稳定 UUID，并被 log entry / Context Budget / audit trail 引用以追溯到本轮决策。

### Append-Only Log 不变量（INV-LOG-*）

- INV-LOG-1：历史消息一旦写入，不可修改、不可删除。唯一豁免是显式 episode freeze（把一段历史卸载成 episode block，原 log entry 保留 pointer）。
- INV-LOG-2：所有写入必须经过统一的 `appendAndPersist()` 入口。runtime / harness / tool 都不能直接 `log.push(...)` 或绕过该函数修改 SQLite。单一写口（呼应 Reasonix）。
- INV-LOG-3：每条 log entry 必须携带 `packetId` 引用，能追溯到当时的 XFP packet。失去 packet 引用的孤儿 entry 视为损坏。
- INV-LOG-4：log entry 顺序由写入序列决定，不允许按 timestamp 排序后改写顺序。即使时间戳乱（多机时钟），写入顺序也是真理。
- INV-LOG-5：log 写入是 fire-and-forget 不允许——必须等持久化成功（SQLite txn commit）才能返回，避免 in-memory log 与 durable log 不一致。
- INV-LOG-6：log 不存任何「待覆盖」「待 mutate」字段。一切修正都靠追加新 entry（compensating entry）+ 引用旧 entry 的 `supersedes` 字段表达。

### 缓存稳态不变量（INV-CACHE-*）

- INV-CACHE-1：Anchor 段（pinned facts + worktree notes + 项目规则）在同一 session 内 byte-identical。任何字符变更必须显式触发 invalidate，并被 Session HQ 标记。
- INV-CACHE-2：Current Field 段在 git HEAD / 分支 / dirty 状态变化时才更新；同一 HEAD 下重复 compile 必须产出 byte-identical 字节流。
- INV-CACHE-3：`buildMessages()` 必须返回 `[immutable_prefix, ...append_only_log, current_request]` 顺序。顺序错乱即破坏 prefix cache（呼应 Reasonix B-2）。
- INV-CACHE-4：接受 cache miss 而不是为了缓存命中 mutate 历史。永远不允许「悄悄改一下 prefix 让它和上轮一样」的优化。
- INV-CACHE-5：packet compiler 在每个 packet 上附带 `prefixHash`，cache layer 校验该 hash 命中或未命中并暴露到 Session HQ 顶栏。
- INV-CACHE-6：cache hit ratio 是结果指标，Context Budget 的 included/omitted 是过程指标。两者并存——不允许为了拉高 cache hit ratio 而省略 Context Budget 的过程记录。

### Volatile Scratch 不变量（INV-SCRATCH-*）

- INV-SCRATCH-1：scratch 内容不进入下一轮 prompt。每轮 turn 结束前，scratch 区必须经过 Pillar 2 蒸馏（保留摘要 + raw ref）或显式丢弃。
- INV-SCRATCH-2：scratch 在每轮 turn 结束时清空（new turn 起点视为空）。
- INV-SCRATCH-3：任何「想保留到下一轮」的信息必须 promote 成 log entry 或 memory page。promote 走专用 API，不能靠「忘了清 scratch」隐式继承。
- INV-SCRATCH-4：scratch 读写仅限当前 turn 的 harness loop；runtime adapter / tool 不能直接读 scratch（避免形成事实上的隐藏 prompt 通道）。

### 工具执行不变量（INV-TOOL-*）

- INV-TOOL-1：工具调用必须经过 permission 检查。绕过 permission 直接 dispatch 视为安全漏洞。
- INV-TOOL-2：工具输出超过阈值（默认 3000 token，可配置）必须先经过 compression / truncation profile 才能进入 model。raw bytes 进入 prompt 是 P0 bug。
- INV-TOOL-3：每次工具调用必须留下 trace（command / args / cwd / exit / duration / raw ref）。trace 进 `command_traces` 表，并被 XFP packet 的 `commandTrace` section 索引。
- INV-TOOL-4：相同 `(toolName, normalizedArgs)` 在滑动窗口（默认 5 轮）内出现 >= 3 次必须被 storm detector 抑制；超过 reflection 次数上限走 `REPEATED_TOOL_CALL_GIVE_UP`。
- INV-TOOL-5：触及 worktree filesystem 的工具一律 `parallelSafe: false`，进串行屏障；read-only 工具走 `Promise.allSettled` 并发，受 `XUANPU_AGENT_PARALLEL_MAX`（默认 3、上限 8）约束。
- INV-TOOL-6：MCP 工具的 `parallelSafe` 默认 `false`，不允许在注册时未声明就被推断为 `true`。
- INV-TOOL-7：工具修复（flatten / scavenge / truncation / storm）必须可观测 + 可关闭。每次触发进 Session HQ timeline，并被 Context Budget 记账。
- INV-TOOL-8：flatten 的 `rehydrate` 失败不能静默填默认值——失败即抛 `MALFORMED_TOOL_CALL`，让模型纠正。
- INV-TOOL-9：scavenge 捞回的 tool call 在 timeline 必须打 `scavenged` 标签，不允许伪装成模型「正常」发出。

### 记忆不变量（INV-MEM-*）

- INV-MEM-1：memory page 必须有 raw refs；无 raw refs 的「总结」不能写入 memory（主规划原则 5）。
- INV-MEM-2：memory 必须分 scope（user / project / worktree / session / episode / command 六层），不允许跨 scope 写入。
- INV-MEM-3：memory 写入必须用户可见、可编辑、可删除。隐式 memory 是 memory poisoning 的入口。
- INV-MEM-4：检索到的 memory 在 Context Budget 中必须标注 `retrievalReason`（路径匹配 / 错误签名匹配 / 用户显式提及 / 项目约束命中等）。
- INV-MEM-5：memory 写入策略为 proposal-based（提议 -> 用户确认 -> 落库），不允许 harness 静默写入长期记忆。
- INV-MEM-6：memory page 必须区分事实 / 决策 / 假设 / 约束 四种类型；不允许「混类」page。

### 权限不变量（INV-PERM-*）

- INV-PERM-1：trusted worktree 之外不允许默认开启写入工具。trusted 状态由用户显式标记，不允许 harness 自我判定。
- INV-PERM-2：危险路径（`~/`、`/`、`/etc`、`/System` 等系统级目录）默认阻止任何写入工具，即使在 trusted worktree 内。
- INV-PERM-3：用户拒绝过的 `(toolName, target)` 组合在同一 session 内不再 prompt，直接返回 `PERMISSION_DENIED` 给模型，让模型换路径。
- INV-PERM-4：permission 状态本身是 XFP packet 的一部分（未来 section），模型必须能看见自己被允许 / 被拒绝过什么，避免反复尝试同一被拒操作。

### 错误处理不变量（INV-ERR-*）

对齐 plan-review AI-3 的错误分类（`TIMEOUT` / `MALFORMED_TOOL_CALL` / `PERMISSION_DENIED` /
`COMPRESSION_FAILURE` / `RUNTIME_ERROR` / `TOOL_EXECUTION_ERROR` / `BUDGET_EXCEEDED` /
`REPEATED_TOOL_CALL_GIVE_UP`）：

- INV-ERR-1：`TIMEOUT` 最多重试 1 次，第二次失败必须 abort turn。不允许「再试三五次说不定就好了」。
- INV-ERR-2：`MALFORMED_TOOL_CALL` 必须把错误回灌给模型（feedback）让其纠正，不允许直接 abort——除非工具修复层四件套全部 give up。
- INV-ERR-3：`COMPRESSION_FAILURE` 必须 fallback 到 head/tail truncation，不允许把原始大输出粗暴塞给模型。
- INV-ERR-4：`BUDGET_EXCEEDED` 必须触发 offload（episode freeze / command trace 压缩 / memory promote），不允许粗暴截断 log。
- INV-ERR-5：`PERMISSION_DENIED` 必须告诉模型「为什么被拒 + 是否有替代路径」，不允许沉默返回。
- INV-ERR-6：`RUNTIME_ERROR` 必须自动 reconnect 并重试当前 turn 一次；二次失败上抛给用户。
- INV-ERR-7：`REPEATED_TOOL_CALL_GIVE_UP` 是 storm 专用错误码，与 `MALFORMED_TOOL_CALL` 分开——前者走升级到用户 / tier 提升路径，后者走模型纠正路径。
- INV-ERR-8：所有 HarnessError 必须携带 `traceId`，traceId 可关联到当时的 XFP `packetId` + 当时的 log entry id。

### Context Budget 不变量（INV-BUDGET-*）

- INV-BUDGET-1：每轮必须记录 `included sections` + `omittedSectionNames`（XFP `budget` section 已有字段）。omitted 列表为空只允许在 packet 真的没省略任何候选时出现。
- INV-BUDGET-2：v1 packet 不记录每个 omitted section 的 reason（按 plan-review AI-4），但 v2 起 omitted 必须配 reason 字符串。
- INV-BUDGET-3：retrieved memory 必须记录 `retrievalReason`（INV-MEM-4 的对偶）。无 reason 的 memory 检索视为 bug。
- INV-BUDGET-4：Context Budget 必须对所有 runtime（不只 xuanpu-agent；Codex / Claude Code / OpenCode 等）统一记录。Context Budget 是跨 runtime 的过程指标层。
- INV-BUDGET-5：工具修复（flatten / scavenge / truncation / storm）消耗的 token 必须进 Context Budget；不能因为「这是修复，不算业务」就漏记。
- INV-BUDGET-6：cache hit ratio / prefix invariant 命中数 / context budget 使用率三项必须在 Session HQ 顶栏暴露给用户。

### 成本地形不变量（INV-COST-*）

对应架构文档 §7「成本地形设计」四层机制（Layer A–D）。这些不变量确保 agent 面对
的"成本地形"偏向调工具而非偷懒，偏向精确而非猜测。

- INV-COST-1（Layer A）：工具输出进入模型前必须经过压缩。裸字符串长输出是 P0 问题。
  CommandProfiler 识别命令类型 → CommandCompressor 按 profile 压缩 → 压缩摘要进
  context，raw output 进 command_traces 表。与 INV-TOOL-2 共轭。
- INV-COST-2（Layer A）：压缩失败必须 fallback 到 head/tail truncation（前 500 行 +
  后 500 行），不允许把原始大输出塞给模型。上报 COMPRESSION_FAILURE + traceId。
- INV-COST-3（Layer A）：工具输出必须结构化返回（exit code / duration / 关键错误 /
  涉及文件 / 压缩比例 / raw ref），不能只返回裸字符串。结构化字段即使为空也必须
  显式 null。
- INV-COST-4（Layer A）：工具注册时必须附带高可发现性描述（tool description），
  让模型能一眼判断"这个工具能解决我当前的问题"。description 字段是必填项，不能
  留空或写 "Executes a command" 级别占位文本。
- INV-COST-5（Layer B）：Post-response claim verifier 检测到的未验证事实声明必须
  注入纠正 turn（M6 实现）。Verifier 不能静默忽略——要么 pass、要么 inject correction。
- INV-COST-6（Layer C）：高风险问答（涉及具体仓库名、库名、API 名）必须路由到
  结构化 sub-agent，其输出 schema 要求 `evidence` 字段非空。evidence 为空 → reject。
  M5-M6 实现。
- INV-COST-7（Layer D）：System prompt 必须用自利框架写约束（"偷懒会污染你自己的
  reasoning context"），不能写道德说教式约束（"你必须严谨、必须搜索"）。代码
  `tool-policy.ts` 的 `getXuanpuAgentSystemPromptLines()` 是单一出口。

## 非不变量（我们不承诺什么）

显式声明这些「看起来像不变量但其实不是」的边界，避免 code review 误用。

- 我们不承诺多 provider 都能命中 prefix cache。DeepSeek 字节级、Anthropic explicit
  cache_control、OpenAI 自动 prefix cache 三种机制不一致；玄圃只承诺「不主动破坏」，
  不承诺「跨 provider 命中率均等」。
- 我们不承诺 `MinimalFieldPacket` CLI 模式跟玄圃内嵌模式行为完全一致。CLI 是 1.7.0
  的 fallback，没有 SQLite / worktree manager / 长期记忆，行为有损是预期。
- 我们不承诺 `estimateTokens` 精确。tokenizer 跨 provider 差异大，估算是启发式；
  3000 token 阈值是字符数 + 估算 token 双指标并行。
- 我们不承诺 memory 检索是确定性的。向量检索 + 关键词检索的混合策略对同一 query
  可能在不同时间返回不同 top-k；用户应通过 `retrievalReason` 审计而非期望复现。
- 我们不承诺 1.5.0 支持 MCP / subtask delegation / 多 worktree 协作。这些是 M6 范围，
  1.5.0 的产品边界不到那里。
- 我们不承诺 packet `capturedAt` 是单调递增的。多进程时钟不一致下，packet 顺序由
  `packetId` 写入序列保证（INV-LOG-4 同理），不是时间戳。
- 我们不承诺 packet 大小有上限。compiler 会努力控制在 budget 内，但极端场景下 packet
  可以超过 budget——超出会被 Context Budget 显式记账，不会被悄悄裁剪。

## 违反不变量的处理

按可检测时机分三层：

### 编译期可检测

- INV-XFP-1（version 字段缺失）-> TypeScript 编译失败
- INV-XFP-4（packet mutation）-> `readonly` 字段 + `Object.freeze` 触发
- INV-XFP-8（MinimalFieldPacket 反向转换）-> 没有公共反向 API

处理：CI 编译失败即阻断合并。

### 运行时可检测

- INV-XFP-5（trust boundary 缺 schema.parse）-> Zod throws，HarnessError 包装上抛
- INV-CACHE-3（buildMessages 顺序错乱）-> runtime 断言 + traceId 入 audit log
- INV-TOOL-4（storm 阈值触发）-> storm detector 直接抑制 + 注入 reflection turn
- INV-LOG-2（绕过 appendAndPersist 写 log）-> db layer 拒绝写入并抛 `RUNTIME_ERROR`
- INV-TOOL-1（绕过 permission 调 tool）-> tool dispatcher 拒绝执行

处理：抛 `HarnessError` + 记录 traceId + Session HQ timeline 警告事件。

### 设计期可检测（code review only）

- 有人想新增第二个「写 log」入口（绕开 appendAndPersist）
- 有人想给 packet 加 mutation API（`packet.appendSection(...)`）
- 有人想把 memory 检索做成「无 reason 也能用」
- 有人想给 `parallelSafe: true` 加例外白名单

处理：code review 必须引用本文档 INV-* ID 拒绝。reviewer 在 PR 评论里写
`违反 INV-LOG-2`，作者据此整改或显式申请例外（例外必须更新本文档）。

## 与 12 条原则的映射

| 原则                                                     | 落地不变量                                                |
| -------------------------------------------------------- | --------------------------------------------------------- |
| 1. 玄圃拥有现场                                          | INV-XFP-3、INV-PERM-1、INV-PERM-4                           |
| 2. xuanpu-agent 优先实现 XFP                             | INV-XFP-1、INV-XFP-5、INV-XFP-9                           |
| 3. 上下文是编译出来的，不是追加出来的                    | INV-XFP-3、INV-CACHE-3、INV-LOG-2                         |
| 4. 旧工作要卸载，不是遗忘                                | INV-LOG-1、INV-LOG-6、INV-ERR-4                           |
| 5. 没有 raw refs 的总结不能叫记忆                        | INV-XFP-2、INV-XFP-7、INV-MEM-1                           |
| 6. 命令输出进入模型前必须被压缩和结构化                  | INV-TOOL-2、INV-TOOL-3、INV-ERR-3、INV-COST-1             |
| 7. 记忆必须分 scope、可编辑、可追溯                      | INV-MEM-2、INV-MEM-3、INV-MEM-4                           |
| 8. 大上下文窗口是 fallback，不是目标                     | INV-BUDGET-1、INV-BUDGET-2、INV-BUDGET-4                  |
| 9. 模型可替换，harness 才是产品                          | INV-CACHE-5、INV-TOOL-7、INV-BUDGET-4                     |
| 10. 我们优化用户工作，不优化模型厂商 token 消耗          | INV-CACHE-4、INV-CACHE-6、INV-TOOL-2                      |
| 11. 约束 LLM 靠改造成本地形，不靠 prompt 说教            | INV-COST-1、INV-COST-2、INV-COST-3、INV-COST-4、INV-COST-7 |
| 12. Trace 是资产，不是废热                               | INV-MEM-5、INV-LOG-1、INV-ERR-4                           |

## 后续

- 本清单是 1.5.0 M1 阶段产物。M2-M6 落地新功能时在对应前缀下新增编号。
- INV-* ID 一旦发布不可重用。废弃的不变量保留行并标 `[deprecated since vX.Y]`，附替代 INV-* 链接。
- 新增不变量的 PR 必须同时改本文档 + 给出落地点（类型 / Zod / 运行时断言 / review checklist 至少一项）。
- M6 收尾时复盘：每条 INV-* 在过去半年触发过多少次、是否过严 / 过松、是否需要降级到「建议」或升级到「类型强约束」。
