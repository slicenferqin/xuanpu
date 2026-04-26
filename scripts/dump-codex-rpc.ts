#!/usr/bin/env node
/**
 * Reader for Codex JSON-RPC NDJSON dumps produced by the runtime tap in
 * src/main/services/codex-rpc-dumper.ts.
 *
 * Usage:
 *   pnpm tsx scripts/dump-codex-rpc.ts <file.ndjson> [...more files] [--mode timeline|methods|raw]
 *
 * Modes:
 *   timeline (default) — readable per-turn breakdown, payload truncated.
 *   methods            — frequency table of method + dir.
 *   raw                — pretty-print every parsed frame, no truncation.
 *
 * The dump file is written by the running app when XUANPU_DUMP_CODEX_RPC=1.
 *   XUANPU_DUMP_CODEX_RPC=1 pnpm dev
 *   # exercise codex …
 *   pnpm tsx scripts/dump-codex-rpc.ts ~/.xuanpu/logs/codex-rpc-*.ndjson
 */
import { readFileSync, existsSync } from 'node:fs'

interface Frame {
  ts: string
  dir: 'in' | 'out'
  threadId: string | null
  raw: string
}

interface ParsedFrame extends Frame {
  parsed: Record<string, unknown> | null
  method: string | null
  id: string | number | null
  isRequest: boolean
  isResponse: boolean
  isNotification: boolean
}

type Mode = 'timeline' | 'methods' | 'raw'

function parseArgs(argv: string[]): { files: string[]; mode: Mode; truncate: number } {
  const files: string[] = []
  let mode: Mode = 'timeline'
  let truncate = 200
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') {
      const next = argv[++i]
      if (next === 'timeline' || next === 'methods' || next === 'raw') mode = next
      else throw new Error(`unknown --mode ${next}`)
    } else if (a === '--truncate') {
      truncate = Number.parseInt(argv[++i] ?? '', 10)
      if (!Number.isFinite(truncate)) throw new Error('--truncate requires a number')
    } else if (a === '-h' || a === '--help') {
      printHelp()
      process.exit(0)
    } else {
      files.push(a)
    }
  }
  if (files.length === 0) {
    printHelp()
    process.exit(1)
  }
  return { files, mode, truncate }
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: dump-codex-rpc.ts <file.ndjson>... [--mode timeline|methods|raw] [--truncate N]',
      '',
      '  --mode timeline  per-turn breakdown (default)',
      '  --mode methods   method frequency table',
      '  --mode raw       pretty-print all frames, no truncation',
      '  --truncate N     payload preview length in timeline mode (default 200)',
      ''
    ].join('\n')
  )
}

function loadFrames(files: string[]): ParsedFrame[] {
  const out: ParsedFrame[] = []
  for (const file of files) {
    if (!existsSync(file)) {
      process.stderr.write(`! file not found: ${file}\n`)
      continue
    }
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let frame: Frame
      try {
        frame = JSON.parse(line) as Frame
      } catch {
        process.stderr.write(`! skipping malformed wrapper line in ${file}\n`)
        continue
      }
      let parsed: Record<string, unknown> | null = null
      try {
        const p = JSON.parse(frame.raw)
        parsed = p && typeof p === 'object' ? (p as Record<string, unknown>) : null
      } catch {
        parsed = null
      }
      const method =
        parsed && typeof parsed.method === 'string' ? (parsed.method as string) : null
      const id =
        parsed && (typeof parsed.id === 'string' || typeof parsed.id === 'number')
          ? (parsed.id as string | number)
          : null
      const isResponse = parsed != null && id !== null && method === null
      const isRequest = parsed != null && id !== null && method !== null
      const isNotification = parsed != null && id === null && method !== null
      out.push({
        ...frame,
        parsed,
        method,
        id,
        isRequest,
        isResponse,
        isNotification
      })
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts))
  return out
}

function methodsMode(frames: ParsedFrame[]): void {
  const counts = new Map<string, number>()
  for (const f of frames) {
    const key = `${f.dir}\t${f.method ?? (f.isResponse ? '<response>' : '<unknown>')}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const rows = Array.from(counts.entries())
    .map(([k, v]) => {
      const [dir, method] = k.split('\t')
      return { dir, method, count: v }
    })
    .sort((a, b) => b.count - a.count)
  process.stdout.write(`# Codex JSON-RPC method frequency (${frames.length} frames)\n\n`)
  process.stdout.write('count   dir method\n')
  process.stdout.write('-----   --- ------\n')
  for (const row of rows) {
    process.stdout.write(`${String(row.count).padStart(5)}   ${row.dir.padEnd(3)} ${row.method}\n`)
  }
}

function rawMode(frames: ParsedFrame[]): void {
  for (const f of frames) {
    process.stdout.write(`---- ${f.ts} ${f.dir} thread=${f.threadId ?? '-'} ----\n`)
    if (f.parsed) {
      process.stdout.write(`${JSON.stringify(f.parsed, null, 2)}\n\n`)
    } else {
      process.stdout.write(`${f.raw}\n\n`)
    }
  }
}

function shortPayload(parsed: Record<string, unknown> | null, max: number): string {
  if (!parsed) return '<unparsed>'
  const params = (parsed.params ?? parsed.result ?? parsed.error) as unknown
  if (params === undefined || params === null) return ''
  const json = JSON.stringify(params)
  if (json.length <= max) return json
  return `${json.slice(0, max)}…(${json.length - max} more)`
}

function turnIdOf(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null
  const params = parsed.params as Record<string, unknown> | undefined
  if (!params) return null
  const turn = params.turn as Record<string, unknown> | undefined
  if (turn && typeof turn.id === 'string') return turn.id
  if (typeof params.turnId === 'string') return params.turnId
  return null
}

function timelineMode(frames: ParsedFrame[], truncate: number): void {
  let currentTurn: string | null = null
  let currentThread: string | null = null
  process.stdout.write(`# Codex JSON-RPC timeline (${frames.length} frames)\n\n`)

  for (const f of frames) {
    if (f.threadId !== currentThread) {
      currentThread = f.threadId
      process.stdout.write(`\n## thread ${currentThread ?? '<boot>'}\n`)
    }

    const turnId = turnIdOf(f.parsed)
    if (turnId && turnId !== currentTurn) {
      currentTurn = turnId
      process.stdout.write(`\n### turn ${turnId}\n`)
    }
    if (f.method === 'turn/completed' || f.method === 'turn.completed') {
      currentTurn = null
    }

    const ts = f.ts.slice(11, 23) // HH:MM:SS.mmm
    const arrow = f.dir === 'in' ? '←' : '→'
    const tag = f.method ?? (f.isResponse ? `response#${f.id}` : '?')
    const idTag = f.isRequest ? ` #${f.id}` : ''
    const preview = shortPayload(f.parsed, truncate)
    process.stdout.write(`${ts}  ${arrow} ${tag}${idTag}  ${preview}\n`)
  }
}

function main(): void {
  const { files, mode, truncate } = parseArgs(process.argv.slice(2))
  const frames = loadFrames(files)
  if (frames.length === 0) {
    process.stderr.write('No frames loaded.\n')
    process.exit(1)
  }
  if (mode === 'methods') methodsMode(frames)
  else if (mode === 'raw') rawMode(frames)
  else timelineMode(frames, truncate)
}

main()
