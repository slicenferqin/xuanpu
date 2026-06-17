# Xuanpu Agent 阶段性交付验收文档

日期：2026-06-17

验收对象：

- 仓库：`slicenferqin/xuanpu`
- 本地工作区：`/Users/slicenfer/.xuanpu-worktrees/xuanpu/xuanpu--schnauzer`
- 分支：`feat/xuanpu-agent-oh-my-pi`
- 功能交付基线提交：`6c882a26 chore: clean xuanpu agent lint guard`
- 主要交付范围：基于 oh-my-pi-derived runtime 的 Xuanpu Agent 首批可运行闭环

关联文档：

- `docs/plans/2026-06-16-xuanpu-agent-implementation-task-list.zh-CN.md`
- `docs/plans/2026-06-17-xuanpu-agent-package-publishing.zh-CN.md`
- `docs/plans/2026-06-17-oh-my-pi-v16-upgrade-spike.zh-CN.md`
- `docs/plans/2026-06-16-xuanpu-agent-oh-my-pi-product-architecture.zh-CN.html`

## 1. 验收结论建议

本轮建议按“通过，有明确后续外部项”验收。

通过范围：

- Track A-M 已落地为代码、测试、脚本或文档，并已推送到 `origin/feat/xuanpu-agent-oh-my-pi`。
- 关键能力已覆盖：上下文预算、图片/媒体卸载、工具调用治理、工具输出卸载、TaskRun/UserRound/ContextSegment 审计、ContextFrame/SegmentCompactor、OpenAI provider-native compact replay archive、独立 CLI、JSON-RPC/ACP bridge、包发布边界、本地 tarball 安装 smoke。
- 当前可用命令能证明本轮产物可构建、可测试、可本地安装、可用 CLI dry-run 验证。

非本轮通过条件：

- 不要求完成真实 npm publish。
- 不要求完成 oh-my-pi v16.x 实际升级。
- 不要求在无 provider credential 的情况下完成真实模型调用。
- 不要求解决 `@oh-my-pi/pi-ai` 在 Node/Vitest 环境中对 `bun:sqlite` 的上游导入副作用。

## 2. 验收范围

| Track   | 验收项                                  | 当前状态 | 验收信号                                              |
| ------- | --------------------------------------- | -------- | ----------------------------------------------------- |
| Track A | 上下文与媒体预算                        | 已完成   | 图片归档、后续请求保留 ref、预算统计与测试覆盖        |
| Track B | 工具调用治理                            | 已完成   | `ToolCallGovernor` rewrite/deny/allow 测试覆盖        |
| Track C | 工具输出卸载                            | 已完成   | 大输出归档、模型只见摘要/ref/hash/bytes               |
| Track D | TaskRun/UserRound/Segment 审计          | 已完成   | repository、provider snapshot、UI panel 测试覆盖      |
| Track E | oh-my-pi-derived runtime 包边界         | 已完成   | `@xuanpu/oh-my-pi-runtime`、alias、`runTurn` contract |
| Track F | TaskRun report export                   | 已完成   | Markdown/JSON report 导出测试覆盖                     |
| Track G | Gateway context budget guard            | 已完成   | 150K/220K/250K 决策、hard pause、snapshot/report 透传 |
| Track H | ContextFrameCompiler / SegmentCompactor | 已完成   | frame ledger、zone/raw-ref ledger、compaction audit   |
| Track I | 独立 `@xuanpu/agent-cli`                | 已完成   | CLI package、dry-run、coding tools、dist/bin          |
| Track J | OpenAI remote compact replay/audit      | 已完成   | preserveData archive、replay refs、report 导出        |
| Track K | v16.x upgrade spike                     | 已完成   | 已输出独立 spike 文档，实际升级拆出后续分支           |
| Track L | 包发布边界                              | 已完成   | runtime -> alias -> CLI 构建/pack 顺序明确            |
| Track M | 本地 tarball 安装 smoke                 | 已完成   | 临时空项目安装三个 tarball，CLI dry-run 可运行        |

## 3. 逐项验收清单

### 3.1 上下文窗口与媒体控制

- [ ] `MediaOffloader` 能按 sha256 归档图片。
- [ ] 同一图片完成识别后，后续 provider request 不再持续携带 raw image block。
- [ ] `ContextBudgetManager` 能统计 raw image seen/omitted bytes。
- [ ] Gateway guard 在 provider 调用前执行预算判断，不依赖 1M 上下文窗口。
- [ ] 220K maintenance compact、250K hard pause、1M provider cap 有测试覆盖。

