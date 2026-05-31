# Session HQ 主对话区域与 Codex 时间线修复方案

> 目标很明确：修两件事。
>
> 1. 主对话区域滚动几何失控：输入框附近遮挡/错位、内容少时能滚出一整屏空白、滚动到顶/底缺少边界感。
> 2. Codex 时间线乱序：截图里 `14:57` 出现在 `14:53` 用户消息上方，就是典型的 durable timeline 排序失败。
>
> 本文按当前代码实际状态和本次实施结果修正方案。默认路径已经不是旧 `SessionView`，而是新版
> `SessionShell + AgentTimeline + useSessionSmartScroll`。旧 `SessionView` 只作为关闭
> `sessionUiV2Enabled` 后的 fallback 兼容处理。

---

## 1. 当前事实

### 1.1 默认入口

当前默认启用新版 Session UI：

| 事实                                                                        | 文件                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `sessionUiV2Enabled: true` 是默认值                                         | `src/renderer/src/stores/useSettingsStore.ts`              |
| `MainPane` 根据 `sessionUiV2Enabled` 选择 `SessionShell` 或旧 `SessionView` | `src/renderer/src/components/layout/MainPane.tsx`          |
| 设置页说明 1.4.0 起默认启用 `SessionShell`                                  | `src/renderer/src/components/settings/SettingsGeneral.tsx` |

因此主修复路径必须是：

```txt
MainPane
  -> SessionShell
    -> AgentTimeline
    -> useSessionSmartScroll
    -> ComposerBar
```

旧路径仍存在，但不是主验收对象：

```txt
MainPane
  -> SessionView
    -> VirtualizedMessageList
```

### 1.2 新版主对话区域当前结构

`SessionShell` 已经采用正确的大结构：

```tsx
<div className="relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
  <div className="row-start-1 row-end-2 min-h-0 overflow-hidden">
    <AgentTimeline ... />
  </div>

  <div className="row-start-2 row-end-3 min-h-0 overflow-visible">
    <InterruptDock ... />
    <ComposerBar ... />
  </div>
</div>
```

这说明 **Composer 不应该改成 absolute/fixed 浮层**。它已经占据真实布局高度，问题不在
顶层布局方向，而在滚动容器和内容层的细节：

| 点                           | 当前状态                                                          | 说明                                                     |
| ---------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `AgentTimeline` 滚动容器     | `h-full min-h-0 overflow-y-auto overscroll-contain`               | 真实主滚动容器已加边界约束                               |
| `AgentTimeline` 内容 wrapper | 动态 `paddingTop` + `paddingBottom`                               | 少量内容按 viewport/content 高度底对齐，长内容保持自然流 |
| `useSessionSmartScroll`      | 已有 sticky-bottom、manual lock、FAB、bottom-area resize 补偿     | 阈值已改为 `max(80px, window.innerHeight * 0.06)`        |
| 旧 `VirtualizedMessageList`  | TanStack Virtual `paddingStart/paddingEnd` + viewport height 测量 | fallback 不再靠外层 padding 处理绝对定位 row             |

### 1.3 时间线当前结构

当前 durable timeline 主路径：

```txt
SessionShell refresh()
  -> window.agentOps.getTimeline(sessionId)
    -> session:getTimeline IPC
      -> getSessionTimeline(sessionId)
        -> db.getSessionMessages(sessionId)
        -> db.getSessionActivities(sessionId)
        -> deriveCodexTimeline(messageRows, activityRows)
          -> normalizeCodexMessageRows(...)
          -> mergeCodexActivityMessages(...)
```

相关事实：

| 事实                                                            | 文件                                     |
| --------------------------------------------------------------- | ---------------------------------------- |
| `CURRENT_SCHEMA_VERSION = 28`                                   | `src/main/db/schema.ts`                  |
| v28 专门用于 `session_activities.sequence` 修复                 | `src/main/db/schema.ts`                  |
| `session_activities.sequence` 字段和 seq index 存在             | `src/main/db/schema.ts`                  |
| `getSessionActivities` 已经优先按 `sequence` 排序               | `src/main/db/database.ts`                |
| `upsertSessionActivity` 已在 DB 层自动分配并保留 sequence       | `src/main/db/database.ts`                |
| `timeline-mappers.ts` activity 排序已优先 sequence              | `src/shared/lib/timeline-mappers.ts`     |
| 旧 renderer fallback `codex-timeline.ts` 也已优先 sequence 排序 | `src/renderer/src/lib/codex-timeline.ts` |

