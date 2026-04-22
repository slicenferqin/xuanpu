# Phase 21.5 — Agent Tool Events (工单)

> For: Amp / 下一位接手 Phase 21 扩展的开发者
> Author: slicenferqin（2026-04-22）
> Priority: **release-blocker for 1.4.0**

## 1 背景

Phase 21 采集了 7 类 P0 事件，但**全部是"人的行为"**（file.selection / terminal.command 等）。

真实使用分布下，玄圃用户分两类：

- **IDE 辅助型**：人看代码、选代码、跑命令，AI 偶尔帮忙 —— Phase 21 覆盖良好
- **全委托型**：所有编辑 / 执行 / 读取都由 Agent 完成，人只发 prompt —— Phase 21 事件近乎零

作者实测数据：45 条事件里 24 条 session.message，只有 3 条 terminal.command / 2 条 file.selection（都是手动做验证才产生的）。日常使用下全委托用户的：

- `hot_files` 永远空（checkpoint-generator.ts:119 依赖 file.focus/open/selection）
- Field Context 的 `## Current Focus` 永远空
- Episodic Memory 只能统计"发了几条 prompt"

**Phase 21.5 的目标：补采 3 类 Agent 侧事件，让全委托用户也能享受 Phase 22/24 的记忆与 checkpoint 能力。**

## 2 范围（MVP，只做这 3 类）

| 类型 | 触发时机 | payload 关键字段 |
|---|---|---|
| `agent.file_read` | Read / Glob / Grep 工具返回成功 | `path`（相对 worktree 根）、`bytes?`、`toolName` |
| `agent.file_write` | Edit / Write / NotebookEdit / MultiEdit 工具返回成功 | `path`、`operation: 'create' \| 'edit' \| 'delete'`、`toolName` |
| `agent.bash_exec` | Bash 工具返回（含超时/失败） | `command`（slice 512）、`exitCode?`、`durationMs?`、`stdoutHead?`（1KB）、`stderrTail?`（1KB） |

显式不做（留给后续）：

- `agent.thinking` / `agent.plan_update`（噪声高，价值低）
- WebFetch / WebSearch（不是本地 workbench 事件）
- Subagent 递归（保留 parent_tool_use_id 上下文即可）
- 每个工具单独建类型（保持只有 3 类，靠 `toolName` 字段细分）

## 3 接入点（已代码核对）

### 3.1 Claude Code runtime

`src/main/services/claude-code-implementer.ts`

- **第 3195 行** `if (blockType === 'tool_use')` —— 工具调用开始时 draft 入 map
- **第 1046–1067 行** —— `tool_result` 合并回 `tool_use` part 时是**完成时刻**

→ 在 1046 行循环后，当 `toolPart` 的 `tool_result` 有了 `exitCode`（Bash）或 `output`（Read/Edit），调 `emitFieldEvent`。
`toolUse.name` 即 tool 名（Read / Edit / Write / Bash / ...），按名字分流到 3 类 field event。

### 3.2 Codex runtime

`src/main/services/codex-event-mapper.ts`

- **第 511–524 行** `item_started` case —— tool 开始
- 对应的 completion 在同文件中查 `exec_command_output_delta` / `exec_command_end`

→ Codex 的 `exec_command_end` 带 `exit_code`，直接 emit `agent.bash_exec`。
Read/Edit 类工具 Codex 通过 `apply_patch` / `file_read` 统一调 —— 具体 event name 请查 `codex-event-mapper.ts` 里的 `item.toolName` 白名单。

### 3.3 OpenCode runtime

`src/main/services/opencode-service.ts` —— SDK 回调里查 `tool_use` 类 part，完成后 emit。
（OpenCode transcript 结构与 Claude Code 类似，可复用同样的 part-walker 模式。）

## 4 emit 骨架

