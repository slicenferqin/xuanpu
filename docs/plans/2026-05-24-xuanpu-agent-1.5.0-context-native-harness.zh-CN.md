# 玄圃 Agent 1.5.0 规划：上下文原生的 Agent Harness

日期：2026-05-24
状态：规划中
目标版本：玄圃 1.5.0
相关分支：`feat/xuanpu-agent-oh-my-pi`

## 核心判断

玄圃 1.5.0 的核心特性，应该是把 `xuanpu-agent` 做成第一个真正围绕 XFP
（Xuanpu Field Protocol，玄圃现场协议）构建的 Agent。

这里的重点不是“再做一个 Claude Code”，也不是“套一个新的聊天模型”。真正的产品判断是：

```text
玄圃负责提供现场。
xuanpu-agent 负责实现协议、理解现场、推进任务。
```

所谓“现场”，包括：

- 当前项目和 worktree
- 当前分支、HEAD、dirty 状态
- 当前文件、选区、可见 tab
- 最近终端输出、测试状态、命令结果
- 当前用户消息
- 历史 session
- episode blocks
- 长期记忆
- pinned facts
- 权限状态
- Context Budget 决策

这些东西不应该再被粗暴拼成一大段 prompt。它们应该由玄圃结构化采集、压缩、筛选、记录，再交给 xuanpu-agent 使用。

## 为什么这是玄圃的杀手级特性

我们不卖 token。模型厂商当然希望用户多传 token、重复传上下文、把一堆无用日志塞进 prompt。对他们来说，这不是问题，甚至是商业收益。

但对玄圃来说，优势应该反过来：

```text
少传无用 token。
少重复 stale context。
少让命令输出污染上下文。
少让模型在一大堆噪音里猜重点。
```

玄圃应该死磕的是：

- 稳态上下文
- 上下文卸载
- 命令执行结果压缩
- 长期记忆
- 可解释的上下文预算
- 可追溯的 raw refs

这才是玄圃和普通 AI IDE / Agent 壳子的区别。

## 当前分支已经证明了什么

`feat/xuanpu-agent-oh-my-pi` 这个分支已经跑通了第一条链路：

```text
Session HQ
  -> xuanpu-agent runtime
  -> openai / gpt-5.5
  -> 真实 provider 返回
  -> field_context_packages
  -> Context Budget
  -> episode freeze
  -> gated retrieval
```

已经验证通过的点：

- `xuanpu-agent` 能被 `XUANPU_AGENT_RUNTIME=1` 注册进玄圃。
- 能复用 `~/.codex/config.toml` 的 OpenAI-compatible base URL。
- 能复用 `~/.codex/auth.json` 里的 key。
- 能真实调用 `openai / gpt-5.5`。
- 能生成 `field_context_packages`。
- Context Budget 能看到当前模型、runtime、context section 和决策。
- 能产生 frozen episode。
- 能在触发 historical reference 时检索 episode。

现在仍然很弱的地方：

- 还基本是 no-tools runtime。
- 流式输出和 timeline 事件还粗糙。
- 请求需要工具时，边界表达还不够稳定。
- 图片/附件还没有真正多模态协议。
- 现在证明的是“链路通了”，不是“已经能替代 Claude Code 干活”。

## 产品定位

xuanpu-agent 不应该只是：

```text
oh-my-pi wrapper
```

也不应该只是：

```text
OpenClaude clone
```

它应该是：

```text
玄圃原生 Agent。
第一个完整实现 XFP 的 Agent。
```

oh-my-pi / pi 负责薄模型运行时。
OpenClaude / Claude Code harness 可以作为参考和能力来源。
但真正的上下文、权限、事件、记忆、worktree 编排，应该归玄圃自己所有。

## 版本范围与不做什么

1.5.0 的范围必须收得住。2026-05-25 复盘"是否要把 xuanpu-agent 做成
通用 agent（Reasonix 通用形态）"之后的结论是：**1.5.0 只做 Field-bound，
不做通用化**。通用化是 2.0.0 之后的事。

| 版本 | 形态 | 关键能力 | 不做 |
|---|---|---|---|
| 1.5.0 | Field-bound | XFP packet 编译、Context Budget、no-tools runtime 收口、只读 harness、命令压缩、工具调用修复 | MinimalField CLI 入口、跨 provider 适配抽象、sub-agent delegation |
| 1.6.0 | Field-bound 加固 | 命令压缩 profile 库、错误分类完整闭环、Context Budget 全 runtime 覆盖 | 写入工具 |
| 1.7.0 | Field-bound + write | 受控写入 harness、Memory Graph、checkpoint/resume | MinimalField CLI |
| 2.0.0+ | 双形态 | MinimalField CLI standalone、provider 适配器抽象、sub-agent delegation | — |