本机 `~/.xuanpu/xuanpu.db` 当前没有查到截图里的具体 session
`019e58c2-1a08-7c43-b833-77a8fc47ab7d` 的 activity 行，所以不能把那条 session 当作
当前环境物证。但代码路径本身已经足够说明风险：activity rows 有 `sequence` 字段，读取层
也准备好了。本次实施后，写入层和 mapper 层已经完成闭环。

---

## 2. 主对话区域修复

### 2.1 目标行为

主对话区域应该满足这些不变式：

| 编号 | 行为                                                                      |
| ---- | ------------------------------------------------------------------------- |
| L1   | 页面是 `Transcript(1fr)` + `BottomStack(auto)` 两行硬布局                 |
| L2   | Composer/InterruptDock 占真实布局高度，不浮在 Transcript 上面             |
| L3   | 内容少于一屏时底对齐，不能把消息整体滚到顶部并露出大面积空白              |
| L4   | 内容多于一屏时自然流滚动，不破坏已有长会话浏览                            |
| L5   | 滚到顶/底时滚动事件不拖动外层工作台，使用 `overscroll-contain`            |
| L6   | 新 token / 新工具卡只在 sticky-bottom 状态下自动跟随                      |
| L7   | 用户手动上滑后保持当前位置，显示跳到底部 FAB                              |
| L8   | Composer multiline、InterruptDock 出现/消失时，最后内容不被挤到输入框下方 |

### 2.2 第一优先级：修新版 `AgentTimeline`

#### A. 给真实滚动容器加边界约束

文件：

```txt
src/renderer/src/components/session-hq/AgentTimeline.tsx
```

当前：

```tsx
<div
  ref={scrollContainerRef}
  className="h-full min-h-0 overflow-y-auto"
  ...
>
```

改为：

```tsx
<div
  ref={scrollContainerRef}
  className="h-full min-h-0 overflow-y-auto overscroll-contain"
  ...
>
```

这一步直接修滚动到顶/底继续拖动外层容器的问题。

#### B. 给 `AgentTimeline` 做少量内容底对齐

`AgentTimeline` 不是虚拟列表，正确做法是在 timeline 内容 wrapper 这一层处理：

```tsx
const [viewportHeight, setViewportHeight] = useState(0)
const [contentHeight, setContentHeight] = useState(0)

const bottomBreathingRoom = bottomFloatingHeight > 0 ? 24 : 72
const topSpacer = Math.max(0, viewportHeight - contentHeight - bottomBreathingRoom)
```

结构上建议加一个内容测量 ref：

```tsx
<div
  ref={scrollContainerRef}
  className="h-full min-h-0 overflow-y-auto overscroll-contain"
  ...
>
  <div
    className="w-[85%] ml-[5%] py-6"
    style={{ paddingTop: `${topSpacer + 24}px`, paddingBottom: `${bottomBreathingRoom}px` }}
  >
    <div ref={contentMeasureRef}>
      {timeline content}
    </div>
  </div>
</div>
```

注意点：

- `topSpacer` 只在内容高度小于 viewport 时生效。
- 内容超过一屏时 `topSpacer = 0`，保持自然流。
- 空状态也要参与同一套底对齐逻辑，不要单独 `py-20` 顶在中间。
- 不要给最后一条消息单独加 margin，这会污染 card 自身职责。

#### C. `useSessionSmartScroll` 只做状态机，不承包布局

`useSessionSmartScroll` 已经负责：

- `stickyBottom`
- `manualScrollLocked`
- `lastSeenVersion`
- FAB 显示与计数
- session view registry 恢复锚点
- bottom area resize 补偿

这部分不用推倒重写。修正点是：

```ts
const NEAR_BOTTOM_THRESHOLD = Math.max(80, Math.round(window.innerHeight * 0.06))
```

