# Xuanpu — Phase 21 Product Requirements Document

## Field Event Stream（现场事件流 · 第一期 · 地基）

---

## Overview

Phase 21 为玄圃增加"**现场事件流（Field Event Stream）**"这一核心能力的第一期地基：在 main 进程内建立一个统一的、结构化的用户行为事件管道，把"用户在玄圃里做了什么"从分散在各模块的副作用，沉淀成一张可被离线查询、可被二期记忆层消费、可被三期 Agent 输入注入消费的事件表。

第一期**只做地基**，不触达 Agent 输入、不触达记忆层、不做前端可视化。交付物是：一个类型安全的 `FieldEvent` 定义、一张 `field_events` SQLite 表（schema v14 迁移，含 `seq` 稳定排序）、一条从 emit 直达 sink 的异步批量写入链路（带失败重试与毒事件隔离）、P0 事件集在 3 个关键 handler 接入、最小只读查询 API、一个用于验收的 CLI dump 工具，以及在 emit 源头生效的隐私开关。

> **设计修订说明**：本 PRD 经 oracle 两轮评审，共吸收 9 处修正：
>
> **第一轮（6 处必改）**：（1）emit 直接 enqueue 到 sink，bus 仅做 best-effort fan-out，避免 listener 异常阻断持久化；（2）schema 加 `seq` 稳定排序与 `project_id` 索引；（3）sink 加失败重试 + 毒事件隔离 + 观测计数器；（4）隐私 gate 上移到 emit 源头；（5）renderer IPC 收窄到单一 `reportWorktreeSwitch` 通道；（6）`terminal.output` 降级到 Phase 21.5/22。
>
> **第二轮（3 处补强）**：（7）sink 用 `currentFlushPromise` + drain loop + `shutdownRequested` 明确 flush/quit 并发语义，`before-quit` 里 `preventDefault` 并 await；（8）sink **eager init** 而非 lazy，确保 `before-quit` hook 一定注册；（9）`worktree.switch` 也纳入 SENSITIVE_TYPES，让 `field_collection_enabled` 设置的语义诚实；privacy cache 在 `settings:set` 的同一写路径内同步更新，消除 stale 窗口。

### Phase 21 Goals

1. 定义 `FieldEvent` 类型和 `field_events` 表 schema（migration v14，含 `seq` 稳定排序与 `project_id` 索引）
2. 提供 `emitFieldEvent()` 工具：**直接 enqueue 到 sink**（主路径）+ 在现有 `EventBus` 上 best-effort 广播 `'field:event'`（副路径，仅供未来订阅者使用）。返回事件 id 供调用方关联后续事件（如 command ↔ output）
3. 建立异步批量落盘的 `FieldEventSink`（buffer + 1s/100 条 flush + 退出前强制 flush + 失败重试 + 毒事件隔离 + 观测计数器）
4. 接入完整 VISION §4.1.1 P0 事件集（6 类）：
   - `worktree.switch` — renderer store 源头去重
   - `file.open` / `file.focus` — useFileViewerStore
   - `file.selection` — CodeMirrorEditor 编辑器层（非 caret-only + 250ms debounce）
   - `terminal.command` — terminal-handlers 行缓冲（best-effort）
   - `terminal.output` — 窗口聚合（256KB / 30s / next-command / exit，head 20 + tail 50）
   - `session.message` — agent-handlers prompt 成功路径
5. 提供最小只读查询 API `getRecentFieldEvents(...)`，供二期记忆层复用
6. 提供 CLI 工具 `scripts/dump-field-events.ts`，按 worktree 导出可读时间线做端到端验收
7. 提供最小隐私开关 `settings.field_collection_enabled`（默认开启），**在 emit 源头 gate**，防止敏感内容进入内存/总线
8. Settings UI 里加 toggle（复用现有 SettingsPrivacy 面板）

### Non-Goals（明确不做）

- ❌ Agent system prompt 注入 → Phase 23
- ❌ Worktree 摘要 / 项目记忆文件 → Phase 22
- ❌ 前端 Field Timeline UI → Phase 22 或 24
- ❌ `file.edit`（手动编辑文件 diff 摘要）→ Phase 22（P1）
- ❌ `cursor.position` / `search.query` → Phase 22(+)（P2）
- ❌ `git.status_change` / `session.approval` / `connection.*` → Phase 22（P1）
- ❌ 事件流 stream 推送到 renderer（一期只读 DB）

---

## Technical Additions

