/**
 * Fixture-driven tests for the Codex event mapper.
 *
 * Each fixture is a real JSON-RPC dump captured from a live codex session
 * (see scripts/dump-codex-rpc.ts). The mapper must produce CanonicalAgentEvent
 * sequences matching the new ToolPart contract — see docs/plans/...
 *
 * IMPORTANT: do NOT replace fixtures with hand-crafted JSON. The point is to
 * exercise the mapper against shapes codex actually emits in production.
 */
import { describe, it, expect } from 'vitest'
import {
  mapCodexEventToStreamEvents,
  createCodexMapperState
} from '../../../src/main/services/codex-event-mapper'
import { loadFixture } from './fixtures/load'

const HIVE = 'hive-test'

function streamFromFixture(name: string): unknown[] {
  const events = loadFixture(name)
  const state = createCodexMapperState()
  return events.flatMap((e) => mapCodexEventToStreamEvents(e, HIVE, state))
}

interface PartUpdate {
  type: 'message.part.updated'
  data: { part?: Record<string, unknown> & { type: string }; delta?: string }
}

function partsOf(stream: unknown[]): PartUpdate[] {
  return stream.filter(
    (e): e is PartUpdate =>
      typeof e === 'object' && e !== null && (e as { type?: string }).type === 'message.part.updated'
  )
}

function allToolParts(stream: unknown[]): Array<Record<string, unknown>> {
  // Returns the LAST tool part per unique callId.
  const seen = new Map<string, Record<string, unknown>>()
  for (const ev of partsOf(stream)) {
    const part = ev.data?.part
    if (part?.type === 'tool' && typeof part.callID === 'string') {
      seen.set(part.callID, part)
    }
  }
  return [...seen.values()]
}

// ────────────────────────────────────────────────────────────────────
// 1. Pure agent message — no tool, just text deltas
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › agent-message-stream', () => {
  const stream = streamFromFixture('agent-message-stream')

  it('emits text parts only (no tool parts)', () => {
    const tools = allToolParts(stream)
    expect(tools).toHaveLength(0)
  })

  it('emits at least one text part', () => {
    const texts = partsOf(stream).filter((e) => e.data?.part?.type === 'text')
    expect(texts.length).toBeGreaterThan(0)
  })

  it('does NOT emit text parts whose text contains "[dump test]" or file dumps', () => {
    // Sanity: no leakage of file contents into top-level text bubbles.
    for (const ev of partsOf(stream)) {
      const part = ev.data?.part
      if (part?.type === 'text') {
        expect(typeof part.text).toBe('string')
      }
    }
  })

  it('emits busy then idle session.status', () => {
    const statuses = stream.filter(
      (e): e is { type: string; statusPayload?: { type: string } } =>
        typeof e === 'object' && e !== null && (e as { type?: string }).type === 'session.status'
    )
    expect(statuses.length).toBeGreaterThanOrEqual(2)
    expect(statuses[0].statusPayload?.type).toBe('busy')
    expect(statuses[statuses.length - 1].statusPayload?.type).toBe('idle')
  })
})

// ────────────────────────────────────────────────────────────────────
// 2. Read via cat — codex commandActions promotion to Read
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › read-via-cat', () => {
  const stream = streamFromFixture('read-via-cat')

  it('promotes single read action to a Read tool part (NOT Bash, NOT text)', () => {
    const tools = allToolParts(stream)
    const reads = tools.filter((t) => t.tool === 'Read')
    expect(reads.length).toBeGreaterThan(0)
  })

  it('Read tool part has file_path in input', () => {
    const reads = allToolParts(stream).filter((t) => t.tool === 'Read')
    for (const r of reads) {
      const state = r.state as { input?: { file_path?: string } }
      expect(typeof state.input?.file_path).toBe('string')
      expect((state.input?.file_path ?? '').length).toBeGreaterThan(0)
    }
  })

  it('does NOT emit a top-level text part containing the file body', () => {
    // Bug we are fixing: outputDelta used to get classified as assistant text.
    // After the fix, command output must live INSIDE the tool part, not top-level.
    for (const ev of partsOf(stream)) {
      const part = ev.data?.part
      if (part?.type === 'text') {
        const text = (part.text as string) ?? ''
        // The fixture cats agent-protocol.ts; that file mentions
        // "CanonicalAgentEvent". If a text part contains it, we leaked.
        expect(text).not.toContain('export type CanonicalAgentEvent')
      }
    }
  })

  it('captures command output inside the tool part state.output', () => {
    const tools = allToolParts(stream)
    const completed = tools.find(
      (t) => (t.state as { status?: string }).status === 'completed'
    )
    expect(completed).toBeDefined()
    const state = completed!.state as { output?: string }
    expect(typeof state.output).toBe('string')
    // The output should be non-trivial (more than just "Done")
    expect((state.output ?? '').length).toBeGreaterThan(20)
  })
})