并且 bottom-area resize 继续合并滚动，避免在 `ResizeObserver` 回调里反复同步写
`scrollTop` 导致 layout loop。可把“首帧测量”和“已 sticky 时恢复到底部”的逻辑保持在
`useLayoutEffect` 或现有 RAF 合并路径里，不要直接把 composer 改成 floating overlay。

#### D. 截图暴露的主区域验收

截图中输入框上方有大面积空白，且同一屏内可见的消息时间不连续。主区域修复后应满足：

- 内容少时，最后一条消息/时间分隔不应被用户滚到远离 Composer 的上方。
- Composer 不遮住输出，InterruptDock 或 multiline Composer 出现时最后内容仍可见。
- 用户手动离底后不会被流式输出拉回底部。
- 点击 FAB 后回到底部，继续自动跟随新内容。

### 2.3 第二优先级：旧 `SessionView` fallback 兼容

旧 UI 仍可通过设置关闭新版后进入，所以保留兼容修复。

文件：

```txt
src/renderer/src/components/sessions/SessionView.tsx
src/renderer/src/components/sessions/VirtualizedMessageList.tsx
```

`SessionView` 可同样加：

```tsx
<div className="h-full overflow-y-auto overscroll-contain" />
```

`VirtualizedMessageList` 不能只给外层 `paddingTop`。它的 row 是 absolute + transform：

```tsx
transform: `translateY(${virtualRow.start}px)`
```

更稳的实现是用 TanStack Virtual v3 已支持的 `paddingStart/paddingEnd`：

```tsx
const virtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => scrollContainerRef.current,
  estimateSize: () => 150,
  overscan: 5,
  paddingStart: topSpacer,
  paddingEnd: bottomPad,
  measureElement: (element) => element.getBoundingClientRect().height
})
```

或者把 `topSpacer` 明确加进每个 row transform：

```tsx
transform: `translateY(${virtualRow.start + topSpacer}px)`
```

优先选 `paddingStart/paddingEnd`，因为它会被 virtualizer 的 size/scrollToIndex 计算纳入。

---

## 3. Codex 时间线乱序修复

### 3.1 根因

当前乱序链路：

```txt
Codex 事件快速到达
  -> mapCodexManagerEventToActivity(...) 生成 SessionActivityCreate
  -> DatabaseService.upsertSessionActivity(...) 写入 session_activities
  -> sequence 没有自动分配，很多 row 为 NULL
  -> getSessionActivities(...) 虽然按 sequence 优先读，但 NULL 行只能退回 created_at/id
  -> timeline-mappers.ts 同时间戳时继续按 id 字典序排
  -> UUID 字典序不是事件顺序
  -> UI 中出现 14:57 在 14:53 前面的乱序观感
```

关键点：修复不能只改 mapper。必须让写入侧给新 activity 分配单调 sequence，再让 mapper
真正使用 sequence。

### 3.2 写入侧：在 DB 层分配 activity sequence

正确位置：

```txt
src/main/db/database.ts
DatabaseService.upsertSessionActivity(...)
```

不要放在 `codex-activity-mapper.ts`，因为 activity 的来源不只有 mapper：

- Codex manager event
- Codex AskUser synthetic activity
- Codex plan / approval synthetic activity
- JSONL recovery supplemental activity
- OpenCode plan activity
- agent handler 写入的 resolved activity

DB 层策略：

```ts
const existing = db.prepare('SELECT sequence FROM session_activities WHERE id = ?').get(id) as
  | { sequence: number | null }
  | undefined

const nextSequence =
  data.sequence ??
  existing?.sequence ??
  (
    db
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM session_activities WHERE session_id = ?'
      )
      .get(data.session_id) as { next_seq: number } | undefined
  )?.next_seq ??
  1
```

`ON CONFLICT(id)` 时不要把已有 sequence 覆盖成 null：

```sql
sequence = COALESCE(excluded.sequence, session_activities.sequence)
```

这样同一个 activity 重放/更新时顺序不漂移。

### 3.3 迁移：新增 v28，不是 v25

当前 `CURRENT_SCHEMA_VERSION = 28`：

```ts
export const CURRENT_SCHEMA_VERSION = 28
```

`MIGRATIONS` 末尾是：

```ts
{
  version: 28,
  name: 'repair_session_activities_sequence',
  up: `-- handled idempotently by ensureSessionActivitySequenceColumn() in database.ts`,
  down: `
    DROP INDEX IF EXISTS idx_session_activities_session_seq;
  `
}
```

