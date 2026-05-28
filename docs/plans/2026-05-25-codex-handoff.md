# Codex 交接文档：玄圃 xuanpu-agent 1.5.0

日期：2026-05-25
状态：准备就绪，可由 Codex 接手
分支：`feat/xuanpu-agent-oh-my-pi`

---

## 交接目标

本文档是玄圃 1.5.0 "上下文原生 Agent Harness" 规划的完整交接包。目标读者是 **Codex**（AI coding assistant），文档写成了 Codex 可以直接读文件、理解上下文、执行任务的形态。所有"你"指 Codex。

**目标**：让 Codex 从"理解现状"到"可以动手实现 M0 → M1.5"。

---

## 文档地图

### 规划文档（阅读顺序）

| 文档 | 作用 | 优先级 |
|---|---|---|
| `docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md` | 主规划。里程碑（M0–M6 + M1.5）、版本范围、近期行动 | **必须读** |
| `docs/plans/2026-05-24-xuanpu-agent-1.5.0-plan-review.md` | OpenClaude review，5 个 action items（AI-1~5）| **必须读** |
| `docs/plans/2026-05-25-reasonix-comparison-and-borrowings.zh-CN.md` | 与 Reasonix 的相似/不同分析，"不抄什么"清单 | 高 |
| `docs/plans/2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md` | M1.5 工具调用修复接口草案 | 高（实施 M1.5 前读） |
| `docs/architecture/xuanpu-agent-invariants.md` | 58 条不变量清单（INV-XFP/LOG/CACHE/SCRATCH/TOOL/MEM/PERM/ERR/BUDGET） | 高（code review 引用） |
| `docs/architecture/xfp-packet-v1.md` | XFP v1 字段文档 + cache stability 注解 | 中（参考） |

### 代码文件（按职责）

| 文件 | 职责 | 现状 | 缺口 |
|---|---|---|---|
| `src/main/services/xuanpu-agent/runtime.ts` | oh-my-pi session wrapper | 有 bug（M0 修复项） | M0 |
| `src/main/services/xuanpu-agent/context-transform.ts` | 编译 prompt messages（旧架构） | 正在用，worktree | M1 替换 |
| `src/main/services/xuanpu-agent/model-config.ts` | provider/model 解析、credentials | 完成 | — |
| `src/main/services/xuanpu-agent/episode-freezer.ts` | episode freeze 选择逻辑 | 完成 | — |
| `src/main/services/xuanpu-agent/xfp/types.ts` | XFP v1 TypeScript 接口 | 新建，待接入 harness | M1 |
| `src/main/services/xuanpu-agent/xfp/schema.ts` | XFP v1 Zod schema + narrowToMinimal | 新建，待接入 harness | M1 |
| `src/main/services/xuanpu-agent/xfp/fixtures.ts` | XFP 测试 fixture | 新建 | — |
| `src/main/services/xuanpu-agent/tool-policy.ts` | 工具策略、allowed tools 列表 | 有占位，待完善 | M2 |
| `src/main/services/xuanpu-agent/episode-retrieval.ts` | episode gated retrieval | 基本完成 | — |
| `src/main/services/xuanpu-agent/bun-compat.ts` | Bun/node 兼容层 | 完成 | — |

### 待新建目录

```
src/main/services/xuanpu-agent/
  harness/                  # M1 — 新的 harness 目录（替换 context-transform.ts）
    index.ts               # harness 入口，导出 runHarnessTurn()
    compiler.ts            # M1 — XFP packet compiler（context-transform 的替代品）
    build-messages.ts      # M1 — buildMessages() 单一出口，invariants 对齐 Reasonix
    budget.ts              # M1 — Context Budget recorder
    error-taxonomy.ts      # M1 — INV-ERR-* 错误枚举 + HarnessError interface
  tool-call-repair/        # M1.5
    index.ts
    flatten.ts             # flatten: 叶子参数 >10，嵌套 >2
    scavenge.ts            # scavenge: reasoning_content 正则扫工具调用
    truncate.ts            # truncation: JSON 截断修复
    storm.ts               # storm: 同 turn 重复调用抑制
  command-trace/            # M3（部分 M2 先用）
    repository.ts          # SQLite 存储 + raw artifact 文件
    compressor.ts          # 压缩 profile
    profiles/
      git-log.ts
      test-output.ts
  tools/                   # M2
    git-status.ts
    git-log.ts
    git-diff.ts
    list-files.ts
    read-file.ts
    rg-search.ts
    inspect-package-scripts.ts
```

