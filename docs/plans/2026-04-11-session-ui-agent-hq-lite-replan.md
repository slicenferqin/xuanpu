# Session UI / Agent HQ-lite 重构计划（替代版）

> 该文档用于替代外部草稿 `/Users/slicenfer/.claude/plans/parallel-kindling-dolphin.md`，并以内置仓库约束为准。

**Goal:** 在不破坏现有多 Provider 能力的前提下，先统一 Session 事件协议、runtime 状态和 durable transcript，再逐步把 Session 详情页演进为一个更稳定的 `Agent HQ-lite` 交互层。

**Architecture:** Main process 继续作为 durable transcript 和 session activity 的唯一真相源。Renderer 只保留一条根级事件桥，把流式事件归一化后写入 session-scoped runtime store。Session 详情页始终渲染 `durable timeline + live overlay`，而不是在 renderer 自己“持久化 append”消息。新的 UI 采用 `Thread Detail + Agent Rail + Interrupt Dock + Global Status Indicator` 的分层结构，既能保持主对话可读，也能显式展示后台 session、child session、subagent 和审批状态。

**Tech Stack:** Electron 33, React 19, TypeScript 5.7, Zustand 5, SQLite (`better-sqlite3`), Tailwind CSS 4, Vitest

---

## 一、为什么要替换原方案

原方案的方向有价值，但执行路径和当前仓库边界不匹配，核心问题有四类：

1. 它试图同时重写 `状态中枢 + transcript 归一化 + UI 树`，改动面过大，难以逐步回归。
2. 它把流式完成后的 assistant 消息重新 append 成“持久消息”，会把 renderer 再次推回双写模式，而当前仓库已经把 transcript 持久化放在 main process。
3. 它把 interrupt queue 设计在局部 hook 里，但 `MainPane` 目前会按 `sessionId` 重挂载 session 视图，切换 tab 时局部状态必然丢失。
4. 它把 `eventId` 去重当成前提，却没有把协议升级、preload normalizer、legacy channel 兼容纳入同一 phase。

因此，这次方案不再走“从零重写整个 Session UI”的路线，而是先做一条可验证、可回退的 runtime spine，再把 UI 逐层替换上去。

---

## 二、外部参考模式

这份方案吸收的是交互模式，不是产品表层外观。

- **Proma**
  - 借鉴点：`Agent Teams` 的显式可视化，尤其是右侧对 agent 工作状态的展示。
  - 不照搬点：不复制独立的聊天产品形态，也不把远程协作、记忆系统、飞书链路拉进这次范围。
- **VS Code Agents / Chat Sessions**
  - 借鉴点：local/background/cloud 都统一抽象成 session；支持多 session 并行；有 in-progress / unread indicator；支持 queue / steer / stop-and-send；把 subagent 显示为可折叠 tool call；支持 fork 和 archive。
  - 不照搬点：Xuanpu 已经有 worktree/session tabs，不需要再平移一套完整的 sessions list 作为主导航。
- **Zed / agentic editor 模式**
  - 借鉴点：主 thread 和 agent activity 分层，避免把所有中间工具步骤塞满主对话。
  - 不照搬点：不在这轮引入新的 editor-level threading 或 remote workflow 模型。

---

## 三、非谈判约束

- `main process` 必须继续作为 durable transcript 的唯一真相源。
- Renderer 不允许新增 assistant durable message 的写路径。
- 事件订阅必须收敛为根级单订阅，不能继续出现 active session 和 global listener 双重消费同类事件。
- Question / Permission / Command Approval / Plan Approval 必须进入 session-scoped store，不能只放在组件本地 state 或局部 hook。
- `injectedWorktrees` 仍然保留“session 首次 prompt 注入一次”的生命周期语义，不能在每个 turn 的 `idle/error` 后清理。
- Feature flag 不通过修改 SQLite `settings` 表结构实现，而是扩展现有 `APP_SETTINGS_DB_KEY` JSON 设置。
- 主题不是前置架构依赖。Catppuccin 只作为预设主题在最后阶段接入，不能反过来决定状态架构。
- 旧 `SessionView` 必须先接入新状态 spine 并通过回归，再引入新 UI 壳层。不能同时替换状态和界面。
- 第一阶段不引入新的“通用 EventBus 抽象层”。先收敛协议和状态，再决定 transport 是否值得二次抽象。