实际修复放在 `DatabaseService.ensureSessionActivitySequenceColumn()`，因为它能同时处理：

- 新 schema 创建后的 index 确认。
- 老库缺 `sequence` 列的版本漂移。
- 已有 `sequence` 部分为空的历史数据。

为什么用 `rowid` 而不是 `id`：

- 文档旧方案里的 `ORDER BY created_at, id` 会把 UUID 字典序固化为 sequence。
- UUID 字典序正是乱序来源之一。
- `rowid` 更接近 SQLite 插入顺序，作为无法恢复原始事件序的历史兜底更合理。
- 如果 session 内已有非空 sequence，空值行从该 session 当前 max(sequence) 之后继续补。

历史回填仍然不是完美还原。真正治本来自新写入的 sequence。回填只是让历史数据在当前库内
稳定，不再每个读路径各排各的。

### 3.4 读取侧：所有 activity 排序都优先 sequence

需要改两组读路径：

```txt
src/shared/lib/timeline-mappers.ts
  - getOrderedActivityTurnIds(...)
  - mergeCodexActivityMessages(...) 内 sortedActivities

src/renderer/src/lib/codex-timeline.ts
  - getOrderedActivityTurnIds(...)
  - mergeCodexActivityMessages(...) 内 sortedActivities
```

排序函数统一成：

```ts
interface ActivitySortKey {
  sequence: number | null
  created_at: string
  id: string
}

function compareActivities(left: ActivitySortKey, right: ActivitySortKey): number {
  const ls = left.sequence
  const rs = right.sequence
  if (ls != null && rs != null && ls !== rs) return ls - rs
  if (ls != null && rs == null) return -1
  if (ls == null && rs != null) return 1

  const leftTime = Date.parse(left.created_at)
  const rightTime = Date.parse(right.created_at)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  return left.id.localeCompare(right.id)
}
```

`id` 只允许作为最后兜底，不能再作为同时间戳的主要排序依据。

### 3.5 验证截图里的乱序

修复后，截图中类似：

```txt
14:57 marker
14:53 user bubble
```

不应再出现于同一个线性 timeline 里。验收要看两层：

1. DB 层：

```sql
SELECT id, kind, created_at, sequence
FROM session_activities
WHERE session_id = '019e58c2-1a08-7c43-b833-77a8fc47ab7d'
ORDER BY sequence ASC, created_at ASC, rowid ASC
LIMIT 80;
```

2. UI 层：

- 打开同一个 Codex session。
- 多次刷新/切 tab，消息顺序不变化。
- 时间分隔与消息气泡不出现明显倒挂。
- 新产生的 tool/activity 行 sequence 连续增长。

---

## 4. 实施顺序

### PR 1：主对话区域

范围：

| Step | 文件                         | 内容                                                     |
| ---- | ---------------------------- | -------------------------------------------------------- |
| 1    | `AgentTimeline.tsx`          | 加 `overscroll-contain`                                  |
| 2    | `AgentTimeline.tsx`          | 内容少于 viewport 时底对齐                               |
| 3    | `useSessionSmartScroll.ts`   | 阈值改成 viewport-aware，保持现有状态机                  |
| 4    | `SessionView.tsx`            | fallback 加 `overscroll-contain`                         |
| 5    | `VirtualizedMessageList.tsx` | fallback 用 `paddingStart/paddingEnd` 做底对齐           |
| 6    | tests                        | 补 `AgentTimeline`/`useSessionSmartScroll` focused tests |

不做：

- 不把 Composer 改成 absolute/fixed。
- 不把全局 `scroll-behavior` 改成 smooth。
- 不用最后一条消息 margin 伪造底对齐。

### PR 2：Codex 时间线

范围：

| Step | 文件                  | 内容                                                     |
| ---- | --------------------- | -------------------------------------------------------- |
| 1    | `database.ts`         | `upsertSessionActivity` 自动分配并保留 sequence          |
| 2    | `schema.ts`           | 新增 v28 `repair_session_activities_sequence`            |
| 3    | `timeline-mappers.ts` | activity 排序优先 sequence                               |
| 4    | `codex-timeline.ts`   | legacy renderer fallback 同步排序逻辑                    |
| 5    | tests                 | DB sequence、mapper sequence、同 created_at 乱序回归测试 |

