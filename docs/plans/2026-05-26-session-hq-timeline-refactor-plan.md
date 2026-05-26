# Session HQ Timeline Refactor Plan

Date: 2026-05-26
Status: In progress
Scope: `SessionShell`, `AgentTimeline`, timeline node rendering, smart scroll, tool card mapping

## 背景

Session HQ 的主对话区已经成为当前默认路径：

```txt
MainPane
  -> SessionShell
    -> AgentTimeline
    -> useSessionSmartScroll
    -> ComposerBar
```

近期滚动、清屏、流式输出、用户气泡宽度、工具卡展示等问题说明：当前实现不是某一个
CSS 或 spacer 数值不对，而是职责边界已经纠缠在一起。一个很小的 UI 改动，往往会同时
影响以下链路：

- durable `timelineMessages` 到 timeline nodes 的拆分
- streaming mirror 到 live overlay nodes 的拆分
- tool name 到 card type 的映射
- user message 到 round 的分组
- round rail 的 active 状态和跳转
- clear-screen spacer 和浏览器 `scrollTop` clamp
- sticky-bottom / manual-scroll-lock / scroll FAB
- ComposerBar / InterruptDock 高度变化后的底部补偿
- user bubble 下方 actions 对气泡宽度的布局影响

继续在 `AgentTimeline.tsx` 和 `SessionShell.tsx` 内部局部补丁，会让交互行为越来越难预测。
本计划的目标是把“数据建模、渲染组件、滚动几何、工具分发”拆开，让后续需求可以按模块
维护和验证。

## 当前问题

### 1. 文件职责过重

当前关键文件体量和职责都偏大：

| 文件                                                       | 当前职责                                                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/session-hq/SessionShell.tsx`  | 会话运行态、streaming mirror、optimistic user message、事件订阅、pending plan/question、滚动触发、timeline metrics、composer action                                   |
| `src/renderer/src/components/session-hq/AgentTimeline.tsx` | message 拆 node、tool 分类、streaming 去重、round 分组、node 渲染、用户气泡交互、工具卡分发、round rail、viewport/content 测量、clear-screen spacer、scroll indicator |
| `src/renderer/src/hooks/useSessionSmartScroll.ts`          | restore anchor、sticky-bottom、manual lock、scroll FAB、bottom-area resize compensation、programmatic scroll                                                          |

这导致 `AgentTimeline` 既是数据适配层，也是 UI 渲染层，还是部分滚动几何 owner。

### 1.1 代码层面的实锤

这不是预防性重构，当前代码已经出现了明确的重复 owner 和隐式契约：

| 问题                      | 证据                                                                                      | 风险                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 主文件过大                | `SessionShell.tsx` 约 2155 行，`AgentTimeline.tsx` 约 1936 行                             | 任意小改动都要跨越 session 编排、timeline 渲染、scroll timing    |
| clear-screen 公式重复     | `SessionShell.tsx:946-948` 与 `AgentTimeline.tsx:1466-1468`                               | 两边一旦不同步，spacer 和 smart-scroll distance 会错位           |
| `safeBottomPadding` 重复  | `SessionShell.tsx:941-944` 与 `AgentTimeline.tsx:1456-1459`                               | padding 调整必须人工同步，否则浏览器 clamp 边界错误              |
| timeline metrics 重复测量 | `SessionShell.tsx:904-937` 与 `AgentTimeline.tsx:1312-1366` 都有 `ResizeObserver`         | 两套 state 不保证同帧一致，容易产生一帧差                        |
| tool 分类重复             | durable 路径 `AgentTimeline.tsx:411-452`，streaming 路径 `AgentTimeline.tsx:1168-1214`    | durable 和 streaming 可能渲染成不同卡片                          |
| streaming todo 分支缺判断 | durable 侧用 `isTodoWriteTool(...)`，streaming 侧没有                                     | 同一种 todo tool 在流式和落库后可能表现不一致                    |
| 底部几何有三个 owner      | `SessionShell` 算 inset，ref 灌给 hook，`AgentTimeline` 再算 spacer DOM                   | 很难判断 spacer、sticky-bottom、FAB 到底以谁为准                 |
| active round 反向传递     | `SessionShell` 持有 `activeRoundId`，`AgentTimeline.tsx:1406-1438` 根据 scroll 计算后回传 | active round 本质是 scroll 位置派生量，却混在 session 编排状态里 |

这些点说明当前症状已经有代码层面的直接原因。重构目标不是“让代码更好看”，而是消掉已经
影响迭代速度和交互稳定性的隐式契约。

### 2. 同一语义重复实现

tool name 到 card type 的映射至少存在两条路径：

- durable message parts -> timeline nodes
- live streaming parts -> streaming nodes

两条路径各自维护 if/else，长期会导致“正在流式时显示一种卡，落库刷新后显示另一种卡”。

### 3. 滚动几何有多个 owner

clear-screen 和底部补偿现在跨越三处：

- `SessionShell` 计算 `clearScreenBottomInset`
- `AgentTimeline` 计算 `shortContentTopSpacer`
- `useSessionSmartScroll` 在 distance-from-bottom 中读取 inset，并处理 sticky/manual/FAB

当新 round 内容不足一屏时，真正需要的是“让 active round 顶部可以滚到视口顶部所需的
底部空间”。如果 spacer 按整体 content height 计算，长会话里会得到 `0`，浏览器又会把
`scrollTop` clamp 到 `maxScrollTop`，导致用户消息停在中段。

这里最关键的设计边界是：`SessionShell` 不应该负责测 timeline geometry。Shell 可以知道
ComposerBar / InterruptDock 这类 session chrome 的高度，但不应该知道 timeline 内部 spacer
有多高，也不应该持有 `clearScreenBottomInsetRef` 这类 timeline 内部几何细节。

### 4. 视觉布局和交互 affordance 没隔离

用户消息气泡和下方 actions row 在同一个 shrink-to-fit wrapper 内。actions button 即使
`opacity-0` 也会参与布局，导致“两字消息”的气泡被下方 copy/edit/fork 按钮撑宽。

这类问题应该局限在 `UserMessageNode` 内解决，不应该牵动整个 timeline。

## 重构目标

### 目标行为

重构后应保持这些不变式：

| 编号 | 不变式                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------ |
| T1   | durable timeline 和 live streaming overlay 使用同一套 card type 派生规则                               |
| T2   | `AgentTimeline` 不直接负责复杂数据归一化，只接收可渲染 view model                                      |
| T3   | round 分组是纯数据结果，不依赖 DOM 查询                                                                |
| T4   | scroll controller 是滚动几何唯一 owner                                                                 |
| T5   | clear-screen spacer 按 active round 到内容末尾的剩余高度计算                                           |
| T6   | sticky-bottom、manual lock、jump round、clear-screen round 是显式状态，而不是分散的 boolean/ref 副作用 |
| T7   | 用户消息 actions 不影响 bubble intrinsic width                                                         |
| T8   | ComposerBar / InterruptDock 高度变化不会遮挡最后一行，也不会错误触发历史浏览回到底部                   |
| T9   | ask-user、plan、sub-agent、todo 等交互卡状态保持当前语义，不因拆组件而回退                             |
| T10  | 每个阶段都能独立提交，且能用 focused tests 验证                                                        |

### 非目标

- 不重写 Session HQ 整体视觉语言。
- 不移除 current `SessionShell` 默认路径。
- 不在第一阶段改 clear-screen 手感。
- 不把旧 `SessionView` fallback 作为主重构目标。
- 不引入虚拟列表，除非后续 profiling 证明 timeline 节点数量已经成为实际性能瓶颈。
- 不重做 Floating Shuttle Rail / fisheye 交互；它可以拆文件，但不在本轮改行为。

## 目标结构

建议逐步演进到下面的边界：

```txt
src/renderer/src/lib/session-timeline/
  card-type.ts
  view-model.ts
  round-model.ts
  streaming-dedupe.ts