理由：

- 玄圃的护城河是 **Field-native**，不是"通用 harness"。先把 Field 通路打透，
  再考虑独立形态。Reasonix 已经证明 byte-level 缓存 + tool-call repair 这种
  "通用形态"可以单独成立，玄圃不必跟它在同一个赛道上竞争。
- 提前抽 provider 适配器会让 1.5.0 的 XFP packet 设计被通用化需求拉变形。先
  让 packet 服务于真实的 codex / openai-compat runtime，再在 2.0.0 抽象。
- MinimalField subset 已经在 `src/main/services/xuanpu-agent/xfp/types.ts`
  作为类型留位（`MinimalFieldPacket` + `narrowToMinimal()`），CLI 入口本身延
  后到 2.0.0；这样 1.5.0 不背 CLI UX / 安装路径 / config 解析的债。
- 工具调用修复（flatten / scavenge / truncation / storm）作为 M1.5 单独成
  立，是 1.5.0 范围内的事；详见草案文档。

详见：

- `docs/plans/2026-05-25-reasonix-comparison-and-borrowings.zh-CN.md` —
  借鉴清单与"不抄什么"
- `docs/plans/2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md` —
  M1.5 工具调用修复接口草案
- `docs/architecture/xfp-packet-v1.md` — XFP v1 字段文档
- `docs/architecture/xuanpu-agent-invariants.md` — Harness 不变量清单

## 总体架构

建议把 xuanpu-agent 拆成这些层：

```text
src/main/services/xuanpu-agent/
  runtime/              # oh-my-pi / pi 模型运行时适配
  harness/              # 玄圃自己的 agent loop
  xfp/                  # XFP packet 类型、校验、编译输入
  context/              # 上下文打包、预算、卸载策略
  memory/               # 长期记忆、检索、写入策略
  tools/                # git / shell / file / rg 等工具
  permissions/          # 权限策略和 UI 请求事件
  command-compression/  # 命令输出解析、压缩、trace
  events/               # harness event -> CanonicalAgentEvent
  checkpoints/          # 可恢复稳态 session packet
```

核心边界：

```text
玄圃拥有现场、上下文、权限、事件和记忆。
模型运行时只消费编译好的 messages，并返回文本或动作。
```

## XFP 是什么

XFP 可以理解成“玄圃向 agent 提供现场的协议”。

它不是一段 prompt 前缀，而是结构化 packet。

一个 XFP packet 应该包含：

- packet id
- 时间戳
- project / worktree / session id
- 当前分支和 HEAD
- dirty 状态
- 当前文件和选区
- 最近终端和测试摘要
- git 状态摘要
- 命令 trace 摘要
- 当前任务目标
- 上下文预算信息
- 每个重要信息的 raw refs

每个 packet 都要回答几个问题：

```text
agent 到底看到了什么？
这些信息来自哪里？
为什么被纳入上下文？
哪些信息被省略了？
用户如何检查这些信息？
```

## 稳态上下文

Agent 不应该无限保留完整聊天历史。每一轮都应该从持久化状态重新编译一个有限、干净、相关的上下文。

建议的上下文区域：

```text
Anchor
  稳定协议、项目规则、pinned facts

Current Field
  当前 worktree、文件、选区、终端、测试、git 状态

Working Set
  最近几轮高保真对话和关键工具结果

Retrieved Memory
  本轮相关的 memory pages 和 episode blocks

Current Request
  当前用户指令
```

目标不是把上下文窗口塞满，而是：

```text
小到足够清晰。
大到不会失忆。
```

默认预算建议：

- Focused：32K-64K
- Balanced：80K-150K
- Extended：150K-200K
- Max：只允许手动选择

200K 不是常态目标，只是上限。

## 上下文卸载

上下文卸载就是把旧对话、旧工具结果、旧命令输出，从 active prompt 里移出去，变成结构化、可检索、可审计的 durable state。

卸载目标：

- episode blocks：完成过的一段任务/对话
- command traces：命令原始输出和压缩摘要
- memory pages：长期事实、约束、决策、项目知识
- checkpoints：可恢复的任务现场

核心原则：

```text
没有 raw refs 的总结只是传说。
有 raw refs 的总结才是记忆。
```

每条 episode / memory / command summary 都应该能追溯回原始消息、原始命令、原始文件或事件。

## 命令执行压缩

命令输出是最容易污染上下文的东西。

比如：

- `pnpm test`
- `vitest`
- `tsc`
- `eslint`
- `playwright`
- `git diff`
- `git log`

