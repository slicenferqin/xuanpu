/**
 * Field Event Stream — emit helper.
 *
 * Phase 21 — see docs/prd/phase-21-field-events.md §2.2
 *
 * Design contract:
 *   1. Privacy-gate sensitive types BEFORE payload assembly / bus emit.
 *   2. Generate id + timestamp.
 *   3. Serialize payload at enqueue time so a bad payload cannot poison
 *      a future flush batch.
 *   4. Enqueue directly to the sink (primary persistence path).
 *   5. Best-effort broadcast on the EventBus (secondary; for future
 *      debug/UI subscribers). Wrapped in try/catch — a throwing listener
 *      MUST NOT affect persistence.
 *   6. Never throw to the caller.
 */
import { randomUUID } from 'crypto'
import { getEventBus } from '../../server/event-bus'
import { createLogger } from '../services/logger'
import { getFieldEventSink } from './sink'
import { isFieldCollectionEnabled } from './privacy'
import type { FieldEvent, FieldEventType } from '../../shared/types'

const log = createLogger({ component: 'FieldEvent' })

/**
 * All Phase 21 event types are treated as sensitive — when collection is
 * disabled, none of them are emitted, assembled, or broadcast.
 *
 * (Per oracle re-review: any exception here would make the user-facing
 * setting name `field_collection_enabled` dishonest.)
 */
const SENSITIVE_TYPES: ReadonlySet<FieldEventType> = new Set<FieldEventType>([
  'worktree.switch',
  'terminal.command',
  'session.message'
])

/**
 * Caller input: full FieldEvent minus auto-populated fields (id, timestamp).
 * The `seq` column is assigned by SQLite on insert, not present here.
 */
export type EmitInput = Omit<FieldEvent, 'id' | 'timestamp'>

export function emitFieldEvent(input: EmitInput): void {
  // 1. Privacy gate at emit site (per PRD §6.2)
  if (SENSITIVE_TYPES.has(input.type) && !isFieldCollectionEnabled()) {
    getFieldEventSink().incrementCounter('dropped_privacy')
    return
  }

  // 2. Generate envelope + 3. serialize payload at enqueue time
  let event: FieldEvent
  let serialized: string
  try {
    event = {
      ...input,
      id: randomUUID(),
      timestamp: Date.now()
    } as FieldEvent
    serialized = JSON.stringify(event.payload)
  } catch (err) {
    getFieldEventSink().incrementCounter('dropped_invalid')
    log.debug('emitFieldEvent: serialization failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return
  }

  // 4. Primary persistence path — direct enqueue. Sink does NOT subscribe to
  //    the EventBus, so listener bugs cannot break persistence.
  try {
    getFieldEventSink().enqueue(event, serialized)
  } catch (err) {
    // Sink should never throw, but if it does (e.g. during init), don't break callers.
    log.warn('emitFieldEvent: sink.enqueue threw', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  // 5. Secondary best-effort broadcast for future Phase 22+ subscribers.
  //    Wrapped because EventEmitter.emit() propagates listener exceptions.
  try {
    getEventBus().emit('field:event', event)
  } catch (err) {
    log.debug('emitFieldEvent: bus broadcast failed (listener threw)', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