src/renderer/src/components/session-hq/timeline/
  AgentTimeline.tsx
  TimelineScroller.tsx
  TimelineContent.tsx
  TimelineRoundSection.tsx
  TimelineNodeFrame.tsx
  TimelineNodeRenderer.tsx
  UserMessageNode.tsx
  ToolNodeRenderer.tsx
  RoundRail.tsx
  ScrollToBottomIndicator.tsx

src/renderer/src/hooks/
  useTimelineScrollController.ts
```

实际落地时不必一次移动所有文件。可以先保留 `AgentTimeline.tsx` 的 public export，再把内部
逻辑分文件，最后根据稳定程度决定是否把主文件变成薄 wrapper。

## 调整后的执行顺序

本计划采用“先消隐式契约，再拆 UI”的顺序：

1. Phase 0：补基线测试，锁定容易回归的 streaming/durable parity、dedupe、structured filter。
2. Phase 1：抽 tool card type 和 timeline view model，不改 DOM、不改 scroll。
3. Phase 2：先删 dead prop、抽 `safeBottomPadding` helper、引入 pending scroll intent。
4. Phase 3：单独修 clear-screen spacer 按 active round 剩余高度计算。
5. Phase 4：拆 `UserMessageNode` / `ToolNodeRenderer` / `TimelineNodeFrame` 等 UI 组件。
6. Phase 5：把 scroll controller 抽成 thin wrapper，迁移 owner，不重写 sticky/manual lock。
7. Phase 6：继续瘦身 `SessionShell`。
8. Phase 7：删除临时兼容和重复逻辑。

Phase 3 是唯一明确改变交互行为的阶段，必须单独提交，方便回滚和独立验证。

## Execution Corrections

这份计划不能机械按 Phase 2 原文理解为“直接把 timeline metrics 从 `SessionShell` 搬到
`AgentTimeline`”。Phase 2 执行时的真实依赖是：

```txt
SessionShell
  -> useSessionSmartScroll({ clearScreenBottomInsetRef })
  -> passes scrollContainerRef / handlers into AgentTimeline
  -> passes timelineContentRef into AgentTimeline
```

也就是说，当时 `useSessionSmartScroll` 仍由 `SessionShell` 创建，`clearScreenBottomInsetRef`
仍是 smart-scroll 计算 distance-from-bottom 的输入。直接把 metrics owner 搬走，会迫使
`AgentTimeline` 反向驱动 Shell/hook，反而制造新的 bridge。执行时需要先做更小、更确定的
修正：

1. Phase 1 的 `session-timeline` 只能是纯函数层，不允许 import React、stores、i18n 或
   components。当前 `isTodoWriteTool(...)` 位于 components 目录，抽 card type 前应先把这类
   predicate 移到 `src/renderer/src/lib/` 下，避免形成 `lib -> components` 的反向依赖。
2. Phase 1 的 view model 只覆盖 durable + streaming node conversion，不覆盖
   `ephemeralStatusRows`、`inflightCompaction`、`finalTodoTasks`、empty state、scroll indicator
   和 round rail。
3. `ask-user pending cross-validation` 依赖 `useQuestionStore`，属于 component test，不属于
   pure view-model test。
4. 当前 `AgentTimelineProps.clearScreenBottomInset` 已经是死 prop：Shell 仍传参，prop 类型仍在，
   但 `AgentTimeline` 不再解构使用它。应先单独删除这个死接口。
5. Phase 2 第一轮不要急着迁移 metrics owner。先抽 `getTimelineSafeBottomPadding(...)`，删除
   dead prop，定义清屏/跳转 intent；metrics owner 的迁移等 `useTimelineScrollController`
   thin wrapper 出现后再做。
6. Phase 3 的 active-round spacer 修复必须先有明确的 pending scroll intent，否则
   `activeRoundId` 会继续同时表示“当前阅读位置”“清屏目标”“round rail 目标”，耦合不会真正下降。

因此，真正可执行的最小顺序应更保守：

1. 纯数据 guardrail tests。
2. 抽 tool card type，并修正 `isTodoWriteTool(...)` 的依赖方向。
3. 抽 timeline view model，但只覆盖 node conversion。
4. 删除 dead `clearScreenBottomInset` timeline prop。
5. 抽 `getTimelineSafeBottomPadding(...)`，只消掉重复公式，不改 owner。
6. 引入 `PendingRoundScroll` intent，区分 clear-screen 和 round jump。
7. 单独修 active-round clear-screen spacer。
8. 再拆 `UserMessageNode` / `ToolNodeRenderer`。
9. 最后做 `useTimelineScrollController` thin wrapper 和 Shell 瘦身。

## Current Execution Status

2026-05-26 first implementation batch:

- Done: moved todo predicate/data helpers into `src/renderer/src/lib/todo-utils.ts` and kept the
  old component path as a compatibility re-export.
- Done: extracted shared `getTimelineCardTypeFromToolName(...)`, fixing durable/streaming todo
  classification parity.
- Done: extracted pure `buildTimelineViewModel(...)` for durable nodes, streaming nodes, dedupe,
  active-run filtering, todo suppression, and round grouping.
- Done: added focused guardrail tests for card-type parity, streaming dedupe, structured-part
  preservation, stale streaming cleanup, round grouping, todo suppression, and timeline geometry.
- Done: removed the dead `AgentTimelineProps.clearScreenBottomInset` prop.
- Done: shared `getTimelineSafeBottomPadding(...)` and `getClearScreenBottomInset(...)` between
  `SessionShell` and `AgentTimeline`.
- Done: changed clear-screen spacer semantics from whole-content height to active-round remaining
  height, while excluding the spacer itself from subsequent content-height measurements.
- Done: made user-message actions absolute-positioned so hidden Copy/Edit/Fork buttons no longer
  widen short message bubbles.
- Done: extracted `UserMessageNode`, `ToolNodeRenderer`, `TimelineNodeRenderer`, and
  `TimelineNodeFrame` so `AgentTimeline` no longer owns user bubble internals, ask-user pending
  cross-validation, generic tool fallback rendering, or repeated connector/icon/timestamp chrome.
- Done: added `src/renderer/src/hooks/useTimelineScrollController.ts` as a thin wrapper over
  `useSessionSmartScroll`. It now owns `clearScreenBottomInsetRef`, timeline content ref,
  viewport/content/active-round measurement, clear-screen pending scroll, and round-anchor scroll
  target calculation.
- Done: `SessionShell` no longer directly measures timeline geometry or queries timeline DOM for
  round navigation.
- Done: migrated active-round derivation into `useTimelineScrollController`. `AgentTimeline` no
  longer reports `onActiveRoundChange`, and `SessionShell` no longer stores `activeRoundId`.
- Done: added a clear-screen pending-scroll guard so the controller waits for spacer inset when
  the target round would otherwise exceed the current browser `maxScrollTop`.
- Done: extracted `RoundRail` so Floating Shuttle Rail fisheye, hover, height observation, and
  dot navigation no longer live inside `AgentTimeline`.
- Done: completed Phase 6 `SessionShell` thinning with focused hooks for runtime connection,
  thread status rows, timeline tool status transition, abort readiness, event subscription,
  usage hydration, mission tasks, plan actions, user-message actions, pending initial send,
  pending queue drain, optimistic messages, and composer actions.
- Done: started Phase 7 cleanup by making `useTimelineScrollController` the single owner of
  clear-screen spacer geometry; `AgentTimeline` now only renders the supplied spacer height.

## Phase 0: Baseline Guardrails

目标：重构前先把风险行为固定下来，避免拆代码时不知道是否改坏。

### 工作项

1. 梳理当前 Session HQ 主路径测试覆盖。
2. 补纯数据测试，不改业务行为：
   - streaming tool 和 durable tool 应映射为相同 card type。
   - streaming dedupe：已落库 tool 不重复渲染 streaming copy。
   - structured part filter：active run filtering 不隐藏 tool/plan/ask-user。
   - round 分组以 user message 为边界。
3. 补组件级测试，不塞进 pure view-model 测试：
   - ask-user pending cross-validation：question store 仍 pending 时 card 不误显示 answered。
   - user message actions 不应改变 bubble 宽度的目标测试，可以先标记为待修复用例。
4. 保留当前 phase-23 focused test 命令作为回归基线。

### 建议测试

```bash
pnpm vitest run \
  test/phase-23/session-shell-composer-layout.test.ts \
  test/phase-23/agent-timeline-user-actions.test.tsx \
  test/phase-23/use-session-smart-scroll.test.tsx