```ts
// src/main/field/emit-agent-tool.ts (新文件)
import { emitFieldEvent } from './emit'
import path from 'node:path'

export function emitAgentToolEvent(args: {
  worktreeId: string
  projectId: string | null
  sessionId: string | null
  worktreePath: string
  toolName: string
  input: Record<string, unknown>
  output?: { text?: string; error?: string; exitCode?: number; durationMs?: number }
}): void {
  const { toolName, input, output, worktreePath } = args

  // 归一化到 3 类
  if (toolName === 'Bash' || toolName === 'exec_command') {
    emitFieldEvent({
      type: 'agent.bash_exec',
      worktreeId: args.worktreeId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      relatedEventId: null,
      payload: {
        toolName,
        command: String(input.command ?? '').slice(0, 512),
        exitCode: output?.exitCode ?? null,
        durationMs: output?.durationMs ?? null,
        stdoutHead: output?.text?.slice(0, 1024) ?? null,
        stderrTail: output?.error?.slice(-1024) ?? null
      }
    })
    return
  }

  const fileReadTools = new Set(['Read', 'Glob', 'Grep', 'file_read'])
  const fileWriteTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])

  const rawPath = (input.file_path ?? input.path ?? input.pattern ?? '') as string
  if (!rawPath) return
  const relPath = path.isAbsolute(rawPath) ? path.relative(worktreePath, rawPath) : rawPath

  if (fileReadTools.has(toolName)) {
    emitFieldEvent({
      type: 'agent.file_read',
      worktreeId: args.worktreeId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      relatedEventId: null,
      payload: { toolName, path: relPath, bytes: output?.text?.length ?? null }
    })
  } else if (fileWriteTools.has(toolName)) {
    emitFieldEvent({
      type: 'agent.file_write',
      worktreeId: args.worktreeId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      relatedEventId: null,
      payload: {
        toolName,
        path: relPath,
        operation: toolName === 'Write' ? 'create' : 'edit'
      }
    })
  }
}
```

## 5 Schema & Types

- `src/shared/types/field-event.ts`：在 discriminated union 加 3 个 variant
- `src/main/field/privacy.ts`：把 3 个新类型加进 `SENSITIVE_TYPES` 白名单
- **无需新 migration** —— `field_events.payload_json` 是弹性列，足以承载新类型

## 6 下游消费（已就位，只要事件进来就激活）

- `src/main/field/checkpoint-generator.ts:119` `rankHotFiles` 加分支：
  - `agent.file_write` +3（score 高于 file.selection）
  - `agent.file_read` +1
- `src/main/field/context-builder.ts` 的 Current Focus 派生：优先看最近一次 `agent.file_write`，其次 `agent.file_read`
- Episodic Memory：`Most-Touched Files` 天然按 `file_events * type` 聚合，加入新类型即可

## 7 验收（真实场景）

1. 清理 DB：`sqlite3 ~/.xuanpu/xuanpu.db "DELETE FROM field_events WHERE type LIKE 'agent.%';"`
2. 装新包，开一个会话，让 Agent 做一个小任务（例如"给 README 加一行"）
3. SQL 核对：
   ```bash
   sqlite3 ~/.xuanpu/xuanpu.db "SELECT type, COUNT(*) FROM field_events WHERE type LIKE 'agent.%' GROUP BY type;"
   ```
   应该看到 `agent.file_read` / `agent.file_write` / `agent.bash_exec` 三类都有计数
4. 下次发 prompt → Field Context Debug 的 Last Injection 里 `## Current Focus` 段有 Agent 刚读/改的文件
5. checkpoint: abort 当前会话 → 重连 → "Resumed from previous session" 块里 `Hot files` 非空

## 8 时间预算

- 接入点（3 runtime × emit）：~3h
- 归一化 + tests：~2h
- Current Focus / Hot files 的消费更新：~1h
- 总计：**半天到一天**

## 9 非目标

- ❌ Phase 22B.2 Haiku episodic（独立 PR）
- ❌ Phase 22C.2 semantic memory auto-update（独立 PR）
- ❌ Redaction / PII filter（未来再加，现阶段依赖用户在 field_collection toggle 控制）

---

Phase 21.5 完成后，1.4.0 才具备对**全委托 AI 用户**的完整价值，届时发布。