---

## 代码契约（Codex 必须遵守）

### runtime.ts 契约（M0 修复后）

```typescript
// XuanpuPiAgentSession.prompt() 契约
// - 每次 prompt() 调用产生一个独立的 agent turn
// - 返回值 messageId/text/modelRef/usage/rawMessage 属于该 turn
// - 同一个 session 对象多次 prompt() 调用共享 PiAgentLike 实例（缓存）
// - 共享 agent 时，agent.state.messages 累积，不可用 findLastAssistantMessage(agent.state.messages)
//   取当前 turn 的最后一条——必须从订阅的 event.messages 里取
```

**已知 bug（M0 修复）**：`runtime.ts:118` 的 fallback 逻辑在 session 复用时可能取到旧 turn 的 assistant 消息。

修复方案：在 `XuanpuPiAgentSession` 里维护 `pendingMessageIds: Set<string>`，每次 `agent.prompt()` 成功后，把本 turn 产生的消息 id 记下来，`findLastAssistantMessage` 只在这批里找。

### Append-Only Log 契约（M1 实现）

```typescript
// INV-LOG-* 必须全部满足
// 历史消息一旦写入不可修改、不可删除
// 所有写入必须经过 appendAndPersist() 统一入口
// log entry 必须带 packet id 引用

interface AppendOnlyLog {
  readonly entries: ReadonlyArray<LogEntry>   // INV-LOG-2
  appendAndPersist(entry: LogEntry): void     // 唯一写口
  toMessages(): XuanpuPiPromptMessage[]        // INV-LOG-3
}
```

### XFP Packet Compiler 契约（M1 实现）

```typescript
// INV-XFP-* 必须全部满足
// packet 编译统一入口，不允许业务代码手工拼接
// 每个被纳入的 section 必须有 raw refs
// packet 不可变（deepFreeze）

interface XfpPacketCompiler {
  compile(
    worktree: Worktree,
    session: Session,
    userMessage: string,
    options: CompileOptions
  ): {
    packet: XfpFieldPacket      // zod parse 校验后才放行
    decisions: CompilerDecision // 记录 included/omitted，Context Budget 用
  }
}

interface CompilerDecision {
  includedSections: string[]
  omittedSections: { name: string; reason: string }[]
  estimatedTokens: number
  budgetProfile: XfpBudgetProfile
}
```

### Context Budget 契约（M1 实现）

```typescript
// INV-BUDGET-* 必须全部满足
// 每轮必须记录 included / omitted sections
// omitted 必须有 omission reason（v1 字符串，v2 才做到结构化 why）
// Context Budget 对所有 runtime（不只 xuanpu-agent）统一记账

interface ContextBudgetRecord {
  turnId: string
  capturedAt: number
  sessionId: string
  runtime: 'xuanpu-agent' | 'codex' | 'claude-code' | 'opencode'
  packetId: string
  budgetProfile: XfpBudgetProfile
  includedSections: string[]
  omittedSections: string[]
  estimatedTokens: number
  compressionRatio: number | null
  rawPacketRef: string   // 指向 XfpFieldPacket 存储路径
}
```

### 错误分类契约（M1 实现）