```

### 验收

- 不改生产代码，或只增加测试辅助。
- 测试能稳定复现当前行为边界。
- 明确哪些用例是“锁定现状”，哪些用例是“待修复目标”。

## Phase 1: Tool Classification And Timeline View Model

目标：先消掉最危险的 duplicated data logic，再把 message/streaming parts 到 renderable
nodes 的转换从 `AgentTimeline` 抽离。这个阶段不改 DOM 结构，不改视觉，不改 scroll 行为。

### Phase 1A: Guardrail Tests

先补 view-model 抽取前的纯数据保护测试。这里不是 nice to have，而是 Phase 1 行为不变的
主要验证工具。

建议新增：

```txt
test/phase-23/session-timeline-view-model.test.ts
```

最小覆盖：

| 场景                       | 断言                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| tool classification parity | bash/read/write/search/sub-agent/plan/ask/todo 在 durable 和 streaming 中得到同一 card type |
| todo variants              | `isTodoWriteTool(...)` 覆盖的 tool name 在 durable 和 streaming 侧都归为 `todo`             |
| streaming dedupe           | 已落库的 `tool_use.id` 不再渲染 streaming copy                                              |
| structured part filter     | active run filtering 不隐藏 tool/plan/ask-user 等 structured parts                          |
| text/reasoning filter      | turn 结束后 streaming text/reasoning 不和 durable copy 重复                                 |
| round grouping             | user message 是 round 起点，后续 assistant/tool 节点归入该 round                            |

`ask-user pending cross-validation` 单独放到组件测试，因为它依赖 `useQuestionStore`，不是纯
view-model 行为。

### Phase 1B: Extract Tool Card Type

先只抽一个函数，改动小、收益高：

```txt
src/renderer/src/lib/session-timeline/card-type.ts
```

```ts
export function getTimelineCardTypeFromToolName(name: string | undefined): TimelineCardType
```

迁移要求：

- durable message path 和 streaming path 必须都调用同一个函数。
- `isTodoWriteTool(...)` 必须覆盖 durable 和 streaming 两侧。
- `card-type.ts` 不允许 import `@/components/...`。若需要复用 todo predicate，先把
  `isTodoWriteTool(...)` 或等价 helper 移到 `src/renderer/src/lib/`。
- 这一步不要顺手移动 DOM 或重排 nodes。

### Phase 1C: Extract Timeline View Model

新增：

```txt
src/renderer/src/lib/session-timeline/view-model.ts
```

核心 API 草案：

```ts
export type TimelineCardType =
  | 'user-message'
  | 'system'
  | 'task-notification'
  | 'thinking'
  | 'bash'
  | 'file-read'
  | 'file-write'
  | 'search'
  | 'sub-agent'
  | 'plan'
  | 'ask-user'
  | 'todo'
  | 'tool-call'
  | 'text'

export interface TimelineViewModelInput {
  timelineMessages: TimelineMessage[]
  streamingParts: StreamingPart[]
  isStreaming: boolean
  activeRunStartedAt?: number | string | null
  suppressTodoCards?: boolean
}

export interface TimelineViewModel {
  nodes: TimelineNode[]
  preludeNodes: TimelineNode[]
  rounds: TimelineRound[]
  streamingNodes: TimelineNode[]
  committedToolUseIds: Set<string>
}

