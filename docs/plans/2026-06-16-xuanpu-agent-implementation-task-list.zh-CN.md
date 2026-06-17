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

### Track F：TaskRun report export

- [x] 新增 `TaskRunReport` 结构化报告，聚合 TaskRun、UserRound、ContextSegment、ProviderRequest 与 related command trace raw refs。
- [x] 报告 Markdown 保留 provider snapshot、prefix/hash、token、config、decision payload byte size 和 raw output ref，便于失败复盘。
- [x] IPC/preload 增加 `exportTaskRunReport()`，导出 `.md` / `.json` 到 app userData 下的 `xuanpu-agent/task-run-reports/`。
- [x] Session HQ TaskRun panel 增加 report export action，导出后打开生成文件。
- [x] 测试覆盖结构化报告、Markdown/JSON 文件导出、missing task-run 错误、IPC 通道和 panel action。

### Track G：Gateway context budget guard

- [x] 新增 `evaluateGatewayBudget()`，在 provider 调用前基于 150K / 220K / 250K 做 budget bucket、maintenance 和 hard pause 决策。
- [x] `XuanpuTurnBudget` / provider snapshot 记录 gateway 决策，report 与 DB replay 能复原当时的预算判断。
- [x] `xuanpu-agent-implementer.ts` 在 provider 前用 gateway cap 钳制 `packContext()`，不依赖 1M context window。
- [x] 当估算越过 hard limit 时，provider 调用前直接 pause，并写入 snapshot / task-run / turn audit。
- [x] 测试覆盖 220K maintenance、250K hard pause、1M provider window cap、snapshot/report gateway 透传。

### Track H：ContextFrameCompiler / SegmentCompactor

- [x] 新增 `ContextFrameCompiler`，在不替换现有 `packContext()` 行为的前提下，把 provider-visible context 包装成可审计 frame。
- [x] `ContextFrame` 记录 `frameId`、`buildReason`、TaskRun/UserRound/ContextSegment scope、provider messages、retrieved episodes 和 packer decisions。
- [x] `ContextFrame` 增加 zone ledger 与 raw-ref ledger，暴露 frozen/retrieved/working-set included/omitted 证据。
- [x] `xuanpu-agent-implementer.ts` 的 user-round start、segment boundary、gateway compact 路径统一使用 `ContextFrameCompiler`。
- [x] 新增 `SegmentCompactor`，复用既有 episode freezer 选择规则，产出 deterministic rule-based fallback episode create data。
- [x] `SegmentCompactor` 记录 selected/kept recent message ids、`firstKeptEntryId`、TaskRun/ContextSegment scope 和 provider-native audit 摘要。
- [x] provider-native `preserveData` 归档到本地 replay archive，并把 `ref` / `sha256` / `bytes` / replay summary 写入 episode metadata。
- [x] `IdeFieldProvider.freezeEpisodes()` 接入 `SegmentCompactor`，继续保留原有 model summarizer 路径，并把 compaction audit 写入 episode metadata。

### Track I：独立 `@xuanpu/agent-cli` 首批骨架

- [x] 新增 `packages/xuanpu-agent-cli` workspace package，提供 source-first CLI API、package metadata、bin/build/typecheck 边界。
- [x] `collectCliFieldContext()` 支持从任意 cwd 解析 git project root，读取 `AGENTS.md`、`CLAUDE.md`、Codex/Copilot/Cursor 规则、Git status 和项目本地 SQLite 路径。
- [x] CLI 事件使用 CanonicalAgentEvent-compatible NDJSON envelope，包含 `sessionId`、`runtimeId: xuanpu-agent`、`sessionSequence`、`runEpoch`、`turnId`。
- [x] 支持 one-shot `run` 与 `interactive` 编排，interactive 复用同一 CLI session。
- [x] Runner 做成 injectable `XuanpuAgentCliRunner`，默认 dry-run runner 可在无 provider/auth 时验证 CLI 现场和事件链路。
- [x] 新增 `createOhMyPiRuntimeRunner()`，通过 runtime dynamic import 接入 `@xuanpu/oh-my-pi-runtime`，不复制 Desktop implementer。
- [x] real-provider runner 接入 CLI coding tools：`read_file`、`rg_search`、`run_test`，以及 `--allow-writes` 下的 `write_file`。
- [x] CLI 包入口切到 `dist`，`bin.xuanpu-agent` 指向编译产物，`pnpm pack` 可生成包含 dist/bin 的 tarball。
- [x] RPC/ACP bridge：新增 `rpc` / `acp` 子命令，支持 stdio newline-delimited JSON-RPC 2.0、session/new、session/prompt、shutdown 和 CanonicalAgentEvent-compatible stream notification。

