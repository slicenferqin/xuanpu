# Amp Adapter 接入技术方案

**日期**：2026-04-23
**性质**：1.4.0 发布后启动的实验性接入
**状态**：方案定稿，待 1.4.0 发版后在 `feat/amp-adapter` 分支实施
**负责人**：TBD（首批自用 + 个人驱动）
**关联文档**：[2026-04-23-companion-and-autopilot-direction.md](./2026-04-23-companion-and-autopilot-direction.md)

---

## TL;DR

- **目标**：把 Sourcegraph Amp 作为玄圃第 4 个 agent runtime 接入，与 CC / Codex / OpenCode 同级
- **路径**：直接依赖官方 `@sourcegraph/amp-sdk`（TypeScript SDK），SDK 调用收拢在 `amp-implementer.ts` 单文件
- **License**：PolyForm-Noncommercial-1.0.0，当前自用/pre-commercial 阶段可接受，商业化前必须切换到 CLI spawn 方案
- **工作量**：MVP ≈ 5 人日；完整版（含 Phase 21.5 对齐） ≈ 7.5 人日
- **启动时机**：1.4.0 发版后，不绑定主线节奏

---

## 一、背景与动机

### 1.1 起点

来自 2026-04-23 的产品方向讨论（见关联文档）。讨论中识别的三个事实：

1. **玄圃护城河 = 跨 agent 横向视野**，不是单一 agent 的深度
2. **市场上有程序化接入通道的 agent 不多**：CC / Codex / OpenCode / Amp / Continue.dev 是目前主要候选
3. **Amp 有官方 TS SDK + `--stream-json` CLI 模式**，接入门槛和现有三家相当

### 1.2 驱动力

当前 Amp 接入**不是主线路线图任务**，驱动力是：

- **个人使用习惯**：维护者日常也在用 Amp，希望纳入玄圃的"多 worktree + 多 session + FieldEvent"统一视野
- **验证 adapter 层的扩展性**：当前 `AgentRuntimeAdapter` 抽象只服务三家，接第四家是对抽象层的首次真正考验
- **为未来商业/主流扩展留路径**：如果自用体验好，1.6.0+ 可以考虑作为官方支持的 agent

### 1.3 与 1.5.0 规划的关系

1.5.0 主线是 **Phase 21.5 跨 agent 化**（给 OpenCode / Codex 补齐 Claude Code 已有的 agent tool events 抽象）。Amp adapter **独立于这条主线**，建议作为：

- 实验分支（`feat/amp-adapter`）先跑通 MVP
- 不阻塞 1.5.0 发版
- 自用验证后再决定是否合入主线

---

## 二、调研结论

### 2.1 Amp 产品概览

