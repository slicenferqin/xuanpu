# Claude Opus 4.8 / Dynamic Workflows 适配方案

日期：2026-05-30
状态：规划中
范围：Claude Code runtime、模型/effort 选择、Session HQ、slash commands、usage/cost 可观测性

## 0. 结论

这次不是只加一个 `claude-opus-4-8` 模型名。对玄圃来说，真正需要适配的是：

1. **Opus 4.8 成为 Claude Code `opus` alias 在 Anthropic API 上的新推荐目标**，并要求 Claude Code v2.1.154+。
2. **effort 层级扩展到 `xhigh`**，且 Opus 4.8 支持 `low / medium / high / xhigh / max`。
3. **`ultracode` 不是 API effort 值**，而是 Claude Code 会话级设置：发送 `xhigh` 给模型，并允许 Claude 自动决定何时启动 dynamic workflow。
4. **dynamic workflow 是后台运行的脚本化多 subagent 编排**，它有独立的运行、审批、进度、token/cost、保存复用、暂停恢复语义。
5. **`/workflows` 已经是 Claude Code 的管理入口**，但玄圃不能只把它当普通 slash command；至少要避免吞掉它的进度和审批语义，理想状态是把它映射成 Session HQ 的“后台任务”视图。

建议分两步走：

- **M0 快速兼容**：升级模型元数据、effort variants、Claude CLI 版本检查、`ultracode` 会话开关、`/workflows` 命令透传和成本警告。
- **M1 原生体验**：引入 `workflow` runtime capability、workflow run store、Session HQ 后台任务面板、workflow 审批卡、phase/agent/token 进度解析、saved workflow 管理。

## 1. 官方信息核准

### 1.1 Opus 4.8

Anthropic 在 2026-05-28 发布 Opus 4.8。官方新闻稿确认：

- Opus 4.8 基于 Opus 4.7 改进，同价发布。
- claude.ai 增加用户控制 effort 的能力。
- Claude Code 增加 dynamic workflows，用于更大规模问题。
- Opus 4.8 fast mode 可达到约 2.5x 速度，且比之前模型便宜三倍。
- Opus 4.8 默认 high effort；`extra` 在 Claude Code 中对应 `xhigh`；官方建议困难任务和长时间异步 workflow 使用 extra/xhigh。

### 1.2 Claude Code model config

Claude Code 文档确认：

- 在 Anthropic API 上，`opus` alias 解析为 Opus 4.8，`sonnet` alias 解析为 Sonnet 4.6。
- 要显式 pin，可用完整模型名，例如 `claude-opus-4-8`，或设置 `ANTHROPIC_DEFAULT_OPUS_MODEL`。
- Opus 4.8 要求 Claude Code v2.1.154 或更高。
- Opus 4.8 / Opus 4.7 支持 `low / medium / high / xhigh / max`。
- 默认 effort：Opus 4.8 是 `high`，Opus 4.7 是 `xhigh`。
- `low / medium / high / xhigh` 可跨 session 持久化；`max` 默认只作用于当前 session，除非通过 `CLAUDE_CODE_EFFORT_LEVEL`。
- `/effort` 菜单提供 `ultracode`，但它不是 `effortLevel`、`--effort` 或 `CLAUDE_CODE_EFFORT_LEVEL` 的值。
- `ultracode` 可通过 `/effort`、`--settings` 的 `"ultracode": true`，或 Agent SDK control request 开启。

### 1.3 API effort

Claude API 文档确认：

- `effort` 是统一控制 token 消耗倾向的参数，不需要 beta header。
- 支持模型包括 Claude Opus 4.8、Mythos Preview、Opus 4.7、Opus 4.6、Sonnet 4.6、Opus 4.5。
- 对 Opus 4.6 / Sonnet 4.6，`effort` 取代 `budget_tokens` 成为推荐方式；旧 `budget_tokens` 已进入弃用路径。
- 推荐把 `effort` 和 adaptive thinking 组合使用。
- `high` 等同于不设置 effort。
- `effort` 影响文本、工具调用参数和 extended thinking 等全部输出 token，而不是只影响 thinking token。
- API effort 层级包括 `low / medium / high / xhigh / max`，其中 `xhigh` 只在 Opus 4.8 / Opus 4.7 可用，典型场景是 30 分钟以上的长程 agentic/coding 任务。

### 1.4 Dynamic workflows

Claude Code workflows 文档确认：

