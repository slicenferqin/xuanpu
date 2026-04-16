# CR Report — akita 分支 (Session UI / Agent HQ-lite 重构)

**审查范围:** `origin/main...HEAD` + uncommitted changes (P0-P7 全 8 Phase)
**对比基准:** `origin/main` @ `129463a`
**变更规模:** 2 commits + 11 modified + 15 new files, ~5,700 行新增代码
**审查日期:** 2026-04-13

---

## 门禁结论: 🚫 BLOCK

存在 2 个 P0（功能性 bug），需修复后重新审查。

---

## 分层验证结果

| 层级 | 命令 | 结果 | 备注 |
|------|------|------|------|
| Lint | `pnpm lint` | ⚠️ 7 errors / 39 warnings | **0 errors 来自本分支文件**，全部为既有代码 |
| Build | `pnpm build` | ✅ 通过 (17.27s) | SessionShell chunk 29.6 kB，合理 |
| Tests | `pnpm vitest run test/phase-23/` | ✅ 97/97 pass (1.30s) | 4 个测试文件全部通过 |
| 全量 Tests | `pnpm vitest run` | ⚠️ 进程 exit 144 | Vitest 进程被信号终止（非本分支引入），Phase-23 测试独立通过 |

---

## P0 — 阻断项 (2)

### P0-1. InterruptDock: 所有 4 个 HITL 回复的 IPC 参数顺序错误

**文件:** `src/renderer/src/components/session-hq/InterruptDock.tsx` L45, L50, L67, L84-91

**证据:**

| 调用位置 | InterruptDock 实际调用 | Preload 签名 (index.d.ts) |
|---------|----------------------|--------------------------|
| L45 | `questionReply(worktreePath, requestId, answers)` | `questionReply(requestId, answers, worktreePath?)` |
| L50 | `questionReject(worktreePath, requestId)` | `questionReject(requestId, worktreePath?)` |
| L67 | `permissionReply(worktreePath, requestId, reply, msg)` | `permissionReply(requestId, reply, worktreePath?, msg?)` |
| L84 | `commandApprovalReply(worktreePath, requestId, ...)` | `commandApprovalReply(requestId, approved, ...)` |

**影响:** 所有通过 SessionShell (v2 UI) 的中断回复都会把 `worktreePath` 当作 `requestId` 发给 agent backend，导致 HITL 交互全面失败。旧 SessionView 不受影响。

**修复:** 调整参数顺序，使 `requestId` 为第一个参数。

**验证:** 启用 `sessionUiV2Enabled` → 发送需要 permission 的命令 → 点击 Allow → 确认 agent 正确收到批准。

---

### P0-2. SessionShell: `drainNextPending` 传入 DB sessionId 而非 agent sessionId

**文件:** `src/renderer/src/components/session-hq/SessionShell.tsx` L175-183

**证据:**

```typescript
// SessionShell L176
drainNextPending(
  sessionId,  // ← DB session ID (SQLite UUID)
  ...
  (wp, sid, content) => window.agentOps.prompt(wp, sid, content),
  //                                           ^^ sid = DB sessionId
  worktreePath
)
```

而 `drainNextPending` (session-send-actions.ts L258) 直接把 `sessionId` 传给 `prompt(worktreePath, sessionId, content)`。但 `window.agentOps.prompt` 需要的是 agent-level `droidSessionId`。

**影响:** 通过 v2 UI 排队的消息在 agent idle 后自动 drain 时，会以错误的 session ID 发送，agent 无法识别，消息静默丢失。

**修复:** 将 `drainNextPending` 的第一个参数改为 `droidSessionId`，或改造函数签名接受两个 ID（store key 和 IPC key）。

**验证:** 在 busy session 排队消息 → 等 agent idle → 确认排队消息被正确发送。

---

## P1 — 高优先级 (7)

### P1-1. `sessionUiV2Enabled` 未加入 `extractSettings` 和 `partialize`，flag 不持久化

**文件:** `useSettingsStore.ts` L266-303, L482-517

`extractSettings()` 和 Zustand persist 的 `partialize` 白名单均遗漏 `sessionUiV2Enabled`。用户开启 v2 UI 后重启 app，flag 回退为 `false`。

**修复:** 在 `extractSettings` 返回对象和 `partialize` 白名单中添加 `sessionUiV2Enabled`。

---

### P1-2. `normalizeAgentEvent` 直接 mutate 输入对象

**文件:** `src/shared/lib/normalize-agent-event.ts` L115-138

