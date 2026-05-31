import {
  ContextBudgetRecorder,
  type ContextBudgetRecord
} from '../../src/main/services/xuanpu-agent/harness/budget'
import {
  HarnessErrorCode,
  isHarnessError
} from '../../src/main/services/xuanpu-agent/harness/error-taxonomy'

describe('ContextBudgetRecorder', () => {
  it('records and returns the latest turn for a session', () => {
    const recorder = new ContextBudgetRecorder()
    const first = createRecord({ turnId: 'turn-1', packetId: 'packet-1', estimatedTokens: 120 })
    const second = createRecord({
      turnId: 'turn-2',
      packetId: 'packet-2',
      estimatedTokens: 180,
      omittedSections: ['terminal']
    })

    recorder.recordTurn(first)
    recorder.recordTurn(second)

    expect(recorder.getRecord('turn-1')).toEqual(first)
    expect(recorder.getLatestRecord('session-1')).toEqual(second)
    expect(recorder.listRecords('session-1')).toEqual([first, second])
  })

  it('keeps independent latest records for different sessions and runtimes', () => {
    const recorder = new ContextBudgetRecorder()
    const xuanpuRecord = createRecord({ turnId: 'turn-1', sessionId: 'session-1' })
    const codexRecord = createRecord({
      turnId: 'turn-2',
      sessionId: 'session-2',
      runtime: 'codex'
    })

    recorder.recordTurn(xuanpuRecord)
    recorder.recordTurn(codexRecord)

    expect(recorder.getLatestRecord('session-1')).toEqual(xuanpuRecord)
    expect(recorder.getLatestRecord('session-2')).toEqual(codexRecord)
    expect(recorder.getLatestRecord('missing')).toBeNull()
  })

  it('stores immutable snapshots instead of caller-owned arrays', () => {
    const recorder = new ContextBudgetRecorder()
    const includedSections = ['identity', 'gitState']
    const omittedSections = ['terminal']
    const record = createRecord({ includedSections, omittedSections })

    recorder.recordTurn(record)
    includedSections.push('mutated')
    omittedSections.push('mutated')

    const stored = recorder.getLatestRecord('session-1')
    expect(stored?.includedSections).toEqual(['identity', 'gitState'])
    expect(stored?.omittedSections).toEqual(['terminal'])
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored?.includedSections)).toBe(true)
    expect(Object.isFrozen(stored?.omittedSections)).toBe(true)
  })

  it('clears in-memory records without touching other recorder instances', () => {
    const recorder = new ContextBudgetRecorder()
    const otherRecorder = new ContextBudgetRecorder()
    const record = createRecord()

    recorder.recordTurn(record)
    otherRecorder.recordTurn(record)
    recorder.clear()

    expect(recorder.getLatestRecord('session-1')).toBeNull()
    expect(otherRecorder.getLatestRecord('session-1')).toEqual(record)
  })

  it('rejects invalid records with a HarnessError', () => {
    const recorder = new ContextBudgetRecorder()

    expect(() =>
      recorder.recordTurn(
        createRecord({
          turnId: '',
          compressionRatio: 2
        })
      )
    ).toThrow('Invalid Context Budget record')

    try {
      recorder.recordTurn(createRecord({ estimatedTokens: -1 }))
    } catch (error) {
      expect(isHarnessError(error)).toBe(true)
      if (isHarnessError(error)) {
        expect(error.code).toBe(HarnessErrorCode.RUNTIME_ERROR)
        expect(error.traceId).toMatch(/^harness-\d+-[a-z0-9]+$/)
      }
    }
  })
})

function createRecord(overrides: Partial<ContextBudgetRecord> = {}): ContextBudgetRecord {
  return {
    turnId: 'turn-1',
    capturedAt: 1760000000000,
    sessionId: 'session-1',
    runtime: 'xuanpu-agent',
    packetId: 'packet-1',
    budgetProfile: 'balanced',
    includedSections: ['identity', 'gitState', 'currentGoal'],
    omittedSections: [],
    estimatedTokens: 100,
    compressionRatio: null,
    rawPacketRef: '/tmp/xuanpu-agent/packet-1.json',
    ...overrides
  }
}
