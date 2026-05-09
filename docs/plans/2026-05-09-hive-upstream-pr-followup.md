# Hive Upstream Recent PR Follow-up Plan

## 背景

本计划基于 2026-05-09 对 `morapelker/hive` 的上游扫描：

- 扫描范围：最近 20 条 GitHub Release，重点覆盖 `v1.1.1` 到 `v1.0.111`。
- 最新 Release：[`v1.1.1`](https://github.com/morapelker/hive/releases/tag/v1.1.1)。
- 功能密度最高的近期 Release：[`v1.1.0`](https://github.com/morapelker/hive/releases/tag/v1.1.0)。
- 当前开放 PR：[`#464 Add default allowlist patterns for read-only operations`](https://github.com/morapelker/hive/pull/464)。

这轮不做整包追上游，也不把 Hive 的产品形态原样搬进 xuanpu。原则是：

1. 小而确定的修复优先吸收。
2. Codex 能力相关的上游改动只作为设计输入，按 xuanpu 当前架构重做。
3. 与 Hive 品牌、Pet、Telegram、Jira、Ghostty 等强绑定的能力默认排除。

## 最值得看

### P0. 默认 allowlist 补齐只读操作

参考 PR：[`#464`](https://github.com/morapelker/hive/pull/464)

目标：

- 在 command filter 默认配置里补充常见只读操作匹配。
- 解决用户批准只读操作后，`grep` / `read` / `glob` 仍反复弹权限的问题。

建议实现：

- 在默认 `commandFilter.allowlist` 中加入：
  - `read: **`
  - `grep: * in *`
  - `glob: *`
- 保持现有 `edit: **`、`write: **` 默认项不变。
- 不改变 blocklist、default behavior 和 security 开关语义。

验收：

- 新用户默认配置包含上述只读 pattern。
- 旧 localStorage 设置 deep merge 后不会丢失新增默认字段。
- command filter 单测覆盖 `read`、`grep: pattern in path`、`glob` 的自动批准路径。

### P0. Run output URL 可点击

参考 PR：[`#461`](https://github.com/morapelker/hive/pull/461)

目标：

- 在 Run output 中识别 HTTP/HTTPS URL。
- 支持 Cmd/Ctrl hover 显示可点击状态。
- 支持 Cmd/Ctrl click 用当前系统/Chrome 打开链接。
- 普通点击、右键、无 modifier 点击不触发打开。

建议实现：

- 新增 URL 拆分工具，处理尾随标点、括号、ANSI 文本和普通文本混排。
- 在 `RunOutputLine` 渲染正常输出时 linkify URL。
- 搜索高亮优先级高于 URL linkify；有 search highlight 时保持现有高亮路径，避免两套 span 切分互相干扰。
- 复用已有 `window.systemOps.openInChrome` 或当前项目已有打开链接能力，不新增主进程 IPC。

验收：

- `https://example.com` 渲染成可点击片段。
- `https://example.com).` 只把真实 URL 部分识别为链接。
- Cmd/Ctrl click 调用打开链接方法。
- 普通 click 不调用打开链接方法。
- ANSI 彩色输出在未搜索时仍能正常显示。

### P0. follow-up 发送时刷新 last-message time

参考 PR：[`#454`](https://github.com/morapelker/hive/pull/454)

目标：

- 用户发送 follow-up 时即时刷新 worktree / connection member 的 `last_message_at`。
- 让 sidebar、recent list、pinned list 的活跃时间更贴近真实交互，而不是只依赖 session idle/completion。

建议实现：

- 抽一个轻量 helper，例如 `bumpWorktreeLastMessage`，集中处理：
  - worktree-bound session
  - connection-bound session 的成员 fan-out
  - 缺少 worktree/connection 信息时 no-op
- 在 session composer、kanban follow-up、auto-launch follow-up 等发送入口复用 helper。
- 不改变现有 idle/completion 更新逻辑，只补发送时的及时更新。

验收：

- worktree session 发送 follow-up 后，该 worktree 的 `last_message_at` 更新。
- connection session 发送 follow-up 后，connection 成员 worktree 的 `last_message_at` 更新。
- 无 worktreeId / connectionId 的 board assistant 场景不报错。

## 可关注

### P1. Codex `/goal` 独立设计线

参考 PR：

- [`#456 Add Codex /goal feature support`](https://github.com/morapelker/hive/pull/456)
- [`#462 Add goal mode support for ticket launches`](https://github.com/morapelker/hive/pull/462)
- [`#463 Sync Codex goal state from global listener events`](https://github.com/morapelker/hive/pull/463)
- [`#466 Add goal mode toggle for Codex handoffs`](https://github.com/morapelker/hive/pull/466)

结论：

- 这是近期上游最重要的 Codex 能力线。
- `#456` 改动面很大，不适合 cherry-pick。
- xuanpu 需要按当前 `SessionShell`、`AgentTimeline`、canonical agent event 和 Codex provider 链路重新设计。

建议能力边界：

- Codex 启动或 handoff 时可选择 `/goal`。
- ticket launch 可携带 goal mode 和 success criteria。
- Codex goal updated / cleared 事件进入 canonical event 流。
- session timeline 能展示 goal 当前状态、目标、预算/耗时等关键信息。
- goal 完成或清除后，UI 状态能回收，不残留过期目标。

拆分建议：

1. 事件与 provider 层：Codex schema / event mapper / implementer 支持 goal 事件。
2. store 与 timeline 层：保存每个 session 的 goal state，并在 `AgentTimeline` 或对应卡片渲染。
3. 入口层：handoff、ticket launch、session composer 的 goal mode toggle。

### P2. Composer 输入性能优化

参考 PR：[`#465 Reduce session composer re-renders on typing`](https://github.com/morapelker/hive/pull/465)

结论：

- 方向值得关注，但不能直接按 Hive 的旧 `SessionView` 结构搬。
- xuanpu 当前已经有 `SessionShell` / `ComposerBar` 新结构，需先 profile 再改。

建议：

- 先用 React Profiler 或针对性 render count 测试确认输入时的主要 re-render 来源。
- 只 memo 化稳定 leaf components，不把业务状态藏到难追踪的局部缓存里。
- 保持 queue、steer、pending plan、attachment 等交互语义不变。

### P2. Monaco hunk-focused diff view

参考 PR：[`#451 Add hunk view for Monaco diffs`](https://github.com/morapelker/hive/pull/451)

结论：

- xuanpu 已有 Monaco diff、hunk action gutter、stage/unstage/revert hunk 能力。
- 上游的价值主要在 hunk-focused view mode、隐藏上下文展开和评论区域保留。

建议：

- 不重复实现基础 hunk action。
- 后续作为 diff review 体验升级：增加 split / inline / hunk 三态 view mode。
- 与 PR comment gutter、file viewer tab state、diff prefs store 一起设计。

### P2. PR notification 展示标题

参考 PR：[`#457 Show PR title in notification widget`](https://github.com/morapelker/hive/pull/457)

目标：

- PR 创建或已有 PR 关联成功后，notification widget 除了状态外展示 PR title。

建议：

- 如果 xuanpu 当前 PR notification 信息不足，可作为小 polish 独立实现。
- 字段命名保持简单，例如 `prTitle?: string`。
- UI 中使用一行 muted/truncated 文案，避免挤占 notification 主信息。

### P3. diff comments 与 copy plan

参考 PR：

- [`#437 Restore diff comments feature with full implementation`](https://github.com/morapelker/hive/pull/437)
- [`#435 Add copy-to-clipboard functionality for plan markdown`](https://github.com/morapelker/hive/pull/435)

结论：

- 都有价值，但不进入近期默认实现。
- diff comments 涉及 DB、IPC、diff anchor、side panel、session attachment，适合作为完整 review workflow 设计。
- copy plan 是小功能，但要先确认 xuanpu 当前 plan FAB / ToolCall context menu 的产品语义。

## 不建议投入

以下上游改动本轮不建议进入 xuanpu backlog：

- Hive Pet / first-pet hatch tip / pet drag 修复：
  - [`#444`](https://github.com/morapelker/hive/pull/444)
  - [`#446`](https://github.com/morapelker/hive/pull/446)
  - [`#452`](https://github.com/morapelker/hive/pull/452)
- Telegram plan forwarding：
  - [`#467`](https://github.com/morapelker/hive/pull/467)
  - 改动大、测试未跑，且不符合当前 xuanpu 近期方向。
- Hive/Jira/Ghostty 专项 polish：
  - 除非本地出现同类 bug，否则不主动吸收。

## 实施顺序

建议拆成三组 PR，不要混在一个大 PR：

1. **PR A：低风险体验修复**
   - 默认 allowlist 补只读操作。
   - Run output URL linkify。
   - follow-up 发送时刷新 `last_message_at`。

2. **PR B：Codex `/goal` 设计与基础实现**
   - 先补一份小设计或 PR 描述，锁定 canonical event shape。
   - 实现 Codex goal event mapping、store 状态和 timeline 展示。

3. **PR C：Codex `/goal` 入口补齐**
   - handoff toggle。
   - ticket launch goal mode。
   - success criteria 输入与展示。

P2/P3 项目不进入上述默认批次，等 PR A/B/C 完成后再回看。

## 验证清单

PR A 至少跑：

```bash
pnpm vitest run test/command-filter.test.ts test/run-pane-redesign/run-output-line.test.tsx
```

如果新增了 URL 工具或 last-message helper，需要补充并运行对应测试文件。

Codex `/goal` PR 至少覆盖：

- Codex event mapper: goal updated / cleared。
- renderer store: session goal state set / clear。
- timeline UI: active / paused / completed / cleared 状态渲染。
- handoff / ticket launch: goal mode 只影响 Codex，不影响 Claude Code / OpenCode。

最终合入前跑：

```bash
pnpm lint
pnpm build
```

## 默认假设

- 不直接 merge 或 cherry-pick 上游 Hive commit。
- 不追更 20 条 release 之前的内容。
- 不把 Hive 的 Pet、Telegram、品牌化 UI 作为 xuanpu 方向。
- 当前已有 `package.json` 本地改动与本计划无关，后续实现时必须保持不动，除非对应 PR 明确需要依赖变更。