```typescript
// INV-ERR-* 必须全部满足
// 对齐 plan-review AI-3

enum HarnessErrorCode {
  TIMEOUT                    = 'TIMEOUT',
  MALFORMED_TOOL_CALL        = 'MALFORMED_TOOL_CALL',
  PERMISSION_DENIED          = 'PERMISSION_DENIED',
  COMPRESSION_FAILURE        = 'COMPRESSION_FAILURE',
  RUNTIME_ERROR              = 'RUNTIME_ERROR',
  TOOL_EXECUTION_ERROR       = 'TOOL_EXECUTION_ERROR',
  BUDGET_EXCEEDED            = 'BUDGET_EXCEEDED',
  REPEATED_TOOL_CALL_GIVE_UP = 'REPEATED_TOOL_CALL_GIVE_UP',  // M1.5 新增
}

interface HarnessError extends Error {
  code: HarnessErrorCode
  recoverable: boolean        // 可恢复的才能重试
  traceId?: string
  context?: Record<string, unknown>
}
```

### 工具调用修复契约（M1.5 实现）

```typescript
// 对齐 docs/plans/2026-05-25-xuanpu-agent-tool-call-repair-interfaces.md

interface ToolCallRepairResult {
  repaired: boolean
  output: ToolCall[]              // 0 个表示完全丢弃
  repairStrategy?: RepairStrategy // 'flatten' | 'scavenge' | 'truncation' | 'storm'
  error?: HarnessError            // 有 error 则 output 不可用
}

interface RepairStrategy {
  type: 'flatten' | 'scavenge' | 'truncation' | 'storm'
  reason: string
  originalInput: string
  traceId: string                 // 可追溯
}
```

---

## 实施路线图（M0 → M1.5）

### M0：Runtime Bug 修复（最高优先级）

**目标**：修掉复用 session 时取错 assistant 消息的问题。

**修改文件**：`src/main/services/xuanpu-agent/runtime.ts`

**改动点**：
1. 在 `XuanpuPiAgentSession` 里加 `private pendingAssistantMessages: PiAssistantMessage[] = []`
2. 订阅逻辑里，`message_end` 和 `agent_end` 事件中，把 `event.messages` 里的所有 assistant 消息 push 到 `pendingAssistantMessages`
3. `prompt()` 返回前：清空 `pendingAssistantMessages`
4. `findLastAssistantMessage` 优先在 `pendingAssistantMessages` 里找，找不到才 fallback 到 `agent.state.messages`

**验收测试**：
```typescript
// 场景：同一个 XuanpuPiAgentSession 调用两次 prompt()
// 预期：第二次返回的是第二次 turn 的 assistant 消息，不是第一次的
const session = new XuanpuPiAgentSession('test-session')
const r1 = await session.prompt('hello', modelRef)
const r2 = await session.prompt('world', modelRef)
// r1.text 不应出现在 r2.text 里
assert(!r2.text.includes(r1.text))
```

### M1：XFP v1 正式接入 Harness

**目标**：让 `context-transform.ts` 逐步被新的 XFP 架构替换；Context Budget 记录器落地。

**改动文件**（新建）：

1. **`harness/error-taxonomy.ts`** — 导出 `HarnessErrorCode` 枚举 + `HarnessError` interface + `isRecoverable()` 辅助函数。覆盖 AI-3 全部 8 个错误码。

2. **`harness/budget.ts`** — `ContextBudgetRecorder` class：
   - `recordTurn(record: ContextBudgetRecord): void` — 写 SQLite 或内存 map
   - `getLatestRecord(sessionId: string): ContextBudgetRecord | null`
   - 实现 INV-BUDGET-*（每轮记录 included/omitted、estimatedTokens、compressionRatio）
   - 注意：先做内存 map 存内存，SQLite schema 后续在 M3 统一加

3. **`harness/compiler.ts`** — `XfpPacketCompiler` class：
   - `compile(worktree, session, userMessage, options): { packet, decisions }`
   - 调用 git-service 获取 gitState
   - 调用 file-tree store 获取 focus
   - 调用 terminal store 获取 terminal summary
   - 调用 ContextBudgetRecorder.recordTurn()
   - packet 必须通过 `XfpFieldPacketSchema.parse()` 才放行
   - 返回 `{ packet, decisions }` 其中 `decisions` 含 included/omitted