---

## 四、目标交互模型

目标不是“更漂亮的聊天页”，而是一个对多 agent / 多 session / 多 provider 更诚实的交互模型。

### 4.1 总体布局

```text
┌──────────────────────────────────────────────────────────────┐
│ Session Header                                              │
│ session title | provider | model | status | tokens | cost   │
├──────────────────────────────┬───────────────────────────────┤
│ Thread Detail                │ Agent Rail                    │
│                              │                               │
│ durable timeline             │ child sessions                │
│ + live overlay               │ background tasks              │
│ + collapsed subagent cards   │ running tools                 │
│ + plan / compaction markers  │ queue / unread / approval     │
│                              │                               │
├──────────────────────────────┴───────────────────────────────┤
│ Interrupt Dock                                                │
│ question / permission / command approval / plan approval      │
├──────────────────────────────────────────────────────────────┤
│ Composer                                                      │
│ idle | queue | steer | stop+send | attachments | slash cmds  │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 三层状态模型

1. **Durable Layer**
   - 来自 DB / transcript / canonical timeline
   - 刷新后仍然存在
   - 是 fork / undo / redo / history 的基线

2. **Runtime Layer**
   - 来自 stream event
   - 包括 live draft、当前 tool、in-progress、interrupt queue、unread 等
   - session-scoped，但不依赖具体页面是否挂载

3. **View Layer**
   - UI 折叠状态、滚动锚点、hover、editor-like composer 光标状态
   - 可以在组件内部，但不承载业务真相

---

## 五、核心状态设计

### 5.1 单一事件桥

新增根级 `useAgentEventBridge`，只在 App 根挂载一次，负责：

- 监听 `window.agentOps.onStream`
- 同时接收 `agent:stream` 和 `opencode:stream`
- 通过统一 normalizer 产出 `CanonicalAgentEventV2`
- 把事件分发给 session-scoped runtime store

这意味着：

- `useAgentGlobalListener` 不再直接保管 Question / Permission / Approval / Plan 的真相状态
- `SessionView` 不再自行订阅原始 stream 事件
- active session、background session、未挂载 session 走同一条事件链

### 5.2 Session Runtime Store

新增 `src/renderer/src/stores/useSessionRuntimeStore.ts`，每个 session 维护以下状态：

```ts
type SessionRuntimeState = {
  lastEventId: string | null
  sessionSequence: number | null
  lifecycle: 'idle' | 'busy' | 'retry' | 'error' | 'materializing'
  liveDraft: {
    parts: StreamingPart[]
    textFallback: string
    startedAt: number | null
    childSessionId?: string | null
  } | null
  currentTool: {
    name: string
    status: 'running' | 'completed' | 'error'
    callId?: string
  } | null
  interruptQueue: InterruptItem[]
  unreadCount: number
  inProgress: boolean
  commandsAvailable: boolean
  modelLimits?: {
    runtimeId: string
    models: Array<{ providerID: string; modelID: string; contextLimit: number }>
  }
  pendingMessages: PendingMessage[]
  lastActivityAt: number | null
}
```

这个 store 是新的 runtime spine。它不是替代 `useSessionStore`，而是补足 `useSessionStore` 当前没有承载的实时状态。

### 5.3 Durable Timeline 只在 Main 侧合成

新增 `session-timeline-service`，由 main process 统一产出 timeline：

- OpenCode：读取 transcript / canonical message rows
- Claude Code：读取 transcript，并映射成统一 message parts
- Codex：读取 `session_messages + session_activities`，在 main 层合成最终 timeline

Renderer 只能拿到：

- `timeline.messages`
- `timeline.checkpoints`
- `timeline.revertBoundary`
- `timeline.planMarkers`
- `timeline.compactionMarkers`

Renderer 不负责“把流式结果 materialize 成 durable transcript”。

### 5.4 Interrupt Queue 必须 session-scoped

Question / Permission / Command Approval / Plan Approval 合并为统一 `InterruptItem`：

```ts
type InterruptItem =
  | { kind: 'question'; id: string; sessionId: string; payload: QuestionRequest }
  | { kind: 'permission'; id: string; sessionId: string; payload: PermissionRequest }
  | { kind: 'command-approval'; id: string; sessionId: string; payload: CommandApprovalRequest }
  | { kind: 'plan'; id: string; sessionId: string; payload: PendingPlan }
