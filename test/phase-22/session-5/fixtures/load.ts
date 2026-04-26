/**
 * Fixture loader for codex JSON-RPC dumps.
 *
 * NDJSON fixtures are slices of real dumps captured by
 * src/main/services/codex-rpc-dumper.ts (see scripts/dump-codex-rpc.ts).
 *
 * Each line of an NDJSON fixture is a wrapper:
 *   { ts, dir: 'in' | 'out', threadId, raw: '<jsonrpc-frame>' }
 *
 * `loadFixture(name)` returns the inbound notifications as
 * `CodexManagerEvent`s — exactly what the manager would emit to the
 * implementer. Outbound frames (our own requests) and responses are skipped.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { CodexManagerEvent } from '../../../../src/main/services/codex-app-server-manager'

interface DumpWrapper {
  ts: string
  dir: 'in' | 'out'
  threadId: string | null
  raw: string
}

interface JsonRpcFrame {
  method?: string
  params?: unknown
  id?: string | number
  result?: unknown
  error?: { code?: number; message?: string }
}

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url))

function readRouteFields(params: unknown): {
  turnId: string | undefined
  itemId: string | undefined
} {
  if (!params || typeof params !== 'object') return { turnId: undefined, itemId: undefined }
  const obj = params as Record<string, unknown>
  const turnId =
    typeof obj.turnId === 'string'
      ? obj.turnId
      : typeof (obj.turn as { id?: unknown })?.id === 'string'
        ? ((obj.turn as { id: string }).id)
        : undefined
  const itemId =
    typeof obj.itemId === 'string'
      ? obj.itemId
      : typeof (obj.item as { id?: unknown })?.id === 'string'
        ? ((obj.item as { id: string }).id)
        : undefined
  return { turnId, itemId }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Load a fixture and convert each inbound JSON-RPC notification into the
 * `CodexManagerEvent` that the real manager would emit.
 *
 * Server requests (the ones with both `id` and `method`) are also passed
 * through as `kind: 'request'` events because mappers may look at them
 * (e.g. requestApproval). Responses to our outbound requests are skipped —
 * they carry no UI signal.
 */
export function loadFixture(name: string): CodexManagerEvent[] {
  const path = join(FIXTURE_DIR, `${name}.ndjson`)
  const text = readFileSync(path, 'utf8')
  const events: CodexManagerEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let wrapper: DumpWrapper
    try {
      wrapper = JSON.parse(line) as DumpWrapper
    } catch {
      continue
    }
    if (wrapper.dir !== 'in') continue

    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(wrapper.raw) as JsonRpcFrame
    } catch {
      continue
    }

    // Skip pure responses (id present, no method).
    if (!frame.method) continue

    const route = readRouteFields(frame.params)
    const isRequest = frame.id !== undefined && frame.method !== undefined
    const threadId = wrapper.threadId ?? ''

    const params = (frame.params ?? {}) as Record<string, unknown>
    const textDelta =
      frame.method === 'item/agentMessage/delta' ? asString(params.delta) : undefined

    events.push({
      id: randomUUID(),
      kind: isRequest ? 'request' : 'notification',
      provider: 'codex',
      threadId,
      createdAt: wrapper.ts,
      method: frame.method,
      ...(route.turnId ? { turnId: route.turnId } : {}),
      ...(route.itemId ? { itemId: route.itemId } : {}),
      ...(textDelta !== undefined ? { textDelta } : {}),
      ...(isRequest ? { requestId: randomUUID() } : {}),
      payload: frame.params
    } as CodexManagerEvent)
  }
  return events
}

export const FIXTURES = [
  'agent-message-stream',
  'read-via-cat',
  'bash-pure',
  'file-change-edit',
  'file-change-revert',
  'update-plan',
  'mcp-tool-call',
  'web-search-reasoning'
] as const

export type FixtureName = (typeof FIXTURES)[number]