验收命令：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-media-offload.test.ts \
  test/phase-24/xuanpu-agent-provider-request-builder.test.ts \
  test/phase-24/xuanpu-agent-provider-request-recorder.test.ts
```

### 3.2 工具调用治理与工具输出卸载

- [ ] `ToolCallGovernor` 能限制高噪声 `rg_search`、`list_files`、`read_file`、`run_test`。
- [ ] 大文件 whole-file read 会被 deny，并给出 line range/search 替代建议。
- [ ] 无界全量测试命令会被阻止，要求 focused test path 或明确范围。
- [ ] 大工具输出写入 raw artifact，模型上下文只接收结构化 `ToolObservation`。
- [ ] 100K 级输出能验证 raw output hash 与 archive 内容一致。

验收命令：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-tool-policy.test.ts \
  test/phase-24/xuanpu-agent-tool-call-governor.test.ts \
  test/phase-24/xuanpu-agent-tool-output-truncation.test.ts
```

### 3.3 TaskRun / UserRound / ContextSegment 审计

- [ ] TaskRun / epoch / UserRound / ContextSegment 语义可落库和回放。
- [ ] no-progress recovery 能在有 concrete tool progress 时继续，无 progress 时暂停。
- [ ] ProviderRequestSnapshot 保留 segment/user-round relation。
- [ ] TaskRun report 能聚合 provider snapshot、gateway audit、raw command refs。
- [ ] Session HQ TaskRun panel 能触发 report export。

验收命令：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-task-run-repository.test.ts \
  test/phase-24/xuanpu-agent-task-run-policy.test.ts \
  test/phase-24/xuanpu-agent-task-run-report.test.ts \
  test/phase-24/xuanpu-agent-task-run-panel.test.tsx
```

### 3.4 ContextFrameCompiler / SegmentCompactor / provider-native replay

- [ ] `ContextFrameCompiler` 生成 frame id、build reason、scope、provider messages。
- [ ] frame ledger 暴露 frozen/retrieved/working-set included/omitted 证据。
- [ ] `SegmentCompactor` 产出 deterministic fallback episode create data。
- [ ] provider-native `preserveData` 归档到本地 archive，只在 metadata 中保留 ref/sha/path/summary。
- [ ] OpenAI/OpenAI-Codex compaction model 且有 API key 时，会尝试 `/responses/compact`；失败时回退本地/model summarizer。

验收命令：

```bash
pnpm vitest run \
  test/phase-24/xuanpu-agent-context-frame-compiler.test.ts \
  test/phase-24/xuanpu-agent-segment-compactor.test.ts \
  test/phase-24/xuanpu-agent-provider-native-compaction.test.ts \
  test/phase-24/xuanpu-agent-auto-freeze.test.ts