### Track J：OpenAI remote compact preserve-data replay / audit

- [x] provider-native `preserveData` 通过本地 archive store 按 sha256 落盘，保留可回放 ref。
- [x] `ContextFrameCompiler` 将 frozen / retrieved episode 里的 provider-native replay refs 汇总进 frame ledger。
- [x] `XuanpuProviderRequestSnapshot` / recorder / task-run report 都暴露 `providerNativeReplay`，便于审计和导出。
- [x] 测试覆盖 archive、summary、metadata 抽取、provider request hash、recorder 和 task-run report。
- [x] OpenAI/OpenAI-Codex compaction model 且有 API key 时，`IdeFieldProvider.freezeEpisodes()` 主动调用 `/responses/compact`，读取上一轮 replacementHistory，失败时回退本地/model summarizer。
- [x] `/responses/compact` 返回的 provider-native `preserveData` 只进入本地 archive，episode metadata 只保存 ref/sha/path/summary，避免 encrypted provider content 污染上下文。

### Track K：v16.x upgrade spike

- [x] 新增 `docs/plans/2026-06-17-oh-my-pi-v16-upgrade-spike.zh-CN.md`，记录当前基线 `15.2.4`、上游最新 `v16.0.3`、风险面、diff 范围、contract tests 和升级门槛。
- [x] 明确本轮不直接整包升级 v16.x；后续必须在独立 spike 分支回收 provider/compaction 层可测补丁。

### Track L：包发布边界

- [x] `@xuanpu/oh-my-pi-runtime` 增加独立 `tsconfig.json`、`build` / `typecheck` / `pack:local` 脚本，npm 入口切到 `dist`，发布文件包含 `dist`、`upstream.json` 和 patch queue。
- [x] `@xuanpu/pi-agent-core` 兼容 alias 增加独立 `tsconfig.json`、dist exports 和 pack 边界，继续依赖 `@xuanpu/oh-my-pi-runtime`。
- [x] 新增 `docs/plans/2026-06-17-xuanpu-agent-package-publishing.zh-CN.md`，记录 runtime -> alias -> CLI 的发布顺序、本地 pack 验证和仍需外部确认的 npm 权限/版本策略。

### Track M：本地 tarball 安装 smoke

- [x] 新增 `scripts/xuanpu-agent-package-install-smoke.mjs`，自动 build 三个包、pack 到临时目录、安装到空项目，并验证 `xuanpu-agent` bin。
- [x] smoke 覆盖 `xuanpu-agent --help`、`xuanpu-agent run --dry-run`、CLI 子路径 export、runtime/alias package export map 和 `upstream.json`。
- [x] 根脚本新增 `probe:xuanpu-agent-package-install`，作为 npm publish 前不依赖 npm 权限的本地安装门禁。
- [x] contract test 锁住 smoke 脚本入口，避免发布边界后续退化成只检查 `package.json`。

## 当前实现顺序

1. 已完成 Track B 的 `ToolCallGovernor`，覆盖高噪声工具调用，避免无效执行。
2. 已完成 Track C 的 `ToolObservation`，让输出卸载对模型和审计都可见。
3. 已完成 Track A/D 的 `ContextSegment`/`UserRound` 语义与测试，证明当前 epoch 存储可作为 internal segment。
4. 已完成 Context Budget Debugger 回放与 runtime 生命周期拆包，当前阶段仍保留后续大项。
5. 已完成 oh-my-pi-derived runtime 主包边界、upstream metadata 与 contract test。
6. 已完成 TaskRun report export，Session HQ 可一键导出任务复盘文件。
7. 已完成 Gateway context budget guard，provider 调用前不再依赖 1M 上下文。
8. 已完成 ContextFrameCompiler / SegmentCompactor 的首批落地，具备 frame 级审计和 segment compaction audit 基础。
9. 已完成独立 `@xuanpu/agent-cli` 首批骨架，具备降级 FieldProvider、one-shot/interactive 编排和可测试事件输出。
10. 已完成 OpenAI remote compact preserve-data replay / audit，具备 archive、frame ledger、request snapshot 和 report 导出链路。
11. 已完成 `@xuanpu/agent-cli` 的基础 real-provider coding tool loop 与 dist/bin/pack 边界。
12. 已完成 `@xuanpu/agent-cli` 的最小 JSON-RPC/ACP stdio bridge，事件仍使用 Xuanpu canonical-compatible envelope。
13. 已完成 OpenAI remote compact live path：按 compaction model/provider/key 条件主动请求 `/responses/compact`，并把 preserveData 归档为 replay ref。
14. 已完成 v16.x upgrade spike 文档，实际升级后续单独分支推进。
15. 已完成 `@xuanpu/oh-my-pi-runtime` / `@xuanpu/pi-agent-core` / `@xuanpu/agent-cli` 的包发布边界定义和 dist build 验证。
16. 已完成本地 tarball 安装 smoke，证明三个发布包装进空项目后 CLI bin、dry-run 事件链路和关键 exports 可用。

