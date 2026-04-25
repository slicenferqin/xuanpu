# Phase 21.5 — Agent Tool Events（修订版）

> For: Amp / 下一位接手 Phase 21 扩展的开发者
> Author: slicenferqin（2026-04-22 初版 / 2026-04-22 修订）
> Priority: **release-blocker for 1.4.0**
> 前版：`phase-21.5-agent-tool-events.md`（已过时，本文件替代）

---

## 0 本文档相对初版的修订

本修订基于内部评审（对照 Phase 24C 评审标准：VISION §6 / 反过度设计 / 诚实优于优雅）。5 项必改 + 2 项 nice-to-have 已落地。

| # | 变更 | 章节 |
|---|---|---|
| 1 | Glob / Grep **不**归到 `agent.file_read`，另列 `agent.file_search` 类型，**不进** `hot_files` 排序 | §2, §4, §6 |
| 2 | `operation` union 砍成单值 `'edit'`（V1 不区分 create/delete） | §2 |
| 3 | 所有 agent 事件 `payload` 内**必须携带** `toolUseId`（V1 即使 `relatedEventId` 仍为 `null`，也为未来 Outcome Loop 保留 join key） | §2, §4 |
| 4 | `stdoutHead / stderrTail` **默认不采集**，加独立 toggle `field.agent_bash_capture_output`（默认 OFF） | §2, §5 |
| 5 | 工时 / schema 影响面写实：**约 8 处 TS 类型 / 测试同步**，工时 **1.5 工作日** 而非"半天到一天" | §5, §8 |
| 6 | Sub-agent / Task tool nested events：**V1 跳过**（`parent_tool_use_id` 非 null 时不 emit） | §2, §4 |
| 7 | Future-proof note：若未来加 "agent 改文件后自动 focus" UX，需要 dedupe by path within 5s window | §9 |

---

## 1 背景

Phase 21 采集了 7 类 P0 事件，但**全部是"人的行为"**（file.selection / terminal.command 等）。

真实使用分布下，玄圃用户分两类：

- **IDE 辅助型**：人看代码、选代码、跑命令，AI 偶尔帮忙 —— Phase 21 覆盖良好
- **全委托型**：所有编辑 / 执行 / 读取都由 Agent 完成，人只发 prompt —— Phase 21 事件近乎零

作者实测数据：45 条事件里 24 条 session.message，只有 3 条 terminal.command / 2 条 file.selection（都是手动做验证才产生的）。日常使用下全委托用户的：

- `hot_files` 永远空（Phase 24C `checkpoint-generator.ts` `rankHotFiles` 依赖 file.focus / file.open / file.selection）
- Field Context 的 `## Current Focus` 永远空
- Episodic Memory 只能统计"发了几条 prompt"

**Phase 21.5 的目标：补采 Agent 侧事件，让全委托用户也能享受 Phase 22 / 24C 的记忆与 checkpoint 能力。**

---

## 2 范围（MVP）

4 类事件（修订：原 3 类分裂为 4 类，因 Glob/Grep 与 Read 的语义截然不同——前者是搜索模式，无具体文件路径，不应进入 `hot_files` 排序）：

| 类型 | 触发时机 | payload 关键字段 |
|---|---|---|
| `agent.file_read` | Read / NotebookRead / file_read 工具返回成功 | `toolUseId`、`path`（相对 worktree 根）、`bytes?`、`toolName` |
| `agent.file_write` | Edit / Write / NotebookEdit / MultiEdit / apply_patch 工具返回成功 | `toolUseId`、`path`、`operation: 'edit'`（V1 单值）、`toolName` |
| `agent.file_search` | Glob / Grep 工具返回成功 | `toolUseId`、`pattern`、`matchCount?`、`toolName` |
| `agent.bash_exec` | Bash / exec_command 返回（含超时/失败） | `toolUseId`、`command`（slice 512）、`exitCode?`、`durationMs?`、可选 `stdoutHead?`（1KB）、可选 `stderrTail?`（1KB） |

