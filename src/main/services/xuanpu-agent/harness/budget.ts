import type { XfpBudgetProfile } from '../xfp/types'
import { HarnessErrorCode, createHarnessError } from './error-taxonomy'

export type ContextBudgetRuntime = 'xuanpu-agent' | 'codex' | 'claude-code' | 'opencode'

export interface ContextBudgetRecord {
  readonly turnId: string
  readonly capturedAt: number
  readonly sessionId: string
  readonly runtime: ContextBudgetRuntime
  readonly packetId: string
  readonly budgetProfile: XfpBudgetProfile
  readonly includedSections: readonly string[]
  readonly omittedSections: readonly string[]
  readonly estimatedTokens: number
  readonly compressionRatio: number | null
  readonly rawPacketRef: string
}

export class ContextBudgetRecorder {
  private readonly recordsByTurnId = new Map<string, ContextBudgetRecord>()
  private readonly recordsBySessionId = new Map<string, ContextBudgetRecord[]>()

  recordTurn(record: ContextBudgetRecord): void {
    assertValidRecord(record)

    const snapshot = freezeRecord(record)
    this.recordsByTurnId.set(snapshot.turnId, snapshot)

    const sessionRecords = this.recordsBySessionId.get(snapshot.sessionId) ?? []
    sessionRecords.push(snapshot)
    this.recordsBySessionId.set(snapshot.sessionId, sessionRecords)
  }

  getRecord(turnId: string): ContextBudgetRecord | null {
    return this.recordsByTurnId.get(turnId) ?? null
  }

  getLatestRecord(sessionId: string): ContextBudgetRecord | null {
    const records = this.recordsBySessionId.get(sessionId)
    return records?.at(-1) ?? null
  }

  listRecords(sessionId: string): readonly ContextBudgetRecord[] {
    return this.recordsBySessionId.get(sessionId) ?? []
  }

  clear(): void {
    this.recordsByTurnId.clear()
    this.recordsBySessionId.clear()
  }
}

function freezeRecord(record: ContextBudgetRecord): ContextBudgetRecord {
  return Object.freeze({
    ...record,
    includedSections: Object.freeze([...record.includedSections]),
    omittedSections: Object.freeze([...record.omittedSections])
  })
}

function assertValidRecord(record: ContextBudgetRecord): void {
  assertNonEmptyString(record.turnId, 'turnId')
  assertNonEmptyString(record.sessionId, 'sessionId')
  assertNonEmptyString(record.packetId, 'packetId')
  assertNonEmptyString(record.rawPacketRef, 'rawPacketRef')
  assertNonNegativeInteger(record.capturedAt, 'capturedAt')
  assertNonNegativeInteger(record.estimatedTokens, 'estimatedTokens')
  assertSectionNames(record.includedSections, 'includedSections')
  assertSectionNames(record.omittedSections, 'omittedSections')

  if (
    record.compressionRatio !== null &&
    (record.compressionRatio < 0 || record.compressionRatio > 1)
  ) {
    throwInvalidRecord('compressionRatio must be null or between 0 and 1', {
      turnId: record.turnId,
      compressionRatio: record.compressionRatio
    })
  }
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (typeof value === 'string' && value.trim().length > 0) return

  throwInvalidRecord(`${fieldName} must be a non-empty string`, { fieldName })
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (Number.isInteger(value) && value >= 0) return

  throwInvalidRecord(`${fieldName} must be a non-negative integer`, { fieldName, value })
}

function assertSectionNames(value: readonly string[], fieldName: string): void {
  if (Array.isArray(value) && value.every((item) => item.trim().length > 0)) return

  throwInvalidRecord(`${fieldName} must contain only non-empty section names`, { fieldName })
}

function throwInvalidRecord(message: string, context: Record<string, unknown>): never {
  throw createHarnessError(
    HarnessErrorCode.RUNTIME_ERROR,
    `Invalid Context Budget record: ${message}`,
    {
      context
    }
  )
}
