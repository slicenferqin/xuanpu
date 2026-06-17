# oh-my-pi v16.x 升级 spike 方案

日期：2026-06-17

关联文档：

- `docs/plans/2026-06-16-xuanpu-agent-oh-my-pi-product-architecture.zh-CN.html`
- `docs/plans/2026-06-16-xuanpu-agent-implementation-task-list.zh-CN.md`
- `packages/xuanpu-oh-my-pi-runtime/upstream.json`

## 结论

当前 Xuanpu Agent 不应在本轮落地分支里直接整体升级到 oh-my-pi v16.x。

推荐策略是：

1. 当前主线继续 pinned at oh-my-pi `15.2.4`，保持 `@xuanpu/oh-my-pi-runtime` 的可测 contract。
2. 单独开 `spike/oh-my-pi-v16-upgrade` 分支，对 `15.2.4 -> v16.0.3` 做 API diff、provider 行为 diff、compaction diff 和 contract test。
3. 只回收对 Xuanpu 有明确收益且能被测试锁住的补丁，不把 TUI、settings、extensions、natives、完整 SDK/ACP 行为一次性拖进主线。

这不是“放弃升级”，而是把升级从“整包迁移风险”拆成“可验收补丁队列”。

## 当前基线

Xuanpu 当前 runtime 包边界：

- `packages/xuanpu-oh-my-pi-runtime/package.json`：版本 `15.2.4`。
- `packages/xuanpu-oh-my-pi-runtime/upstream.json`：`upstreamTag` 为 `v15.2.4`。
- 当前 Xuanpu-owned contracts：
  - `turn-scoped-runTurn-context-messages-do-not-prompt-echo`
  - `fresh-agent-per-runTurn-call`
  - `provider-session-state-disabled-by-default`
- 当前 patch queue：
  - `0001-turn-scoped-runTurn`：提供 `runTurn()` facade，通过 `replaceMessages` 注入 context，只把当前用户 prompt 作为 prompt。

本轮已经新增的 Xuanpu 自主管控层不依赖直接升级 v16：

- `ContextFrameCompiler`：frame、zone ledger、raw-ref ledger、provider request replay。
- `SegmentCompactor`：rule-based fallback episode、provider-native replay audit。
- OpenAI remote `/responses/compact` live path：在 OpenAI/OpenAI-Codex compaction model 且存在 API key 时主动请求远端 compact，失败回退本地/model summarizer。
- 工具输出卸载、媒体卸载、工具调用过滤和 gateway budget guard。
- `@xuanpu/agent-cli`：one-shot、interactive、coding tools、JSON-RPC/ACP stdio bridge。

## 上游状态

2026-06-17 通过 GitHub Releases 查询：

- 最新 release：`v16.0.3`
- 发布时间：2026-06-17T00:17:49Z
- Release URL：https://github.com/can1357/oh-my-pi/releases/tag/v16.0.3

相关 v16 releases：