不做：

- 不新增 v25。
- 不把 sequence 分配只放在 `codex-activity-mapper.ts`。
- 不用 `created_at,id` 固化历史 UUID 顺序。

### PR 3：交互打磨

范围：

| Step | 内容                                     |
| ---- | ---------------------------------------- |
| 1    | `Cmd/Ctrl + Down` 跳到底部并重新 sticky  |
| 2    | `Cmd/Ctrl + Up` 跳到顶部                 |
| 3    | `PageUp/PageDown` 在 Composer 失焦时翻页 |
| 4    | 视需要增加“新消息 N 条”FAB 文案          |

---

## 5. 验收清单

### 主对话区域

- [ ] 新版 Session UI 默认路径下，`AgentTimeline` 是唯一主滚动容器。
- [ ] 1-2 条消息时内容贴近 Composer 上方，不能被滚到顶部后留下大面积空白。
- [ ] 50+ 条消息时自然流滚动，不影响历史浏览。
- [ ] 滚到顶/底不会拖动外层工作台。
- [ ] 流式输出中用户上滑，timeline 不自动抢回底部。
- [ ] FAB 出现后点击能回到底部，并恢复 sticky-bottom。
- [ ] Composer multiline 撑高时最后内容保持可见。
- [ ] InterruptDock 出现/消失时最后内容保持可见。
- [ ] 关闭新版 UI 后旧 `SessionView` fallback 至少不再滚出空屏。

### Codex 时间线

- [ ] 新 activity 写入后 `sequence` 非空且按 session 单调递增。
- [ ] 同 `created_at` 的 activity 按 `sequence` 排，不按 UUID 排。
- [ ] v28 迁移后历史 `session_activities.sequence` 被回填。
- [ ] `getSessionActivities`、`timeline-mappers.ts`、`codex-timeline.ts` 排序口径一致。
- [ ] 截图中的 `14:57` 在 `14:53` 上方这类倒挂不再出现。
- [ ] 同一 Codex session 多次刷新/切 tab，timeline 顺序一致。
- [ ] JSONL recovery / AskUser / plan ready/resolved synthetic activity 不丢 sequence。

---

## 6. 风险

| 风险                                                   | 处理                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `AgentTimeline` 底对齐测量引入抖动                     | 用 `ResizeObserver` 测 content/viewport，top spacer 只在短内容时生效 |
| `useSessionSmartScroll` 与底对齐重复补偿               | 布局归 `AgentTimeline`，sticky/anchor 归 hook，职责分离              |
| 旧 `VirtualizedMessageList` 底对齐影响 `scrollToIndex` | 优先用 TanStack Virtual 的 `paddingStart/paddingEnd`                 |
| v28 历史回填无法恢复真实事件顺序                       | 明确使用 `rowid` 作为最佳历史兜底；新写入 sequence 才是治本          |
| `ON CONFLICT` 重放 activity 改变顺序                   | 冲突更新保留已有 sequence，不用 null 覆盖                            |
| 新旧 timeline mapper 排序不一致                        | shared mapper 和 renderer fallback 同时改，同测覆盖                  |

---

## 7. 最终判断

主对话区域和时间线问题都是真问题，但修复必须按当前默认新版 `SessionShell` 路径下手。

第一波先修 `AgentTimeline/useSessionSmartScroll` 的滚动几何，让截图里的主对话区域不再出现
空屏、遮挡和边界失控。第二波修 `session_activities.sequence` 的写入、迁移和 mapper 排序，
让 Codex durable timeline 不再用 UUID 字典序决定事件顺序。

---

## 8. 第二轮诊断（用户实测后补充）

> § 1-7 的方案 codex 已经落地（`overscroll-contain` + `shortContentTopSpacer` + `getNearBottomThreshold` + activity sequence 全套），但用户实测仍然不对。这一节回到真实截图重新定根因。

### 8.1 截图证据

时间 16:28，主对话区视口里只有一行 `Agent Running 546.8s`，下面是占视口 80% 的纯白区域，**没有 ScrollToBottomFab**，右侧滚动条 indicator 在中段（`scrollHeight` 明显大于 `clientHeight`）。Agent 已经流式运行 9 分钟，但流式内容看不见。

