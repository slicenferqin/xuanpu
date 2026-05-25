export enum HarnessErrorCode {
  TIMEOUT = 'TIMEOUT',
  MALFORMED_TOOL_CALL = 'MALFORMED_TOOL_CALL',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  COMPRESSION_FAILURE = 'COMPRESSION_FAILURE',
  RUNTIME_ERROR = 'RUNTIME_ERROR',
  TOOL_EXECUTION_ERROR = 'TOOL_EXECUTION_ERROR',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  REPEATED_TOOL_CALL_GIVE_UP = 'REPEATED_TOOL_CALL_GIVE_UP'
}

export type HarnessErrorContext = Record<string, unknown>

export interface HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly recoverable: boolean
  readonly traceId: string
  readonly context?: HarnessErrorContext
}

export interface CreateHarnessErrorOptions {
  recoverable?: boolean
  traceId?: string
  context?: HarnessErrorContext
  cause?: unknown
}

const DEFAULT_RECOVERABLE_BY_CODE: Record<HarnessErrorCode, boolean> = {
  [HarnessErrorCode.TIMEOUT]: true,
  [HarnessErrorCode.MALFORMED_TOOL_CALL]: true,
  [HarnessErrorCode.PERMISSION_DENIED]: true,
  [HarnessErrorCode.COMPRESSION_FAILURE]: true,
  [HarnessErrorCode.RUNTIME_ERROR]: true,
  [HarnessErrorCode.TOOL_EXECUTION_ERROR]: true,
  [HarnessErrorCode.BUDGET_EXCEEDED]: true,
  [HarnessErrorCode.REPEATED_TOOL_CALL_GIVE_UP]: false
}

export class XuanpuHarnessError extends Error implements HarnessError {
  readonly code: HarnessErrorCode
  readonly recoverable: boolean
  readonly traceId: string
  readonly context?: HarnessErrorContext
  readonly cause?: unknown

  constructor(code: HarnessErrorCode, message: string, options: CreateHarnessErrorOptions = {}) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
    this.recoverable = options.recoverable ?? isRecoverable(code)
    this.traceId = options.traceId ?? createHarnessTraceId()
    this.context = options.context
    this.cause = options.cause
  }
}

export function isRecoverable(code: HarnessErrorCode): boolean {
  return DEFAULT_RECOVERABLE_BY_CODE[code]
}

export function createHarnessError(
  code: HarnessErrorCode,
  message: string,
  options: CreateHarnessErrorOptions = {}
): HarnessError {
  return new XuanpuHarnessError(code, message, options)
}

export function toHarnessError(
  error: unknown,
  code: HarnessErrorCode = HarnessErrorCode.RUNTIME_ERROR,
  options: Omit<CreateHarnessErrorOptions, 'cause'> = {}
): HarnessError {
  if (isHarnessError(error)) return error

  const message = error instanceof Error ? error.message : String(error)
  return createHarnessError(code, message, { ...options, cause: error })
}

export function isHarnessError(error: unknown): error is HarnessError {
  return (
    error instanceof Error &&
    typeof (error as Partial<HarnessError>).code === 'string' &&
    typeof (error as Partial<HarnessError>).recoverable === 'boolean' &&
    typeof (error as Partial<HarnessError>).traceId === 'string'
  )
}

function createHarnessTraceId(): string {
  return `harness-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