| Component                     | Technology                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Field event type definitions  | New `src/shared/types/field-event.ts` — discriminated union of event types with per-type payload interfaces           |
| SQLite field_events table     | New migration v14 in `src/main/db/schema.ts` + idempotent `ensureFieldEventsTable()` in `database.ts`; includes `seq` stable ordering column and `project_id` index |
| EventBus extension            | Extend `EventBusEvents` in `src/server/event-bus.ts` with `'field:event': [event: FieldEvent]` (best-effort fan-out only — not the persistence path) |
| Emit + enqueue helper         | New `src/main/field/emit.ts` — `emitFieldEvent(partial)` validates + serializes + **enqueues to sink directly**; bus broadcast is secondary best-effort |
| FieldEventSink                | New `src/main/field/sink.ts` — single in-memory queue, `flushInProgress` guard, batch snapshot, transactional INSERT, retry with backoff, row-by-row poison isolation, observability counters |
| Field repository              | New `src/main/field/repository.ts` — `getRecentFieldEvents({worktreeId?, projectId?, sessionId?, since?, limit?})` for Phase 22 reuse |
| Renderer → main reporter IPC  | Narrow `ipcMain.on('field:reportWorktreeSwitch', ...)` + preload `window.field.reportWorktreeSwitch(...)` — only one whitelisted event type, payload validated and size-capped |
| Worktree switch emission      | Renderer `useWorktreeStore.selectWorktree/selectWorktreeOnly` calls `window.field.reportWorktreeSwitch(...)`; **dedup at source** (skip if `prevId === newId`) |
| Terminal command emission     | `terminal-handlers.ts` accumulates `terminal:write` input per worktree, emits `terminal.command` on `\r`; documented as **best-effort line capture** (not a reliable command parser) |
| Session message emission      | `agent-handlers.ts` prompt handler emits `session.message` after schema validation passes                             |
| Privacy gate                  | Checked **at emit site** before payload assembly for sensitive types (`terminal.command`, `session.message`); also re-checked at sink as defense-in-depth |
| Observability counters        | `dropped_overflow`, `dropped_invalid`, `dropped_privacy`, `flush_failures`, `last_flush_at` — exposed via debug log + repository getter |
| Dump script                   | New `scripts/dump-field-events.ts` — reads via repository, groups by worktree, prints markdown timeline for last N minutes |

---

## Features

### 1. Field Event Type System

#### 1.1 Design

`FieldEvent` is a **discriminated union keyed by `type`**. Every event has a stable envelope; payloads are typed per variant.

New file `src/shared/types/field-event.ts`:

```ts
export type FieldEventType =
  | 'worktree.switch'
  | 'terminal.command'
  | 'terminal.output'
  | 'session.message'

export interface FieldEventEnvelope {
  /** UUID v4 */
  id: string
  /** Unix ms, main-process clock */
  timestamp: number
  /** Worktree DB id (worktrees.id). NULL for global events. */
  worktreeId: string | null
  /** Project DB id (projects.id). Cached from worktree at emit time for cheap grouping. */
  projectId: string | null
  /** Session DB id (sessions.id). Only set for session-scoped events. */
  sessionId: string | null
  type: FieldEventType
}

export interface WorktreeSwitchPayload {
  fromWorktreeId: string | null
  toWorktreeId: string
  /** 'user-click' | 'keyboard' | 'store-restore' — for dedup */
  trigger: 'user-click' | 'keyboard' | 'store-restore' | 'unknown'
}

export interface TerminalCommandPayload {
  /** The command line the user submitted (trimmed, no trailing \r). */
  command: string
  /** PTY shell if known (bash/zsh/fish/...). */
  shell?: string
  /** Working directory at submit time, if known. */
  cwd?: string
}

export interface TerminalOutputPayload {
  /** The command id this output belongs to (if we can correlate), else null. */
  commandEventId: string | null
  /** Head of output, up to N lines. */
  head: string
  /** Tail of output, up to M lines. */
  tail: string
  /** True if middle was elided. */
  truncated: boolean
  /** Total bytes observed for the window. */
  totalBytes: number
  /** Exit code if process exited during the window. */
  exitCode: number | null
}

export interface SessionMessagePayload {
  agentSdk: 'opencode' | 'claude-code' | 'codex'
  agentSessionId: string
  /** Text preview of user message (truncated to 1KB). Attachments listed separately. */
  text: string
  attachmentCount: number
  modelOverride?: { providerID: string; modelID: string; variant?: string }
}

export type FieldEvent =
  | (FieldEventEnvelope & { type: 'worktree.switch'; payload: WorktreeSwitchPayload })
  | (FieldEventEnvelope & { type: 'terminal.command'; payload: TerminalCommandPayload })
  | (FieldEventEnvelope & { type: 'terminal.output'; payload: TerminalOutputPayload })
  | (FieldEventEnvelope & { type: 'session.message'; payload: SessionMessagePayload })
```

#### 1.2 Database Schema

New migration in `src/main/db/schema.ts` — bump `CURRENT_SCHEMA_VERSION` to `14`:

```sql
CREATE TABLE IF NOT EXISTS field_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  timestamp INTEGER NOT NULL,
  worktree_id TEXT,
  project_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  related_event_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_field_events_worktree_ts
  ON field_events(worktree_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_project_ts
  ON field_events(project_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_type_ts
  ON field_events(type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_ts
  ON field_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_session_ts
  ON field_events(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_related
  ON field_events(related_event_id) WHERE related_event_id IS NOT NULL;
```

**Design decisions**:

- **`seq INTEGER PRIMARY KEY AUTOINCREMENT`**: stable ingest ordering. `timestamp` alone is insufficient — multiple events can share a millisecond, and Phase 22/23 will need deterministic replay. `seq` is the column most likely to save regret later.
- **`id TEXT UNIQUE`**: keeps stable external id (for correlation from renderer, deduplication, log tracing) while `seq` drives order.
- **No `created_at` column**: redundant with `timestamp` (both are emit-time, main-process clock). If Phase 22 later needs a separate "persisted at" time, add `recorded_at` then.
- **`related_event_id`**: first-class correlation column (e.g. command ↔ output, message ↔ response). Even though Phase 21 ships only `terminal.command` (no output yet), the column is cheap and un-migrating later is painful.
- **`project_id` redundantly stored AND indexed**: earlier draft stored it without an index — that undercut the rationale. Fixed.
- **No foreign keys to `worktrees` / `sessions` / `projects`**: events are historical records, survive subject deletion, avoid cascade write amplification. Matches `usage_entries.worktree_id ON DELETE SET NULL` precedent.
- **`payload_json` as TEXT**, not normalized columns. Event schemas will evolve; JSON gives flexibility. If any payload field becomes hot for filtering, promote it in a later migration.
- **Add `ensureFieldEventsTable()`** in `database.ts` alongside existing `ensureConnectionTables()` / `ensureUsageAnalyticsTables()` for idempotent repair.

#### 1.3 Acceptance

- Migration applies cleanly on a fresh DB and on an existing v13 DB
- Re-running migrations is a no-op (idempotent)
- `PRAGMA table_info(field_events)` shows the expected schema
- All four indexes listed above exist

---

### 2. Emit + EventBus Integration

#### 2.1 EventBus extension (best-effort fan-out only)

Edit `src/server/event-bus.ts`:

```ts
import type { FieldEvent } from '../shared/types/field-event'

interface EventBusEvents {
  // ... existing entries ...
  'field:event': [event: FieldEvent]
}
```

**Crucial caveat about EventBus semantics** (corrected from earlier draft):

- Node `EventEmitter.emit()` is **synchronous**
- A thrown listener **does propagate** out of `emit()`
- A thrown listener can **prevent later listeners from running**

Therefore the EventBus is **NOT** the persistence path. The sink does **not** subscribe to `'field:event'` for its writes. Bus emission is a secondary best-effort fan-out reserved for future debug/UI subscribers (Phase 22+ Field Timeline). This decouples persistence reliability from any future listener bug.

#### 2.2 Emit helper — direct enqueue + best-effort broadcast

New file `src/main/field/emit.ts`:

```ts
import { randomUUID } from 'crypto'
import { getEventBus } from '../../server/event-bus'
import { getFieldEventSink } from './sink'
import { isFieldCollectionEnabled } from './privacy'
import { createLogger } from '../services/logger'
import type { FieldEvent, FieldEventType } from '../../shared/types/field-event'

const log = createLogger({ component: 'FieldEvent' })

const SENSITIVE_TYPES: ReadonlySet<FieldEventType> = new Set([
  'worktree.switch',
  'terminal.command',
  'session.message'
])

type EmitInput =
  | Omit<Extract<FieldEvent, { type: 'worktree.switch' }>, 'id' | 'timestamp' | 'seq'>
  | Omit<Extract<FieldEvent, { type: 'terminal.command' }>, 'id' | 'timestamp' | 'seq'>
  | Omit<Extract<FieldEvent, { type: 'session.message' }>, 'id' | 'timestamp' | 'seq'>

export function emitFieldEvent(input: EmitInput): void {
  // Privacy gate at emit site for sensitive types — short-circuit BEFORE
  // payload assembly contributes any cost or hits the bus
  if (SENSITIVE_TYPES.has(input.type) && !isFieldCollectionEnabled()) {
    getFieldEventSink().incrementCounter('dropped_privacy')
    return
  }

  let event: FieldEvent
  let serialized: string
  try {
    event = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...input
    } as FieldEvent
    // Serialize at enqueue time, not at flush time — one bad payload
    // cannot poison the entire flush batch
    serialized = JSON.stringify(event.payload)
  } catch (err) {
    getFieldEventSink().incrementCounter('dropped_invalid')
    log.debug('emitFieldEvent serialization failed', err instanceof Error ? err.message : String(err))
    return
  }

  // Primary path: enqueue to sink directly. Persistence does NOT depend on bus listener health.
  getFieldEventSink().enqueue(event, serialized)

  // Secondary path: best-effort bus broadcast for future debug/UI subscribers.
  // Wrapped in try/catch because a downstream listener may throw and we must
  // never let that affect persistence or the caller.
  try {
    getEventBus().emit('field:event', event)
  } catch (err) {
    log.debug('field:event broadcast failed', err instanceof Error ? err.message : String(err))
  }
}
```

**Contract**: `emitFieldEvent` is non-throwing and has O(1) synchronous cost. Callers do not `await`.

#### 2.3 Acceptance

- Calling `emitFieldEvent` enqueues to sink even when no `'field:event'` listener exists
- A throwing `'field:event'` listener does **not** prevent persistence
- Privacy disabled drops sensitive-type events before serialization and before bus emit
- `id`, `timestamp`, and `seq` (assigned by SQLite) are auto-populated

---

### 3. FieldEventSink — Async Batched Persistence

#### 3.1 Design

New file `src/main/field/sink.ts`. Singleton via `getFieldEventSink()`.

**Responsibilities**:

1. Receive events via `enqueue(event, serializedPayload)` — called directly from `emitFieldEvent`
2. Maintain a single in-memory queue (cap **500**)
3. Flush to DB when **either**:
   - 100 events queued
   - 1 second elapsed since first unflushed event
4. On `before-quit`, flush synchronously (best-effort) before close
5. On overflow (queue at 500): drop **oldest** event, increment `dropped_overflow`
6. On flush failure: retry with backoff, isolate poison events row-by-row
7. Expose observability counters