4. **`harness/build-messages.ts`** — `buildMessages()` 函数（对齐 Reasonix 契约）：
   ```typescript
   function buildMessages(
     prefix: XfpFieldPacket,
     log: AppendOnlyLog,
     currentRequest: string
   ): XuanpuPiPromptMessage[] {
     // INV-CACHE-3: 必须返回 [prefix, ...log, currentRequest] 顺序
     // prefix 来自 compile() 输出的 packet 里的 anchor section
     // log 来自 session runtime store
     return [
       ...buildPrefixMessages(prefix),
       ...log.toMessages(),
       createUserMessage(currentRequest, Date.now())
     ]
   }
   ```

5. **`context-transform.ts` 改造** — 暂时保留，但让 `buildXuanpuAgentPromptMessages` 调用新的 compiler，逐步把 `<xuanpu-current-field-context>` 替换成结构化 XFP packet 注入。

**验收测试**：
- `XfpFieldPacketSchema.parse()` 对 fixtures.ts 里的两个 fixture 都通过
- 新 compiler 产生的 packet 对旧 context-transform 结果有明确的-diff 覆盖
- Context Budget 每轮 turn 有记录

### M1.5：工具调用修复

**目标**：在工具循环正式开张前，先把模型畸形 tool call 拦截住。

**改动文件**（新建 `harness/tool-call-repair/`）：

1. **`flatten.ts`** — 检测并降维过深的工具 schema：
   ```typescript
   function flattenToolCall(toolCall: ToolCall): { repaired: ToolCall; changed: boolean }
   // INV-TOOL: 叶子参数 >10 或嵌套深度 >2 时触发
   ```

2. **`scavenge.ts`** — 从 reasoning_content 扫出内嵌 tool call：
   ```typescript
   function scavengeToolCalls(reasoningContent: string): ToolCall[]
   // 正则扫 reasoning_content 中的 tool_use block
   ```

3. **`truncate.ts`** — 修复被模型截断的 JSON：
   ```typescript
   function repairTruncatedJson(raw: string): { result: ToolCall | null; repaired: boolean }
   // 尝试 JSON.parse，失败则做启发式截断修复
   // 不可修复时返回 { result: null, repaired: false }
   ```

4. **`storm.ts`** — 同一 turn 重复调用抑制：
   ```typescript
   function suppressToolCallStorm(toolCalls: ToolCall[]): ToolCall[]
   // 相同 (tool.name, tool.input) 的调用合并或丢弃
   // 对应 REPEATED_TOOL_CALL_GIVE_UP 错误码
   ```

5. **`index.ts`** — `repairToolCalls()` 组合函数：
   ```typescript
   function repairToolCalls(raw: string): ToolCallRepairResult
   // 顺序: flatten -> scavenge -> truncate -> storm
   // 每次修复留下 traceId，关联到 command-trace 表
   ```

**注意**：M2 只读工具需要这个层先就位——因为工具返回结果时也要经过同样的压缩/修复管道。

**验收测试**：
- 每个子函数有独立单元测试
- `repairToolCalls()` 对已知畸形输入有确定输出
- REPEATED_TOOL_CALL_GIVE_UP 错误码在 harness error taxonomy 里存在

### M2：只读 Harness 工具

**目标**：xuanpu-agent 能真实读取 git 状态、文件内容、搜索代码。

**工具列表**（按 plan 原文）：
- `git_status` — 调用 git-service，返回结构化 gitState
- `git_log` — 封装 git log --oneline -20，输出经过 M3 压缩 profile
- `git_diff` — 对工作区 diff 做 head/tail truncation（参考 plan-review AI-2 Recommendation A）
- `list_files` — 读取文件树，排除 node_modules / .git 等
- `read_file` — 带 maxLines 参数，支持行范围
- `rg_search` — 封装 ripgrep，输出结构化
- `inspect_package_scripts` — 读 package.json scripts

**注意**：M2 工具输出必须经过 hard truncation（head 500 + tail 500），raw output 存 artifact file，SQLite 存 metadata row。不要让未压缩的输出直接进模型上下文。

**验收测试**：
- 每个工具函数有单元测试
- `git_status` 在 xuanpu --schnauzer worktree 上能跑出当前分支
- 长输出（git log -100）经过 truncation 后 ≤ head 500 + tail 500