## 仍待落实的大项

- 真正执行 npm publish 前，还需要确认 `@xuanpu` npm scope 权限、automation token、release tag/changelog 规则，以及 runtime 版本线是否继续跟随上游 `15.2.4`。
- 实际 v16.x 升级不属于本轮落地范围；已完成 spike 文档，后续应在独立分支做 API diff、contract tests 和 patch queue 更新。

## 验收命令

最小验收：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-oh-my-pi-runtime-contract.test.ts \
  test/phase-24/xuanpu-agent-media-offload.test.ts \
  test/phase-24/xuanpu-agent-tool-output-truncation.test.ts \
  test/phase-24/xuanpu-agent-cli.test.ts \
  test/phase-24/xuanpu-agent-context-frame-compiler.test.ts \
  test/phase-24/xuanpu-agent-segment-compactor.test.ts \
  test/phase-24/xuanpu-agent-provider-native-compaction.test.ts \
  test/phase-24/xuanpu-agent-task-run-policy.test.ts \
  test/phase-24/xuanpu-agent-provider-request-builder.test.ts \
  test/phase-24/xuanpu-agent-provider-request-recorder.test.ts \
  test/phase-24/xuanpu-agent-implementer-prompt-path.test.ts \
  test/phase-24/xuanpu-agent-task-run-repository.test.ts \
  test/phase-24/xuanpu-agent-task-run-report.test.ts \
  test/phase-24/xuanpu-agent-task-run-panel.test.tsx
```

静态检查：

```bash
pnpm exec eslint \
  packages/xuanpu-agent-cli/src \
  test/phase-24/xuanpu-agent-cli.test.ts \
  src/main/services/xuanpu-agent/context/context-frame-compiler.ts \
  src/main/services/xuanpu-agent/context/segment-compactor.ts \
  src/main/services/xuanpu-agent/context/provider-native-compaction.ts \
  src/main/services/xuanpu-agent/task-run-policy.ts \
  src/main/services/xuanpu-agent/turn/turn-snapshot.ts \
  src/main/services/xuanpu-agent/turn/provider-request-recorder.ts \
  src/main/services/xuanpu-agent-implementer.ts \
  src/main/services/xuanpu-agent/runtime.ts \
  src/main/services/xuanpu-agent/context/budget-manager.ts \
  src/main/services/xuanpu-agent/harness/tool-call-repair \
  src/main/services/xuanpu-agent/media-offloader.ts \
  src/main/db/task-run-repository.ts \
  src/main/db/turn-repository.ts \
  src/renderer/src/components/session-hq/XuanpuAgentTaskRunPanel.tsx \
  src/main/services/xuanpu-agent/task-run-report.ts \
  packages/xuanpu-oh-my-pi-runtime/src/index.ts \
  packages/xuanpu-oh-my-pi-runtime/src/agent-loop.ts