```

旧的：

- `useQuestionStore`
- `usePermissionStore`
- `useCommandApprovalStore`

第一阶段不删除，而是变成 compatibility adapter，最终收口到 runtime store。

### 5.5 Composer 采用三态发送模型

当 session 正在运行时，Composer 不再只有一个 `Send`：

- `Queue`
  - 新消息排队，等当前响应结束后发送
- `Steer`
  - 提示当前运行中的 agent 尽快让出控制权，然后立即处理新消息
- `Stop and Send`
  - 直接中断当前运行，立刻发送新消息

这和现有 `pendingFollowUpMessages` / `pendingPlans` 的方向一致，但需要提升为统一的 session runtime 行为。

---

## 六、协议升级范围

原草稿的问题之一，是把 `eventId` 当作既定事实，但没有把协议升级列入文件边界。这次要明确写进 Phase 0。

### 6.1 统一事件信封

在 [src/shared/types/agent-protocol.ts](/Users/slicenfer/Development/projects/self/xuanpu/xuanpu/src/shared/types/agent-protocol.ts) 上扩展为 `CanonicalAgentEventV2`：

```ts
type EventEnvelope = {
  eventId: string
  sessionSequence: number
  sessionId: string
  runtimeId?: SharedAgentRuntimeId
  emittedAt: string
  sourceChannel: 'agent:stream' | 'opencode:stream'
  childSessionId?: string
}
```

每个事件体都带上 `EventEnvelope`。

### 6.2 把真实事件面纳入共享类型

当前共享类型之外、但仓库真实存在的事件，必须补进协议：

- `session.commands_available`
- `session.model_limits`
- `command.approval_problem`
- legacy `session.idle`（保留兼容层，不作为最终业务语义）

### 6.3 Preload 继续兼容双通道，但加 normalizer

`preload/index.ts` 仍然监听：

- `agent:stream`
- `opencode:stream`

但在回调进入 renderer 前，统一经过 `normalizeAgentEvent(raw)`：

- 修正字段别名，如 `requestID -> requestId`
- 补充 `sourceChannel`
- 为旧事件生成 `eventId` 和 `sessionSequence`
- 对缺失字段做兼容映射

---

## 七、分阶段实施计划

### Phase 0: 协议清点与事件归一化

**目标：** 让多 Provider 真正共享一份事件协议，而不是“名义 canonical、实际 any”。

**新增 / 修改：**

- 修改 `src/shared/types/agent-protocol.ts`
- 修改 `src/preload/index.ts`
- 修改 `src/preload/index.d.ts`
- 新建 `src/shared/lib/normalize-agent-event.ts`
- 新建 `test/phase-23/agent-event-normalization.test.ts`

**关键动作：**

1. 给 canonical event 增加 `eventId`、`sessionSequence`、`sourceChannel`
2. 收拢遗漏的真实事件类型
3. 在 preload 做统一 normalizer
4. 所有 implementer 先通过 `emitAgentEvent()` helper 输出，而不是直接散落 `sendToRenderer('opencode:stream', ...)`

**明确不做：**

- 不上通用 EventBus middleware
- 不改 UI
- 不改 DB schema

**通过标准：**

- `onStream` 的订阅者能收到统一事件形状
- 旧 provider 不需要一次性全部改完，也能通过 normalizer 兼容

---

### Phase 1: 根级事件桥与 Session Runtime Store

**目标：** 把 runtime 真相从页面里抽出来。

**新增 / 修改：**

- 新建 `src/renderer/src/stores/useSessionRuntimeStore.ts`
- 新建 `src/renderer/src/hooks/useAgentEventBridge.ts`
- 修改 `src/renderer/src/hooks/useAgentGlobalListener.ts`
- 修改 `src/renderer/src/stores/useSessionStore.ts`
- 新建 `test/phase-23/use-session-runtime-store.test.ts`

**关键动作：**

1. 只在 App 根挂一个 `useAgentEventBridge`
2. 把 background session 的 unread / in-progress / idle / title sync 移到 bridge
3. 把 Question / Permission / Approval / Plan 统一收进 `interruptQueue`
4. 让旧 stores 先从 runtime store 派生，保证 UI 平滑迁移

**通过标准：**

- 切换 tab 时 interrupt queue 不丢
- 没打开的 session 也能正确更新 unread / in-progress
- active session 不再自行消费一套平行的原始 stream 事件

---

### Phase 2: Main 侧 Timeline Service 与 Durable Transcript 统一

**目标：** 彻底消灭 renderer 侧 durable transcript 拼装逻辑。

**新增 / 修改：**

- 新建 `src/main/services/session-timeline-service.ts`
- 新建 `src/main/ipc/session-timeline-handlers.ts`
- 修改 `src/preload/index.ts`
- 修改 `src/preload/index.d.ts`
- 适配 `src/main/services/claude-code-implementer.ts`
- 适配 `src/main/services/codex-implementer.ts`
- 复用 / 收敛现有 transcript reader

**关键动作：**

1. 提供统一 IPC：`agentOps.getTimeline(sessionId)` 或同等语义接口
2. 把 Codex 的 `messageRows + activityRows -> timeline` 合成迁到 main
3. 把 Claude transcript 的 canonical mapping 固化在 main
4. Renderer 不再直接把 `window.db.sessionMessage.list()` 和 `window.db.sessionActivity.list()` 暴露为核心依赖

**通过标准：**

- refresh 后 assistant 最终消息只 materialize 一次
- provider-specific timeline 合成从 renderer 移除
- fork / undo / redo 都基于统一 timeline boundary

---

### Phase 3: 先让旧 SessionView 吃新状态 spine

**目标：** 在不替换界面的情况下，先验证状态和 transcript 方案是真的稳定。

**修改：**

- 修改 `src/renderer/src/components/sessions/SessionView.tsx`
- 修改相关 tool renderers 的输入来源
- 调整 `SessionView` 内部对 `onStream`、`loadCodexDurableState`、approval stores 的依赖

**关键动作：**

1. `SessionView` 改为：
   - durable data 来自 `getTimeline(sessionId)`
   - runtime data 来自 `useSessionRuntimeStore`
2. 去掉 provider-specific 的重复 stream 订阅
3. 保留现有 DOM 结构和交互尽量不变，降低回归面

**通过标准：**

- 消息不丢
- 消息不重
- 审批不丢
- 背景 session 不失联

---

### Phase 4: 新的 SessionShell 与 Agent HQ-lite UI

**目标：** 在状态 spine 稳定后，再替换展示层。

**新目录建议：**

```text
src/renderer/src/components/session-hq/
├── SessionShell.tsx
├── SessionHeader.tsx
├── ThreadPane.tsx
├── AgentRail.tsx
├── InterruptDock.tsx
├── ComposerBar.tsx
├── cards/
│   ├── MessageCard.tsx
│   ├── ToolCallCard.tsx
│   ├── SubagentCard.tsx
│   ├── PlanMarker.tsx
│   └── CompactionMarker.tsx
└── index.ts
```

**设计原则：**

- 主 thread 只承载用户真正关心的 conversation 主线
- subagent 默认折叠为一张 card，避免主线程噪音
- child session / running tools / unread / approvals 放在右侧 `AgentRail`
- 中断相关 UI 放在 `InterruptDock`，而不是散落在多个 prompt 组件里

**通过标准：**

- 在复杂 session 中，主 thread 可读性显著高于旧版
- child session / subagent 状态可见，但不打断主阅读路径

---

### Phase 5: Composer 状态机与 Queue / Steer / Stop+Send

**目标：** 把“运行中发送消息”的行为从 ad-hoc 逻辑收敛成标准模型。

**新增 / 修改：**

- 修改 `useSessionRuntimeStore`
- 修改 `useSessionStore`
- 新建 `src/renderer/src/lib/session-send-actions.ts`
- 修改 `SessionView` 或 `ComposerBar`
- 新建 `test/phase-23/session-send-actions.test.ts`

**关键动作：**

1. 把 queued / steering / interrupted message 统一建模
2. 对多个 pending message 支持顺序调整
3. 明确 plan mode / approval pending 时的发送规则

**通过标准：**

- 运行中发送新消息时，用户总能看清当前将发生什么
- pending messages 在 session 切换后不会消失

---

### Phase 6: 全局 Session Status Indicator 与后台可见性

**目标：** 不再只靠进入 session 页面才知道 agent 在干什么。

**新增 / 修改：**

- 新建 `src/renderer/src/components/layout/SessionStatusIndicator.tsx`
- 修改 `src/renderer/src/components/layout/MainPane.tsx`
- 修改 `SessionTabs` 或其周边 header 区域

**显示内容：**

- unread sessions 数量
- in-progress sessions 数量
- pending approval sessions 数量
- 快速筛选到“有活动的 session”

**说明：**

Xuanpu 不必照抄 VS Code 的完整 sessions list，但必须补上一个全局可见的“活动状态控制中心”。

---

### Phase 7: 主题预设与 Feature Flag 上线

**目标：** 最后再做视觉增强和灰度切换。

**新增 / 修改：**

- 修改 `src/renderer/src/lib/themes.ts`
- 修改 `src/renderer/src/styles/globals.css`
- 修改 `src/renderer/src/stores/useSettingsStore.ts`
- 修改 `src/renderer/src/components/layout/MainPane.tsx`
- 修改 `SettingsAppearance` 或 General/Experimental 设置页

**关键动作：**

1. 在 `themes.ts` 中新增：
   - `catppuccin-mocha`
   - `catppuccin-latte`
2. 在 `globals.css` 中补 session-specific semantic vars
3. 在 `useSettingsStore` 的 JSON setting 里加入：
   - `sessionUiV2Enabled: boolean`
4. `MainPane` 用 feature flag 切换：
   - off -> `SessionView`
   - on -> `SessionShell`

**明确不做：**

- 不改 SQLite `settings` 表结构
- 不把 Catppuccin 插件安装作为状态重构前提

---

## 八、文件边界建议

### 新建文件

```text
src/shared/lib/normalize-agent-event.ts
src/renderer/src/stores/useSessionRuntimeStore.ts
src/renderer/src/hooks/useAgentEventBridge.ts
src/main/services/session-timeline-service.ts
src/main/ipc/session-timeline-handlers.ts
src/renderer/src/components/session-hq/SessionShell.tsx
src/renderer/src/components/session-hq/SessionHeader.tsx
src/renderer/src/components/session-hq/ThreadPane.tsx
src/renderer/src/components/session-hq/AgentRail.tsx
src/renderer/src/components/session-hq/InterruptDock.tsx
src/renderer/src/components/session-hq/ComposerBar.tsx
src/renderer/src/components/layout/SessionStatusIndicator.tsx
```

### 重点修改文件

```text
src/shared/types/agent-protocol.ts
src/preload/index.ts
src/preload/index.d.ts
src/renderer/src/hooks/useAgentGlobalListener.ts
src/renderer/src/stores/useSessionStore.ts
src/renderer/src/components/sessions/SessionView.tsx
src/renderer/src/components/layout/MainPane.tsx
src/renderer/src/lib/themes.ts
src/renderer/src/styles/globals.css
src/main/services/claude-code-implementer.ts
src/main/services/codex-implementer.ts
src/main/services/opencode-service.ts
```

### 兼容层，先留后删

```text
src/renderer/src/stores/useQuestionStore.ts
src/renderer/src/stores/usePermissionStore.ts
src/renderer/src/stores/useCommandApprovalStore.ts
```

---

## 九、测试与验证

### 自动化测试

新增测试至少覆盖：

- 事件 normalizer：
  - legacy channel -> canonical event
  - `requestID` / `requestId` 等字段兼容
  - `eventId` 去重逻辑
- session runtime store：
  - background session 事件更新
  - interrupt queue FIFO
  - unread / in-progress indicator
- timeline service：
  - Claude timeline
  - Codex timeline
  - OpenCode timeline
  - fork / undo / redo boundary
- composer state machine：
  - queue
  - steer
  - stop-and-send

### 手动验证矩阵

#### Provider 维度

- Claude Code
- OpenCode
- Codex

#### 场景维度

- 单个 session 正常发消息
- streaming 过程中快速切换 session
- background session 完成后显示 unread / in-progress badge
- permission / question / command approval / plan approval 出现后切 tab 再回来
- fork 全量 session
- 从 checkpoint fork
- undo 后继续发送
- context compacted 后消息仍然稳定
- queued / steer / stop-and-send 三种发送动作
- child session / subagent 折叠显示

### 验收标准

- 任意 provider 下，最终 assistant 消息只出现一次，刷新后不重复。
- 背景 session 在未打开详情页时也能正确更新 unread / in-progress / approval 状态。
- interrupt queue 在切 tab、切 worktree、切 inline connection 时不丢。
- renderer 不再持有 durable transcript 的写路径。
- 旧 `SessionView` 在接入新状态 spine 后即可通过回归，不需要等新 UI 完成。
- 新 `SessionShell` 启用后，主 thread 可读性优于旧版，同时 agent activity 可见性显著提升。

---

## 十、风险与回退策略

### 主要风险

- Protocol upgrade 期间，legacy event shape 和 canonical shape 并存，容易出现漏映射。
- 旧 `SessionView` 接入新 state spine 时，局部 effect 可能与新 store 冲突。
- Timeline service 若过早改动过大，可能影响 Codex / Claude 现有 transcript 行为。

### 回退策略

- 每个 Phase 都保持 UI 可运行，不做“大爆炸切换”。
- 新旧事件协议在 preload normalizer 阶段并存，直到 implementer 全量迁完。
- `SessionShell` 始终挂在 feature flag 后面。
- 若新 UI 出现回归，可退回旧 `SessionView`，但仍保留新的 runtime spine 和 timeline service。

---

## 十一、如何闭合当前 Review Findings

- **`eventId` 协议缺失**
  - 在 Phase 0 正式升级 `agent-protocol`、preload、normalizer 和事件 helper。
- **interrupt queue 放在局部 hook 会丢**
  - 在 Phase 1 明确落到 `useSessionRuntimeStore` 的 session-scoped state。
- **renderer 持久化 append 会形成双写**
  - 在 Phase 2 明确 durable timeline 只在 main 侧合成，renderer 只读。
- **`injectedWorktrees` 生命周期设计错误**
  - 在本方案中保持 session-first-prompt 语义，不在 `idle/error` 后清理。

---

## 十二、实施顺序

建议按以下顺序推进，而不是按视觉组件先行：

1. `Phase 0`
   - 协议和 normalizer 打通
2. `Phase 1`
   - runtime store 和根级事件桥落地
3. `Phase 2`
   - main 侧 timeline service 落地
4. `Phase 3`
   - 旧 `SessionView` 吃新状态 spine，通过回归
5. `Phase 4`
   - 新 `SessionShell` / `AgentRail` / `InterruptDock`
6. `Phase 5`
   - composer 状态机
7. `Phase 6`
   - 全局状态指示器和后台可见性
8. `Phase 7`
   - 主题预设与 feature flag 上线

这个顺序的关键在于：**先修真相源和事件流，再换 UI；先让旧页面稳定，再让新页面漂亮。**
