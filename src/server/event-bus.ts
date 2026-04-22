import { EventEmitter } from 'events'
import type {
  OpenCodeStreamEvent,
  FileTreeIndividualChangeEvent,
  ScriptOutputEvent,
  FieldEvent
} from '../shared/types'

interface EventBusEvents {
  'agent:stream': [event: OpenCodeStreamEvent]
  'worktree:branchRenamed': [data: { worktreeId: string; newBranch: string }]
  'git:statusChanged': [data: { worktreePath: string }]
  'git:branchChanged': [data: { worktreePath: string }]
  'file-tree:change': [event: FileTreeIndividualChangeEvent]
  'script:output': [channel: string, event: ScriptOutputEvent]
  'terminal:data': [worktreeId: string, data: string]
  'terminal:exit': [worktreeId: string, code: number]
  // Phase 21: Field Event Stream — best-effort fan-out only.
  // NOT the persistence path; FieldEventSink is enqueued directly from emitFieldEvent().
  // Reserved for future debug/UI subscribers (Phase 22 Field Timeline).
  'field:event': [event: FieldEvent]
}

export class EventBus {
  private emitter = new EventEmitter()

  emit<K extends keyof EventBusEvents>(event: K, ...args: EventBusEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  on<K extends keyof EventBusEvents>(
    event: K,
    listener: (...args: EventBusEvents[K]) => void
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
  }

  off<K extends keyof EventBusEvents>(
    event: K,
    listener: (...args: EventBusEvents[K]) => void
  ): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void)
  }

  removeAllListeners(event?: keyof EventBusEvents): void {
    if (event) this.emitter.removeAllListeners(event)
    else this.emitter.removeAllListeners()
  }
}

let instance: EventBus | null = null

export function getEventBus(): EventBus {
  if (!instance) instance = new EventBus()
  return instance
}

export function resetEventBus(): void {
  instance?.removeAllListeners()
  instance = null
}