```

## 当前验证记录

- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- runtime/report export/provider-native replay 相关 ESLint：通过，无 warning。
- xuanpu-agent 可运行验收集：25 个测试文件、143 个测试通过。
- `pnpm build`：通过，保留既有 Vite dynamic import chunking warnings。
- `TaskRunScheduler` / `UserRoundRunner` 模块级测试覆盖新建/恢复 TaskRun、UserRound 起点、ContextSegment/Turn scope、失败/中止落库路径。
- `@xuanpu/oh-my-pi-runtime` contract test 覆盖 turn-scoped `runTurn()` 的核心不变量。
- `TaskRunReport` 测试覆盖结构化报告、Markdown/JSON 文件导出、ProviderRequest replay refs、related command trace raw refs、missing task-run 错误路径。
- Gateway budget guard 测试覆盖 220K maintenance compact、250K hard pause、1M provider context window cap、snapshot/report gateway audit。
- `ContextFrameCompiler` / `SegmentCompactor` 测试覆盖 frame metadata、zone/raw-ref ledger、stable frame id、rule-based fallback、existing episode 去重、provider-native preserve data archive / replay audit。
- `ProviderNativeCompactionArchiveStore` 测试覆盖 OpenAI remote compaction preserveData summary、stable sha ref、archive path 和 metadata replay ref 抽取。
- `pnpm vitest run test/phase-24/xuanpu-agent-provider-native-compaction.test.ts test/phase-24/xuanpu-agent-segment-compactor.test.ts test/phase-24/xuanpu-agent-context-frame-compiler.test.ts test/phase-24/xuanpu-agent-provider-request-builder.test.ts test/phase-24/xuanpu-agent-provider-request-recorder.test.ts test/phase-24/xuanpu-agent-task-run-report.test.ts`：6 个测试文件、28 个测试通过。
- `git diff --check`：通过。
- `pnpm vitest run test/phase-24/xuanpu-agent-context-frame-compiler.test.ts test/phase-24/xuanpu-agent-segment-compactor.test.ts test/phase-24/xuanpu-agent-context-packer.test.ts test/phase-24/xuanpu-agent-context-steady-state.test.ts test/phase-24/xuanpu-agent-implementer-prompt-path.test.ts test/phase-24/xuanpu-agent-episode-freezer.test.ts test/phase-24/xuanpu-agent-episode-summarizer.test.ts`：7 个测试文件、63 个测试通过。
- `@xuanpu/agent-cli` 测试覆盖 project-local rules/Git/SQLite 采集、one-shot/interactive 编排、CanonicalAgentEvent-compatible NDJSON 输出、CLI coding tools、runtime runner tool/context 注入和 package dist/bin exports。
- `pnpm vitest run test/phase-24/xuanpu-agent-cli.test.ts`：1 个测试文件、8 个测试通过。
- `pnpm --filter @xuanpu/agent-cli typecheck`：通过。
- `pnpm --filter @xuanpu/agent-cli build`：通过。
- `pnpm --filter @xuanpu/agent-cli pack --pack-destination /tmp/xuanpu-agent-cli-pack`：通过，tarball 包含 dist JS/d.ts 与 package metadata。
- `pnpm vitest run test/phase-24/xuanpu-agent-provider-native-compaction.test.ts test/phase-24/xuanpu-agent-auto-freeze.test.ts test/phase-24/xuanpu-agent-cli.test.ts`：3 个测试文件、22 个测试通过。
- `pnpm --filter @xuanpu/agent-cli typecheck`：通过。
- `pnpm --filter @xuanpu/agent-cli build`：通过。
- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- `pnpm vitest run test/phase-24/xuanpu-oh-my-pi-runtime-contract.test.ts`：1 个测试文件、4 个测试通过。
- `pnpm --filter @xuanpu/oh-my-pi-runtime typecheck && pnpm --filter @xuanpu/oh-my-pi-runtime build && pnpm --filter @xuanpu/pi-agent-core typecheck && pnpm --filter @xuanpu/pi-agent-core build && pnpm --filter @xuanpu/agent-cli typecheck && pnpm --filter @xuanpu/agent-cli build`：通过。
- `pnpm --filter @xuanpu/oh-my-pi-runtime pack --pack-destination /tmp/xuanpu-agent-package-pack && pnpm --filter @xuanpu/pi-agent-core pack --pack-destination /tmp/xuanpu-agent-package-pack && pnpm --filter @xuanpu/agent-cli pack --pack-destination /tmp/xuanpu-agent-package-pack`：通过，tarball 中 workspace 依赖已转换为具体版本。
- `pnpm run probe:xuanpu-agent-package-install`：通过，临时空项目安装 runtime/alias/CLI tarball 后，`xuanpu-agent --help`、`xuanpu-agent run --dry-run`、CLI 子路径 exports、runtime/alias export map 和 `upstream.json` 均可验证。
- `test/phase-24/xuanpu-agent-runtime-status.test.ts` 当前在 Node/Vitest 环境下因上游 `@oh-my-pi/pi-ai` 的 `bun:sqlite` 解析失败，未纳入本轮通过集；该失败早于本轮 runtime 逻辑执行。