```

### 3.5 oh-my-pi-derived runtime 包边界

- [ ] `@xuanpu/oh-my-pi-runtime` 是主 runtime facade。
- [ ] `@xuanpu/pi-agent-core` 是兼容 alias。
- [ ] `upstream.json` 记录 oh-my-pi `v15.2.4` 基线、上游包版本和 Xuanpu-owned contract。
- [ ] `runTurn()` 保证 contextMessages 只通过 `replaceMessages()` 进入上下文，不发生 prompt echo。
- [ ] 每轮 `runTurn()` fresh Agent，默认不转发 `providerSessionState`。

验收命令：

```bash
pnpm vitest run test/phase-24/xuanpu-oh-my-pi-runtime-contract.test.ts
```

### 3.6 独立 CLI、RPC/ACP bridge 与本地安装

- [ ] `@xuanpu/agent-cli` 可 build、pack、安装。
- [ ] CLI 能读取 project-local rules、Git status、SQLite path。
- [ ] one-shot `run` 和 `interactive` 复用事件 envelope。
- [ ] dry-run runner 在无 provider/auth 时可验证 CLI 现场和事件链路。
- [ ] JSON-RPC/ACP bridge 支持 initialize、session/new、session/prompt、cancel、shutdown、exit。
- [ ] tarball 安装到临时空项目后，`xuanpu-agent --help` 和 `xuanpu-agent run --dry-run` 可运行。

验收命令：

```bash
pnpm vitest run test/phase-24/xuanpu-agent-cli.test.ts
pnpm run probe:xuanpu-agent-package-install
```

## 4. 一键验收命令

### 4.1 最小验收测试集

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

期望结果：

- `14 passed`
- `105 passed`

当前实测结果：

- 2026-06-17 已通过。
- 测试输出中可能出现既有 SQLite migration stderr 噪声，但 Vitest result 为 passed。

### 4.2 静态检查

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

期望结果：

- exit code `0`
- 无 error
- 无 warning

当前实测结果：

- 2026-06-17 已通过。

### 4.3 TypeScript 工程检查

```bash
pnpm exec tsc -p tsconfig.json --noEmit
```

期望结果：

- exit code `0`

当前实测结果：

- 2026-06-17 已通过。

### 4.4 本地发布安装 smoke

```bash
pnpm run probe:xuanpu-agent-package-install
```

期望结果：

- build `@xuanpu/oh-my-pi-runtime`
- build `@xuanpu/pi-agent-core`
- build `@xuanpu/agent-cli`
- pack 三个 tarball
- 在临时空项目安装三个 tarball
- `xuanpu-agent --help` 成功
- `xuanpu-agent run --dry-run "package install smoke"` 输出：
  - `session.materialized`
  - `session.updated`
  - `session.status`
  - `message.updated`
  - `session.status`
  - `session.idle`
- 能解析：
  - `@xuanpu/agent-cli`
  - `@xuanpu/agent-cli/runner`
  - `@xuanpu/agent-cli/rpc-bridge`
  - `@xuanpu/oh-my-pi-runtime`
  - `@xuanpu/oh-my-pi-runtime/agent-loop`
  - `@xuanpu/oh-my-pi-runtime/upstream.json`
  - `@xuanpu/pi-agent-core`
  - `@xuanpu/pi-agent-core/agent-loop`

当前实测结果：

- 2026-06-17 已通过。

## 5. 交付文件索引

### 5.1 Runtime 与 CLI 包

| 文件                                                 | 用途                                    |
| ---------------------------------------------------- | --------------------------------------- |
| `packages/xuanpu-oh-my-pi-runtime/package.json`      | runtime 发布边界、exports、files        |
| `packages/xuanpu-oh-my-pi-runtime/upstream.json`     | 上游基线与 Xuanpu contract              |
| `packages/xuanpu-oh-my-pi-runtime/src/index.ts`      | runtime facade                          |
| `packages/xuanpu-oh-my-pi-runtime/src/agent-loop.ts` | turn-scoped `runTurn()`                 |
| `packages/xuanpu-pi-agent-core/package.json`         | 兼容 alias 发布边界                     |
| `packages/xuanpu-pi-agent-core/src/index.ts`         | alias re-export                         |
| `packages/xuanpu-agent-cli/package.json`             | CLI package/bin/exports                 |
| `packages/xuanpu-agent-cli/src/cli.ts`               | CLI main、run/interactive/rpc/acp       |
| `packages/xuanpu-agent-cli/src/rpc-bridge.ts`        | JSON-RPC/ACP bridge                     |
| `packages/xuanpu-agent-cli/src/runner.ts`            | dry-run runner 与 oh-my-pi runtime 接入 |
| `packages/xuanpu-agent-cli/src/tools.ts`             | CLI coding tools                        |
| `scripts/xuanpu-agent-package-install-smoke.mjs`     | 本地 tarball 安装验收 smoke             |

### 5.2 上下文、压缩与审计

| 文件                                                                   | 用途                                     |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| `src/main/services/xuanpu-agent/context/budget-manager.ts`             | 上下文预算与 gateway guard               |
| `src/main/services/xuanpu-agent/context/context-frame-compiler.ts`     | provider-visible frame 编译与 ledger     |
| `src/main/services/xuanpu-agent/context/segment-compactor.ts`          | segment compaction 与 fallback episode   |
| `src/main/services/xuanpu-agent/context/provider-native-compaction.ts` | provider-native preserveData archive     |
| `src/main/services/xuanpu-agent/media-offloader.ts`                    | 图片/media offload                       |
| `src/main/services/xuanpu-agent/turn/provider-request-recorder.ts`     | provider request snapshot/replay         |
| `src/main/services/xuanpu-agent/task-run-report.ts`                    | TaskRun report export                    |
| `src/main/services/xuanpu-agent-implementer.ts`                        | Xuanpu Agent prompt path integration     |
| `src/main/db/task-run-repository.ts`                                   | TaskRun/UserRound/ContextSegment 持久化  |
| `src/renderer/src/components/session-hq/XuanpuAgentTaskRunPanel.tsx`   | Session HQ TaskRun panel / report action |

### 5.3 验收测试

| 测试文件                                                        | 覆盖重点                                 |
| --------------------------------------------------------------- | ---------------------------------------- |
| `test/phase-24/xuanpu-oh-my-pi-runtime-contract.test.ts`        | runtime contract、package publishability |
| `test/phase-24/xuanpu-agent-cli.test.ts`                        | CLI、tools、RPC/ACP、dist/bin exports    |
| `test/phase-24/xuanpu-agent-media-offload.test.ts`              | 图片/media offload                       |
| `test/phase-24/xuanpu-agent-tool-output-truncation.test.ts`     | 工具输出归档与摘要                       |
| `test/phase-24/xuanpu-agent-provider-native-compaction.test.ts` | preserveData archive/replay refs         |
| `test/phase-24/xuanpu-agent-context-frame-compiler.test.ts`     | ContextFrame ledger                      |
| `test/phase-24/xuanpu-agent-segment-compactor.test.ts`          | SegmentCompactor                         |
| `test/phase-24/xuanpu-agent-provider-request-builder.test.ts`   | provider request/gateway context         |
| `test/phase-24/xuanpu-agent-provider-request-recorder.test.ts`  | snapshot recorder                        |
| `test/phase-24/xuanpu-agent-task-run-repository.test.ts`        | TaskRun/UserRound/Segment persistence    |
| `test/phase-24/xuanpu-agent-task-run-report.test.ts`            | report export                            |
| `test/phase-24/xuanpu-agent-task-run-panel.test.tsx`            | Session HQ panel action                  |

## 6. 不纳入本轮验收的问题

### 6.1 npm publish

真实 npm publish 不属于本轮代码验收。发布前仍需要确认：

- `@xuanpu` npm scope owner / automation token。
- release tag / changelog 规则。
- runtime 版本线是否继续跟随上游 `15.2.4`，还是切换到 Xuanpu 自有 semver。
- 是否真的需要发布 compat alias `@xuanpu/pi-agent-core`。

本轮只验收本地 publishability：

- package exports
- dist build
- tarball pack
- 临时项目安装 smoke

### 6.2 oh-my-pi v16.x 实际升级

v16.x 实际升级不属于本轮分支。当前已交付的是：

- v16.x spike 文档。
- v15.2.4 基线上的 Xuanpu-owned runtime contract。
- 后续独立分支应做 API diff、contract tests、patch queue 更新。

### 6.3 `xuanpu-agent-runtime-status.test.ts`

`test/phase-24/xuanpu-agent-runtime-status.test.ts` 当前未纳入本轮通过集。

原因：

- 上游 `@oh-my-pi/pi-ai` 在 Node/Vitest 环境中存在 `bun:sqlite` 导入副作用。
- 该失败早于本轮 runtime 逻辑执行，不作为本轮功能失败判定。

## 7. 验收判定表

| 类别       | 判定标准                                       | 结果 |
| ---------- | ---------------------------------------------- | ---- |
| 代码实现   | Track A-M 对应能力已落到代码或脚本             | 通过 |
| 测试覆盖   | 最小验收测试集通过                             | 通过 |
| 静态检查   | ESLint scoped check 无 error/warning           | 通过 |
| 类型检查   | `pnpm exec tsc -p tsconfig.json --noEmit` 通过 | 通过 |
| 本地安装   | 三个 tarball 可安装到临时空项目                | 通过 |
| CLI 可运行 | `xuanpu-agent --help` 与 dry-run 可执行        | 通过 |
| 发布边界   | build/pack/install smoke 已覆盖                | 通过 |
| 外部发布   | 依赖 npm 权限和版本策略，不纳入本轮            | 排除 |
| v16 升级   | 已输出 spike 文档，实际升级后续独立分支        | 排除 |

## 8. 验收签收区

验收人：

- 姓名：
- 日期：
- 结论：通过 / 有条件通过 / 不通过

验收备注：

```text

```

如判定为“有条件通过”，建议只记录外部项：

- npm scope / token / release automation。
- v16.x 独立升级分支。
- 真实 provider credential 下的 dogfood 验收。

## 9. 附：当前工作区说明

当前分支已经推送。以下文件或目录是本轮验收文档之外的既有未提交内容，未纳入本轮代码交付判断：

- `.agent/workflows/cat-a6faec59.json`
- `.agent/workflows/git-status-1cbcddbd.json`
- `.codegraph/`
- `.codex/`
- `.mimocode/`
- `docs/architecture/xuanpu-agent-task-run/`
