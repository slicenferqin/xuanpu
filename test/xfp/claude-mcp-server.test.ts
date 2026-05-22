import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { XfpProvider } from '../../src/main/xfp/types'

const sdkTool = vi.fn((name, description, inputSchema, handler, options) => ({
  name,
  description,
  inputSchema,
  handler,
  options
}))

const createSdkMcpServer = vi.fn((config) => config)

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer,
  tool: sdkTool
}))

vi.mock('../../src/main/xfp/provider', () => ({
  XFP_DEFAULT_RECENT_LIMIT: 10,
  XFP_DEFAULT_RECENT_WINDOW_MS: 300000,
  XFP_DEFAULT_TERMINAL_MAX_CHARS: 4000,
  XFP_TERMINAL_MAX_CHARS: 12000,
  xfpProvider: {
    getCurrentFocus: vi.fn(),
    getLastTerminalActivity: vi.fn(),
    getRecentActivity: vi.fn(),
    getWorktreeSummary: vi.fn(),
    getPinnedFacts: vi.fn()
  }
}))

import { __resetXfpAuditForTest, listXfpAuditEvents } from '../../src/main/xfp/audit'
import {
  XFP_CLAUDE_ALLOWED_TOOLS,
  XFP_CLAUDE_MCP_SERVER_NAME,
  createXfpClaudeMcpServerConfig,
  createXfpClaudeMcpToolHandlers
} from '../../src/main/xfp/claude-mcp-server'

function provider(overrides: Partial<XfpProvider> = {}): XfpProvider {
  return {
    getCurrentFocus: vi.fn(async () => ({
      disabled: false,
      asOf: 1,
      worktree: { id: 'w-1', name: 'akita', branchName: 'feat/xfp', path: '/repo' },
      file: { path: '/repo/src/a.ts', name: 'a.ts' },
      selection: null
    })),
    getLastTerminalActivity: vi.fn(async () => ({
      command: 'pnpm test',
      commandAt: 2,
      exitCode: 1,
      output: { tail: 'failed', truncated: false }
    })),
    getRecentActivity: vi.fn(async () => [
      { timestamp: 3, type: 'agent.file_write', summary: 'edited file' }
    ]),
    getWorktreeSummary: vi.fn(async () => ({
      markdown: 'summary',
      compactedAt: 4,
      source: 'checkpoint',
      warnings: []
    })),
    getPinnedFacts: vi.fn(async () => ({ markdown: 'facts', updatedAt: 5 })),
    ...overrides
  }
}

function parseResult(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text)
}

describe('createXfpClaudeMcpServerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetXfpAuditForTest()
  })

  it('registers only the scoped XFP tools on the xuanpu-field server', async () => {
    const config = await createXfpClaudeMcpServerConfig({
      worktreeId: 'w-1',
      provider: provider()
    })

    expect(createSdkMcpServer).toHaveBeenCalledWith({
      name: XFP_CLAUDE_MCP_SERVER_NAME,
      version: '1.0.0',
      tools: expect.any(Array)
    })
    expect(config.name).toBe(XFP_CLAUDE_MCP_SERVER_NAME)

    const toolNames = config.tools.map((toolConfig: { name: string }) => toolConfig.name)
    expect(toolNames).toEqual([
      'xfp_get_current_focus',
      'xfp_get_last_terminal_activity',
      'xfp_get_recent_activity',
      'xfp_get_worktree_summary',
      'xfp_get_pinned_facts'
    ])
    expect(toolNames).not.toContain('xfp_search_field_events')
    expect(toolNames.some((name: string) => name.includes('full_context'))).toBe(false)
    expect(XFP_CLAUDE_ALLOWED_TOOLS).toEqual([
      'mcp__xuanpu-field__xfp_get_current_focus',
      'mcp__xuanpu-field__xfp_get_last_terminal_activity',
      'mcp__xuanpu-field__xfp_get_recent_activity',
      'mcp__xuanpu-field__xfp_get_worktree_summary',
      'mcp__xuanpu-field__xfp_get_pinned_facts'
    ])
  })

  it('declares explicit input schemas for every tool', async () => {
    const config = await createXfpClaudeMcpServerConfig({
      worktreeId: 'w-1',
      provider: provider()
    })

    for (const toolConfig of config.tools) {
      expect(toolConfig.inputSchema).toBeDefined()
      expect(typeof toolConfig.inputSchema).toBe('object')
      expect(toolConfig.options).toEqual({ annotations: { readOnly: true } })
    }
    expect(Object.keys(config.tools[1].inputSchema)).toEqual(['includeOutput', 'maxChars'])
    expect(Object.keys(config.tools[2].inputSchema)).toEqual(['limit', 'windowMs', 'types'])
  })
})