#### 3.2 Concurrency model

```ts
class FieldEventSink {
  private queue: QueuedEvent[] = []
  private flushInProgress = false
  private flushTimer: NodeJS.Timeout | null = null
  private retryBatch: QueuedEvent[] | null = null
  private retryAttempts = 0
  private counters = {
    dropped_overflow: 0,
    dropped_invalid: 0,
    dropped_privacy: 0,
    flush_failures: 0,
    last_flush_at: 0,
    last_flush_size: 0
  }

  enqueue(event: FieldEvent, serialized: string): void {
    if (this.queue.length >= 500) {
      this.queue.shift()
      this.counters.dropped_overflow++
    }
    this.queue.push({ event, serialized })

    if (this.queue.length >= 100) {
      this.scheduleFlush(0)
    } else if (!this.flushTimer) {
      this.scheduleFlush(1000)
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    if (this.flushInProgress) return
    if (this.queue.length === 0 && !this.retryBatch) return

    this.flushInProgress = true
    try {
      // Snapshot: take retry batch first if present, else current queue
      const batch = this.retryBatch ?? this.queue
      if (!this.retryBatch) this.queue = []

      try {
        this.writeBatch(batch)
        this.counters.last_flush_at = Date.now()
        this.counters.last_flush_size = batch.length
        this.retryBatch = null
        this.retryAttempts = 0
      } catch (err) {
        this.counters.flush_failures++
        log.warn(`flush failed (attempt ${this.retryAttempts + 1})`, err)
        if (this.retryAttempts >= 3) {
          // Quarantine: try one row at a time to identify and drop poison
          this.quarantineBatch(batch)
          this.retryBatch = null
          this.retryAttempts = 0
        } else {
          this.retryBatch = batch
          this.retryAttempts++
          this.scheduleFlush(Math.min(1000 * 2 ** this.retryAttempts, 30_000))
        }
      }

      // If new events arrived during flush, schedule next round
      if (this.queue.length > 0) this.scheduleFlush(this.queue.length >= 100 ? 0 : 1000)
    } finally {
      this.flushInProgress = false
    }
  }

  private writeBatch(batch: QueuedEvent[]): void {
    const db = getDatabase().getDbHandle()
    const stmt = db.prepare(
      `INSERT INTO field_events
        (id, timestamp, worktree_id, project_id, session_id, type, related_event_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const tx = db.transaction((items: QueuedEvent[]) => {
      for (const { event, serialized } of items) {
        stmt.run(
          event.id, event.timestamp, event.worktreeId, event.projectId,
          event.sessionId, event.type, event.relatedEventId ?? null, serialized
        )
      }
    })
    tx(batch)
  }

  private quarantineBatch(batch: QueuedEvent[]): void {
    let dropped = 0
    for (const item of batch) {
      try {
        this.writeBatch([item])
      } catch (err) {
        dropped++
        this.counters.dropped_invalid++
        log.warn('quarantined poison event', { id: item.event.id, type: item.event.type, err })
      }
    }
    log.warn(`quarantine complete: ${batch.length - dropped}/${batch.length} written, ${dropped} dropped`)
  }

  shutdown(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    // Synchronous final flush — better-sqlite3 is sync, no await needed
    if (this.queue.length > 0 || this.retryBatch) {
      try {
        const batch = this.retryBatch ?? this.queue
        this.writeBatch(batch)
      } catch (err) {
        log.error('shutdown flush failed', err)
      }
    }
  }

  incrementCounter(key: keyof typeof this.counters): void { this.counters[key]++ }
  getCounters() { return { ...this.counters, queueDepth: this.queue.length } }
}
```

**Key invariants**:

- One flush at a time, tracked via `currentFlushPromise: Promise<void> | null` (added per oracle re-review — `flushInProgress` boolean alone is insufficient for quit-path awaiting)
- Failed batches are retained, never silently lost
- Poison events isolated via row-by-row retry after 3 batch failures
- New events arriving during flush go to a fresh queue; flush only sees its snapshot
- Serialization happens at `enqueue` time (caller side, in `emitFieldEvent`), so flush itself cannot fail due to bad payloads
- **Drain loop**: after a flush completes, if the queue is non-empty, immediately schedule another flush (delay 0 if ≥100 queued, else 1000ms). Prevents events from being stranded.
- **Single timer**: `flushTimer` is always cleared before scheduling a new one. No possibility of duplicate timers during retry/backoff.

**Honest framing**: `better-sqlite3` is synchronous. The "async" in the section title means **deferred**, not non-blocking I/O. A 100-row INSERT in WAL mode is sub-millisecond on typical hardware; main-thread cost is acceptable.

#### 3.3 Shutdown protocol (added per oracle re-review)

Earlier draft under-specified the quit path. Proper protocol:

```ts
// In src/main/index.ts (bootstrap, NOT lazy-init — see §3.4)
app.on('before-quit', async (event) => {
  const sink = getFieldEventSink()
  if (sink.isShutdownComplete()) return
  event.preventDefault() // defer quit until flush done
  await sink.shutdown()
  app.quit() // now safe
})
```

Sink `shutdown()` method:

```ts
async shutdown(): Promise<void> {
  this.shutdownRequested = true
  if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }

  // Wait for in-flight flush (if any), then drain loop until queue is empty
  while (this.currentFlushPromise || this.queue.length > 0 || this.retryBatch) {
    if (this.currentFlushPromise) {
      await this.currentFlushPromise
    } else {
      await this.flush()
    }
  }
  this.shutdownComplete = true
}
```

**Key guarantees**:

- `before-quit` calls `preventDefault()` then awaits `shutdown()` — app will not exit while events are in-flight or queued
- In-flight flush is awaited (via `currentFlushPromise`), not raced
- Drain loop ensures no stranded events — if new enqueue happens after quit was signaled but before shutdown drained, those events are also flushed (the `shutdownRequested` flag is primarily informational; the drain loop handles the actual work)
- `shutdownComplete` prevents double-shutdown if `before-quit` fires twice

#### 3.4 Lifecycle — eager initialization (critical)

Per oracle re-review: **the sink must be initialized eagerly at app bootstrap, not lazily on first `emitFieldEvent` call**. Rationale:

- `before-quit` hook must be registered before the quit event can fire
- If sink is lazy and the first event never arrives before quit (rare but possible), the hook is never registered and queued-during-shutdown events are lost

Required wiring:

```ts
// src/main/index.ts, inside app.whenReady()
getDatabase() // migrations first
getFieldEventSink() // constructs + registers before-quit hook
```

`getFieldEventSink()` still uses the singleton pattern, but its constructor (or first invocation) unconditionally registers the shutdown hook.

#### 3.5 Privacy gate (defense-in-depth)

Primary privacy enforcement is at `emitFieldEvent` (Section 2.2). Sink does **not** re-check by default — once an event is enqueued, it persists. This avoids the trap of inconsistent state across the bus + sink boundary.

If a future use case needs runtime pause without losing already-queued events, add an `isPaused` flag on the sink — this is **not** in scope for Phase 21.

#### 3.6 Acceptance

- Emit 1000 events in a tight loop: < 50ms wall time, all eventually persisted
- After 1s idle, all queued events are in `field_events`
- Quit while 50 events are queued: all 50 land in DB before process exits (verify via `before-quit` blocking)
- Quit while a flush is mid-transaction: app waits for that flush, then drains remaining queue
- Force `writeBatch` to throw 3 times on a 50-event batch: 1 poison row identified, other 49 written
- Cannot produce duplicate timers: manual test by forcing rapid enqueue during retry backoff
- A throwing listener subscribed to `'field:event'` does not affect persistence
- `dropped_overflow` increments when queueing the 501st event
- Privacy disabled mid-stream stops new sensitive events from entering the queue (and since all types are sensitive, stops everything)

---

### 4. Event Emission Points (P0 Set)

#### 4.1 `worktree.switch`

**Where**: `src/renderer/src/stores/useWorktreeStore.ts`, inside `selectWorktree` and `selectWorktreeOnly`.

**Why renderer-side**: selection lives in Zustand; main has no visibility. Report via a narrow fire-and-forget IPC (see Section 5).

**Source-side dedup** (per oracle review): skip the call entirely if `prevId === newId`. Persistence layer must not silently rewrite history; semantic ambiguity belongs at the source.

```ts
selectWorktree: (id: string | null) => {
  const prevId = get().selectedWorktreeId
  set({ selectedWorktreeId: id })
  if (id) {
    if (prevId !== id) {
      window.field?.reportWorktreeSwitch({
        fromWorktreeId: prevId,
        toWorktreeId: id,
        trigger: 'user-click'
      })
    }
    get().touchWorktree(id)
    // ... existing logic
  }
}
```

**`trigger` classification**: `'user-click'` from UI handlers, `'keyboard'` from shortcut handlers, `'store-restore'` from Zustand persist rehydration. Defaults to `'unknown'`.

**Note**: persist rehydration on app start should pass `'store-restore'` so downstream consumers (timeline UI, future memory layer) can filter. The store itself does not call `reportWorktreeSwitch` from rehydration unless explicitly desired — TBD by the implementer.

#### 4.2 `terminal.command`

**Where**: `src/main/ipc/terminal-handlers.ts`, inside `ipcMain.on('terminal:write', ...)`.

**Honest framing** (per oracle review): this is a **best-effort line capture**, not a reliable command parser. The `\r` heuristic works adequately for simple interactive shell commands like `ls`, `git status`, `pnpm test`. It does **not** reliably handle:

- bracketed paste of multi-line commands
- shell line continuations (`\` at EOL), heredocs, open quotes, `for`/`while` blocks
- arrow-key history navigation (escape sequences may pollute the buffer)
- commands aborted via Ctrl+C (no completion event)
- TUI applications (vim, less, htop) where keystrokes have no command semantics

Phase 21 ships this with the explicit limitation. A reliable command lifecycle requires shell-integration markers (OSC 133 etc.) — out of scope.

**Mechanism**: maintain a per-worktree line buffer in a `Map<worktreeId, string>`. For each `data` chunk received in `terminal:write`:

1. Filter out control bytes below 0x20 except `\r`, `\n`, `\t`; explicitly drop ESC-prefixed sequences `\x1b[...`
2. Append remaining characters to the buffer
3. If the chunk contains `\r`, take the buffered content, trim, emit if non-empty
4. Reset buffer after every `\r`
5. Cap accumulated buffer at 4KB; on overflow, drop and increment counter

`shell` and `cwd` resolved from `ptyService` at emit time (both already exposed).

#### 4.3 `session.message`

**Where**: `src/main/ipc/agent-handlers.ts`, at the end of the `prompt` handler success path (after schema validation, before returning).

```ts
emitFieldEvent({
  type: 'session.message',
  worktreeId, // resolved from session lookup
  projectId, // resolved from session lookup
  sessionId,
  payload: {
    agentSdk: runtimeId,
    agentSessionId,
    text: typeof message === 'string'
      ? message.slice(0, 1024)
      : message.find((p) => p.type === 'text')?.text.slice(0, 1024) ?? '',
    attachmentCount: Array.isArray(message)
      ? message.filter((p) => p.type === 'file').length
      : 0,
    modelOverride
  }
})
```

No Agent-side events this phase (tool calls, streaming tokens, assistant replies) — deferred to Phase 22.

---

### 5. Renderer → Main IPC: Narrow Surface

#### 5.1 Design rationale (per oracle review)

Earlier draft proposed a **generic** `window.field.report(event)` that accepted any `FieldEventType`. This is rejected:

- renderer would be able to forge main-owned events (`terminal.command`, `session.message`)
- payload `unknown` invites shape drift that contaminates Phase 22 consumers
- Phase 21 only needs renderer to report **one** event: `worktree.switch`

Therefore Phase 21 ships a **single narrow, validated IPC channel**. Future renderer-owned events (e.g. `file.open` in Phase 22) get their own dedicated channels, each with a specific payload type.

#### 5.2 Preload surface

Edit `src/preload/index.ts` and `src/preload/index.d.ts`:

```ts
// preload/index.ts
field: {
  reportWorktreeSwitch: (input: WorktreeSwitchInput) =>
    ipcRenderer.send('field:reportWorktreeSwitch', input)
}

// preload/index.d.ts
interface Window {
  field: {
    reportWorktreeSwitch(input: WorktreeSwitchInput): void
  }
}

interface WorktreeSwitchInput {
  fromWorktreeId: string | null
  toWorktreeId: string
  trigger: 'user-click' | 'keyboard' | 'store-restore' | 'unknown'
}
```

#### 5.3 Main handler with validation

New `src/main/ipc/field-handlers.ts`:

```ts
const MAX_ID_LEN = 64

ipcMain.on('field:reportWorktreeSwitch', (_event, input: unknown) => {
  // Hand-rolled validation — sufficient for one channel, no Zod dependency
  if (!isPlainObject(input)) return
  const { fromWorktreeId, toWorktreeId, trigger } = input as Record<string, unknown>

  if (typeof toWorktreeId !== 'string' || toWorktreeId.length === 0 || toWorktreeId.length > MAX_ID_LEN) return
  if (fromWorktreeId !== null && (typeof fromWorktreeId !== 'string' || fromWorktreeId.length > MAX_ID_LEN)) return
  if (!['user-click', 'keyboard', 'store-restore', 'unknown'].includes(trigger as string)) return

  const worktree = getDatabase().getWorktree(toWorktreeId)
  if (!worktree) return // unknown worktree id — silently drop

  emitFieldEvent({
    type: 'worktree.switch',
    worktreeId: toWorktreeId,
    projectId: worktree.project_id,
    sessionId: null,
    relatedEventId: null,
    payload: {
      fromWorktreeId: fromWorktreeId as string | null,
      toWorktreeId,
      trigger: trigger as WorktreeSwitchInput['trigger']
    }
  })
})
```

**Security notes**:

- Renderer **cannot** forge `terminal.command` or `session.message` — those types have no IPC channel
- Payload size capped (id length 64); whole IPC message size capped by Electron defaults
- `getWorktree()` lookup ensures `toWorktreeId` is a real DB row, eliminating ghost data
- No `await` round-trip — `ipcMain.on` is fire-and-forget

---

### 6. Privacy Gate

#### 6.1 Setting key

Add one row to the existing `settings` table (no schema change needed):

- key: `field_collection_enabled`
- value: `'true'` (default) or `'false'`
- Absent row is treated as `'true'`

#### 6.2 Where the gate runs

Per oracle review, the **primary** gate is at `emitFieldEvent` (Section 2.2), specifically for sensitive types (`terminal.command`, `session.message`). Rationale:

- when disabled, sensitive payloads are not assembled, not enqueued, not emitted on the bus
- a future bus subscriber (Phase 22 Field Timeline UI) cannot accidentally observe sensitive content while collection is "off"
- the user-facing semantics of "field collection disabled" become honest: nothing happens, not "still happens but not stored"

Secondary defense-in-depth: not implemented in Phase 21 (kept simple). If a runtime pause-without-flush use case appears, add `sink.pause()` later.

#### 6.3 Cached read with synchronous invalidation

`src/main/field/privacy.ts`:

```ts
let cached: boolean | null = null

export function isFieldCollectionEnabled(): boolean {
  if (cached !== null) return cached
  const v = getDatabase().getSetting('field_collection_enabled')
  cached = v !== 'false' // default: true
  return cached
}

/** Update cache immediately, in the same call path as the DB write. */
export function setFieldCollectionEnabledCache(value: boolean): void {
  cached = value
}

export function invalidatePrivacyCache(): void { cached = null }
```

**Critical wiring** (per oracle re-review): `settings:set` must update the cache **synchronously in the same write path**, not via an invalidation callback after the fact. Otherwise there's a window where events get processed with the stale cached value.

In `settings-handlers.ts`:

```ts
ipcMain.handle('settings:set', (_e, key: string, value: string) => {
  getDatabase().setSetting(key, value)
  if (key === 'field_collection_enabled') {
    setFieldCollectionEnabledCache(value !== 'false')
  }
  return { success: true }
})
```

`invalidatePrivacyCache()` is kept for test setup / manual DB edits only.

#### 6.4 UI (minimal)

A single toggle in the existing settings surface (location TBD by implementer; an existing Privacy/Developer section is fine). The full Field Timeline & per-event-type toggles are deferred to Phase 22.

#### 6.5 Behavior when disabled

**Updated per oracle re-review**: gate **all** field event types when `field_collection_enabled === false`, so the setting name matches user expectations.

- `worktree.switch`: dropped at emit, `dropped_privacy` increments
- `terminal.command`: dropped at emit, `dropped_privacy` increments
- `session.message`: dropped at emit, `dropped_privacy` increments
- Existing rows are **not deleted** — disable pauses, does not purge. A "Clear my field history" action is a Phase 22 item.

(Earlier draft debated whether to gate `worktree.switch`; oracle pointed out that any exception makes the setting name dishonest. Decision: gate everything.)

---

### 7. Field Repository (Read API)

Per oracle review: Phase 21 must ship a minimal query API, not just a CLI dump script. Otherwise Phase 22 starts day 1 by writing the same plumbing.

New file `src/main/field/repository.ts`:

```ts
export interface FieldEventQuery {
  worktreeId?: string | null
  projectId?: string | null
  sessionId?: string | null
  type?: FieldEventType | FieldEventType[]
  /** Lower bound (inclusive), unix ms */
  since?: number
  /** Upper bound (exclusive), unix ms */
  until?: number
  /** Default 100, max 1000 */
  limit?: number
  /** 'asc' | 'desc' on (timestamp, seq); default 'desc' */
  order?: 'asc' | 'desc'
}

export interface StoredFieldEvent {
  seq: number
  id: string
  timestamp: number
  worktreeId: string | null
  projectId: string | null
  sessionId: string | null
  type: FieldEventType
  relatedEventId: string | null
  payload: unknown // parsed from payload_json
}

export function getRecentFieldEvents(query: FieldEventQuery): StoredFieldEvent[] {
  // Build SQL using prepared statement parts; clamp limit to 1000;
  // parse payload_json on read.
}

export function getFieldEventCounters(): SinkCounters {
  return getFieldEventSink().getCounters()
}
```

Implementation is a straightforward parameterized SELECT with the indexes from Section 1.2. Order is **always** `(timestamp, seq)`, which guarantees deterministic results even within the same millisecond.

The dump script (Section 8) and Phase 22 memory layer both consume this API.

#### 7.1 Acceptance

- Query by `worktreeId` returns only that worktree's events
- Query by `since` is exclusive of older rows
- Result order matches `(timestamp DESC, seq DESC)` by default
- `limit > 1000` is silently clamped
- `payload` is parsed (not raw JSON string)

---

### 8. Dump Script (Acceptance Tool)

New file `scripts/dump-field-events.ts`:

```bash
pnpm tsx scripts/dump-field-events.ts --minutes 30 [--worktree <id>] [--project <id>]
```

Implementation: thin wrapper that calls `getRecentFieldEvents({ since: Date.now() - minutes * 60_000, ... })` and prints markdown grouped by worktree.

Sample output:

```md
## Worktree: feat_20260420_event (feature/auth)

- 14:23:14 [worktree.switch] from `main` (user-click)
- 14:23:45 [terminal.command] `pnpm test auth`
- 14:24:02 [session.message] (claude-code) "这里为什么会挂？"
```

Purpose: single-command end-to-end verification during development and for the DoD demo.

---

## Out of Scope for Phase 21 (Reiterated)

| Item                                 | Planned Phase |
| ------------------------------------ | ------------- |
| `terminal.output` (window + correlation) | 21.5 / 22 |
| Agent-side events (tool calls, replies) | 22         |
| Agent system prompt injection        | 23            |
| Worktree rolling summaries           | 22            |
| Project memory `.xuanpu/memory.md`   | 22/23         |
| Field Timeline UI                    | 22 or 24      |
| `file.open` / `file.selection`       | 22            |
| `git.status_change`                  | 22            |
| `session.approval`                   | 22            |
| `connection.*`                       | 22            |
| Per-event-type privacy toggles       | 22            |
| Field data export / purge UI         | 22            |
| Retention / TTL policy               | 22            |
| Zod validation of renderer payloads  | 22 (if needed) |
| Shell-integration command lifecycle (OSC 133) | 23+ |

---

## Rollout Plan

### Task Breakdown (estimated ~5 working days)

| #  | Task                                                                                          | Est. | Dependencies |
| -- | --------------------------------------------------------------------------------------------- | ---- | ------------ |
| 1  | `FieldEvent` types + migration v14 (with `seq`, `related_event_id`, `project_id` index)       | 0.5d | —            |
| 2  | EventBus extension + `emitFieldEvent` (direct enqueue + best-effort broadcast)                | 0.5d | #1           |
| 3  | `FieldEventSink` (queue, flush, retry, quarantine, shutdown, counters)                        | 1.0d | #1, #2       |
| 4  | Privacy gate (`privacy.ts`, cached read, invalidation hook)                                   | 0.3d | #2           |
| 5  | Narrow `field:reportWorktreeSwitch` IPC + preload + validation                                | 0.5d | #2           |
| 6  | Emit `worktree.switch` from store (with source-side dedup)                                    | 0.3d | #5           |
| 7  | Emit `terminal.command` in terminal-handlers (best-effort line capture)                        | 0.5d | #2           |
| 8  | Emit `session.message` in agent-handlers                                                       | 0.3d | #2           |
| 9  | Field repository (`getRecentFieldEvents`, `getFieldEventCounters`)                             | 0.4d | #1           |
| 10 | `scripts/dump-field-events.ts`                                                                 | 0.3d | #9           |
| 11 | Settings UI toggle (one checkbox; reuse existing settings surface)                             | 0.3d | #4           |
| 12 | End-to-end verification + DoD demo                                                             | 0.6d | all          |

### Definition of Done

1. Fresh install → run玄圃 30+ minutes across ≥2 worktrees, doing real work (switch, terminal commands, Agent prompts)
2. Run `pnpm tsx scripts/dump-field-events.ts --minutes 30` — output reconstructs a coherent timeline
3. Toggle `field_collection_enabled = false` → no new sensitive events appear; `dropped_privacy` increments per attempt
4. Toggle back → collection resumes
5. Kill app ungracefully mid-session → no more than the current flush window is lost (≤100 events / ≤1s)
6. Inject a throwing `'field:event'` listener for one minute → persistence continues unaffected; counters look healthy
7. Force `writeBatch` to throw 3 times on a batch containing one bad payload → quarantine isolates the bad row, others persist
8. Migration applies cleanly: fresh DB, existing v13 DB (copy production DB to a test location and verify)
9. All new code passes `pnpm lint` and `pnpm test`
10. Schema repair (`ensureFieldEventsTable`) is idempotent across multiple app starts

### Risks and Mitigations

| Risk                                                      | Mitigation                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Throwing bus listener breaks persistence                  | Bus is NOT the persistence path; sink enqueued directly from `emitFieldEvent`           |
| One bad payload poisons the flush batch                   | Serialize at enqueue time; sink quarantines via row-by-row retry after 3 failures       |
| High-frequency emit blocks main thread                    | Queue + batched transactions; benchmark with 1000-event loop in DoD                     |
| DB bloat over time                                        | Phase 22 adds retention policy (default 30 days); acceptable risk for Phase 21          |
| Renderer forges events                                    | Only `worktree.switch` channel exposed; payload validated; worktree id verified in DB   |
| Store-restore re-emits `worktree.switch`                  | Source-side dedup (`prevId === newId` short-circuits)                                   |
| Terminal buffer grows unbounded on pathological input     | 4KB cap per command line; ESC sequences explicitly dropped                              |
| Terminal command capture is not reliable                  | Documented as best-effort; reliable lifecycle deferred to shell-integration in Phase 23+ |
| Privacy concerns                                          | Default on but visible toggle; local-only (no cloud); gate at emit (sensitive payloads never assembled when off) |
| `seq` ordering vs replay determinism                      | `seq` autoincrement guarantees stable order even within same millisecond                |
| Sink stalls silently                                      | Counters (`flush_failures`, `dropped_overflow`, `last_flush_at`) exposed via repository |

---

## Appendix — File Inventory

### New files

- `src/shared/types/field-event.ts`
- `src/main/field/emit.ts`
- `src/main/field/sink.ts`
- `src/main/field/privacy.ts`
- `src/main/field/repository.ts`
- `src/main/ipc/field-handlers.ts`
- `scripts/dump-field-events.ts`
- `test/phase-21/field-event-sink.test.ts`
- `test/phase-21/field-emit.test.ts`
- `test/phase-21/field-repository.test.ts`

### Modified files

- `src/main/db/schema.ts` — add migration v14, bump `CURRENT_SCHEMA_VERSION` to 14
- `src/main/db/database.ts` — add `ensureFieldEventsTable()`; expose `getDbHandle()` if not already public (sink needs raw `Database` for prepared statements)
- `src/server/event-bus.ts` — add `'field:event'` to `EventBusEvents` (best-effort fan-out)
- `src/main/index.ts` — initialize `getFieldEventSink()` after DB ready; register shutdown
- `src/main/ipc/index.ts` — export `registerFieldHandlers`
- `src/main/ipc/terminal-handlers.ts` — emit `terminal.command` on enter
- `src/main/ipc/agent-handlers.ts` — emit `session.message` after prompt validation
- `src/main/ipc/settings-handlers.ts` — call `invalidatePrivacyCache()` on `field_collection_enabled` write
- `src/preload/index.ts` — add `window.field.reportWorktreeSwitch`
- `src/preload/index.d.ts` — declare `window.field` surface
- `src/renderer/src/stores/useWorktreeStore.ts` — call `window.field.reportWorktreeSwitch` on select (with source-side dedup)