export function buildTimelineViewModel(input: TimelineViewModelInput): TimelineViewModel
```

迁移步骤：

1. 搬出 `messageToNodes`。
2. 搬出 `groupNodesIntoRounds`。
3. 搬出 streaming dedupe 和 streaming nodes 构造。
4. `AgentTimeline` 改为调用 `buildTimelineViewModel(...)`。
5. 保持 `TimelineNodeView` 和 DOM 渲染不动。

验收：

- `AgentTimeline` 行为不变。
- tool 分类只剩一个实现。
- view model 单测覆盖核心分支。

## Phase 2: Timeline Geometry Owner Cleanup

目标：在不改变清屏行为的前提下，先消掉确定安全的重复和死接口。这个阶段是结构修复，不做
active-round spacer 行为改造，也不急着迁移 metrics owner。

### 当前要删除的设计味道

`SessionShell` 现在持有：

- `timelineContentRef`
- `timelineViewportHeight`
- `timelineContentHeight`
- `clearScreenBottomInset`
- `clearScreenBottomInsetRef`
- 一套 `ResizeObserver`

这让 shell 知道了 timeline 内部 spacer 的物理高度。这个方向要修，但不能在 Phase 2 直接
全部删除，因为 `useSessionSmartScroll` 仍在 Shell 中创建并消费 `clearScreenBottomInsetRef`。
Phase 2 只处理低风险部分：dead prop、重复 padding helper、scroll intent 形态。

### 工作项

1. 删除 dead `AgentTimelineProps.clearScreenBottomInset`：
   - 删除 `AgentTimelineProps` 中的 prop 声明。
   - 删除 `SessionShell` 传给 `AgentTimeline` 的 `clearScreenBottomInset={...}`。
   - 不动 `clearScreenBottomInsetRef` 到 `useSessionSmartScroll` 的链路。

2. 抽一个共享 helper，避免 `safeBottomPadding` 继续复制：

```ts
export function getTimelineSafeBottomPadding(bottomFloatingHeight: number): number
```

3. 引入 pending scroll intent 类型，但先不改 spacer 公式：

```ts
type PendingRoundScroll =
  | { type: 'clear-screen'; roundId: string }
  | { type: 'jump'; roundId: string; behavior: ScrollBehavior }
```

4. 保留现有 metrics owner，直到 `useTimelineScrollController` thin wrapper 出现：
   - `SessionShell` 仍可暂时维护 `clearScreenBottomInsetRef`。
   - `AgentTimeline` 仍可暂时维护 spacer DOM 所需 metrics。
   - 这一阶段只减少重复公式和死接口，不假装完成 geometry owner 迁移。

### 验收

- dead `AgentTimelineProps.clearScreenBottomInset` 被删除。
- `safeBottomPadding` 只有一个实现。
- `PendingRoundScroll` 或等价 intent 形态存在，clear-screen 与 round jump 不再共用隐式信号。
- 现有 clear-screen 行为保持不变，行为修复放到 Phase 3。

## Phase 3: Clear-Screen Spacer Behavior Fix

目标：单独修长历史中新发短消息后，用户消息无法顶到视口顶部的问题。这个 commit 会改变交互
行为，必须单独提交、单独可回滚。

### 当前公式

当前 short-content spacer 基于整体 content height：

```txt
spacer = viewportHeight - timelineContentHeight - safeBottomPadding - 24
```

这只适合“整页内容比视口短”的场景。长历史里 `timelineContentHeight > viewportHeight`，
spacer 会是 `0`，浏览器会把 `scrollTop` clamp 到 `maxScrollTop`，导致 active round 顶不到
视口顶部。

### 目标公式

改为按 active round 到内容末尾的剩余高度计算：

```txt
activeRemainingHeight = timelineContentHeight - activeRoundOffsetTop
spacer = max(0, viewportHeight - activeRemainingHeight - safeBottomPadding)
```

含义：不是“整页内容短才撑高”，而是“保证当前 round 顶部有足够滚动空间可以到达视口顶部”。

### 实现边界

- 测量 `activeRoundId` 对应 section 的 `offsetTop` 或相对 content top 的 rect delta。
- spacer 只服务于 active clear-screen round，不影响普通历史浏览。
- round rail 跳转和 clear-screen round 要区分 intent，避免点击历史 round 也制造大底部空白。
- 继续遵守 manual scroll lock：用户明确滚动后不强行清屏/贴底。

### 验收场景

| 场景                                                         | 预期                                      |
| ------------------------------------------------------------ | ----------------------------------------- |
| 长历史中新发两字消息，后续 thinking + Agent Running 不足一屏 | 用户消息能到达视口顶部附近，不停在中段    |
| 长历史中新发消息，后续工具卡很快撑满一屏                     | 不出现过量底部空白                        |
| 短会话中新发消息                                             | 保持原本清屏体验                          |
| 用户手动上滑看历史                                           | streaming 不强行拉回底部，显示 scroll FAB |
| 用户点击 scroll indicator                                    | 回到底部并恢复 sticky-bottom              |
| Composer 从单行变多行                                        | 最后一行不被遮挡                          |
| InterruptDock 出现/消失                                      | bottom compensation 正确                  |

## Phase 4: Render Component Split

目标：把视觉组件拆开，让用户气泡、工具分发、timeline frame、round rail 各自可维护。Phase 4
放在 geometry 去重和 clear-screen 修复之后，避免新组件继续被 spacer/inset props 污染。

### 拆分组件

```txt
components/session-hq/timeline/UserMessageNode.tsx
components/session-hq/timeline/ToolNodeRenderer.tsx
components/session-hq/timeline/TimelineNodeRenderer.tsx
components/session-hq/timeline/TimelineNodeFrame.tsx
components/session-hq/timeline/TimelineRoundSection.tsx
components/session-hq/timeline/RoundRail.tsx
```

### 优先顺序

1. 先抽 `UserMessageNode`。
2. 再抽 `ToolNodeRenderer`。
3. 再抽 `TimelineNodeFrame`，统一左侧 connector、icon、timestamp。
4. 最后抽 `RoundRail`。

### `UserMessageNode` 目标

`UserMessageNode` 应拥有：

- 文本显示
- 图片/文件附件显示
- queued / steered badge
- edit textarea
- copy/edit/fork actions
- 气泡宽度和 actions 布局

修复原则：

- actions row 不参与气泡 intrinsic width。
- 可以使用 absolute positioned actions 或单独 overlay layer。
- hover 视觉可以保留，但按钮占位不能撑宽 bubble。

### `ToolNodeRenderer` 目标

`ToolNodeRenderer` 只负责 card type -> component：

```ts
switch (node.cardType) {
  case 'bash':
    return <BashCard ... />
  case 'file-read':
    return <FileReadCard ... />
  ...
}
```

ask-user 和 plan 的特殊状态仍保留，但不要让这些逻辑留在主 `AgentTimeline`。

### 验收

- DOM 层级可读，`AgentTimeline` 只负责编排。
- 用户气泡短消息宽度跟内容走。
- copy/edit/fork hover 行为不回退。
- ask-user、plan、sub-agent、todo 卡状态不回退。

## Phase 5: Timeline Scroll Controller

目标：把滚动几何和滚动意图统一到一个 hook，减少 timing 副作用。这个阶段先做 thin wrapper，
不要重写 sticky/manual lock 状态机。

### 新 hook

```txt
src/renderer/src/hooks/useTimelineScrollController.ts
```

### 状态模型草案

```ts
type ScrollIntent =
  | { type: 'restore-anchor' }
  | { type: 'stick-bottom' }
  | { type: 'clear-screen-round'; roundId: string }
  | { type: 'jump-round'; roundId: string; behavior: ScrollBehavior }
  | { type: 'user-locked' }