### 为什么 `agent.file_search` 独立

Glob 的 `input.pattern` 是 `**/*.ts` 这种字符串，不是具体路径。初版把它塞进 `agent.file_read` 的 `path` 字段，下游 `rankHotFiles` 会调 `statSync('**/*.ts')` 必然失败，等于无效事件——但更危险的是如果 ranker 日后没做 stat 过滤，glob 字符串会进入 `hot_files` 列表污染 checkpoint 显示。

独立后：
- `agent.file_search` **不进** `hot_files` 排序，也不派生 `Current Focus`
- 它只为 Episodic Memory 做 "agent 搜了些什么" 的语义帮助（未来可选）
- 保留 `matchCount` 为将来判断"搜索是否高效"提供数据

### 为什么 `operation` V1 只有 `'edit'`

初版 union 是 `'create' | 'edit' | 'delete'`，但代码只在 `toolName === 'Write'` 时设 `'create'`，其他全是 `'edit'`。`'delete'` 永远是 dead code。真正准确区分 create/edit 需要 file-existed-before 检测，那是 Outcome Loop 的工作，不是 V1 的工作。

**V1 约定**：`operation` 固定 `'edit'`。未来 Outcome Loop 引入时再细分，到时候 `'edit'` → `'create' | 'edit'` 是向下兼容的 union 扩展。

### 为什么每个 payload 都必须带 `toolUseId`

- Claude Code: `block.id`（tool_use 的 id）
- Codex: `item.id`
- OpenCode: SDK part id

同一 tool_use 的 read+write、或 bash 触发测试后的 stdoutHead 与后续 session.message，都有天然因果。`relatedEventId` V1 保持 `null`（不做强耦合），但 `toolUseId` 作为最低成本 join key 写进 payload。未来 Outcome Loop 要做 "把 test_pass 归因到 bash 命令" 时，从 payload 查 `toolUseId` 比反查 `relatedEventId` 便宜。

### 为什么 sub-agent nested events 跳过

Claude Code 的 Task tool 会启动子 agent，子 agent 自己用 Read/Write/Bash。如果 nested 工具也 emit，会污染主 session 的 `hot_files`（子任务的 Read 文件被误当主会话的热文件）。

**V1 策略**：检测 tool 调用的 `parent_tool_use_id`（或等价字段），**非 null 时完全跳过 emit**。"我看见的 session 是顶层那个"——符合用户心智。

未来若真需要 sub-session 观测，另开一个 `session.sub_agent_summary` 事件类型（汇总不逐条）。

### 显式不做（留给后续）

- `agent.thinking` / `agent.plan_update`（噪声高，价值低）
- WebFetch / WebSearch（不是本地 workbench 事件，属于外部世界观测）
- Subagent 递归逐条采集（见上条，V1 跳过）
- Per-tool 独立类型（保持 4 类，靠 `toolName` 字段细分）

---

## 3 接入点（已代码核对）

### 3.1 Claude Code runtime

`src/main/services/claude-code-implementer.ts`

- **第 3195 行** `if (blockType === 'tool_use')` —— 工具调用开始时 draft 入 map
- **第 1046–1067 行** —— `tool_result` 合并回 `tool_use` part 时是**完成时刻**

→ 在 1046 行循环后，当 `toolPart` 的 `tool_result` 有了 `exitCode`（Bash）或 `output`（Read/Edit），调 `emitAgentToolEvent`。`toolUse.name` 即 tool 名（Read / Edit / Write / Bash / Glob / Grep / ...），按名字分流到 4 类 field event。

**sub-agent 过滤**：检查 `tool_use_id` 的 `parent_tool_use_id`（Claude Code SDK 在 Task tool 启动子会话时会填这个字段），非 null 直接 return。

### 3.2 Codex runtime

`src/main/services/codex-event-mapper.ts`

