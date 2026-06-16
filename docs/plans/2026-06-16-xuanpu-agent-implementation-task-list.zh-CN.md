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
- [ ] `ContextSegment`：把现有 epoch 的产品语义收敛为 internal segment，测试证明 segment 内不做全量 rebuild。

### Track B：工具调用治理

- [ ] `ToolCallGovernor`：在工具执行前 allow/rewrite/deny 高噪声调用。
- [ ] `rg_search`：限制 maxResults，清理空 glob/path，记录 rewrite decision。
- [ ] `list_files`：限制 root/deep traversal 的 depth，避免生成巨大目录树。
- [ ] `read_file`：大文件 whole-file read 在执行前 deny，并给 line range/search 替代建议。
- [ ] `run_test`：阻止无界全量测试命令，要求 focused test path 或明确范围。
- [ ] Governor decisions 进入 audit-visible 文本或 runtime metadata。

### Track C：工具输出卸载

- [x] `ToolOutputTruncator` 已接入 oh-my-pi `afterToolCall`。
- [x] 原始工具输出已写入 `command_traces` raw artifact。
- [ ] `ToolObservation`：模型上下文收到结构化观察，而不是只有 footer。
- [ ] 100K 输出测试：验证 raw output hash 与 archive 内容一致，模型只看到摘要/ref/hash/bytes。
- [ ] 小输出仍归档，但不强制污染模型上下文。

### Track D：TaskRun/UserRound/Segment 审计

- [x] TaskRun / epoch 持久化已有基础表。
- [x] no-progress recovery 有 concrete tool progress 时继续，无 progress 时暂停。
- [ ] 增加 `UserRound`/`ContextSegment` 运行时类型 alias 或 ledger record。
- [ ] ProviderRequestSnapshot 增加 segment/user-round relation 的可回放证据。
- [ ] Session HQ 后续展示 TaskRun/UserRound/Segment/ProviderRequest 四层状态。

## 当前实现顺序

1. 完成 Track B 的 `ToolCallGovernor`，先覆盖高噪声工具调用，避免无效执行。
2. 完成 Track C 的 `ToolObservation`，让输出卸载对模型和审计都可见。
3. 补 Track A/D 的 `ContextSegment` 语义测试，证明当前 epoch 边界不会回到 provider-request-level rebuild。
4. 跑 targeted tests，再根据风险跑 `pnpm test` 或 xuanpu-agent 相关测试子集。

## 验收命令

最小验收：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-media-offload.test.ts \
  test/phase-24/xuanpu-agent-tool-output-truncation.test.ts \
  test/phase-24/xuanpu-agent-provider-request-builder.test.ts \
  test/phase-24/xuanpu-agent-provider-request-recorder.test.ts \
  test/phase-24/xuanpu-agent-implementer-prompt-path.test.ts
```

静态检查：

```bash
pnpm exec eslint \
  src/main/services/xuanpu-agent/runtime.ts \
  src/main/services/xuanpu-agent/context/budget-manager.ts \
  src/main/services/xuanpu-agent/harness/tool-call-repair \
  src/main/services/xuanpu-agent/media-offloader.ts
```