这些输出如果原封不动塞给模型，很快就会把上下文搞脏。

参考 RTK / Rust Token Killer 这类方向，玄圃应该在命令输出进入模型前做压缩：

```text
原始命令输出
  -> 命令类型识别
  -> 结构化解析
  -> 压缩摘要
  -> 保留 raw artifact / raw ref
  -> timeline 可查看
  -> Context Budget 记账
```

模型应该看到的是：

- 命令
- cwd
- exit code
- 耗时
- 关键错误
- 失败测试
- 涉及文件
- 重要 excerpt
- 是否截断
- 压缩比例
- raw trace id

用户仍然可以在玄圃里点开 raw output。

## 记忆系统

GBrain 的方向值得参考：记忆不应该是一段巨大 prompt，而应该是 local-first、可检索、可编辑、可追溯的知识系统。

玄圃记忆应该分层：

- 用户记忆
- 项目记忆
- worktree 记忆
- session 记忆
- episode 记忆
- command 记忆

记忆写入要有策略：

- 不保存闲聊废话
- 不把临时构建噪音保存成长期事实
- 必须有 raw refs
- 区分事实、决策、假设、约束
- 用户可以查看、修改、删除
- 防止 memory poisoning

记忆检索也要在 Context Budget 里说清楚：

```text
为什么这条 memory 被纳入？
因为路径匹配？
因为用户说“上次那个问题”？
因为错误签名匹配？
因为项目约束命中？
```

## 1.5.0 里程碑

### M0：Runtime 收口

目标：把当前 spike 做成可靠 no-tools runtime。

要做：

- 修掉复用 session 时反复取第一条 assistant 回复的问题。
- 稳定 Codex-compatible provider 配置。
- no-tools 场景要明确说自己不能读文件/跑命令。
- 打磨 Session HQ 流式输出。
- Context Budget 作为“agent 到底看了什么”的黑盒记录器。

验收：

- 连续多轮 prompt 不再复读旧回复。
- context package 正确记录 model / runtime / user message。
- 对需要工具的请求，能诚实表达能力边界。

### M1：XFP v1 协议

目标：把 XFP 正式定义为玄圃和 xuanpu-agent 的边界。

要做：

- `XfpFieldPacket` shared type
- packet compiler
- packet validator
- packet repository / audit trail
- Context Budget 展示 packet 决策
- 测试 packet 大小、source refs、omission reason

验收：

- xuanpu-agent 消费 XFP packet，不再依赖临时拼接 prompt。
- 每个被纳入的 section 都有理由和来源。
- 每个被省略的候选上下文都能解释为什么被省略。

### M1.5：工具调用修复

目标：在工具循环正式开张前，把模型常见的"工具调用畸形"问题用 harness 层拦下来。

要做：

- `flatten`：检测工具 schema 中叶子参数 >10 或嵌套深度 >2，编译期降维。
- `scavenge`：从 `reasoning_content` 用正则扫到内嵌的 tool-call JSON。
- `truncation`：解析被模型截断的 JSON，能修就修，不能修就标记
  `MALFORMED_TOOL_CALL` 回灌给模型纠正。
- `storm`：同一 turn 内相同 `(tool, args)` 重复调用必须聚合或拒绝，对应
  `REPEATED_TOOL_CALL_GIVE_UP` 错误码。
- 错误分类对齐 plan-review.md 的 AI-3 表，扩展新增码。

验收：

- 上游模型返回畸形 tool call 时，harness 能产生明确 `HarnessError`，而不是
  把脏 JSON 推给下一轮模型。
- 同 turn storm 调用被聚合，timeline 可以看到聚合过程。
- 单元测试覆盖 flatten / scavenge / truncation / storm 四种路径。

详见：`docs/plans/2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md`

### M2：只读 Harness

目标：让 xuanpu-agent 真正能理解仓库，但还不写文件。

工具：

- `git_status`
- `git_log`
- `git_diff`
- `list_files`
- `read_file`
- `rg_search`
- `inspect_package_scripts`

策略：

- trusted worktree 里默认允许只读工具。
- 大输出必须压缩。
- raw output 存成 trace。
- 工具事件进入 Session HQ timeline。

验收：

```text
用户问“看下当前分支最近提交/上游变化”，xuanpu-agent 必须真的能看 git 状态。
用户问“这个错误可能在哪”，xuanpu-agent 必须能搜索和读文件。
```

### M3：命令压缩层

目标：避免 shell / tool 输出污染上下文。

要做：

- command trace 表
- 压缩 profile
- raw output artifact
- compressed summary
- timeline raw/compressed toggle
- Context Budget 展示压缩比例