- **第 511–524 行** `item_started` case —— tool 开始
- 对应的 completion 在同文件中查 `exec_command_output_delta` / `exec_command_end`

→ Codex 的 `exec_command_end` 带 `exit_code`，直接 emit `agent.bash_exec`。Read/Edit 类工具 Codex 通过 `apply_patch` / `file_read` 统一调 —— 具体 event name 请查 `codex-event-mapper.ts` 里的 `item.toolName` 白名单。

### 3.3 OpenCode runtime

`src/main/services/opencode-service.ts` —— SDK 回调里查 `tool_use` 类 part，完成后 emit。（OpenCode transcript 结构与 Claude Code 类似，可复用同样的 part-walker 模式。）

### 3.4 三个 adapter 现实

评审指出"三种 SDK 结构都不同"——**helper 只做归一化 + emit，每个 adapter 自己写 5–10 行形状转换**才是诚实的工作量（见 §8 工时）。

---

## 4 emit 骨架

```ts
// src/main/field/emit-agent-tool.ts (新文件)
import { emitFieldEvent } from './emit'
import path from 'node:path'

export interface AgentToolObservation {
  worktreeId: string
  projectId: string | null
  sessionId: string | null
  worktreePath: string
  toolName: string
  toolUseId: string
  parentToolUseId?: string | null   // sub-agent 过滤
  input: Record<string, unknown>
  output?: {
    text?: string
    error?: string
    exitCode?: number
    durationMs?: number
    matchCount?: number             // Glob/Grep only
  }
}

const READ_TOOLS = new Set(['Read', 'NotebookRead', 'file_read'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const SEARCH_TOOLS = new Set(['Glob', 'Grep'])
const BASH_TOOLS = new Set(['Bash', 'exec_command'])

export function emitAgentToolEvent(obs: AgentToolObservation): void {
  // Sub-agent: skip nested tool uses entirely (V1)
  if (obs.parentToolUseId) return

  const { toolName, input, output, worktreePath, toolUseId } = obs
  const base = {
    worktreeId: obs.worktreeId,
    projectId: obs.projectId,
    sessionId: obs.sessionId,
    relatedEventId: null as string | null
  }

  if (BASH_TOOLS.has(toolName)) {
    const captureOutput = isBashOutputCaptureEnabled()
    emitFieldEvent({
      type: 'agent.bash_exec',
      ...base,
      payload: {
        toolUseId,
        toolName,
        command: String(input.command ?? '').slice(0, 512),
        exitCode: output?.exitCode ?? null,
        durationMs: output?.durationMs ?? null,
        stdoutHead: captureOutput ? (output?.text?.slice(0, 1024) ?? null) : null,
        stderrTail: captureOutput ? (output?.error?.slice(-1024) ?? null) : null
      }
    })
    return
  }

  if (SEARCH_TOOLS.has(toolName)) {
    emitFieldEvent({
      type: 'agent.file_search',
      ...base,
      payload: {
        toolUseId,
        toolName,
        pattern: String(input.pattern ?? input.path ?? '').slice(0, 512),
        matchCount: output?.matchCount ?? null
      }
    })
    return
  }

  const rawPath = (input.file_path ?? input.path ?? '') as string
  if (!rawPath) return
  // Guard: if caller accidentally passed a glob into a read/write tool
  // (should not happen with white-lists above), bail rather than pollute
  if (rawPath.includes('*') || rawPath.includes('?')) return
  const relPath = path.isAbsolute(rawPath) ? path.relative(worktreePath, rawPath) : rawPath

  if (READ_TOOLS.has(toolName)) {
    emitFieldEvent({
      type: 'agent.file_read',
      ...base,
      payload: {
        toolUseId,
        toolName,
        path: relPath,
        bytes: output?.text?.length ?? null
      }
    })
  } else if (WRITE_TOOLS.has(toolName)) {
    emitFieldEvent({
      type: 'agent.file_write',
      ...base,
      payload: {
        toolUseId,
        toolName,
        path: relPath,
        operation: 'edit' // V1: single value; future Outcome Loop may refine
      }
    })
  }
  // Unknown tool names: no-op (safer than miscategorizing)
}
```