- Dynamic workflows 处于 research preview。
- 需要 Claude Code v2.1.154+。
- 适用于所有 paid plans、Anthropic API、Bedrock、Vertex AI、Microsoft Foundry。
- Pro 用户需在 `/config` 的 Dynamic workflows 行开启。
- Workflow 是 Claude 编写的 JavaScript 编排脚本，由 runtime 在后台执行，session 仍保持响应。
- 适合 codebase-wide bug sweep、500-file migration、cross-checked research、从多个角度 stress-test 高风险计划。
- `/deep-research` 是内置 workflow；用户保存的 workflow 会作为 command 出现在 slash autocomplete 中。
- `/workflows` 是查看和管理 workflow run 的入口；官方 progress view 展示每个 phase 的 agent 数、token total、elapsed time，并可 drill down 到各 agent 的发现。
- workflow launch 有审批语义；Desktop approval card 会展示 workflow 名称、phase list 和 token caution，并提供 Once / Always / Deny。
- 在 bypass permissions、`claude -p` 和 Agent SDK 中没有交互式 launch prompt，run 会直接开始。
- workflow spawn 的 subagents 总是以 `acceptEdits` 运行并继承 tool allowlist；file edits 自动批准；shell/web/MCP 如果不在 allowlist 仍可能 mid-run prompt。
- 官方明确提醒 dynamic workflows 可能比普通 Claude Code session 消耗更多 token。

## 2. 当前玄圃基线

### 2.1 已经具备的基础

- `src/main/services/claude-code-implementer.ts` 已通过 Claude Agent SDK 驱动 Claude Code，并设置 `thinking: adaptive`、`effort`、`includePartialMessages`、file checkpointing、MCP servers、tool approval callback。
- `src/main/services/agent-runtime-types.ts` 已有 runtime capability 结构，包括 commands、permissions、questions、model selection、partial streaming。
- `src/renderer/src/components/sessions/ModelSelector.tsx` 已能展示 model variants，并可通过 variant chip / Alt+T 切换。
- `src/renderer/src/components/sessions/SlashCommandPopover.tsx` 已支持 slash command autocomplete。
- Session HQ 已有 timeline、interrupt dock、usage/hydration、permission/question/plan 卡片雏形。
- 近期 usage audit 已把 Claude/Codex usage correctness 和 context-window/total-session-usage 分离问题梳理清楚，可直接复用为 workflow token/cost 的数据模型依据。

### 2.2 主要缺口

1. `CLAUDE_MODELS` 仍显示 Opus 4.7，且 Opus variants 缺 `xhigh`。
2. 玄圃把 `variant` 直接当 SDK `Options['effort']`，但当前类型/数据结构不能表达 `ultracode` 这种“会话级模式 + xhigh effort + workflow auto”的复合能力。
3. `AgentRuntimeCapabilities` 没有 `supportsEffortLevel`、`supportsUltracode`、`supportsDynamicWorkflows`、`supportsWorkflowRuns`。
4. `sendCommand()` 对 Claude Code 只是拼成 `/${command}` 再 prompt。对 `/workflows` 这种管理界面命令，这可能只能触发 CLI 文本路径，不能映射出独立 UI。
5. Claude Code permission no-op 的现状不够覆盖 workflow：workflow launch approval 和 mid-run tool approval 是两个层级；玄圃目前只有 tool approval/question/plan 的通用 interrupt 槽位。
6. 没有 workflow run 级别的数据模型：run id、workflow name、phase list、agent count、token total、elapsed、status、saved command path 都没有持久化位置。
7. 使用量 UI 目前主要围绕 session/turn/message；dynamic workflows 需要 run/phase/agent 三层 usage，可累积到 session，但不能只显示为普通 assistant turn。

## 3. M0：快速兼容

目标：让用户在玄圃里能正确选择 Opus 4.8 / xhigh / ultracode，并且 dynamic workflow 不被现有 UI/权限/usage 逻辑误导。

### M0-1. 模型元数据更新

修改 `src/main/services/claude-code-implementer.ts`：

- `CLAUDE_OPUS_EFFORT_VARIANTS` 改为 `{ low, medium, high, xhigh, max }`。
- `CLAUDE_MODELS[opus].name` 改为 `Opus 4.8`。
- `defaultVariant` 保持 `high`，不要沿用 Opus 4.7 的 `xhigh`。
- 保留 `supportsFastMode: true`，但 UI 文案需要明确这是 Opus fast mode，不等于 `low effort`。
- 可选：在 provider metadata 中加入 `requiresClaudeCodeVersion: '2.1.154'`、`supportsUltracode: true`、`supportsDynamicWorkflows: true`。

注意：模型 id 保持 `opus` 是合理的，因为 Claude Code 官方 alias 会滚动到推荐模型；但 UI 应允许显示 `Opus 4.8`，并在高级设置里支持显式 pin `claude-opus-4-8`。

### M0-2. Effort 与 ultracode 分层

不要把 `ultracode` 塞进 model `variant`。

新增一个 session/runtime option：

```ts
interface ClaudeCodePromptOptions {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  ultracode?: boolean
}
```

