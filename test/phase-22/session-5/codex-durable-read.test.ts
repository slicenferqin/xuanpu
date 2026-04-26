/**
 * Tests for the durable timeline reader's codex shape handling.
 *
 * The bug being prevented: when a codex tool finishes, its activity is
 * persisted with the raw codex item shape (item.type === 'commandExecution'
 * with item.command, item.commandActions, item.aggregatedOutput, etc.).
 * The renderer must classify this into the canonical ToolPart shape so the
 * card matches the streaming overlay (Read / Bash / Edit / etc.) instead of
 * falling through to the FallbackToolView with a name like "commandExecution".
 */
import { describe, it, expect } from 'vitest'
import {
  parseToolPartFromActivity,
  type DbSessionActivity
} from '../../../src/shared/lib/timeline-mappers'

function activity(over: Partial<DbSessionActivity>): DbSessionActivity {
  return {
    id: 'a-1',
    session_id: 's-1',
    agent_session_id: 'thr-1',
    thread_id: 'thr-1',
    turn_id: 't-1',
    item_id: 'item-1',
    request_id: null,
    kind: 'tool.completed',
    tone: 'tool',
    summary: 'commandExecution',
    payload_json: '',
    created_at: new Date().toISOString(),
    ...over
  } as DbSessionActivity
}

describe('timeline-mappers › codex durable read path', () => {
  it('classifies a single read action commandExecution as Read', () => {
    const a = activity({
      payload_json: JSON.stringify({
        item: {
          type: 'commandExecution',
          id: 'item-1',
          command: 'cat README.md',
          commandActions: [
            { type: 'read', name: 'README.md', path: '/abs/README.md' }
          ],
          status: 'completed',
          aggregatedOutput: '# Title\nbody\n',
          exitCode: 0
        }
      })
    })
    const part = parseToolPartFromActivity(a)
    expect(part).not.toBeNull()
    expect(part!.type).toBe('tool_use')
    expect(part!.toolUse?.name).toBe('Read')
    expect(part!.toolUse?.input).toEqual({
      file_path: '/abs/README.md',
      displayName: 'README.md'
    })
    expect(part!.toolUse?.status).toBe('success')
    expect(part!.toolUse?.output).toContain('# Title')
  })

  it('classifies a single search action commandExecution as Grep', () => {
    const a = activity({
      payload_json: JSON.stringify({
        item: {
          type: 'commandExecution',
          id: 'item-1',
          command: 'rg foo src/',
          commandActions: [{ type: 'search', query: 'foo', path: 'src/' }],
          status: 'completed',
          aggregatedOutput: 'match-1\nmatch-2\n'
        }
      })
    })
    const part = parseToolPartFromActivity(a)
    expect(part!.toolUse?.name).toBe('Grep')
    expect(part!.toolUse?.input).toEqual({ pattern: 'foo', path: 'src/' })
  })

  it('keeps multi-action commandExecution as Bash', () => {
    const a = activity({
      payload_json: JSON.stringify({
        item: {
          type: 'commandExecution',
          id: 'item-1',
          command: 'rg pat && cat f',
          commandActions: [
            { type: 'search', query: 'pat' },
            { type: 'read', path: 'f' }
          ],
          status: 'completed',
          aggregatedOutput: 'output\n'
        }
      })
    })
    const part = parseToolPartFromActivity(a)
    expect(part!.toolUse?.name).toBe('Bash')
    expect(part!.toolUse?.input?.command).toBe('rg pat && cat f')
  })

  it('classifies fileChange as Edit with diff', () => {
    const a = activity({
      payload_json: JSON.stringify({
        item: {
          type: 'fileChange',
          id: 'item-1',
          changes: [
            {
              path: '/p/README.md',
              kind: { type: 'update' },
              diff: '@@ -1 +1 @@\n-old\n+new\n'
            }
          ],
          status: 'completed'
        }
      })
    })
    const part = parseToolPartFromActivity(a)
    expect(part!.toolUse?.name).toBe('Edit')
    const input = part!.toolUse?.input as Record<string, unknown>
    expect(input.file_path).toBe('/p/README.md')
    expect(input.diff).toContain('+new')
    expect(Array.isArray(input.changes)).toBe(true)
  })

  it('classifies mcpToolCall as McpTool with raw codex shape', () => {
    const a = activity({
      payload_json: JSON.stringify({
        item: {
          type: 'mcpToolCall',
          id: 'item-1',
          server: 'codex',
          tool: 'list_resources',
          arguments: { foo: 'bar' },
          result: { content: [{ type: 'text', text: 'ok' }] },
          status: 'completed'
        }
      })
    })
    const part = parseToolPartFromActivity(a)
    expect(part!.toolUse?.name).toBe('McpTool')
    const input = part!.toolUse?.input as Record<string, unknown>
    expect(input.arguments).toEqual({ foo: 'bar' })
  })

  it('falls back to claude-code shape when item.type is not a codex item', () => {
    const a = activity({
      kind: 'tool.completed',
      payload_json: JSON.stringify({
        item: {
          type: 'tool_use',
          toolName: 'Bash',
          name: 'Bash',
          input: { command: 'ls' },
          output: 'file-a\n'
        }
      })
    })
    const part = parseToolPartFromActivity(a)
    expect(part!.toolUse?.name).toBe('Bash')
    expect(part!.toolUse?.input).toEqual({ command: 'ls' })
  })

  it('marks tool.failed activity as error status', () => {
    const a = activity({
      kind: 'tool.failed',
      payload_json: JSON.stringify({
        item: {
          type: 'commandExecution',
          id: 'item-1',
          command: 'fail',
          commandActions: [],
          status: 'failed',
          aggregatedOutput: 'permission denied'
        }
      })
    })
    const part = parseToolPartFromActivity(a)
    expect(part!.toolUse?.status).toBe('error')
    expect(part!.toolUse?.error).toContain('permission denied')
  })
})