### Bash output capture toggle

```ts
// src/main/field/privacy.ts (add-on)
const KEY_BASH_CAPTURE = 'field.agent_bash_capture_output'
export function isBashOutputCaptureEnabled(): boolean {
  // Default: OFF. Bash output can contain secrets (API keys, env dumps).
  return getSetting(KEY_BASH_CAPTURE) === 'true'
}
```

UI: Settings → Privacy → "Capture Bash stdout/stderr for agent analysis"（默认 unchecked）。

---

## 5 Schema & Types

**物理 schema**：**无 migration**（`field_events.payload_json` 是弹性列）。

**逻辑 schema**：`FieldEventType` 是 discriminated union，新增 4 个 variant 意味着下游消费者都要同步。**实测影响面约 8 处**：

1. `src/shared/types/field-event.ts` —— union 加 4 个 variant + payload interface
2. `src/main/field/privacy.ts` —— `SENSITIVE_TYPES` 白名单 + 新增 `isBashOutputCaptureEnabled`
3. `src/main/field/checkpoint-generator.ts` —— `rankHotFiles` switch 加分支（见 §6）
4. `src/main/field/context-builder.ts` —— `deriveFocus` 加 agent.file_write / agent.file_read 分支
5. `src/main/field/context-formatter.ts` —— `summarizeEvent` switch 加 4 个 case
6. `src/main/field/emit.ts` —— dispatcher 可能需要识别新类型的 log 等级
7. `scripts/dump-field-events.ts` —— `formatRow` switch 加 4 个 case
8. `test/phase-21/field-events/sink.test.ts` 等 —— 硬编码事件枚举的测试断言

Phase 24C 的 `episodic-schema.test.ts` 已经用了 `toBeGreaterThanOrEqual(18)` 模式，其他硬编码处照此处理。

---

## 6 下游消费

### 6.1 `rankHotFiles`（Phase 24C checkpoint-generator.ts）

```ts
// 加在现有 switch 里
} else if (ev.type === 'agent.file_write') {
  bump((ev.payload as { path?: string }).path, 3)  // 写权重最高
} else if (ev.type === 'agent.file_read') {
  bump((ev.payload as { path?: string }).path, 1)
}
// agent.file_search / agent.bash_exec 不进 hot_files 排序
```

对 `editCount` 统计也要加 `agent.file_write.path` 到 touchedFiles set。

### 6.2 `deriveFocus`（context-builder.ts）

Current Focus 优先级链（新→旧覆盖原则的反向）：
1. 最近的 `file.focus` / `file.open`（人的行为，最高优先级）
2. 最近的 `agent.file_write`（agent 正在编辑）
3. 最近的 `agent.file_read`（agent 正在观察）

**修改理由**：全委托用户无 `file.focus`，但 agent 正在编辑 `src/auth.ts` 时，下次 prompt 的 Current Focus 应该能看到 `src/auth.ts`。

### 6.3 Episodic Memory（非本期改动）

`Most-Touched Files` 天然按 `file_events × type` 聚合，加入新类型后自动生效，不需要单独改 episodic compactor。

---

## 7 验收（真实场景）

1. 清理 DB：
   ```bash
   sqlite3 ~/.xuanpu/xuanpu.db "DELETE FROM field_events WHERE type LIKE 'agent.%';"
   ```
2. 装新包，开一个会话，让 Agent 做一个小任务（例如 "给 README 加一行"）
3. SQL 核对事件类型都进来了：
   ```bash
   sqlite3 ~/.xuanpu/xuanpu.db \
     "SELECT type, COUNT(*) FROM field_events WHERE type LIKE 'agent.%' GROUP BY type;"
   ```
   应看到 `agent.file_read` / `agent.file_write` / `agent.file_search` / `agent.bash_exec` 四类都有计数（除非任务恰好没用到某类）