```

### Hook 职责

- 持有 `scrollContainerRef`
- 持有 `contentRef`
- 观测 viewport height / content height
- 观测 bottom chrome height
- 计算 active round offset
- 计算 clear-screen bottom spacer
- 执行 scroll target
- 维护 sticky-bottom / manual-scroll-lock / FAB state
- 暴露 scroll event handlers
- 派生 active round，并对外暴露 `activeRoundId`

### active round 归属

`activeRoundId` 现在由 `SessionShell` 持有，`AgentTimeline` 根据 scroll 位置计算后回传。拆
scroll controller 时应把它收进去，因为 active round 本质是 scroll 位置的派生量，不是
session orchestration state。

### 风险控制

- 第一版 `useTimelineScrollController` 内部复用 `useSessionSmartScroll`，不要直接重写。
- `manualScrollIntentRef`、`pointerDownInScrollerRef`、`isProgrammaticScrollRef`、
  `hasRestoredInitialAnchorRef` 是现有时序契约，第一版只迁移 owner，不改语义。
- 每次迁移一个 scroll intent，保留 focused tests。

### Current Implementation

2026-05-26 已完成第一版 thin wrapper：

- `useTimelineScrollController` 复用 `useSessionSmartScroll`，没有重写 sticky-bottom、
  manual lock、scroll FAB 或 bottom-area resize compensation。
- wrapper 内部接管了 `clearScreenBottomInsetRef`、`timelineContentRef`、timeline metrics
  `ResizeObserver`、active round offset measurement、clear-screen pending intent 和
  `scrollToRound(...)`。
- `SessionShell` 只调用 `requestClearScreenScroll(...)` 触发新 round 清屏，并通过
  `scrollToRound(...)` 处理 round rail 跳转，不再直接 query timeline DOM。
- active round 现在由 controller 从 scroll position / streaming state / explicit round jump
  派生，`AgentTimeline` 只消费 `activeRoundId` 进行 rail 高亮和 spacer offset measurement。
- clear-screen pending scroll 在目标超过当前 `maxScrollTop` 且 spacer inset 尚未计算出时会保留
  pending intent，避免第一帧被浏览器 clamp 到错误位置。
- `RoundRail` 已独立为 `components/session-hq/timeline/RoundRail.tsx`，`AgentTimeline` 只传入
  rounds、active round、scroll container ref 和 round navigation callback。
- 新增 `test/phase-23/use-timeline-scroll-controller.test.tsx`，覆盖 clear-screen pending
  scroll、active-round spacer inset、round-anchor navigation、scroll-derived active round 和
  streaming latest-round active state。

## Phase 6: SessionShell Thinning

目标：让 `SessionShell` 从“所有状态都在这里”变成 session orchestration。

### 应保留在 `SessionShell` 的职责

- session/runtime lifecycle
- composer/action hook wiring
- optimistic message append
- pending plan/question/fork dialog
- event subscription
- high-level store coordination

### 应移出的职责

- timeline view model 构建
- timeline DOM query
- clear-screen spacer 计算
- scroll target 计算
- tool card rendering details
- user bubble layout
- composer send/queue/steer side-effect orchestration

### 迁移后理想边界

```txt
SessionShell
  - owns session orchestration
  - passes timeline data and callbacks

AgentTimeline
  - owns timeline visual composition
  - receives view model or builds it through pure helper

useTimelineScrollController
  - owns scroll state and geometry