| 版本      | 发布时间             | 对 Xuanpu 的主要含义                                                                                                                                    |
| --------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v16.0.0` | 2026-06-15T15:44:19Z | v16 主版本起点，需要视为 breaking line。                                                                                                                |
| `v16.0.1` | 2026-06-15T19:47:19Z | 包含 coding-agent breaking changes，也修了 OpenAI Responses payload replacement、streamed tool args、strict schema nullable enum 等 provider 关键问题。 |
| `v16.0.2` | 2026-06-16T13:53:22Z | 继续修 OpenAI Responses 工具 schema、并行 tool deltas、Codex browser login、task/subagent retry、plugin/extension 等。                                  |
| `v16.0.3` | 2026-06-17T00:17:49Z | 继续修 OpenAI Responses/Codex tool schema normalization、parallel tool-call routing、Codex 默认认证选择，以及大量 TUI/agent queue 行为。                |

调研来源：

- https://github.com/can1357/oh-my-pi/releases
- https://github.com/can1357/oh-my-pi/releases/tag/v16.0.1
- https://github.com/can1357/oh-my-pi/releases/tag/v16.0.2
- https://github.com/can1357/oh-my-pi/releases/tag/v16.0.3

## 为什么不能直接整包升级

v16.x 对 Xuanpu 有价值，但它不是一个纯 provider bugfix release。它同时改了多个与 Xuanpu runtime 边界相冲突的面：

| 风险面              | v16 变化                                                                                         | Xuanpu 风险                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| settings/extensions | `hooks`、`customTools`、`commands` 等配置/目录语义迁移到 `extensions` / `prompts` 体系。         | Xuanpu 当前不是直接采用 oh-my-pi 的完整用户目录模型；直接升级会把上游配置迁移风险带入 Desktop。                                        |
| SDK/RPC/ACP         | upstream session prompt/streaming/cancel 行为在 v16 中继续演进。                                 | Xuanpu 已经定义 CanonicalAgentEvent-compatible event envelope、TaskRun/UserRound/ContextSegment 语义，不能直接把上游协议作为产品真相。 |
| provider payload    | v16 修复了 OpenAI Responses/Codex payload replacement、tool schema、tool-call delta routing 等。 | 这些修复值得回收，但必须证明不会破坏 Xuanpu 的 provider request snapshot、tool output offload、media offload 和 replay。               |
| compaction          | v16 继续维护 provider-native compaction 和 post-compaction guidance。                            | Xuanpu 已有 `SegmentCompactor` 和 provider-native archive/ref 语义，升级前必须 diff preserveData/replacementHistory 格式。             |
| TUI/natives         | v16 包含大量 TUI、terminal、native addon、STT、plugin installer 改动。                           | Xuanpu Desktop 不应为 CLI/TUI 体验修复承担 Electron 主线回归风险。                                                                     |
| agent loop          | subagent、task、advisor、queue、interrupt/auto-resume 行为变化很多。                             | Xuanpu 的长任务语义是 TaskRun/UserRound/budget-driven，不应被上游 queue/auto-resume 策略隐式替换。                                     |

## 需要 diff 的重点文件

以 oh-my-pi `v15.2.4 -> v16.0.3` 为目标 diff 范围，优先看这些上游路径。具体路径以实际 upstream checkout 为准：

| 优先级 | 路径/模块                                     | 目标                                                                                                               |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P0     | `src/compaction/openai.ts`                    | 确认 `/responses/compact` 请求体、response output 过滤、preserveData/replacementHistory 格式是否改变。             |
| P0     | `src/compaction/compaction.ts`                | 确认 compaction trigger、history replacement、post-compaction continuation 语义。                                  |
| P0     | `src/agent.ts` / agent loop 相关模块          | 确认 message transform、`replaceMessages`、prompt/session 状态与 Xuanpu `runTurn()` facade 是否兼容。              |
| P0     | OpenAI Responses/Codex provider modules       | 回收 payload replacement、strict schema normalization、parallel tool delta routing、Codex auth fallback 相关修复。 |
| P1     | tool definition / argument validation modules | 比较 schema normalization、nullable enum、array-string pre-parse、regex lookaround stripping 的实现。              |
| P1     | RPC/ACP/session modules                       | 只做协议参考，不直接替换 Xuanpu bridge；重点确认 `prompt` streamingBehavior、cancel、session events 是否值得映射。 |
| P2     | settings/extensions/modules                   | 仅记录迁移影响；本轮不接入上游完整 extensions 模型。                                                               |
| P2     | TUI/natives/STT/modules                       | 只评估是否影响 runtime package import side effects，不纳入首轮升级。                                               |

## Spike 分支工作流

建议单独开分支：

```bash
git switch -c spike/oh-my-pi-v16-upgrade
```

执行步骤：

1. 拉取上游源码或 tarball，对比 `v15.2.4`、`v16.0.1`、`v16.0.2`、`v16.0.3`。
2. 建立 `packages/xuanpu-oh-my-pi-runtime/patches/v16/` 草案，不直接覆盖当前 `0001-turn-scoped-runTurn`。
3. 给每个候选 patch 记录：
   - upstream PR/issue/release note 来源。
   - Xuanpu 要回收的最小代码范围。
   - 影响的 contract test。
   - 是否改变 provider-visible input/output。
4. 先做 provider/compaction 修复回收，再评估 agent loop / SDK / RPC 行为。
5. 不迁移 Xuanpu Desktop 的 product-facing task semantics；TaskRun/UserRound/ContextSegment 仍由 Xuanpu 自己定义。

## 必须补齐的 contract tests

升级 spike 至少要新增或扩展这些测试：

| 测试方向                               | 验收标准                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runTurn()` context contract           | context messages 不 prompt-echo；每 turn fresh agent；providerSessionState 默认 disabled。                                                                                  |
| OpenAI Responses payload replacement   | `onPayload` 替换后的 body 才是上游真实请求体；provider request snapshot 记录替换后的审计摘要。                                                                              |
| OpenAI/Codex tool schema normalization | invalid schema 只隔离坏工具，不导致整轮 400；regex lookaround、nullable enum、array string union 有回归测试。                                                               |
| Parallel tool-call deltas              | late keyed argument deltas 不串到其他 call；object-shaped tool args 深合并。                                                                                                |
| `/responses/compact` preserveData      | response 必须包含 `compaction` 或 `compaction_summary`；archive 只保存 ref/sha/path/summary 到 episode metadata；下一次 remote compact 能读回 previous replacementHistory。 |
| Media/image offload                    | provider vision request 后不把 raw image blocks 永久放进历史上下文；后续 request 只保留本地 path/ref/summary。                                                              |
| Tool output offload                    | 100K+ tool output 仍落 artifact；模型上下文只收到 `ToolObservation` 摘要/ref/hash/bytes。                                                                                   |
| CLI bridge                             | `rpc` / `acp` 子命令仍输出 Xuanpu canonical-compatible events，不被上游 protocol shape 反向绑架。                                                                           |