describe('createXfpClaudeMcpToolHandlers', () => {
  beforeEach(() => {
    __resetXfpAuditForTest()
  })

  it('calls provider methods with scoped worktreeId and sessionId', async () => {
    const xfp = provider()
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: 'w-1',
      sessionId: 's-1',
      provider: xfp
    })

    const result = await handlers.xfp_get_current_focus({})

    expect(xfp.getCurrentFocus).toHaveBeenCalledWith({ worktreeId: 'w-1', sessionId: 's-1' })
    expect(parseResult(result)).toEqual({
      ok: true,
      tool: 'xfp_get_current_focus',
      data: {
        disabled: false,
        asOf: 1,
        worktree: { id: 'w-1', name: 'akita', branchName: 'feat/xfp', path: '/repo' },
        file: { path: '/repo/src/a.ts', name: 'a.ts' },
        selection: null
      }
    })
    expect(listXfpAuditEvents()).toMatchObject([
      {
        worktreeId: 'w-1',
        sessionId: 's-1',
        runtimeId: 'claude-code',
        kind: 'tool',
        toolName: 'xfp_get_current_focus',
        privacy: 'allowed'
      }
    ])
  })

  it('defaults terminal activity to tail output and default maxChars', async () => {
    const xfp = provider()
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: 'w-1',
      provider: xfp
    })

    await handlers.xfp_get_last_terminal_activity({})

    expect(xfp.getLastTerminalActivity).toHaveBeenCalledWith({
      worktreeId: 'w-1',
      includeOutput: 'tail',
      maxChars: 4000
    })
  })

  it('normalizes invalid terminal output mode back to tail', async () => {
    const xfp = provider()
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: 'w-1',
      provider: xfp
    })

    await handlers.xfp_get_last_terminal_activity({
      includeOutput: 'full',
      maxChars: 12_999
    })

    expect(xfp.getLastTerminalActivity).toHaveBeenCalledWith({
      worktreeId: 'w-1',
      includeOutput: 'tail',
      maxChars: 12000
    })
  })

  it('defaults recent activity limit and lookback window', async () => {
    const xfp = provider()
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: 'w-1',
      provider: xfp
    })

    await handlers.xfp_get_recent_activity({})

    expect(xfp.getRecentActivity).toHaveBeenCalledWith({
      worktreeId: 'w-1',
      limit: 10,
      windowMs: 300000
    })
  })

  it('passes recent activity limit, window, and non-empty type filters', async () => {
    const xfp = provider()
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: 'w-1',
      provider: xfp
    })

    await handlers.xfp_get_recent_activity({
      limit: 3.8,
      windowMs: 60000,
      types: ['agent.file_write', '', 42]
    })

    expect(xfp.getRecentActivity).toHaveBeenCalledWith({
      worktreeId: 'w-1',
      limit: 3,
      windowMs: 60000,
      types: ['agent.file_write']
    })
  })

  it('preserves null provider data in structured JSON text', async () => {
    const xfp = provider({
      getWorktreeSummary: vi.fn(async () => null),
      getPinnedFacts: vi.fn(async () => null)
    })
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: 'w-1',
      provider: xfp
    })

    const summary = await handlers.xfp_get_worktree_summary({})
    const facts = await handlers.xfp_get_pinned_facts({})

    expect(parseResult(summary)).toEqual({
      ok: true,
      tool: 'xfp_get_worktree_summary',
      data: null
    })
    expect(parseResult(facts)).toEqual({
      ok: true,
      tool: 'xfp_get_pinned_facts',
      data: null
    })
  })

  it('returns MCP-style error results for provider failures', async () => {
    const warn = vi.fn()
    const xfp = provider({
      getPinnedFacts: vi.fn(async () => {
        throw new Error('snapshot unavailable')
      })
    })
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: 'w-1',
      provider: xfp,
      logger: { warn }
    })

    const result = await handlers.xfp_get_pinned_facts({})

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: 'XFP error in xfp_get_pinned_facts: snapshot unavailable'
        }
      ],
      isError: true
    })
    expect(warn).toHaveBeenCalledWith('xfp mcp tool failed', {
      tool: 'xfp_get_pinned_facts',
      error: 'snapshot unavailable'
    })
    expect(listXfpAuditEvents()).toMatchObject([
      {
        worktreeId: 'w-1',
        runtimeId: 'claude-code',
        kind: 'tool',
        toolName: 'xfp_get_pinned_facts',
        outputSummary: 'snapshot unavailable'
      }
    ])
  })

  it('returns an error instead of calling provider when worktreeId is missing', async () => {
    const xfp = provider()
    const handlers = createXfpClaudeMcpToolHandlers({
      worktreeId: '',
      provider: xfp
    })

    const result = await handlers.xfp_get_current_focus({})

    expect(result).toEqual({
      content: [{ type: 'text', text: 'XFP error: context.worktreeId is required' }],
      isError: true
    })
    expect(xfp.getCurrentFocus).not.toHaveBeenCalled()
  })
})