验收：

- 长测试输出不会原封不动进入模型。
- 失败信息能保留准确文件路径和错误行。
- 用户能打开 raw trace。
- 重复命令输出不会撑爆 working set。

### M4：受控写入 Harness

目标：支持小规模代码修改。

工具：

- `apply_patch`
- `write_file`
- `edit_file`
- `run_test`
- `format_file`

策略：

- 写入需要 diff preview 或明确 trust mode。
- 危险路径默认阻止。
- patch 必须绑定上下文 refs。
- 测试失败输出压缩后再进入模型。
- rollback / revert 路径可见。

验收：

- xuanpu-agent 能做一个小代码修改。
- 能跑 focused test。
- 能解释 diff。
- 所有写入都能审计。

### M5：Memory Graph

目标：把项目知识变成长期、可编辑、可追溯的记忆。

要做：

- memory page schema
- entity / reference extraction
- project / worktree / session scope
- memory write proposal
- memory correction / deletion UI
- Context Budget 展示 memory retrieval reason

验收：

- 完成任务后能沉淀有价值 memory。
- 未来任务能检索相关决策和约束。
- memory 可编辑、可删除、有 raw refs。

### M6：高级 Harness

目标：接近 Claude Code 级别的任务可靠性，但保持玄圃原生控制。

范围：

- MCP
- subtask delegation
- checkpoint / resume
- long-running command supervision
- multi-worktree awareness
- PR / review workflow
- hub / mobile event propagation

验收：

- xuanpu-agent 能执行多步骤工程任务。
- 上下文、权限、事件、记忆仍由玄圃掌控。

## 产品界面

### Session HQ

需要有这些卡片：

- XFP packet compiled
- tool permission requested
- tool running
- compressed command output
- raw trace available
- memory write proposed
- episode frozen
- checkpoint created

### Context Budget

Context Budget 要变成 agent 的黑盒记录器：

- budget profile
- included sections
- omitted sections
- frozen episodes
- retrieved episodes
- memory pages
- command traces
- raw refs
- token estimate
- compression ratio
- safety / policy decisions

### XFP Inspector

XFP Inspector 要能看：

- packet history
- field event sources
- 每轮 packet diff
- 为什么 packet 变了
- 哪些来源缺失
- 哪些信息 stale
- 隐私和存储策略

## 度量指标

每轮应该记录：

- 原始候选上下文大小
- 最终 active context 大小
- 压缩比例
- command output raw vs compressed
- retrieved episodes 数量
- retrieved memory pages 数量
- stale context 事件
- repeated answer 事件
- permission prompt 接受/拒绝
- tool failure recovery rate
- 用户打开 raw output 的次数

核心指标：

```text
agent 是否用更少上下文、更少噪音、更强可解释性完成任务？
```

## 原则

1. 玄圃拥有现场。
2. xuanpu-agent 优先实现 XFP。
3. 上下文是编译出来的，不是追加出来的。
4. 旧工作要卸载，不是遗忘。
5. 没有 raw refs 的总结不能叫记忆。
6. 命令输出进入模型前必须被压缩和结构化。
7. 记忆必须分 scope、可编辑、可追溯。
8. 大上下文窗口是 fallback，不是目标。
9. 模型可替换，harness 才是产品。
10. 我们优化用户工作，不优化模型厂商 token 消耗。

## 待决问题

- trusted worktree 里只读工具是否默认开启？
- command trace 原始输出存在 SQLite、文件，还是两者都存？
- XFP v1 最小 packet schema 是什么？
- 1.5.0 的 memory write 是自动、提议式，还是手动确认？
- project memory 和 session episode 如何区分？
- RTK 风格压缩 profile 是内置实现，还是支持外部 compressor？
- OpenClaude 只作为 harness 参考，还是也做一个可选 external runtime adapter？

## 近期行动

1. 提交当前 runtime bugfix：修复复用 session 时取错 assistant 消息。
2. 起草 XFP v1 shared type。
3. 做 `git_status` + `git_log` 只读 harness spike。
4. 增加 command trace 存储。
5. 先实现 `git log` 的压缩 profile。
6. Context Budget 展示 command trace 和压缩比例。
7. 写第一个 dogfood 脚本：让 xuanpu-agent 总结当前 worktree 上游变化。

## 参考方向

- RTK / Rust Token Killer：命令输出进入模型上下文前的压缩。
- GBrain：local-first、长期、可检索、可编辑的 agent memory。
- OpenClaude / Claude Code harness：工具循环、权限请求、流式事件、任务 UX 的参考。