**Amp** 是 [Sourcegraph 2026 推出的 agent 级 AI 编码产品](https://ampcode.com/)，定位对标 Claude Code / Codex，主要特征：

- 多模型支持（Claude Opus / GPT-5 等，用户无需自己配 key，Sourcegraph 代管）
- 独立 CLI（`npm i -g @sourcegraph/amp`）+ VS Code / JetBrains 插件
- Thread 模型（对应玄圃的 session 概念）
- 官方 Skills / MCP 集成 / 自定义 Tools

### 2.2 接入通道

Amp 提供**三条**程序化接入通道：

| 通道 | 包名 | 说明 |
|---|---|---|
| TypeScript SDK | [`@sourcegraph/amp-sdk`](https://libraries.io/npm/@sourcegraph%2Famp-sdk) | 官方 SDK，async iterator 流式消息 |
| Python SDK | [`amp-sdk` (PyPI)](https://pypi.org/project/amp-sdk/) | 同语义，但对 Electron 项目不友好 |
| CLI `--stream-json` | 内置于 `@sourcegraph/amp` | NDJSON 格式，stdin/stdout 协议 |

玄圃是 Electron + TypeScript 技术栈，**TS SDK 是最自然匹配**。

### 2.3 TS SDK API 形态

```ts
import { AmpOptions, execute } from '@sourcegraph/amp-sdk'

const messages = execute({ prompt, options })
for await (const message of messages) {
  if (message.type === 'system')    { /* { session_id, cwd, tools, mcp_servers } */ }
  if (message.type === 'user')      { /* echoed user input */ }
  if (message.type === 'assistant') { /* streaming model output */ }
  if (message.type === 'result')    { /* { duration_ms, is_error, num_turns, result } */ }
}
```

**关键能力**：
- `execute()` 返回 `AsyncIterator` —— 和 CC SDK 风格一致
- `AmpOptions` 支持 `cwd` / `dangerouslyAllowAll` / `toolbox` / thread 参数
- `create_permission` helper 做细粒度工具权限
- `create_user_message()` 在流中追加 user 消息（实现 `steer`）
- Thread 级别 resume（`amp threads continue` 语义）

### 2.4 License

```
License: PolyForm-Noncommercial-1.0.0
```

**边界**（[原文](https://polyformproject.org/licenses/noncommercial/1.0.0/)）：

| 场景 | 合规性 |
|---|---|
| 个人自用 | ✅ 安全 |
| 公开开源分发免费二进制（玄圃当前形态） | ✅ 安全 |
| 在公司内部用玄圃写公司代码 | ⚠️ 灰色 |
| 玄圃付费版 / 接受商业赞助 | ❌ 违规 |

**结论**：当前阶段可接受，**商业化前必须评估是否切换到 CLI spawn 方案**。

---

## 三、能力矩阵（Amp ↔ AgentRuntimeAdapter）

参考 `src/main/services/agent-runtime-types.ts` 中的 21 个方法接口。

| AgentRuntimeAdapter 方法 | Amp 实现 | 覆盖度 | 备注 |
|---|---|---|---|
| `connect` / `disconnect` | Thread 创建 / 关闭 | ✅ | `execute()` 首次调用产生 `system.init` 含 `session_id` |
| `reconnect` | `amp threads continue <threadID>` 语义 | ✅ | SDK options 接受 thread 参数 |
| `cleanup` | 清理所有 thread | ✅ | |
| `prompt` | `execute({ prompt, options })` | ✅ | 一次性 prompt |
| `steer` | `create_user_message()` 流追加 | ✅ | SDK 支持 `AsyncIterator<UserInputMessage>` |
| `abort` | `AbortController` 传入 SDK | ✅ | |
| `getMessages` | 解析已收 messages 缓存 / `threads.markdown()` | ✅ | |
| `getSessionInfo` | 自维护 revertMessageID | ⚠️ | undo/redo 不支持时返回 null |
| `questionReply` | 通过 stream input 回 question 响应 | ✅ | 需细看 [plugin-api](https://ampcode.com/manual/plugin-api) |
| `questionReject` | 同上 | ✅ | |
| `permissionReply` | `create_permission` + `ToolCallEvent` 协议 | ✅ | action: `allow` / `reject-and-continue` / `modify` |
| `permissionList` | 自维护 pending 列表 | ✅ | |
| `hasPendingQuestion` / `hasPendingApproval` | 自维护 | ✅ | |
| `undo` / `redo` | ❌ Amp 暂无原生 API | ❌ | 初版 capabilities `false`，抛 `NOT_SUPPORTED` |
| `listCommands` / `sendCommand` | Amp 用 Skills 概念，不映射 | ❌ | 初版 capabilities `false` |
| `getAvailableModels` / `getModelInfo` | SDK 通过 settings 文件配置 | ⚠️ | 初版可硬编码已知模型清单，迭代再做动态发现 |
| `setSelectedModel` / `clearSelectedModel` | 写入 AmpOptions | ✅ | |
| `renameSession` | Thread Labels API | ✅ | |
| `forkSession` | Thread Visibility 不等同 fork | ❌ | 初版抛 `FORK_NOT_SUPPORTED`（与 CC/Codex 一致） |
| `setMainWindow` | 玄圃自身机制 | ✅ | |

**覆盖度评估**：核心 lifecycle / messaging / permission **100%**；P2 能力（undo/fork/commands）有缺口，**与 OpenCode/Codex 同级**，不是退化版。

### 3.1 AMP_CAPABILITIES（初版）

```ts
export const AMP_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsUndo: false,           // 初版 false，等 Amp 出原生 API
  supportsRedo: false,
  supportsSteer: true,           // SDK 流式输入支持
  supportsCommands: false,       // Skills 概念不映射
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,       // thread continue
  supportsPartialStreaming: true
}
```

---

## 四、架构设计

### 4.1 文件布局

新增文件（参考 Codex adapter 的模块化风格）：

```
src/main/services/
├── amp-binary-resolver.ts       # 检测用户本地 amp CLI 安装
├── amp-implementer.ts           # AgentRuntimeAdapter 实现（唯一 SDK 引入点）
├── amp-event-mapper.ts          # SDK message → agent event bus 归一化
├── amp-activity-mapper.ts       # SDK message → Session HQ activity 流
├── amp-session-title.ts         # 自动命名 thread（复用 CC/Codex 的模板）
├── amp-models.ts                # 已知模型清单（初版硬编码）
└── amp-utils.ts                 # 辅助函数
```

**强约束**：`@sourcegraph/amp-sdk` 的 import 只出现在 `amp-implementer.ts`。其他文件通过 `amp-implementer.ts` 导出的类型 alias 使用 SDK 类型。这是 License 风险的软着陆设计（详见第五章）。

### 4.2 事件归一化

SDK 的 message 类型与玄圃 `normalize-agent-event` 的映射：

| Amp message | 玄圃 agent event | 备注 |
|---|---|---|
| `system` (subtype: init) | `session.connected` | 取出 `session_id` 作为 agentSessionId |
| `user` | `message.user.committed` | echo 回来的用户输入 |
| `assistant` (streaming) | `message.assistant.delta` | 增量输出 |
| `assistant` (final) | `message.assistant.committed` | stop_reason != null |
| tool_use（在 assistant content 里） | `tool.call.started` | 对齐 Phase 21.5 tool events |
| tool_result | `tool.call.completed` | |
| `result` | `session.turn.completed` | 含 duration_ms / num_turns / token usage |
| permission 请求 | `permission.requested` | 需细看 ToolCallEvent 协议 |

### 4.3 SDK 调用隔离模式

```ts
// amp-implementer.ts —— 唯一引入 @sourcegraph/amp-sdk 的文件
import {
  execute,
  AmpOptions,
  create_permission,
  create_user_message
} from '@sourcegraph/amp-sdk'

// 所有 SDK 类型向外 re-export 为玄圃内部别名
export type AmpMessage = /* SDK 类型别名 */
export type AmpUserInput = /* SDK 类型别名 */

export class AmpImplementer implements AgentRuntimeAdapter {
  readonly id: AgentRuntimeId = 'amp'
  readonly capabilities = AMP_CAPABILITIES

  // ... 所有 SDK 调用收拢在此类中
}
```

**切换成本**：如果未来需要改走 CLI spawn，只需重写 `amp-implementer.ts` 一个文件，其他七个文件零改动。预估切换成本 ≈ 3 人日。

### 4.4 进程内 vs 子进程

- **TS SDK 路径**：SDK 调用在 Electron **main 进程内**，SDK 自己会管理与 Amp 后端的 HTTP/SSE 连接
- **不需要 spawn 额外子进程**（对比 Codex 要 spawn app-server、OpenCode 要 spawn server）
- **优点**：进程管理简单、资源占用低
- **注意**：需测试 SDK 在 Electron main 进程（Node runtime）的兼容性，特别是 fetch / AbortSignal / async iteration 行为

---

## 五、License 决策（嵌入式 ADR）

### ADR-001: Amp adapter 直接依赖 @sourcegraph/amp-sdk

**决策日期**：2026-04-23
**决策状态**：已接受（自用 / pre-commercial 阶段）
**决策者**：项目 owner

#### 决策

Amp adapter 的实现直接在 `package.json` 中依赖 `@sourcegraph/amp-sdk`，而非通过 CLI spawn + stream-json 方式间接调用。

#### 考量对比

| 维度 | TS SDK | CLI spawn |
|---|---|---|
| 开发工作量 | ~7.5 人日 | ~11 人日 |
| Type safety | 完整 | 自写 NDJSON 类型 |
| 运行时依赖 | npm package | 用户本地 `amp` 二进制 |
| License 风险 | ⚠️ PolyForm-NC 进入 package.json | ✅ 不直接依赖 SDK |
| Electron 打包复杂度 | 略增 | 无变化 |

#### 已知风险

**PolyForm-Noncommercial-1.0.0** license 的核心约束：

> "any use that does not include an intention of or result in commercial advantage or monetary compensation"

在以下任何事件发生时，必须**重新评估**本决策：

1. 玄圃开始接受赞助 / 付费订阅 / 商业合作
2. 企业版或付费版计划启动
3. Sourcegraph 改变 Amp 的 license 条款
4. 收到 Sourcegraph 的 cease-and-desist 或 license 合规询问

#### 应对预案

如需切换到 CLI spawn 方案：

1. `amp-implementer.ts` 内部重写（spawn `@sourcegraph/amp` CLI 二进制 + `--stream-json` 解析）
2. 从 `package.json` 移除 `@sourcegraph/amp-sdk` 依赖
3. 其他七个文件无需改动（因为 SDK 调用已被隔离）
4. 预估切换成本 ≈ 3 人日

#### 拒绝的替代方案

- **方案 B：直接走 CLI spawn**。拒绝理由：开发速度慢 ~30%、Type safety 自写成本高、license 优势在当前阶段尚不需要
- **方案 D：插件化**。把 Amp 作为玄圃可选插件、用户自行安装 SDK。拒绝理由：玄圃当前没有插件系统，为此搭建插件架构代价远大于直接集成

---

## 六、实现路径

### 6.1 Phase 0：前置准备（0.5 人日）

- [ ] 在 `feat/amp-adapter` 分支启动
- [ ] `pnpm add @sourcegraph/amp-sdk`，验证在 Electron main 进程的兼容性（特别是 fetch / streams / async iteration）
- [ ] 阅读 [`/manual/plugin-api`](https://ampcode.com/manual/plugin-api) 中 `ToolCallEvent` 协议，确认 permission 双向流的具体格式
- [ ] 用一个独立 sandbox 跑通 `execute()` 基本调用，确认 message 类型和 SDK 文档一致

### 6.2 Phase 1：MVP（5 人日，自用够用）

目标：在你自己机器上跑通 Amp 接入 Session HQ 的基础体验。

| Task | 工作量 | 产出 |
|---|---|---|
| `agent-runtime-types.ts` 添加 `'amp'` 到 `AgentRuntimeId` union + `AMP_CAPABILITIES` 常量 | 0.25 天 | type 定义 |
| `amp-binary-resolver.ts` | 0.5 天 | 检测 `npm i -g @sourcegraph/amp` 安装、版本号、未安装时友好提示 |
| `amp-implementer.ts` 骨架（connect/disconnect/prompt/abort/getMessages） | 1.5 天 | 基础生命周期 |
| `amp-event-mapper.ts` | 1 天 | SDK message 流 → agent event bus |
| 注册到 `agent-runtime-manager.ts` | 0.25 天 | 让 manager 能创建 Amp 实例 |
| Renderer 端最小适配（NewSessionDialog 加 Amp 选项 + SessionView 渲染） | 1 天 | UI 能跑 |
| 自用联调 | 0.5 天 | |

**MVP 验收**：能在玄圃里新建 Amp session、发 prompt、收到流式响应、能 abort、能查看历史 messages。

### 6.3 Phase 2：完整版（再 +2.5 人日，达到三家同级）

| Task | 工作量 | 产出 |
|---|---|---|
| `amp-activity-mapper.ts` + Phase 21.5 tool event 对齐 | 1.5 天 | Session HQ 活动流和 CC/Codex 一致 |
| Permission 双向流（`ToolCallEvent` 完整实现） | 0.5 天 | 工具权限 UI 可用 |
| `reconnect` / thread management | 0.25 天 | 重启玄圃后恢复 thread |
| Model selection（初版硬编码已知模型） | 0.25 天 | UI 可切换 Claude Opus / GPT-5 等 |

### 6.4 Phase 3：可选增强（按需）

- onboarding-doctor 集成（检测 amp 已装、登录态、网络）
- session-title 自动命名
- 模型清单动态发现（如 Amp 后续提供 API）
- E2E 测试用例

### 6.5 文件改动清单

**新增**（7 文件）：
```
src/main/services/amp-binary-resolver.ts
src/main/services/amp-implementer.ts
src/main/services/amp-event-mapper.ts
src/main/services/amp-activity-mapper.ts
src/main/services/amp-session-title.ts
src/main/services/amp-models.ts
src/main/services/amp-utils.ts
```

**修改**（基于 Grep `AgentRuntimeId` 引用点）：

| 文件 | 改动 |
|---|---|
| `src/main/services/agent-runtime-types.ts` | union 加 `'amp'`、新增 `AMP_CAPABILITIES` |
| `src/main/services/agent-runtime-manager.ts` | 注册 AmpImplementer |
| `src/main/db/database.ts` | 如有 agent 类型枚举校验，需扩展 |
| `src/main/db/types.ts` | 同上 |
| `src/preload/index.ts` / `index.d.ts` | 如有类型 union 暴露，扩展 |
| `src/shared/types/worktree.ts` | union 扩展 |
| `src/shared/types/session.ts` | union 扩展 |
| `src/shared/types/agent-protocol.ts` | union 扩展 |
| `src/server/resolvers/helpers/sdk-dispatch.ts` | switch case 加 amp 分支 |
| `src/server/resolvers/helpers/runtime-dispatch.ts` | 同上 |
| `src/main/ipc/agent-handler-wrapper.ts` | 同上 |
| `src/renderer/src/stores/useWorktreeStore.ts` | union 扩展 |
| `src/renderer/src/stores/useSettingsStore.ts` | 同上 |
| `src/renderer/src/stores/useSessionStore.ts` | 同上 |
| `src/renderer/src/components/setup/AgentSetupGuard.tsx` | Amp 安装引导 |
| `src/renderer/src/components/sessions/NewSessionDialog.tsx` | 选项加 Amp |
| `src/renderer/src/components/sessions/SessionView.tsx` | 渲染分支 |
| `src/renderer/src/components/sessions/SessionTabs.tsx` | tab 图标 / 颜色 |
| `src/renderer/src/components/session-hq/SessionHeader.tsx` | header 显示 |
| `package.json` | 加 `@sourcegraph/amp-sdk` 依赖 |

**实施时第一步**：在分支上跑 `grep -r "'opencode' | 'claude-code' | 'codex' | 'terminal'" src/` 拿到所有需扩展的 union 字面量位置，逐个加 `'amp'`。

---

## 七、风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| SDK 在 Electron main 进程不兼容（fetch/streams 行为） | 低 | 中 | Phase 0 sandbox 先验证；不兼容则降级为 CLI spawn |
| `ToolCallEvent` 协议文档���完整、permission 流走不通 | 中 | 中 | 先实现 `dangerouslyAllowAll: true` 跑通主流程，permission 流作为 Phase 2 |
| Amp SDK 频繁 pre-release 更新（npm 上看到 nightly 节奏）破坏 API | 中 | 低 | 锁定具体版本号，不用 `^` 范围；定期手动升级 |
| Phase 21.5 抽象不能干净映射 Amp 的 tool event | 中 | 低 | Phase 21.5 跨 agent 化主线推进时同步对齐，必要时反过来调整抽象 |
| License 状态突变（Sourcegraph 改条款 / 玄圃商业化） | 低-中 | 高 | 隔离设计已就绪，3 人日切换到 CLI spawn |
| Amp 后端依赖 Sourcegraph 服务（不是纯本地 agent） | 高 | 低 | 这是 Amp 产品定性，玄圃不解决；onboarding-doctor 提示用户登录态 |

---

## 八、验收标准

### 8.1 MVP 验收（Phase 1 完成）

- [ ] 在玄圃 NewSessionDialog 中可选 Amp 作为 agent
- [ ] 新建 Amp session 后能成功 connect，UI 显示 connected 状态
- [ ] 发送 prompt 后能收到流式响应，渲染到 Session HQ
- [ ] Abort 按钮能中断进行中的 turn
- [ ] 关闭 session 不留僵尸进程 / 残留连接
- [ ] 至少在你的日常工作流程下连续使用 1 周无致命 bug

### 8.2 完整版验收（Phase 2 完成）

MVP 全部通过 +：

- [ ] Tool 使用在 Session HQ 活动流中显示，格式与 CC/Codex 一致
- [ ] Permission 请求弹窗工作正常，allow / reject / modify 三种 action 都能回包
- [ ] 玄圃重启后能 reconnect 上次的 thread
- [ ] 模型切换 UI 工作（至少能切换 Claude Opus / GPT-5）
- [ ] `lint` / `tsc` / `vitest` 全绿
- [ ] 不破坏现有三家 agent 的任何行为

### 8.3 合并主线门槛（决定是否合入 main）

完整版通过 +：

- [ ] 自用满意度评估：连续 2 周自用，体验不弱于 CC / Codex
- [ ] License 状态复核：玄圃当前阶段仍是 pre-commercial，无新风险
- [ ] 文档：在 `docs/GUIDE.md` 中加 Amp 接入说明（用户视角）

---

## 九、实施日历建议

| 时间 | 事件 |
|---|---|
| 1.4.0 发版 | 不动 Amp adapter，全力发版 |
| 1.4.0 发版 +1 天 | 开 `feat/amp-adapter` 分支，启动 Phase 0 |
| +1 周 | Phase 1 MVP 完成，开始自用 |
| +2 周 | Phase 2 完整版完成 |
| +4 周 | 自用 2 周后做合并决策 |

不绑死 1.5.0 节奏。1.5.0 主线（Phase 21.5 跨 agent 化）由其他人/其他时间窗口推进，Amp adapter 不阻塞、不抢资源。

---

## 十、参考资料

### Amp 官方
- [Amp 官网](https://ampcode.com/)
- [Amp Owner's Manual](https://ampcode.com/manual)
- [Amp SDK 文档](https://ampcode.com/manual/sdk)
- [Amp TypeScript SDK 公告](https://ampcode.com/news/typescript-sdk)
- [Amp Streaming JSON 公告](https://ampcode.com/news/streaming-json)
- [Amp Plugin API（permission/tool 协议）](https://ampcode.com/manual/plugin-api)
- [Amp CLI guide](https://github.com/sourcegraph/amp-examples-and-guides/blob/main/guides/cli/README.md)
- [Amp CLI API 路由文档](https://help.router-for.me/agent-client/amp-cli)

### 包
- [`@sourcegraph/amp-sdk` (npm)](https://libraries.io/npm/@sourcegraph%2Famp-sdk)
- [`@sourcegraph/amp` CLI (npm)](https://www.npmjs.com/package/@sourcegraph/amp)

### License
- [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)

### 玄圃内部
- [2026-04-23 伴随式 / 自动驾驶方向](./2026-04-23-companion-and-autopilot-direction.md)
- `src/main/services/agent-runtime-types.ts` —— AgentRuntimeAdapter 接口
- `src/main/services/codex-implementer.ts` —— 接入参考（最近的同级实现）
- `src/main/services/opencode-service.ts` —— 接入参考（spawn 风格对照）

---

## 附录 A：决策记忆

为什么不等 Amp 出官方 ACP 实现？
> ACP 当前还是 Zed 主推的早期协议，Amp 没表态。等 ACP 等于无限期推迟，且 ACP 设计偏 1:1 的「编辑器 ↔ agent」模型，无法覆盖玄圃跨 worktree / 多 session 的场景。直接走 SDK 是务实选择。

为什么不做插件系统？
> 插件系统是 1.7.0+ 才考虑的事情。现在为单个 agent 接入搭建插件架构，复杂度远大于收益。SDK 隔离设计已经提供了"未来插件化"的预演路径。

为什么 Amp 优先级排在 Continue.dev 之前？
> Continue.dev 用户重合度低（VS Code 内嵌），且与 OpenCode 生态位撞车（都是 BYOK + 开源）。Amp 是 Sourcegraph 背书的 SaaS 风格 agent，独立生态位。但**真正的优先级理由仍然是"项目 owner 个人使用"**，不是市场分析。