函数将 `raw` 强转 `any` 后直接在原对象上写入 `eventId`、`sourceChannel`、`statusPayload`。如果 Electron IPC 复用对象引用或同一对象被多处引用，会导致数据污染。

**修复:** 在函数开头 `const event = { ...raw }` 浅拷贝。

---

### P1-3. `sessionSequences` Map 在生产环境中永不清理

**文件:** `normalize-agent-event.ts` L28

每个 session 在 `sessionSequences` Map 留下一条记录，`resetSessionSequence()` 存在但无人调用。长时间运行后 Map 单调增长。

**修复:** 在 session disconnect / archive 时调用 `resetSessionSequence(sessionId)`。

---

### P1-4. `useSessionRuntimeStore.clearSession()` 无外部调用方 — 内存泄漏

**文件:** `useSessionRuntimeStore.ts` L343-354

`clearSession()` 可清理 `sessions`、`interruptQueues`、`pendingMessages` 三个 Map，但 grep 确认无任何外部调用。每次打开新 session 都会在 Map 中累积条目。

**修复:** 在 SessionTabs 关闭 tab、session archive 等生命周期节点调用 `clearSession`。

---

### P1-5. `dequeueMessage()` TOCTOU 竞态 — read 与 write 分离可能丢消息

**文件:** `useSessionRuntimeStore.ts` L309-323

`get()` 读取快照后，`set()` 回调中使用基于旧快照计算的 `rest`。如果在 `get()` 和 `set()` 之间有 `queueMessage` 调用（async drain 场景），新入队消息会被静默覆盖。

**修复:** 将整个 read-then-write 逻辑移入 `set()` updater 内部。

---

### P1-6. EventBridge: background session 的 `session.materialized` 事件被静默丢弃

**文件:** `useAgentEventBridge.ts` L562

Bridge 的事件处理链在未命中特定类型后以 `if (event.type !== 'session.status') return` 兜底。`session.materialized` 不在处理链中，对背景 session 会被丢弃。这导致 `pending::*` session ID 永远无法更新为真实 ID，后续 follow-up dispatch 失败。

**修复:** 在 bridge 中添加 `session.materialized` 处理，调用 `useSessionStore.getState().setOpenCodeSessionId()`。

---

### P1-7. SessionHeader: `PROVIDER_COLORS` / `PROVIDER_LABELS` 的 key 与实际 `agent_sdk` 值不匹配

**文件:** `SessionHeader.tsx` L20-32

Map 的 key 为 `droid`、`claude_alt`、`droid_alt`，但 `Session.agent_sdk` 的实际值为 `'opencode' | 'claude-code' | 'codex' | 'terminal'`。任何 SDK 都匹配不到正确的颜色和标签。

**修复:** key 改为 `opencode`、`claude-code`、`codex`、`terminal`。

---

## P2 — 中优先级 (12)

| # | 文件 | 问题 | 建议 |
|---|------|------|------|
| 1 | `useSessionRuntimeStore.ts` L246 | `getInterruptQueue()` 的 `?? []` 每次创建新数组引用，导致使用该 selector 的组件在任何 store 变更时 re-render | 使用模块级 `EMPTY_ARRAY` 哨兵值 |
| 2 | `useSessionRuntimeStore.ts` L150 | `setLifecycle` 计算 `inProgress` 时未包含 `materializing`，与 Composer 状态机矛盾 | 补入 `lifecycle === 'materializing'` |
| 3 | `useSessionRuntimeStore.ts` L166-173 | `setInProgress()` 可被 `setLifecycle()` 静默覆盖，grep 无外部调用方 | 考虑移除 `setInProgress` 或明确优先级 |
| 4 | `session-send-actions.ts` L195-235 | `executeSendAction` 无 try/catch，`stop_and_send` 中 abort 成功但 prompt 失败时消息丢失 | 在 `stop_and_send` 分支添加 catch，或文档要求调用方 wrap |
| 5 | `timeline-mappers.ts` L303-317 | 用户消息去重以 `content.trim()` 为 key，合法重复 prompt 会被静默丢弃 | 改用 message ID 或 (id + content) 复合 key |
| 6 | `timeline-mappers.ts` L346 | `DbSessionActivity.kind` 类型为 `string` 而非 `SessionActivityKind`，失去穷举检查 | 改用 `SessionActivityKind` |
| 7 | `timeline-mappers.ts` L657-669 | `turnOrder` 用 `Array.includes` 做去重，O(n*m) | 改用 `Set` 辅助去重 |
| 8 | `session-timeline-handlers.ts` L20-21 | IPC handler catch 块返回空 `TimelineResult`，renderer 无法区分"无消息"和"查询失败" | 添加 `error` 字段或抛出结构化错误 |
| 9 | `SessionStatusIndicator.tsx` L33-34 | 订阅整个 `sessions` Map 引用，任意 session 的 `touchActivity` 都触发 useMemo 重算 | 使用 `useShallow` 或自定义 equality 提取标量 |
| 10 | `globals.css` L113-132 | 8 个 session 语义 CSS 变量已定义但 grep 无消费方 | 若为 forward-declare 需注释说明；否则清理 |
| 11 | `InterruptDock.tsx` L37, L59, L76 | 在 render body 调用 `useXxxStore.getState()` 读快照，store 更新后组件不会 re-render | 改为 `useXxxStore(selector)` 订阅 |
| 12 | `useAgentEventBridge.ts` L288 | active session 的 `message.updated` 被跳过，导致 OpenCode/Claude Code 的 token tracking 只在 session 进入 background 后才生效 | 移除 `sessionId !== activeId` 守卫，或在 active 路径也提取 token |