短期可以仍复用 `model.variant` 表示 effort，但 `ultracode` 必须单独存在，因为官方明确它不是 effort level。发送给 SDK 时：

- `effort = ultracode ? 'xhigh' : selectedEffort`
- 同时通过 Claude Agent SDK control request 或 settings 传 `ultracode: true`
- 如果当前 SDK 版本不支持 control request，先用 session warning 提示“已退化为 xhigh，未开启 workflow auto”

### M0-3. Claude Code 版本 preflight

在 `system-info` 或 Claude runtime connect/prompt 前增加 `claude --version` 检测：

- `< 2.1.154`：Opus 4.8 alias、xhigh、dynamic workflow 可能不完整，显示 warning。
- `unknown option '--thinking'` 的现有 fallback 保留，但 warning 文案更新为“升级 Claude Code v2.1.154+ 以使用 Opus 4.8 / xhigh / dynamic workflows”。

### M0-4. UI 最小入口

`ModelSelector` 继续展示 `LOW / MEDIUM / HIGH / XHIGH / MAX` variant chips。

另外增加一个 Claude-only toggle：

- 标签：`Ultracode`
- 位置：SessionHeader 或 ModelSelector compact popover 内
- 行为：只作用于当前 session
- 描述：内部 tooltip 可说明会增加 token 消耗并允许 Claude 自动启动 workflow；不要把它显示成普通 effort chip。

### M0-5. `/workflows` 透传和警告

短期不做原生 UI 时：

- slash command autocomplete 允许 `/workflows`。
- 发送 `/workflows` 前，如果 runtime 是 Claude Code，显示一次 token/cost warning。
- 对 `/deep-research` 和用户保存 workflow command 也显示同类 warning。
- 确保 `sendCommand()` 透传 args，不要被 Xuanpu 的 plan/build 模式改写。

### M0-6. Usage 显示防误导

dynamic workflow 的 token 可能来自大量子 agent。短期：

- session total usage 可以照常累加。
- context-window indicator 不能把 workflow total tokens 当成当前 context occupancy。
- 如果事件里无法区分 workflow usage，显示“包含后台 workflow 消耗”的 badge，避免用户以为是单轮上下文占用。

## 4. M1：原生 workflow 体验

目标：把 Claude Code dynamic workflows 从“透传 CLI 文本”升级为玄圃 Session HQ 的一等后台任务。

### M1-1. Runtime capability

扩展 `AgentRuntimeCapabilities`：

```ts
supportsEffortLevels: boolean
supportsUltracode: boolean
supportsDynamicWorkflows: boolean
supportsWorkflowRuns: boolean
```

Claude Code 设置为：

- `supportsEffortLevels: true`
- `supportsUltracode: true`
- `supportsDynamicWorkflows: true`
- `supportsWorkflowRuns: true` 只有在 SDK 能读取 workflow run 状态时开启

Codex/OpenCode 先保持 false，避免 UI 暗示跨 runtime 同构。

### M1-2. Workflow run store

新增轻量数据模型：

```ts
interface WorkflowRun {
  id: string
  sessionId: string
  runtimeId: 'claude-code'
  name: string
  command?: string
  status: 'pending_approval' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  startedAt?: number
  endedAt?: number
  elapsedMs?: number
  totalTokens?: number
  phases: WorkflowPhase[]
}

interface WorkflowPhase {
  id: string
  name: string
  status: WorkflowRun['status']
  agentCount?: number
  totalTokens?: number
  elapsedMs?: number
  findings?: WorkflowFinding[]
}
```

先放 renderer runtime store，不急着 DB migration。等能稳定解析 SDK events 后再持久化。

### M1-3. Session HQ 后台任务面板

在 Session HQ 右侧 rail 或 ThreadStatusRow 增加“Background tasks”区域：

- running workflow 摘要：name、status、phase、tokens、elapsed。
- 展开后按 phase 展示 agent count 和 findings。
- workflow 完成后把最终 report 作为普通 assistant message 留在 timeline。
- workflow 中间态不要塞进主 timeline，否则会把聊天读流污染成上百条 agent 子结果。

### M1-4. Workflow approval card

复用现有 `InterruptDock`，新增 `workflow_approval` 类型：

- 展示 workflow name、phase list、token caution。
- 操作：Once / Always / Deny。
- Always 要明确作用域：project-local workflow + current tool allowlist，不要误表述成全局放行。

注意官方行为：Agent SDK / `claude -p` 下可能不会有 launch prompt。因此玄圃如果通过 SDK 启动 workflow，必须自己在前置 UI 做一层确认，尤其是 ultracode 自动 workflow。

### M1-5. Saved workflow 管理

Claude workflow 保存位置：

- project: `.claude/workflows/`
- user: `~/.claude/workflows/`

玄圃适配：

