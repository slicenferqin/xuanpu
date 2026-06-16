# xuanpu-agent 落地实现任务清单

日期：2026-06-16

关联方案：

- `docs/plans/2026-06-16-xuanpu-agent-oh-my-pi-product-architecture.zh-CN.html`
- 分支：`feat/xuanpu-agent-oh-my-pi`

## 交付目标

把方案中的“oh-my-pi-derived runtime + Xuanpu 自主管控层”落成可验收的运行时能力。首批实现不做大规模拆包，
优先落高收益、可测、能直接降低上下文开销和长任务失控风险的模块。

## 并行任务分解

### Track A：上下文与媒体预算

- [x] `MediaOffloader`：图片按 sha256 归档到本地 media archive。
- [x] `ImageObservationRef`：同一图片首次 vision request 后，后续 provider request 不再携带 raw image block。
- [x] `ContextBudgetManager` 统计 raw image seen/omitted bytes。
- [x] `ContextSegment`：把现有 epoch 的产品语义收敛为 internal segment，测试证明 segment 内不做全量 rebuild。

### Track B：工具调用治理

- [x] `ToolCallGovernor`：在工具执行前 allow/rewrite/deny 高噪声调用。
- [x] `rg_search`：限制 maxResults，清理空 glob/path，记录 rewrite decision。
- [x] `list_files`：限制 root/deep traversal 的 depth，避免生成巨大目录树。
- [x] `read_file`：大文件 whole-file read 在执行前 deny，并给 line range/search 替代建议。
- [x] `run_test`：阻止无界全量测试命令，要求 focused test path 或明确范围。
- [x] Governor decisions 进入 audit-visible 文本或 runtime metadata。

### Track C：工具输出卸载

- [x] `ToolOutputTruncator` 已接入 oh-my-pi `afterToolCall`。
- [x] 原始工具输出已写入 `command_traces` raw artifact。
- [x] `ToolObservation`：模型上下文收到结构化观察，而不是只有 footer。
- [x] 100K 输出测试：验证 raw output hash 与 archive 内容一致，模型只看到摘要/ref/hash/bytes。
- [x] 小输出仍归档，但不强制污染模型上下文。

### Track D：TaskRun/UserRound/Segment 审计

- [x] TaskRun / epoch 持久化已有基础表。
- [x] no-progress recovery 有 concrete tool progress 时继续，无 progress 时暂停。
- [x] 增加 `UserRound`/`ContextSegment` 运行时类型 alias 或 ledger record。
- [x] ProviderRequestSnapshot 增加 segment/user-round relation 的可回放证据。
- [x] Session HQ 后续展示 TaskRun/UserRound/Segment/ProviderRequest 四层状态。
- [x] Context Budget Debugger 支持按 ProviderRequestSnapshot 回放完整 provider-visible 输入。
- [x] 把 `xuanpu-agent-implementer.ts` 进一步拆成 `TaskRunScheduler`、`UserRoundRunner`、`ProviderRequestRecorder` 等独立模块。

### Track E：oh-my-pi-derived runtime 包边界

- [x] 新增 `@xuanpu/oh-my-pi-runtime` 主包，保留 `@xuanpu/pi-agent-core` 作为兼容 alias。
- [x] 增加 `upstream.json` 与命名 patch queue，明确 oh-my-pi `15.2.4` 基线和 Xuanpu-owned contract。
- [x] `loadPiAgentCoreModule()` 默认加载新的 runtime facade，避免 Desktop 业务直接依赖上游行为细节。
- [x] `runTurn()` contract test 覆盖 context 不 prompt-echo、fresh Agent per turn、providerSessionState 默认 disabled。

## 当前实现顺序

1. 已完成 Track B 的 `ToolCallGovernor`，覆盖高噪声工具调用，避免无效执行。
2. 已完成 Track C 的 `ToolObservation`，让输出卸载对模型和审计都可见。
3. 已完成 Track A/D 的 `ContextSegment`/`UserRound` 语义与测试，证明当前 epoch 存储可作为 internal segment。
4. 已完成 Context Budget Debugger 回放与 runtime 生命周期拆包，当前阶段不再保留功能性未完成项。
5. 已完成 oh-my-pi-derived runtime 主包边界、upstream metadata 与 contract test。

## 验收命令

最小验收：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-oh-my-pi-runtime-contract.test.ts \
  test/phase-24/xuanpu-agent-media-offload.test.ts \
  test/phase-24/xuanpu-agent-tool-output-truncation.test.ts \
  test/phase-24/xuanpu-agent-provider-request-builder.test.ts \
  test/phase-24/xuanpu-agent-provider-request-recorder.test.ts \
  test/phase-24/xuanpu-agent-implementer-prompt-path.test.ts \
  test/phase-24/xuanpu-agent-task-run-repository.test.ts \
  test/phase-24/xuanpu-agent-task-run-panel.test.tsx
```

静态检查：

```bash
pnpm exec eslint \
  src/main/services/xuanpu-agent/runtime.ts \
  src/main/services/xuanpu-agent/context/budget-manager.ts \
  src/main/services/xuanpu-agent/harness/tool-call-repair \
  src/main/services/xuanpu-agent/media-offloader.ts \
  src/main/db/task-run-repository.ts \
  src/main/db/turn-repository.ts \
  src/renderer/src/components/session-hq/XuanpuAgentTaskRunPanel.tsx \
  packages/xuanpu-oh-my-pi-runtime/src/index.ts \
  packages/xuanpu-oh-my-pi-runtime/src/agent-loop.ts
```

## 当前验证记录

- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- runtime 包边界相关 ESLint：通过，无 warning。
- xuanpu-agent 可运行验收集：24 个测试文件、138 个测试通过。
- `TaskRunScheduler` / `UserRoundRunner` 模块级测试覆盖新建/恢复 TaskRun、UserRound 起点、ContextSegment/Turn scope、失败/中止落库路径。
- `@xuanpu/oh-my-pi-runtime` contract test 覆盖 turn-scoped `runTurn()` 的核心不变量。
- `test/phase-24/xuanpu-agent-runtime-status.test.ts` 当前在 Node/Vitest 环境下因上游 `@oh-my-pi/pi-ai` 的 `bun:sqlite` 解析失败，未纳入本轮通过集；该失败早于本轮 runtime 逻辑执行。