---

## P3 — 低优先级 / 改善项 (15)

| # | 文件 | 问题 |
|---|------|------|
| 1 | `normalize-agent-event.ts` L89,138 | `as CanonicalAgentEvent` 无运行时校验，恶意/畸形事件静默通过 |
| 2 | `normalize-agent-event.ts` L118 | `eventId` 的 falsy 检查与 `sessionSequence` 的 `== null` 检查策略不一致 |
| 3 | `normalize-agent-event.ts` L127-136 | `statusPayload` 两份都存在但值矛盾时无警告 |
| 4 | `normalize-agent-event.ts` L122 | preload 路径 `sessionSequence` 硬编码 `0`，序列排序对 legacy 事件无效 |
| 5 | `useAgentEventBridge.ts` L5 | 文档声称"唯一订阅者"，但 `usePRDetection` 有独立 `onStream` 订阅 |
| 6 | `useAgentEventBridge.ts` L691-693 | background follow-up dispatch 错误被静默吞掉，无日志无 toast |
| 7 | `useSessionRuntimeStore.ts` L29,38 | `InterruptItem.data` 和 `PendingMessage.attachments` 类型为 `any` |
| 8 | `useSessionRuntimeStore.ts` L129 | `ensureSession` 在只读 `getSession` 中每次创建新 throwaway 对象 |
| 9 | `SessionShell.tsx` L129,137 | `streamingParts` state 始终为空，是死代码 |
| 10 | `ComposerBar.tsx` L125 | `reply_interrupt` 模式允许提交空内容 |
| 11 | `ComposerBar.tsx` L116 | 无 double-submit 防护，快速连击可能重复触发 |
| 12 | `session-send-actions.ts` L223 | `stop_and_send` 硬编码 100ms delay 是 race condition 风险点 |
| 13 | `session-hq/*.tsx` | 全部 6 个组件无 ARIA 属性（无 `aria-label`、`aria-live`、`role`） |
| 14 | `session-hq/*.tsx` | 无 ErrorBoundary 包裹（CLAUDE.md 规范要求"where appropriate"） |
| 15 | `themes.ts` L367 | Catppuccin Mocha `foreground` HSL 值轻微偏差 (hue 227/sat 68% vs 官方 226/64%) |

---

## 未覆盖风险

| 项目 | 说明 |
|------|------|
| 全量 Vitest | 进程被信号终止 (exit 144)，无法确认本分支是否引入了其他测试回归 |
| E2E | 未执行 `pnpm test:e2e`，HITL 端到端流程未自动化验证 |
| 手动回归 | 三个 provider × streaming/tab-switch/compaction/fork 组合矩阵未执行 |
| Feature flag 切换 | 未验证运行时从 v1→v2→v1 反复切换是否有状态残留 |

---

## 建议修复优先级

1. **立即修复 (P0):** InterruptDock 参数顺序 + drainNextPending session ID — 这两个是功能性 bug
2. **PR 前修复 (P1):** `sessionUiV2Enabled` 持久化 + `clearSession` 接入生命周期 + `dequeueMessage` TOCTOU + EventBridge `session.materialized` + SessionHeader provider keys
3. **可后续 PR (P2+):** selector 优化、CSS 变量消费、timeline mapper 去重逻辑、InterruptDock 订阅模式

---

*审查人: Claude Code CR Agent | 6 并行审查 agent 汇总*