建议最小命令：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-oh-my-pi-runtime-contract.test.ts \
  test/phase-24/xuanpu-agent-provider-native-compaction.test.ts \
  test/phase-24/xuanpu-agent-auto-freeze.test.ts \
  test/phase-24/xuanpu-agent-cli.test.ts

pnpm --filter @xuanpu/agent-cli typecheck
pnpm --filter @xuanpu/agent-cli build
pnpm exec tsc -p tsconfig.json --noEmit
```

## 可回收收益清单

v16.x 中优先值得回收的是 provider 层和 compaction 层修复：

1. OpenAI Responses/Codex payload replacement 真实生效。
2. OpenAI Responses strict schema normalization 更稳，避免单个坏 MCP schema 拖垮整轮。
3. OpenAI-compatible / Codex parallel tool-call delta routing 修复。
4. Codex browser login / default auth 选择修复。
5. provider image budget、large image resize/降级策略的设计参考。
6. post-compaction todo/task reminder 设计参考，但只能转译为 Xuanpu TaskRun/UserRound 语义，不能直接搬上游 reminder。

不建议首轮回收：

1. 完整 TUI 渲染与 terminal 逻辑。
2. 完整 extensions/settings 迁移。
3. upstream advisor/subagent/IRC queue 语义。
4. upstream 完整 RPC/ACP server 行为。
5. native/STT/package installer 相关改动。

## 决策门槛

只有满足以下条件，才允许把 v16 相关 patch 合入主线：

1. `@xuanpu/oh-my-pi-runtime` 的三个既有 contract 全部通过。
2. `ContextFrameCompiler` replay ledger、provider request snapshot、TaskRun report 输出结构不变。
3. OpenAI remote compaction 的 provider-native replay archive 可回放，且 metadata 不包含 encrypted provider content。
4. 工具过滤、工具输出卸载、媒体卸载和 gateway budget guard 没有被上游逻辑绕过。
5. `@xuanpu/agent-cli` 的 one-shot、interactive、RPC、ACP bridge 均通过测试。
6. `bun:sqlite` / upstream runtime import side effect 不进入 Node/Vitest 的阻塞路径，或者有明确隔离方案。

## 推荐落点

本轮落地分支只交付 spike 文档和现有 15.2.4 基线上的能力闭环。

实际 v16 升级应独立分支推进，预计输出：

1. `docs/plans/YYYY-MM-DD-oh-my-pi-v16-api-diff.zh-CN.md`
2. `packages/xuanpu-oh-my-pi-runtime/patches/v16/*.patch`
3. 新增 contract tests
4. 一次小范围 provider/compaction 修复回收 PR

这样做能把上游 v16 的收益拿回来，同时不牺牲 Xuanpu Agent 已经建立的 TaskRun/UserRound/ContextSegment、context budget、tool/media offload 和 replay audit 体系。
