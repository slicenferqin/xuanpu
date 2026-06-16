import { randomUUID } from 'node:crypto'

export type XuanpuAgentCliEventType =
  | 'session.materialized'
  | 'session.status'
  | 'session.updated'
  | 'session.warning'
  | 'session.error'
  | 'session.idle'
  | 'message.part.updated'
  | 'message.updated'

export interface XuanpuAgentCliRawEvent {
  type: XuanpuAgentCliEventType
  data: Record<string, unknown>
  origin?: 'context' | 'prompt' | 'model' | 'tool' | 'system'
  turnId?: string
}

export interface XuanpuAgentCliEvent extends XuanpuAgentCliRawEvent {
  eventId: string
  sessionSequence: number
  runEpoch: number
  sourceChannel: 'agent:stream'
  sessionId: string
  runtimeId: 'xuanpu-agent'
  eventSequence: number
}

export interface XuanpuAgentCliEventFactoryOptions {
  sessionId: string
  runEpoch?: number
}

export class XuanpuAgentCliEventFactory {
  private sessionSequence = 0
  private eventSequence = 0
  private readonly sessionId: string
  private readonly runEpoch: number

  constructor(options: XuanpuAgentCliEventFactoryOptions) {
    this.sessionId = options.sessionId
    this.runEpoch = options.runEpoch ?? Date.now()
  }

  next(raw: XuanpuAgentCliRawEvent): XuanpuAgentCliEvent {
    this.sessionSequence += 1
    this.eventSequence += 1
    return {
      ...raw,
      eventId: randomUUID(),
      sessionSequence: this.sessionSequence,
      runEpoch: this.runEpoch,
      sourceChannel: 'agent:stream',
      sessionId: this.sessionId,
      runtimeId: 'xuanpu-agent',
      eventSequence: this.eventSequence
    }
  }
}

export function stringifyNdjsonEvent(event: XuanpuAgentCliEvent): string {
  return `${JSON.stringify(event)}\n`
}