4. SQL 核对 payload 有 `toolUseId`：
   ```bash
   sqlite3 ~/.xuanpu/xuanpu.db \
     "SELECT json_extract(payload_json, '$.toolUseId') FROM field_events WHERE type = 'agent.file_write' LIMIT 3;"
   ```
   每行非 null
5. SQL 核对 `agent.bash_exec` **默认不含 stdoutHead**：
   ```bash
   sqlite3 ~/.xuanpu/xuanpu.db \
     "SELECT json_extract(payload_json, '$.stdoutHead') FROM field_events WHERE type = 'agent.bash_exec' LIMIT 3;"
   ```
   应为 null（除非用户已打开 capture toggle）
6. SQL 核对 `agent.file_search` 的 `pattern` **不等于**文件路径：
   ```bash
   sqlite3 ~/.xuanpu/xuanpu.db \
     "SELECT json_extract(payload_json, '$.pattern') FROM field_events WHERE type = 'agent.file_search' LIMIT 3;"
   ```
   看到 glob 字符串（`**/*.ts` 等），不是文件路径
7. 下次发 prompt → Field Context Debug 的 Last Injection 里 `## Current Focus` 段有 Agent 刚读/改的文件
8. checkpoint: abort 当前会话 → 重连 → "Resumed from previous session" 块里 `Hot files` 非空且**只包含真实文件路径**（无 glob 模式）
9. Sub-agent 场景：启动 Task tool 子会话 → 检查 nested 工具调用的事件**没有**进入 `field_events`

---

## 8 时间预算（修订）

| 项 | 预估 |
|---|---|
| 3 runtime adapter 接入（各有形状差异） | 1.0 天 |
| 类型 + 8 处下游 TS 类型 / 测试同步 | 0.25 天 |
| `rankHotFiles` / `deriveFocus` / `summarizeEvent` 消费改动 | 0.25 天 |
| Bash output capture privacy toggle + Settings UI + 测试 | 0.25 天 |
| Phase 21.5 专属测试（schema + emit + dedupe + sub-agent skip） | 0.25 天 |
| **总计** | **~1.5–2 工作日** |

初版 "半天到一天" 严重低估了 3 个 adapter 形状差异 + 下游同步成本。

---

## 9 非目标 & Future-proof 注记

- ❌ Phase 22B.2 Haiku episodic（独立 PR）
- ❌ Phase 22C.2 semantic memory auto-update（独立 PR）
- ❌ Redaction / PII filter（未来再加，现阶段依赖 `field_collection` toggle + 默认关闭 bash output capture）
- ❌ Sub-agent nested 工具逐条观测（V1 跳过，未来 `session.sub_agent_summary` 聚合事件）
- ❌ `operation: 'create' | 'delete'` 细分（留给 Outcome Loop）

### Future-proof 注记

- **如果未来加 "agent 改文件后自动 focus 那个文件" UX**（现在没有）：`agent.file_write` 和 `file.focus` 会对同一 path 双 emit。需要在 `rankHotFiles` 加 dedupe：按 `(path, 5s window)` 合并为单次事件。
- **如果 Outcome Loop 引入**：从 `agent.bash_exec.payload.toolUseId` 反查同 tool_use 的 stdout / 后续 session.message 情感，即可做归因。现在保留 `toolUseId` 就是为了那一天。

---

## 10 修订记录

| 日期 | 修订人 | 内容 |
|---|---|---|
| 2026-04-22 | slicenferqin | 初版 |
| 2026-04-22 | slicenferqin | 评审落地 5 项必改 + 2 项 nice-to-have（见 §0） |

---

Phase 21.5 完成后，1.4.0 才具备对**全委托 AI 用户**的完整价值，届时发布。
