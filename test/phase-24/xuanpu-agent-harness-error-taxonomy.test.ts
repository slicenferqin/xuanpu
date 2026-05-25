import {
  HarnessErrorCode,
  XuanpuHarnessError,
  createHarnessError,
  isHarnessError,
  isRecoverable,
  toHarnessError
} from '../../src/main/services/xuanpu-agent/harness/error-taxonomy'

describe('xuanpu-agent harness error taxonomy', () => {
  it('defines the stable AI-3 and M1.5 error codes', () => {
    expect(Object.values(HarnessErrorCode)).toEqual([
      'TIMEOUT',
      'MALFORMED_TOOL_CALL',
      'PERMISSION_DENIED',
      'COMPRESSION_FAILURE',
      'RUNTIME_ERROR',
      'TOOL_EXECUTION_ERROR',
      'BUDGET_EXCEEDED',
      'REPEATED_TOOL_CALL_GIVE_UP'
    ])
  })

  it('marks storm give-up as non-recoverable while normal harness errors are recoverable', () => {
    expect(isRecoverable(HarnessErrorCode.TIMEOUT)).toBe(true)
    expect(isRecoverable(HarnessErrorCode.MALFORMED_TOOL_CALL)).toBe(true)
    expect(isRecoverable(HarnessErrorCode.PERMISSION_DENIED)).toBe(true)
    expect(isRecoverable(HarnessErrorCode.COMPRESSION_FAILURE)).toBe(true)
    expect(isRecoverable(HarnessErrorCode.RUNTIME_ERROR)).toBe(true)
    expect(isRecoverable(HarnessErrorCode.TOOL_EXECUTION_ERROR)).toBe(true)
    expect(isRecoverable(HarnessErrorCode.BUDGET_EXCEEDED)).toBe(true)
    expect(isRecoverable(HarnessErrorCode.REPEATED_TOOL_CALL_GIVE_UP)).toBe(false)
  })

  it('creates HarnessError instances with trace and context metadata', () => {
    const error = createHarnessError(HarnessErrorCode.MALFORMED_TOOL_CALL, 'bad tool call', {
      traceId: 'trace-1',
      context: { toolName: 'read_file' }
    })

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(XuanpuHarnessError)
    expect(error.name).toBe('HarnessError')
    expect(error.code).toBe(HarnessErrorCode.MALFORMED_TOOL_CALL)
    expect(error.message).toBe('bad tool call')
    expect(error.recoverable).toBe(true)
    expect(error.traceId).toBe('trace-1')
    expect(error.context).toEqual({ toolName: 'read_file' })
    expect(isHarnessError(error)).toBe(true)
  })

  it('generates a trace id when the caller does not provide one', () => {
    const error = createHarnessError(HarnessErrorCode.RUNTIME_ERROR, 'runtime crashed')

    expect(error.traceId).toMatch(/^harness-\d+-[a-z0-9]+$/)
  })

  it('wraps unknown errors without double-wrapping existing HarnessError values', () => {
    const original = new Error('spawn failed')
    const wrapped = toHarnessError(original, HarnessErrorCode.TOOL_EXECUTION_ERROR, {
      traceId: 'trace-2'
    })

    expect(wrapped.code).toBe(HarnessErrorCode.TOOL_EXECUTION_ERROR)
    expect(wrapped.message).toBe('spawn failed')
    expect(wrapped.traceId).toBe('trace-2')

    const alreadyHarness = createHarnessError(HarnessErrorCode.PERMISSION_DENIED, 'denied', {
      traceId: 'trace-3'
    })
    expect(toHarnessError(alreadyHarness)).toBe(alreadyHarness)
  })
})
