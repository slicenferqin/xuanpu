# Session HQ 信息层级与右侧布局方案

日期：2026-05-30

目标很直接：把“会话信息”从一个容易膨胀的展示面，收敛成可持续维护的层级结构。

当前的问题不是某一个组件画得不够好，而是信息被放在了错误的容器里。
右上角如果同时承载当前会话、多个会话、模型、费用、上下文、状态切换，它很快就会失控。
右侧 inspector 也是同样的问题，不能既是诊断面板，又是会话导航区。

## 结论

**右上角可以放会话相关信息，但只能放“当前会话控制面板”，不能放“会话列表”。**

真正的会话列表应该继续放在 topbar 的 `SessionTabs`，或者在 topbar / header 提供一个可搜索的 session switcher。
右侧面板应该保持为当前会话和 worktree 的 inspector，不承担完整切换职责。

## 设计原则

1. 当前会话优先。
2. 统计信息服务于判断，不服务于占位。
3. 多会话切换和多会话概览是不同任务，不能塞进同一个狭小区域。
4. 右侧面板只做诊断，不做列表堆叠。
5. 多于少的情况要有明确的折叠策略，而不是无限横向生长。

## 推荐的信息分层

### 第一层：当前会话控制面板

放在 SessionHeader 或顶部控制区，内容只保留当前活跃会话的高频状态：

- provider
- model
- lifecycle / running state
- 当前费用
- 当前 token 进度
- 必要时显示 context 压力

这一区域的职责是“让用户一眼知道我现在正在看哪一个会话、它正在做什么、花了多少、是否还在跑”。

它不应该承载：

- 会话列表
- 过多的历史指标
- worktree 级聚合明细
- 其他会话的逐项状态

如果需要跳会话，这一区域只提供一个入口，例如：

- `Sessions · 7`
- `More sessions`
- 搜索式 switcher

### 第二层：会话导航带

会话切换继续由 `SessionTabs` 承担，尤其是 topbar 里的横向 tabs。

它是“切换带”，不是“诊断带”。
它可以容纳很多项，但只负责索引，不负责展示所有细节。

建议的行为是：

- 少量会话时直接展示 tab。
- 中等数量会话时保持横向滚动和左右箭头。
- 会话很多时，把非活跃项收进 overflow popover / searchable switcher。

也就是说，**会话多了以后，应该先压缩导航形式，而不是把右上角撑大。**

### 第三层：右侧 inspector

右侧面板只做三件事：

1. 当前会话的统计摘要
2. worktree / connection 级聚合
3. 数据质量与覆盖情况

建议顺序保持：

- Current Session
- Worktree Aggregate
- Data Quality

这和现在的使用心智是一致的，但要继续压低权重：

- Current Session 是主角
- Worktree Aggregate 是次级
- Data Quality 是诊断信息

右侧不应该再出现完整会话列表。

## 多会话场景的展示策略

这是最重要的一条。

### 1 到 3 个会话

可以正常显示在 topbar tabs 中。
右上角只显示当前会话控制面板。

### 4 到 8 个会话

仍然保留 tabs，但以滚动和左右箭头为主。
右上角仍然只保留当前会话的摘要，不展示其他会话条目。

### 9 个以上会话

进入“高密度模式”：

- tabs 区域继续作为主导航
- 非活跃会话通过 overflow menu / searchable switcher 收纳
- 右上角只显示当前会话和一个总数提示

例如：

- `Current · Codex`
- `Sessions · 12`

这里的 `12` 只是计数，不是列表。

### 20 个以上会话

需要明确降级：

- tabs 保留 active + 最近几项
- 其余项收进搜索式会话切换器
- 右侧 inspector 绝不扩展为会话列表

否则右上角会被“会话密度”压垮。

## 组件映射建议

### `SessionHeader`

职责：当前会话控制面板。

建议保留：

- provider capsule
- model selector
- readiness / runtime capsule
- SessionCostPill
- ContextIndicator

建议新增或强化：

- 当前会话数 / worktree session count 的轻量提示
- 一个进入 session switcher 的入口

不建议放：

- 会话逐项列表
- 多行 session metrics
- 右上角堆叠式 session history

### `SessionTabs`

职责：会话导航带。

建议继续作为多会话的主入口。
如果数量过多，应该先做：

- 搜索
- overflow
- 最近会话快捷入口

而不是把多会话塞到右上角。

### `ContextPanelHost`

职责：当前会话 / worktree inspector。

建议继续保持：

- Current Session
- Worktree Aggregate
- Data Quality

如果需要额外信息，可以加一个轻量 `session_count` / `related sessions` 提示，但不要做成列表。

### `SessionShell`

职责：决定当前视图是“阅读 / 输入 / 诊断 / 切换”哪一种。

这里不适合再长出新的会话列表容器。

## 推荐的最终结构

### 顶部

- 左侧：项目 / worktree / 全局导航
- 中间：SessionTabs，作为会话切换带
- 右侧：当前会话控制面板，显示 active session 的状态与关键指标

### 主体

- 中间：timeline / message stream / composer
- 右侧：inspector

### 右侧 inspector

- 当前会话
- worktree aggregate
- data quality

### 会话很多时

- tabs 收纳 overflow
- header 只保留 active session
- switcher 通过 popover 或 searchable panel 打开

## 视觉原则

右侧和右上角不要同时抢注意力。
如果右侧已经有费用、tokens、context 和数据质量，那么右上角就只保留轻量控制与当前会话身份。

换句话说：

- 右上角是“当前会话仪表盘”
- 右侧是“当前会话与 worktree 的诊断面板”
- topbar tabs 是“会话导航”

这三者必须分工明确。

## 落地顺序

1. 先把右上角定义成当前会话控制面板，不承载多会话列表。
2. 保持 `SessionTabs` 作为唯一的会话导航主入口。
3. 把右侧 inspector 的“当前会话”和“worktree aggregate”权重分开，继续压低 aggregate。
4. 为多会话增加 overflow / search switcher。
5. 最后再做右侧和 header 的视觉再平衡。

