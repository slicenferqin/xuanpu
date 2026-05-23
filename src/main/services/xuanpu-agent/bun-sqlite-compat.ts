export interface StatementRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export class Statement<T = Record<string, unknown>> {
  constructor(readonly sql: string) {}

  all(..._params: unknown[]): T[] {
    return []
  }

  get(..._params: unknown[]): T | null {
    return null
  }

  run(..._params: unknown[]): StatementRunResult {
    return { changes: 0, lastInsertRowid: 0 }
  }

  values(..._params: unknown[]): unknown[][] {
    return []
  }

  finalize(): void {}
}

export class Database {
  constructor(
    readonly filename: string,
    readonly options?: Record<string, unknown>
  ) {}

  run(_sql?: string, ..._params: unknown[]): StatementRunResult {
    return { changes: 0, lastInsertRowid: 0 }
  }

  prepare<T = Record<string, unknown>>(sql: string): Statement<T> {
    return new Statement<T>(sql)
  }

  query<T = Record<string, unknown>>(sql: string): Statement<T> {
    return new Statement<T>(sql)
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult
  ): (...args: TArgs) => TResult {
    return (...args: TArgs) => fn(...args)
  }

  close(): void {}
}