排除：
- ❌ 不是 composer 遮挡（composer 在 `row-start-2`，不会侵入 timeline 区）
- ❌ 不是 `shortContentTopSpacer`（当 content > viewport 时它恒为 0）
- ❌ 不是状态机失效（`stickyBottom` 状态写到了 sessionStorage，不会随便丢）

### 8.2 真实根因 #1：`clearScreenBottomInset` 没解除

`src/renderer/src/hooks/useSessionSmartScroll.ts:91-93`：

```ts
const clearScreenBottomInset = clearScreenActive
  ? Math.max((viewportHeight > 0 ? viewportHeight : 456) - 96, 240)
  : 0
```

当 `clearScreenActive=true` 时，向 timeline 注入 **`viewport - 96px`（最少 240px）的底部空白**。

`AgentTimeline.tsx:1665-1670` 真的把这个 inset 渲染成了实体 spacer：

```tsx
{clearScreenBottomInset > 0 && nodes.length > 0 && (
  <div
    aria-hidden="true"
    data-testid="timeline-clear-screen-spacer"
    style={{ height: `${clearScreenBottomInset}px` }}
  />
)}
```

`SessionShell.tsx:672` 有 `const [clearScreenActive, setClearScreenActive] = useState(false)`，但**没有在新一轮 streaming 开始时调用 `setClearScreenActive(false)`**。结果：
1. 用户某次清屏，`clearScreenActive=true`，inset 注入 ~700px 空白
2. 之后开始新一轮 streaming，状态没解除
3. 新消息渲染到 spacer 上方，但 spacer 把它们顶上去了
4. 用户看到的"大片空白"= 这个 spacer
5. 状态机用 `getDistanceFromBottom(el, clearScreenBottomInset)` 计算"距底"，inset 把"底"往上挪了 700px，所以 sticky 判定为 true，FAB 不显示
6. 用户必须手动滚才能看到刚到达的流式内容（因为视觉"底"在 spacer 上方）

**这一条直接解释了截图的全部三个症状**（大片空白、看不到流式输出、没 FAB）。

### 8.3 真实根因 #2：streaming 期间没有"硬贴底"约束

`useSessionSmartScroll` 的状态机是用户友好的：用户手动上滑 → 解除 sticky → 新消息不抢光标。

但用户的诉求是：**"流式输出触底了应该把内容往上顶，不需要手动滚"**。这是说，**只要用户没主动上滑**，流式增量必须强制把视口贴住 `scrollHeight - clientHeight`。

当前的 `useEffect`（renderer 里被 contentVersion 触发）只在 `isAutoScrollEnabled === true` 时滚动，**且不区分流式 vs 已结束**。问题出在切换会话或首次进入会话时：
- `stickyBottom=true` 的初始状态可能因为首帧测量 `scrollHeight` 还没就绪而失效
- 第一波 streaming 增量到达时，状态机已经把 `manualScrollIntent` 判定为 false，但因为 `isProgrammaticScrollRef` 的 race，scroll 没真正发生

### 8.4 真实根因 #3：鱼眼 Rail 实现走偏

用户原始方案（Fisheye Timeline Rail）核心是：
1. **rail 总高度 = 容器高度 100%**，不允许 rail 内部出现滚动条
2. 50 个 round 时圆点等比压缩成微点/短横线，**全部铺在固定高度的竖线上**
3. Hover 时局部圆点像 macOS Dock 一样**变焦放大**，跟随鼠标 Y 坐标滑动
4. 离开 hover 立即恢复原状（无残留）

codex 现状（`AgentTimeline.tsx` 的 `getRoundRailDotStyle` L176-194）：

```ts
const influenceRadius = clamp(railHeight * 0.22, 52, 96)
```

写了一个**线性影响半径**做圆点缩放，但不是 Dock 风格的"放大+顶开邻居"，只是单点尺寸变化。当 round 数量大时仍然会触发溢出滚动（`setRoundRailHeight(336)` 默认值就是固定 336px，不跟容器走）。

---

## 9. 修订方案 v2

### 9.1 P0 — 修 `clearScreenBottomInset`