---

## 缺口分析与优先处理

### 已有实现（局部可用，需配合 M7 验证）

- XFP v1 类型 + Zod schema + fixtures
- episode freezer + retrieval 逻辑
- model-config provider 解析
- 部分 context-transform（旧架构）
- 所有规划文档和 INVARIANTS 契约清单

> **M7 CR 更新**：以上实现已有代码和测试，但上下文稳态（Context Packer active path、
> soft shrink、prefix cache）尚未全部完成，不能视为可直接放行。

### 立即要做（M0）

1. **runtime.ts bugfix** — 唯一阻塞其他里程碑的已知 bug
2. **harness/error-taxonomy.ts** — 所有后续代码都依赖这个枚举

### M1 做完才能做 M1.5（M1.5 依赖 M1 的 budget recorder）

### M1.5 做完才能做 M2（工具输出压缩需要 tool-call-repair 层先就位）

---

## 测试策略

- **单元测试**：`pnpm vitest run test/xuanpu-agent/` 下，按 harness/、tool-call-repair/、command-trace/ 分组
- **Fixtures**：已有的 `xfp/fixtures.ts` 提供两个 packet fixture，M1 编译器必须有 Zod parse 测试覆盖这两个 fixture
- **集成测试**：M0 bugfix 之后，在 `feat/xuanpu-agent-oh-my-pi` 分支上跑现有 E2E 测试确认没有退化
- **Dogfood 测试**（Task 4，已延后）：让 xuanpu-agent 总结当前 worktree 上游变化，在 M2 完成之后做

---

## 里程碑验收标准（快速对照）

| 里程碑 | 验收一句话 |
|---|---|
| M0 | 同一个 session 连续两次 prompt() 不再出现消息混淆 |
| M1 | XFP packet compiler 产生可 Zod parse 的 packet；Context Budget 每轮有记录 |
| M1.5 | 畸形 tool call 产生明确 HarnessError 而非脏 JSON；storm 抑制有 trace |
| M2 | 用户问"当前分支最近提交"时 xuanpu-agent 真能看到 git 状态 |
| M3 | 长测试输出不原封不动进模型；用户能看到 raw trace |

---

## 设计决策记录（已拍板，不要再讨论）

| 决策 | 结论 | 理由 |
|---|---|---|
| raw output 存文件不存 SQLite | 文件 | 太大；SQLite 只存 metadata + file path |
| cache stability 分 stable/volatile/mixed | 是 | prefix cache 复用依赖这个分区 |
| XFP v1 不做"why omitted" | v2 再做 | v1 只管 what + source refs |
| Context Budget 跨 runtime 记录 | 是 | AI-5 plan-review 决定 |
| M1.5 在 M1 和 M2 之间 | 是 | tool-call repair 是工具循环的前提 |
| REPEATED_TOOL_CALL_GIVE_UP 新增错误码 | 是 | 和 MALFORMED_TOOL_CALL 处理路径不同 |
| 1.5.0 不做通用化 | 是 | Field-native 护城河先打透 |

---

## 参考方向

- **RTK / Rust Token Killer**：命令输出压缩（`command-trace/compressor.ts` 参考）
- **GBrain**：local-first 记忆系统（`src/main/field/memory/` 方向，M5 再做）
- **Reasonix src/loop.ts**：Append-Only Log 契约（`harness/build-messages.ts` 参考）
- **OpenClaude / Claude Code harness**：工具循环 UX（实现参考，不照抄架构）

---

## 如果 Codex 遇到问题

1. **不确定某个设计决策** → 先查 `docs/architecture/xuanpu-agent-invariants.md`，用 INV-* ID 搜索文档
2. **不确定某个字段意义** → 查 `src/main/services/xuanpu-agent/xfp/types.ts` 的 JSDoc 注释
3. **不确定某个 milestone 的范围** → 查主规划文档的 M* 章节
4. **想改已有的不变量** → 先在本次任务里提出，不要直接改 INVARIANTS.md