timeline/* components
  - own local rendering only
```

### Current Implementation

2026-05-26 已完成第一步 SessionShell thinning：

- 新增 `src/renderer/src/hooks/useSessionComposerActions.ts`，从 `SessionShell` 中移出主
  composer action handler。
- hook 仍然复用 `executeSendAction(...)`，没有重写 send/queue/steer/stop-and-send 的状态机。
- hook 接管：
  - diff comment context 拼接与发送后清理；
  - send / stop-and-send live overlay reset；
  - queue / steer / send 的 first-message 标记；
  - goal composer clear/restore；
  - optimistic user message append、turn-top scroll、失败回滚；
  - attachment prompt parts 构建；
  - stop-only abort 语义。
- `SessionShell` 只负责把 session/runtime 依赖传入 hook，并继续保留 initial pending message、
  edit resend、plan implement/handoff、fork dialog 和 event subscription。
- 新增 `test/phase-23/use-session-composer-actions.test.tsx`，覆盖：
  - queue optimistic bubble 的 `deliveryStatus: 'queued'`；
  - pure stop 不插 optimistic、不清 overlay；
  - send 失败恢复 goal composer 并移除 optimistic；
  - diff comment context + attachment message parts 发送后清理。
- `SessionShell.tsx` 从本阶段开始前约 2019 行降到 1842 行；`AgentTimeline.tsx` 当前约 631 行。

2026-05-26 继续完成 optimistic timeline helper 抽取：

- 新增 `src/renderer/src/hooks/useOptimisticTimelineMessages.ts`，把 optimistic user message 的
  创建、append、remove、trim 收口到单一 controller。
- `SessionShell` 的 initial pending message、edit resend、plan implement 不再手写
  `appendOptimistic(...) -> requestTurnTopScroll(...) -> timelineMessagesRef.current = ... ->
syncOptimisticMessagesToMirror()` 这条副作用链。
- `useSessionComposerActions` 改为接收 `optimisticTimeline` controller，移除 hook 内部重复的
  optimistic remove helper。
- 新增 `test/phase-23/use-optimistic-timeline-messages.test.tsx`，覆盖：
  - optimistic user message 创建时保留 queued delivery status 和 attachments；
  - append 的副作用顺序仍是 optimistic ref/state、turn-top scroll、timeline mirror；
  - remove 会同步清理 optimistic ref、timeline ref、rendered messages 和 streaming mirror；
  - edit resend 的 trim 语义会保留仍在 trimmed timeline 内的 optimistic message。

2026-05-26 继续抽出 pending initial message sender：

- 新增 `src/renderer/src/hooks/usePendingInitialMessageSender.ts`，接管启动时
  `dequeuePendingMessageWithOptions(...) -> optimistic append -> window.agentOps.prompt(...)`
  的发送流程。
- 保留失败路径语义：发送失败时 requeue 原始 pending message/options、移除 optimistic user
  message、清 session status、`resetLiveOverlay(false)` 并 toast。
- `SessionShell` 仅负责传入 runtime session id、`buildPendingPromptOptions(...)`、
  `optimisticTimeline` 和 overlay reset。
- 新增 `test/phase-23/use-pending-initial-message-sender.test.tsx`，覆盖：
  - pending initial message 会携带 launch options 发送，并写入 optimistic timeline；
  - 失败时会回滚 optimistic state 并恢复 pending initial message。
- 完成 optimistic helper 和 pending initial sender 后，`SessionShell.tsx` 当前约 1751 行；
  `AgentTimeline.tsx` 保持约 631 行。

2026-05-26 继续抽出 pending message drain：

- 新增 `src/renderer/src/hooks/usePendingMessageDrain.ts`，接管 busy session 的 pending follow-up
  auto-drain。
- hook 内部仍然复用 `createPendingDrainController()`，保持同一 session drain 串行化，不重写
  queue 状态机。
- 保留 queued attachment 重建语义：有附件时继续调用
  `buildMessageParts(message.attachments as Attachment[], message.content)`，并优先使用 queued
  message 自带的 model / promptOptions。
- `SessionShell` 继续通过返回的 `drainQueuedMessage` 在 runtime idle event 后触发补 drain。
- 新增 `test/phase-23/use-pending-message-drain.test.tsx`，覆盖：
  - idle + pendingCount 时自动 drain，并把 data attachment 转成 message parts；
  - provider send 失败时已 claim 的 queued item 恢复为 pending。
- 完成 pending message drain 后，`SessionShell.tsx` 当前约 1717 行。

2026-05-26 继续抽出 plan actions：

- 新增 `src/renderer/src/hooks/useSessionPlanActions.ts`，接管 plan implement / handoff /
  reject 三条 action。
- 保留关键语义：
  - Claude Code `planApprove(...)` 成功后不插 fake implementation request，继续同一 prompt
    cycle；
  - Codex implement 使用 `Implement the plan.`，并通过 optimistic timeline 显示用户请求；
  - 非 Codex/Claude runtime 仍使用 `buildPlanImplementationPrompt(planContent)`；
  - handoff session 继续携带 goal mode pending options；
  - reject 仍先清 UI 状态并 transition tool status，再调用 `planReject(...)` / `refresh()`。
- 新增 `test/phase-23/use-session-plan-actions.test.tsx`，覆盖：
  - Claude Code approve 不插 optimistic/fake prompt；
  - Codex implement 会 append optimistic message 并按当前 model/options 发送。
- 完成 plan actions 后，`SessionShell.tsx` 当前约 1504 行。

2026-05-26 继续抽出 durable timeline data hook：

- 新增 `src/renderer/src/hooks/useSessionTimeline.ts`，把 `SessionShell` 内部的 durable
  timeline fetch、SDK transcript fallback、optimistic merge/dedupe、attachment cache restore 收口为
  独立 hook。
- 保留关键语义：
  - mounted 时从 streaming buffer 恢复 optimistic user message，支持切 tab 后不丢本地气泡；
  - durable timeline 没有可渲染 assistant 内容时，非 Codex/terminal runtime 仍 fallback 到 SDK
    `getMessages(...)`；
  - durable DB 已出现同内容 user message 后，会移除 optimistic copy；
  - optimistic message 携带的本地 attachment 会在 refresh 后补回 durable user message。
- 新增 `test/phase-23/use-session-timeline.test.tsx`，覆盖 optimistic buffer restore/dedupe、SDK
  transcript fallback、attachment restore。

2026-05-26 继续抽出 user message edit/fork actions：

- 新增 `src/renderer/src/hooks/useSessionUserMessageActions.ts`，接管用户消息 inline edit resend
  和 fork-from-message action。
- `SessionShell` 仍保留 `ForkFromMessageConfirmDialog` 的实际渲染，但不再直接持有
  `editingMessageId`、`editingContent`、`forkingMessageId`、`pendingForkMessageId` 等 action state。
- 保留关键语义：
  - 只有最新 user message 且 session 非 streaming/busy/materializing 时可编辑；
  - edit resend 仍先 trim timeline，再 append optimistic message，并通过 `executeSendAction('send', ...)`
    按当前 model/promptOptions 发送；
  - fork confirmation 的 “don't show again” 仍写入 `skipForkFromMessageConfirm`；
  - fork cutoff 仍通过 `getUserMessageForkCutoff(...)` 取被选 user message 后的第一个非
    optimistic 节点；
  - fork 后仍创建本地 session、刷新 worktree session list、切换 active session。
- 新增 `test/phase-23/use-session-user-message-actions.test.tsx`，覆盖 edit resend 和
  confirmation fork flow。
- 更新 source verification，使它们验证 `SessionShell -> hook -> AgentTimeline/Dialog` wiring，而不是
  要求所有逻辑都留在 `SessionShell.tsx`。
- 完成这两步后，`SessionShell.tsx` 当前约 1176 行；`AgentTimeline.tsx` 保持约 631 行。

2026-05-26 继续抽出 active-session event / usage / mission task 边界：

- 新增 `src/renderer/src/hooks/useSessionUsageHydration.ts`，接管：
  - persisted usage summary fetch；
  - durable timeline assistant usage token hydration；
  - SDK transcript `getMessages(...)` token/cost hydration；
  - active-session `message.updated` completed usage apply helper。
- 新增 `src/renderer/src/hooks/useSessionMissionTasks.ts`，接管当前 round 的 mission task mirror：
  - latest user round 派生；
  - 新 round 清空 shared task；
  - streamed task/todo tool update 合并；
  - idle refresh 后从 committed timeline 重新提取 task snapshot。
- 新增 `src/renderer/src/hooks/useSessionEventSubscription.ts`，把 `SessionShell` 的
  `subscribeToSessionEvents(sessionId, ...)` useEffect 搬成 thin wrapper。
- 保留关键语义：
  - active session idle 仍负责 completed badge、usage refresh、timeline refresh、mission task sync、
    optimistic ref 清空和 pending queue 补 drain；
  - idle refresh finally 仍不清 streaming overlay，避免用户回看刚完成的 live parts 时内容被抹掉；
  - `message.updated` / `session.context_usage` usage 更新逻辑不改；
  - `session.materialized` 仍回填 runtime session id 并刷新 usage；
  - `session.commands_available` 仍只 bump `commandsVersion` 触发 ComposerBar 重新拉 slash commands。
- 新增测试：
  - `test/phase-23/use-session-usage-hydration.test.tsx`
  - `test/phase-23/use-session-mission-tasks.test.tsx`
  - `test/phase-23/use-session-event-subscription.test.tsx`
- `SessionShell.tsx` 当前约 889 行；`AgentTimeline.tsx` 保持约 631 行。

2026-05-26 继续抽出 runtime connection thin hook：

- 新增 `src/renderer/src/hooks/useSessionRuntimeConnection.ts`，接管：
  - worktree session path 从 `useWorktreeStore.worktreesByProject` 同步解析；
  - connection session path 通过 `window.connectionOps.get(connectionId)` 异步解析；
  - `window.agentOps.connect(...)` / `window.agentOps.reconnect(...)`；
  - reconnect 后 runtime session id remap 的 `setOpenCodeSessionId(...)` 和 DB update；
  - `window.agentOps.capabilities(runtimeSessionId)` 派生 `supportsSteer`。
- `SessionShell` 继续持有 high-level `sessionRecord`、`worktreeId`、`connectionId`，但不再直接处理 path
  resolution / connect / reconnect / capabilities IPC。
- 新增 `test/phase-23/use-session-runtime-connection.test.tsx`，覆盖：
  - worktree path connect 并持久化新 runtime id；
  - connection path reconnect remap 并同步 store/DB；
  - capabilities 结果驱动 `supportsSteer`。
- `SessionShell.tsx` 当前约 789 行；`AgentTimeline.tsx` 保持约 631 行。

2026-05-26 Phase 6 收尾：

- 新增 `src/renderer/src/hooks/useSessionThreadStatusRows.ts`，接管 running status row、
  inflight/completed compaction row 派生，以及 durable compaction message 落库后的 completed overlay
  cleanup。
- 新增 `src/renderer/src/hooks/useTimelineToolStatusTransition.ts`，接管 plan approve/reject 后对
  streaming buffer 和 committed timeline message parts 的 tool status 同步更新。
- 新增 `src/renderer/src/hooks/useSessionAbortReadiness.ts`，把 stop-and-send 的 abort 后等 idle/error
  边界从 `SessionShell` 移出，但保留原来的 lifecycle subscription + timeout guard 语义。
- 删除 `SessionShell` 中过时的 “Connect or reconnect to agent runtime on mount” 注释；source
  verification 从旧内联实现检查改为 hook wiring 检查。
- 新增 focused tests：
  - `test/phase-23/use-session-thread-status-rows.test.tsx`
  - `test/phase-23/use-timeline-tool-status-transition.test.tsx`
  - `test/phase-23/use-session-abort-readiness.test.tsx`
- `SessionShell.tsx` 当前约 682 行；`AgentTimeline.tsx` 保持约 631 行。

2026-05-26 当前验证：

- Focused suite：

	  ```bash
	  pnpm vitest run \
	    test/phase-23/use-session-runtime-connection.test.tsx \
	    test/phase-23/use-session-event-subscription.test.tsx \
    test/phase-23/use-session-usage-hydration.test.tsx \
    test/phase-23/use-session-mission-tasks.test.tsx \
    test/phase-23/use-session-user-message-actions.test.tsx \
    test/phase-23/use-session-timeline.test.tsx \
    test/phase-23/session-shell-thread-status-source.test.ts \
    test/phase-23/use-session-plan-actions.test.tsx \
    test/phase-23/use-pending-message-drain.test.tsx \
    test/phase-23/use-pending-initial-message-sender.test.tsx \
    test/phase-23/use-optimistic-timeline-messages.test.tsx \
    test/phase-23/use-session-composer-actions.test.tsx \
    test/phase-23/use-timeline-scroll-controller.test.tsx \
    test/phase-23/session-timeline-view-model.test.ts \
    test/phase-23/session-timeline-geometry.test.ts \
    test/phase-23/timeline-node-renderer.test.tsx \
    test/phase-23/session-shell-composer-layout.test.ts \
    test/phase-23/session-shell-plan-implement-source.test.ts \
    test/phase-23/diff-comments-workflow.test.tsx \
    test/phase-23/agent-timeline-connector.test.tsx \
    test/phase-23/agent-timeline-user-actions.test.tsx \
    test/phase-23/use-session-smart-scroll.test.tsx \
    test/phase-23/session-send-actions.test.ts \
    test/phase-23/composer-bar.test.tsx \
    test/phase-19/session-2/todo-utils.test.ts
  ```

	  结果：25 files / 167 tests passed。`composer-bar.test.tsx` 仍有既有 React act warning。

  2026-05-26 Phase 6 收尾后补跑包含新增 hook tests 的 focused suite：

  ```bash
  pnpm vitest run \
    test/phase-23/use-session-thread-status-rows.test.tsx \
    test/phase-23/use-timeline-tool-status-transition.test.tsx \
    test/phase-23/use-session-abort-readiness.test.tsx \
    test/phase-23/use-session-runtime-connection.test.tsx \
    test/phase-23/use-session-event-subscription.test.tsx \
    test/phase-23/use-session-usage-hydration.test.tsx \
    test/phase-23/use-session-mission-tasks.test.tsx \
    test/phase-23/use-session-user-message-actions.test.tsx \
    test/phase-23/use-session-timeline.test.tsx \
    test/phase-23/session-shell-thread-status-source.test.ts \
    test/phase-23/use-session-plan-actions.test.tsx \
    test/phase-23/use-pending-message-drain.test.tsx \
    test/phase-23/use-pending-initial-message-sender.test.tsx \
    test/phase-23/use-optimistic-timeline-messages.test.tsx \
    test/phase-23/use-session-composer-actions.test.tsx \
    test/phase-23/use-timeline-scroll-controller.test.tsx \
    test/phase-23/session-timeline-view-model.test.ts \
    test/phase-23/session-timeline-geometry.test.ts \
    test/phase-23/timeline-node-renderer.test.tsx \
    test/phase-23/session-shell-composer-layout.test.ts \
    test/phase-23/session-shell-plan-implement-source.test.ts \
    test/phase-23/diff-comments-workflow.test.tsx \
    test/phase-23/agent-timeline-connector.test.tsx \
    test/phase-23/agent-timeline-user-actions.test.tsx \
    test/phase-23/use-session-smart-scroll.test.tsx \
    test/phase-23/session-send-actions.test.ts \
    test/phase-23/composer-bar.test.tsx \
    test/phase-19/session-2/todo-utils.test.ts
  ```

  结果：28 files / 172 tests passed。`composer-bar.test.tsx` 仍有既有 React act warning。

- Scoped ESLint 已通过：

  ```bash
  pnpm exec eslint \
    src/renderer/src/components/session-hq/SessionShell.tsx \
    src/renderer/src/hooks/useSessionRuntimeConnection.ts \
    src/renderer/src/hooks/useSessionEventSubscription.ts \
    src/renderer/src/hooks/useSessionUsageHydration.ts \
    src/renderer/src/hooks/useSessionMissionTasks.ts \
    src/renderer/src/hooks/useSessionTimeline.ts \
    src/renderer/src/hooks/useSessionUserMessageActions.ts \
    test/phase-23/use-session-runtime-connection.test.tsx \
    test/phase-23/use-session-event-subscription.test.tsx \
    test/phase-23/use-session-usage-hydration.test.tsx \
    test/phase-23/use-session-mission-tasks.test.tsx \
    test/phase-23/use-session-timeline.test.tsx \
    test/phase-23/use-session-user-message-actions.test.tsx \
    test/phase-23/session-shell-thread-status-source.test.ts \
    test/phase-23/session-shell-plan-implement-source.test.ts
  ```

  2026-05-26 Phase 6 收尾后，包含新增 hook/test 的 scoped ESLint 也已通过。

- `pnpm build` 通过，仍有既有 Vite dynamic/static import warnings。
- `git diff --check` 通过。
- `pnpm lint` 当前被无关 untracked 文件
  `src/main/services/xuanpu-agent/context/compressor.ts` 的 `require()` lint error 阻塞；该文件不属于
  本阶段 Session HQ / timeline refactor 改动。

## Phase 7: Cleanup And Deletion

目标：删除临时兼容层和重复逻辑。

### 清理项

- 删除旧的 duplicated tool classification。
- 删除 `SessionShell` 和 `AgentTimeline` 双份 metrics 计算。
- 删除不再需要的 `clearScreenBottomInset` prop/ref 穿透。
- 删除 DOM query scattered logic，集中到 scroll controller。
- 精简过时注释，保留设计意图注释。

### 验收

- `AgentTimeline.tsx` 体量显著下降。
- `SessionShell.tsx` 不再直接处理 timeline geometry。
- phase-23 focused tests 通过。
- `pnpm lint` 无新增 warning。
- `pnpm build` 通过。

### Current Implementation

2026-05-26 已开始 Phase 7 cleanup：

- `AgentTimeline` 不再本地重复测量 `timelineViewportHeight` / `timelineContentHeight` /
  `activeRoundOffsetTop`，也不再 import `CLEAR_SCREEN_SPACER_SELECTOR` 或
  `getClearScreenBottomInset(...)`。
- clear-screen spacer height 由 `useTimelineScrollController` 的
  `clearScreenBottomInset` 计算后，通过 `SessionShell -> AgentTimeline` 的
  `clearScreenSpacerHeight` 传入。
- `AgentTimeline` 仍负责视觉渲染和内容 ref attachment；timeline scroll geometry owner 保持在
  `useTimelineScrollController`。
- 旧的 `contentHeightRef` 命名已清理为 `timelineContentRef`，避免继续暗示 renderer 本地维护
  content-height owner。
- 已删除旧的 `src/renderer/src/components/sessions/tools/todo-utils.ts` 兼容 re-export，并把 fallback
  sessions 组件和 phase-19 todo tests 全部迁移到 `@/lib/todo-utils`。
- 更新 `test/phase-23/session-shell-composer-layout.test.ts`，守住
  controller-owned spacer geometry 的 source boundary。
- `AgentTimeline.tsx` 当前约 525 行；`SessionShell.tsx` 当前约 683 行。
- Phase 7 cleanup 验证：
  - todo-utils path cleanup target tests：3 files / 12 tests passed。
  - migrated todo-utils scoped ESLint 通过，无 error；`SessionView.tsx` / `ToolCard.tsx` 仍有既有
    `react-refresh/only-export-components` warning。
  - focused suite：28 files / 173 tests passed；`composer-bar.test.tsx` 仍有既有 React act warning。
  - scoped ESLint 通过。
  - `pnpm build` 通过，仍有既有 Vite dynamic/static import warnings。
  - `git diff --check` 通过。
  - dev smoke 通过：`http://localhost:5173` 返回 200 OK，最近 dev log 未扫到
    ReferenceError / TypeError / SyntaxError / crash / missing export。

## 提交策略

每个阶段独立提交，避免一次 PR 同时改数据、DOM、滚动。

建议提交边界：

1. `test: add session timeline refactor guardrails`
2. `refactor: extract timeline tool card type`
3. `refactor: extract session timeline view model`
4. `refactor: remove dead clear screen timeline prop`
5. `refactor: share timeline safe bottom padding`
6. `refactor: introduce pending round scroll intent`
7. `fix: compute clear screen spacer from active round`
8. `refactor: split session timeline renderers`
9. `fix: isolate user message actions layout`
10. `refactor: introduce timeline scroll controller`
11. `refactor: thin session shell timeline responsibilities`

如果某阶段发现风险过高，优先停在“抽纯函数 + 单测”边界，不继续碰 DOM 或 scroll timing。

## 回归命令

每阶段至少跑：

```bash
pnpm vitest run \
  test/phase-23/use-session-timeline.test.tsx \
  test/phase-23/use-session-user-message-actions.test.tsx \
  test/phase-23/use-session-composer-actions.test.tsx \
  test/phase-23/use-timeline-scroll-controller.test.tsx \
  test/phase-23/session-shell-composer-layout.test.ts \
  test/phase-23/agent-timeline-user-actions.test.tsx \
  test/phase-23/use-session-smart-scroll.test.tsx
```

涉及 view model 时增加：

```bash
pnpm vitest run test/phase-23/session-timeline-view-model.test.ts
```

涉及滚动和布局时增加：

```bash
pnpm lint
pnpm build
```

涉及真实交互手感时，启动开发版并做人工验证：

```bash
pnpm dev
```

人工验证重点：

- 长历史会话中新发短消息。
- 新消息后 thinking + Agent Running 不足一屏。
- streaming 文本持续增长。
- 用户手动上滑期间继续 streaming。
- Composer 多行、附件、InterruptDock 展开。
- copy/edit/fork actions hover。
- ask-user / plan card pending 状态。

## 成功标准

完成后应达到：

- 修改用户气泡样式不需要碰 scroll hook。
- 修改工具卡分类不需要碰 DOM 渲染。
- 修改 clear-screen 行为不需要碰 tool card 或 user bubble。
- durable 和 streaming 的工具显示一致。
- `SessionShell` 只做会话编排，不再直接承担 timeline 几何。
- 每个关键交互都有 focused test 或明确人工验收项。

这次重构的核心不是“把文件拆小”，而是把副作用边界拆清楚。只有这样，后面加需求时才不会
继续出现“改一点点，影响一大片”的维护成本。
