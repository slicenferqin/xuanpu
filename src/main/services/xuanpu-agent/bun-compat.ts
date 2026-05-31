import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, promises as fs } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

type BunHash = {
  (input: unknown, seed?: number | bigint): number
  xxHash32: (input: unknown, seed?: number | bigint) => number
}

interface BunFileHandle {
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

interface JsonlChunkResult {
  values: unknown[]
  error: unknown
  read: number
  done: boolean
}

export const YAML = {
  parse(input: string): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    for (const line of input.split(/\r?\n/)) {
      const match = line.match(/^([\w-]+):\s*(.*)$/)
      if (!match) continue
      result[match[1]] = parseScalar(match[2])
    }

    return result
  }
}

export class Glob {
  readonly pattern: string

  constructor(pattern: string) {
    this.pattern = pattern
  }

  scanSync(): string[] {
    return []
  }

  async *scan(): AsyncGenerator<string> {}
}

export function $(): never {
  throw new Error('Bun shell API is not available in the Xuanpu Electron runtime')
}

export function installBunCompatGlobal(): void {
  const globalRecord = globalThis as unknown as Record<string, unknown>
  const existing = globalRecord.Bun as Record<string, unknown> | undefined
  const bunCompat = existing ?? {}

  bunCompat.env = bunCompat.env ?? process.env
  bunCompat.sleep = bunCompat.sleep ?? sleep
  bunCompat.which = bunCompat.which ?? which
  bunCompat.hash = bunCompat.hash ?? createBunHash()
  bunCompat.sha = bunCompat.sha ?? sha
  bunCompat.stripANSI = bunCompat.stripANSI ?? stripANSI
  bunCompat.JSONL = bunCompat.JSONL ?? { parseChunk: parseJsonlChunk }
  bunCompat.JSON5 = bunCompat.JSON5 ?? { parse: JSON.parse }
  bunCompat.file = bunCompat.file ?? bunFile
  bunCompat.write = bunCompat.write ?? bunWrite
  bunCompat.Glob = bunCompat.Glob ?? Glob
  bunCompat.YAML = bunCompat.YAML ?? YAML
  bunCompat.$ = bunCompat.$ ?? $

  globalRecord.Bun = bunCompat
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && String(numeric) === trimmed) return numeric

  return trimmed.replace(/^["']|["']$/g, '')
}

function sleep(duration: number | Date = 0, options?: { signal?: AbortSignal }): Promise<void> {
  const signal = options?.signal
  if (signal?.aborted) return Promise.reject(createAbortError())

  const ms =
    duration instanceof Date
      ? Math.max(0, duration.getTime() - Date.now())
      : Math.max(0, duration)

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(createAbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function which(command: string, options?: { PATH?: string; path?: string; cwd?: string }): string | null {
  if (!command) return null

  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    const candidate = options?.cwd && !isAbsolute(command) ? join(options.cwd, command) : command
    return isExecutable(candidate) ? candidate : null
  }

  const pathValue = options?.PATH ?? options?.path ?? process.env.PATH ?? ''
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : ['']

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (isExecutable(candidate)) return candidate
    }
  }

  return null
}

function isExecutable(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function createBunHash(): BunHash {
  const hash = ((input: unknown, seed?: number | bigint) =>
    fnv1a32(normalizeHashInput(input), seed)) as BunHash
  hash.xxHash32 = (input: unknown, seed?: number | bigint) =>
    fnv1a32(normalizeHashInput(input), seed)
  return hash
}

function fnv1a32(input: Uint8Array, seed?: number | bigint): number {
  let hash = seed === undefined ? 0x811c9dc5 : Number(seed) >>> 0
  for (const byte of input) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function normalizeHashInput(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }

  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input))
}

function sha(input: string | Uint8Array, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHash('sha256').update(input).digest(encoding)
}

function stripANSI(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ''
  )
}

function parseJsonlChunk(
  input: string | Uint8Array,
  start = 0,
  stop?: number
): JsonlChunkResult {
  const text =
    typeof input === 'string'
      ? input.slice(start, stop)
      : Buffer.from(input.subarray(start, stop ?? input.length)).toString('utf8')
  const values: unknown[] = []
  let offset = 0

  for (const line of text.split(/\n/)) {
    const trimmed = line.trim()
    offset += line.length + 1
    if (!trimmed) continue

    try {
      values.push(JSON.parse(trimmed))
    } catch (error) {
      return {
        values,
        error,
        read: Math.min(offset, text.length),
        done: false
      }
    }
  }

  return {
    values,
    error: null,
    read: text.length,
    done: true
  }
}

function bunFile(filePath: string): BunFileHandle {
  return {
    async text() {
      return fs.readFile(filePath, 'utf8')
    },
    async json() {
      return JSON.parse(await fs.readFile(filePath, 'utf8'))
    },
    async arrayBuffer() {
      const buffer = await fs.readFile(filePath)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    }
  }
}

async function bunWrite(filePath: string, data: string | Uint8Array): Promise<number> {
  await fs.writeFile(filePath, data)
  return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
}