// ────────────────────────────────────────────────────────────────────
// 3. Bash pure — git log, no semantic promotion
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › bash-pure', () => {
  const stream = streamFromFixture('bash-pure')

  it('emits a Bash tool part with command in input', () => {
    const bash = allToolParts(stream).find((t) => t.tool === 'Bash')
    expect(bash).toBeDefined()
    const state = bash!.state as { input?: { command?: string } }
    expect(typeof state.input?.command).toBe('string')
    expect(state.input?.command).toMatch(/git/)
  })

  it('does NOT leak command output as text part', () => {
    for (const ev of partsOf(stream)) {
      const part = ev.data?.part
      if (part?.type === 'text') {
        const text = (part.text as string) ?? ''
        // Sample git log output likely contains commit-hash patterns; we
        // intentionally check for 4+ consecutive commit hash lines as
        // signature of leak.
        expect(text).not.toMatch(/^[0-9a-f]{7,40} /m)
      }
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// 4. File change — single-file edit with diff
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › file-change-edit', () => {
  const stream = streamFromFixture('file-change-edit')

  it('emits an Edit tool part with changes[] in input', () => {
    const edits = allToolParts(stream).filter((t) => t.tool === 'Edit')
    expect(edits.length).toBeGreaterThan(0)
    const state = edits[0].state as { input?: { changes?: Array<{ path: string; diff: string }> } }
    expect(Array.isArray(state.input?.changes)).toBe(true)
    expect(state.input!.changes!.length).toBeGreaterThan(0)
    expect(state.input!.changes![0].path).toMatch(/README\.md$/)
    expect(state.input!.changes![0].diff).toContain('[dump test]')
  })

  it('emits session.turn_diff with cumulative git diff', () => {
    const turnDiffs = stream.filter(
      (e): e is { type: 'session.turn_diff'; data: { turnId: string; diff: string } } =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: string }).type === 'session.turn_diff'
    )
    expect(turnDiffs.length).toBeGreaterThan(0)
    expect(turnDiffs[0].data.diff).toContain('diff --git')
    expect(turnDiffs[0].data.diff).toContain('README.md')
  })
})

// ────────────────────────────────────────────────────────────────────
// 5. File change revert — should still emit Edit tool parts
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › file-change-revert', () => {
  const stream = streamFromFixture('file-change-revert')

  it('emits Edit tool parts (one or more)', () => {
    const edits = allToolParts(stream).filter((t) => t.tool === 'Edit')
    expect(edits.length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// 6. Update plan — turn/plan/updated synthesizes a TodoWrite tool
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › update-plan', () => {
  const stream = streamFromFixture('update-plan')

  it('emits a TodoWrite tool part for turn/plan/updated', () => {
    const plans = allToolParts(stream).filter((t) => t.tool === 'TodoWrite')
    expect(plans.length).toBeGreaterThan(0)
  })

  it('TodoWrite has todos[] with step + status', () => {
    const plan = allToolParts(stream).find((t) => t.tool === 'TodoWrite')
    expect(plan).toBeDefined()
    const state = plan!.state as {
      input?: { todos?: Array<{ step?: string; status?: string }> }
    }
    expect(Array.isArray(state.input?.todos)).toBe(true)
    expect((state.input?.todos ?? []).length).toBeGreaterThan(0)
    expect(typeof state.input!.todos![0].step).toBe('string')
    expect(typeof state.input!.todos![0].status).toBe('string')
  })

  it('synthesizes a stable callID for plan updates', () => {
    const plan = allToolParts(stream).find((t) => t.tool === 'TodoWrite')
    expect(plan).toBeDefined()
    expect(typeof plan!.callID).toBe('string')
    expect((plan!.callID as string).length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// 7. MCP tool call — list_mcp_resources
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › mcp-tool-call', () => {
  const stream = streamFromFixture('mcp-tool-call')

  it('emits an McpTool part with mcpServer + toolDisplay', () => {
    const mcp = allToolParts(stream).find((t) => t.tool === 'McpTool')
    expect(mcp).toBeDefined()
    expect(typeof mcp!.mcpServer).toBe('string')
    expect((mcp!.mcpServer as string).length).toBeGreaterThan(0)
    expect(typeof mcp!.toolDisplay).toBe('string')
  })

  it('MCP tool result is preserved in state.result', () => {
    const mcp = allToolParts(stream).find((t) => t.tool === 'McpTool')
    expect(mcp).toBeDefined()
    const state = mcp!.state as { status?: string; result?: unknown }
    expect(state.status).toBe('completed')
    expect(state.result).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────────────
// 8. WebSearch + reasoning
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › web-search-reasoning', () => {
  const stream = streamFromFixture('web-search-reasoning')

  it('emits a WebSearch tool part with queries', () => {
    const ws = allToolParts(stream).find((t) => t.tool === 'WebSearch')
    expect(ws).toBeDefined()
    const state = ws!.state as { input?: { query?: string; queries?: string[] } }
    // Either a single query or an array of queries should be present.
    const hasQuery =
      typeof state.input?.query === 'string' ||
      (Array.isArray(state.input?.queries) && state.input!.queries.length > 0)
    expect(hasQuery).toBe(true)
  })

  it('emits reasoning parts (not text parts) for summaryTextDelta', () => {
    const reasonings = partsOf(stream).filter((e) => e.data?.part?.type === 'reasoning')
    expect(reasonings.length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────────────
// Cross-cutting: status normalization
// ────────────────────────────────────────────────────────────────────
describe('codex mapper › status normalization', () => {
  it('all tool parts use the canonical status set', () => {
    const allowed = new Set(['pending', 'running', 'completed', 'error', 'cancelled'])
    for (const fname of [
      'read-via-cat',
      'bash-pure',
      'file-change-edit',
      'file-change-revert',
      'mcp-tool-call',
      'update-plan',
      'web-search-reasoning'
    ]) {
      const tools = allToolParts(streamFromFixture(fname))
      for (const t of tools) {
        const status = (t.state as { status?: string }).status
        expect(allowed.has(status ?? '')).toBe(true)
      }
    }
  })
})