- 在 project context panel 里只显示 project-local saved workflows。
- user-level workflows 可以在 settings 里显示，但不要默认写入。
- 保存 workflow 时应明确是否会进入仓库，并提示是否要纳入 git。

## 5. M2：玄圃自己的 workflow 借鉴

不要马上复刻 Claude dynamic workflow runtime。短期应把它视为 Claude Code 的 provider-local capability。

但玄圃自研 `xuanpu-agent` 可以借鉴三个方向：

1. **脚本化编排而不是纯 prompt 递归**：长任务 orchestration 应落成可读、可 rerun 的计划/脚本。
2. **run/phase/agent 三层可观测性**：不要把所有子 agent 输出塞入主对话。
3. **token/cost 前置预算**：启动多 agent 前必须明确预算和审批，而不是结束后才报账。

这和玄圃既有 XFP / Context Kernel 路线兼容：Claude dynamic workflow 是 runtime-local 能力；玄圃 Field 负责现场、预算、审计和跨 session 可观测性。

## 6. 风险

1. **版本漂移**：`opus` alias 会继续滚动，UI 显示必须能从官方/provider metadata 更新，不能长期硬编码。
2. **SDK 支持不足**：如果 Claude Agent SDK 暂时不能读 workflow run 状态，M1 只能做 prompt/command 透传和 warning。
3. **权限误导**：workflow subagents 的 `acceptEdits` 和 file edits auto-approved 与玄圃现有 command approval 心智不同，必须在 UI 上明确。
4. **usage 混淆**：workflow token total、session total、context occupancy 是三种不同指标，不能共用一个条。
5. **长任务资源占用**：dynamic workflow 可能启动几十到几百个 subagents，玄圃要把它当后台任务，不要阻塞主 session UI。

## 7. 建议实施顺序

1. 更新 Claude 模型元数据：Opus 4.8、`xhigh`、默认 `high`。
2. 增加 Claude Code version preflight 和升级提示。
3. 把 `ultracode` 从 variant 中分离，做 session-only toggle。
4. `/workflows`、`/deep-research` 和 saved workflow command 透传，附 token/cost warning。
5. 扩展 runtime capabilities，先给 Claude Code 标记 workflow 支持能力。
6. 研究 Claude Agent SDK 是否能暴露 workflow run/control events。
7. 有事件源后做 WorkflowRun store 和 Session HQ 后台任务面板。
8. 最后再考虑 project/user saved workflow 管理和 DB 持久化。

## 8. 代码入口

| 目标 | 文件 |
| --- | --- |
| Claude model/effort 元数据 | `src/main/services/claude-code-implementer.ts` |
| Runtime capability | `src/main/services/agent-runtime-types.ts` |
| IPC/preload capability 类型 | `src/preload/index.ts`, `src/preload/index.d.ts` |
| 模型/effort UI | `src/renderer/src/components/sessions/ModelSelector.tsx` |
| Session HQ 顶栏入口 | `src/renderer/src/components/session-hq/SessionHeader.tsx` |
| slash command UI | `src/renderer/src/components/sessions/SlashCommandPopover.tsx` |
| composer command dispatch | `src/renderer/src/components/session-hq/ComposerBar.tsx`, `src/renderer/src/lib/session-send-actions.ts` |
| runtime transient state | `src/renderer/src/stores/useSessionRuntimeStore.ts` |
| usage/cost 防混淆 | `src/renderer/src/components/sessions/ContextIndicator.tsx`, usage analytics 相关 service |

## 9. 验证清单

- `pnpm lint`
- `pnpm vitest run test/phase-23/session-send-actions.test.ts`
- `pnpm vitest run test/phase-23/use-pending-message-drain.test.tsx`
- 新增 tests：
  - Claude model list includes Opus 4.8 and xhigh.
  - Opus default effort is high, not xhigh.
  - Ultracode is not emitted as `effort: 'ultracode'`.
  - `/workflows` command dispatch preserves command/args.
  - Workflow usage does not overwrite context-window occupancy.

## 10. Sources

- Anthropic News: Introducing Claude Opus 4.8, 2026-05-28: https://www.anthropic.com/news/claude-opus-4-8
- Claude Blog: Introducing dynamic workflows in Claude Code, 2026-05-28: https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Claude Code Docs: Dynamic workflows: https://code.claude.com/docs/en/workflows
- Claude Code Docs: Model configuration: https://code.claude.com/docs/en/model-config
- Claude API Docs: Effort: https://docs.anthropic.com/en/docs/build-with-claude/effort
- TechCrunch: Anthropic releases Opus 4.8 with new dynamic workflow tool, 2026-05-28: https://techcrunch.com/2026/05/28/anthropic-releases-opus-4-8-with-new-dynamic-workflow-tool/