#### 方案 A（保守）：streaming 开始时自动解除

`SessionShell.tsx` 找到 streaming 启动入口（`useAgentEventBridge` 收到 `run.started` / `message.streaming.start`），添加：

```tsx
useEffect(() => {
  if (isStreaming) {
    setClearScreenActive(false)
  }
}, [isStreaming])
```

#### 方案 B（推荐）：根本不要"清屏 spacer"

`clearScreenActive` 这个机制本身就是反 L3 的——它强行让"底"在视觉中部，导致 sticky 判定错位。

更标准的清屏体验是：
- **不插入 spacer**
- 而是把上一轮内容用 `opacity-40` 灰化 + 加分隔线 "Cleared 16:28"
- 新一轮 streaming 自然出现在分隔线下方
- 用户上滑仍可读到上一轮历史

```tsx
// AgentTimeline.tsx 删掉 L1665-1670 的 spacer
// 改成在 clearMarker 那个时间点插入一条标记
{clearMarker && (
  <div className="my-6 flex items-center gap-2 text-xs text-muted-foreground">
    <div className="flex-1 border-t border-border" />
    <span>Cleared at {formatTime(clearMarker.at)}</span>
    <div className="flex-1 border-t border-border" />
  </div>
)}
```

并把 `useSessionSmartScroll` 里所有用到 `clearScreenBottomInset` 的距底计算改回纯 `scrollHeight - scrollTop - clientHeight`。

**建议走方案 B**，方案 A 只是 hack 不治本。

### 9.2 P0 — Streaming 期间强 sticky

修改 `useSessionSmartScroll`，加一条规则：

```ts
// 流式期间，只要用户没在"明显上滑"，每次 contentVersion 增加都强制贴底
useEffect(() => {
  if (!isStreaming) return
  const el = scrollContainerRef.current
  if (!el) return
  if (viewState.manualScrollLocked) return // 用户主动上滑了，尊重
  markProgrammaticScroll()
  el.scrollTop = el.scrollHeight - el.clientHeight
}, [isStreaming, contentVersion, viewState.manualScrollLocked])
```

并把 `manualScrollLocked` 的解除条件改成：**只有用户主动 wheel/touch 向上才能 lock，** 同步随手把 lock 在内容触底时自动解开。

### 9.3 P1 — Fisheye Rail（Mac Dock 风格）

重写 `getRoundRailDotStyle`。核心数学：

```ts
// 输入：rail 总高度 H、round 总数 N、hover Y 坐标 hy（null = 没 hover）
// 每个点 i 的原始位置 baseY = (i / (N-1)) * H
// 鼠标距离 d = |baseY - hy|
// fisheye 函数（cosine 钟形）：
//   if d > R (影响半径): scale = 1
//   else: scale = 1 + (MAX_SCALE - 1) * cos(π * d / (2R))

const R = clamp(H * 0.12, 40, 80)          // 影响半径
const MAX_SCALE = 4.5                       // 中心点最大放大倍数
const baseDotSize = clamp(H / N, 2, 8)      // 基础尺寸跟 N 走，N 大就细

function dotStyle(i: number, hy: number | null) {
  const baseY = (i / Math.max(N - 1, 1)) * H
  if (hy === null) return { y: baseY, size: baseDotSize, scale: 1 }
  const d = Math.abs(baseY - hy)
  if (d >= R) return { y: baseY, size: baseDotSize, scale: 1 }
  const t = d / R
  const scale = 1 + (MAX_SCALE - 1) * Math.cos((Math.PI * t) / 2)
  // Dock 关键：放大的点要把邻居"推开"
  const push = (MAX_SCALE - 1) * baseDotSize * Math.sin((Math.PI * t) / 2)
  const y = baseY + (baseY < hy ? -push : push) * 0.5
  return { y, size: baseDotSize * scale, scale }
}
```

容器约束：

```tsx
// AgentTimeline.tsx round rail 部分
<div
  ref={railRef}
  className="relative w-3 h-full overflow-hidden"   // ← h-full + overflow-hidden 双保险
  onPointerMove={handleHover}
  onPointerLeave={() => setHoverY(null)}
>
  {/* 中线 */}
  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border -translate-x-1/2" />
  {/* 每个 round 渲染成 absolute 点，y 和 size 由 dotStyle 决定 */}
  {rounds.map((round, i) => {
    const s = dotStyle(i, hoverY)
    return (
      <div
        key={round.id}
        className="absolute left-1/2 rounded-full bg-foreground/60 -translate-x-1/2 transition-[width,height,top] duration-100"
        style={{
          top: s.y - s.size / 2,
          width: s.size,
          height: s.size,
        }}
        onClick={() => onJumpToRound(round.id)}
      />
    )
  })}
</div>
```

关键点：
- 容器 `h-full overflow-hidden` —— **永不出现 rail 内滚动条**
- 圆点 absolute 定位，y 由数学计算得到 —— rail 不会被点撑高
- `baseDotSize` 跟 N 反比 —— round 越多点越细
- `MAX_SCALE = 4.5` —— hover 时中心点直径达到 ~30px，外圈点保持 2-3px，视觉对比明显

依赖：rail 必须能拿到自己的 `clientHeight`（用 ResizeObserver 设到 state）。

### 9.4 P2 — 视觉边界反馈

`overscroll-contain` 在 Electron 默认不显示橡皮筋。用户要"弹力"感，需要手动加：

```css
/* tailwind config 或全局 css */
.timeline-scroll {
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
/* 滚到边界时用 scroll-shadow 模拟边界 */
.timeline-scroll::before,
.timeline-scroll::after {
  content: '';
  position: sticky;
  display: block;
  height: 8px;
  pointer-events: none;
  background: linear-gradient(to bottom, transparent, hsl(var(--background) / 0.6));
}
```

或者用纯 JS 在到顶/到底时给容器加短暂的 `translateY` transform（30ms × 8px 回弹），更接近 macOS 原生。

---

## 10. 验收清单 v2（追加项）

在 § 5 已有项基础上：

- [ ] **流式输出 9 分钟后视口里始终能看到最新增量**，不需要手动滚
- [ ] 主动上滑后，新增量不抢视口；点 FAB 立刻贴底
- [ ] 清屏后视口里没有任何强制空白；上一轮内容可上滑读到
- [ ] Round Rail 在 50+ 轮次时仍然 100% 填充容器高度，**rail 内无滚动条**
- [ ] 鼠标划过 Rail，hover 点直径 ≥ 24px，邻近点平滑跟随放大；离开 Rail 100ms 内复位
- [ ] 滚到顶/底有可见的边界反馈（gradient 或回弹）

---

## 11. 实施顺序 v2

| Step | 改动 | 文件 | 工作量 |
|---|---|---|---|
| **1** | 移除 `clearScreenBottomInset` 机制，改"灰化分隔线" | `useSessionSmartScroll.ts` + `AgentTimeline.tsx` + `SessionShell.tsx` | ~40 行 |
| **2** | streaming 强 sticky useEffect | `useSessionSmartScroll.ts` | ~15 行 |
| **3** | 重写 `getRoundRailDotStyle` + rail JSX 容器 | `AgentTimeline.tsx` L176-260, L1686-1720 | ~80 行 |
| **4** | 视觉边界反馈（gradient mask 或 JS bounce） | `AgentTimeline.tsx` + 全局 css | ~20 行 |
| **5** | 验收测试覆盖新行为 | `test/phase-23/*` | ~50 行 |

第一波（Step 1+2）能直接修掉截图反映的所有用户痛点。第二波（Step 3）做 Rail。第三波（Step 4+5）打磨。

---

## 12. 给下一个动手的 Claude / Codex 的提醒

1. **别再改 `sessions/SessionView.tsx` 那条路径**，那是旧 UI。session-hq 才是默认入口。
2. **`clearScreenBottomInset` 不是 bug 修复，是病根**，§ 9.1 方案 B 才是出路。
3. **`shortContentTopSpacer` 已经存在且行为正确**，不要再加更复杂的对齐逻辑，那是过度工程。
4. **Fisheye Rail 用 absolute + 数学函数实现**，不要去配 `flex-1` 之类的弹性布局，那永远做不出 Dock 那种"邻居被推开"的效果。
5. **每次改完跑用户 9 分钟 streaming 场景**：发一条"等 10 分钟再回复"，观察视口里能否始终看到增量。能 → 这次真修好了。
