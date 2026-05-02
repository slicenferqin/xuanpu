import { describe, it, expect } from 'vitest'
import { classifyOpenCodeTool } from '../src/shared/lib/opencode-classify'

describe('classifyOpenCodeTool', () => {
  describe('native built-in tools', () => {
    it('classifies bash -> Bash', () => {
      expect(classifyOpenCodeTool('bash')).toEqual({
        tool: 'Bash',
        toolDisplay: 'bash'
      })
    })

    it('classifies read -> Read', () => {
      expect(classifyOpenCodeTool('read')).toEqual({
        tool: 'Read',
        toolDisplay: 'read'
      })
    })

    it('classifies write -> Write', () => {
      expect(classifyOpenCodeTool('write')).toEqual({
        tool: 'Write',
        toolDisplay: 'write'
      })
    })

    it('classifies edit -> Edit', () => {
      expect(classifyOpenCodeTool('edit')).toEqual({
        tool: 'Edit',
        toolDisplay: 'edit'
      })
    })

    it('classifies multiedit -> Edit (treated as Edit variant)', () => {
      expect(classifyOpenCodeTool('multiedit')).toEqual({
        tool: 'Edit',
        toolDisplay: 'multiedit'
      })
    })

    it('classifies grep -> Grep', () => {
      expect(classifyOpenCodeTool('grep')).toEqual({
        tool: 'Grep',
        toolDisplay: 'grep'
      })
    })

    it('classifies glob -> Glob', () => {
      expect(classifyOpenCodeTool('glob')).toEqual({
        tool: 'Glob',
        toolDisplay: 'glob'
      })
    })

    it('classifies list -> Glob (directory listing)', () => {
      expect(classifyOpenCodeTool('list')).toEqual({
        tool: 'Glob',
        toolDisplay: 'list'
      })
    })

    it('classifies webfetch -> WebFetch', () => {
      expect(classifyOpenCodeTool('webfetch')).toEqual({
        tool: 'WebFetch',
        toolDisplay: 'webfetch'
      })
    })

    it('classifies websearch -> WebSearch', () => {
      expect(classifyOpenCodeTool('websearch')).toEqual({
        tool: 'WebSearch',
        toolDisplay: 'websearch'
      })
    })

    it('classifies todowrite -> TodoWrite', () => {
      expect(classifyOpenCodeTool('todowrite')).toEqual({
        tool: 'TodoWrite',
        toolDisplay: 'todowrite'
      })
    })

    it('classifies task -> Task', () => {
      expect(classifyOpenCodeTool('task')).toEqual({
        tool: 'Task',
        toolDisplay: 'task'
      })
    })

    it('classifies question -> AskUserQuestion (Phase 1.4.8)', () => {
      // OpenCode wraps the `question.asked` HITL request in a tool part named
      // `question`. Without this mapping it would fall through to `Unknown`
      // and AgentTimeline would not render AskUserCard, even though the
      // composer correctly switches into reply mode.
      expect(classifyOpenCodeTool('question')).toEqual({
        tool: 'AskUserQuestion',
        toolDisplay: 'question'
      })
    })

    it('classifies askuserquestion / ask_user as AskUserQuestion (Claude/Codex aliases)', () => {
      expect(classifyOpenCodeTool('askuserquestion')).toEqual({
        tool: 'AskUserQuestion',
        toolDisplay: 'askuserquestion'
      })
      expect(classifyOpenCodeTool('ask_user')).toEqual({
        tool: 'AskUserQuestion',
        toolDisplay: 'ask_user'
      })
    })
  })

  describe('case insensitivity', () => {
    it('accepts uppercase canonical names (idempotent)', () => {
      expect(classifyOpenCodeTool('Bash')).toEqual({
        tool: 'Bash',
        toolDisplay: 'Bash'
      })
    })

    it('accepts mixed case (TodoWrite)', () => {
      expect(classifyOpenCodeTool('TodoWrite')).toEqual({
        tool: 'TodoWrite',
        toolDisplay: 'TodoWrite'
      })
    })
  })

  describe('MCP tools', () => {
    it('classifies mcp_ prefixed tool with single underscore separator', () => {
      const result = classifyOpenCodeTool('mcp_figma_get_file')
      expect(result).toEqual({
        tool: 'McpTool',
        toolDisplay: 'mcp_figma_get_file',
        mcpServer: 'figma'
      })
    })

    it('classifies mcp__ double-underscore prefix (claude-code shape)', () => {
      const result = classifyOpenCodeTool('mcp__hive-lsp__lsp')
      expect(result).toEqual({
        tool: 'McpTool',
        toolDisplay: 'mcp__hive-lsp__lsp',
        mcpServer: 'hive-lsp'
      })
    })

    it('classifies tool with double-underscore as MCP even without mcp prefix', () => {
      const result = classifyOpenCodeTool('context7__query-docs')
      expect(result).toEqual({
        tool: 'McpTool',
        toolDisplay: 'context7__query-docs',
        mcpServer: 'context7'
      })
    })

    it('omits mcpServer when MCP detection cannot extract a server segment', () => {
      const result = classifyOpenCodeTool('mcp_')
      expect(result.tool).toBe('McpTool')
      expect(result.toolDisplay).toBe('mcp_')
      expect(result.mcpServer).toBeUndefined()
    })
  })

  describe('edge cases', () => {
    it('returns Unknown for empty string', () => {
      expect(classifyOpenCodeTool('')).toEqual({ tool: 'Unknown' })
    })

    it('returns Unknown for undefined', () => {
      expect(classifyOpenCodeTool(undefined)).toEqual({ tool: 'Unknown' })
    })

    it('returns Unknown for null', () => {
      expect(classifyOpenCodeTool(null)).toEqual({ tool: 'Unknown' })
    })

    it('returns Unknown for non-string input', () => {
      expect(classifyOpenCodeTool(42)).toEqual({ tool: 'Unknown' })
      expect(classifyOpenCodeTool({ tool: 'bash' })).toEqual({ tool: 'Unknown' })
    })

    it('returns Unknown for unrecognized snake_case (not MCP-shaped)', () => {
      // Single underscore without mcp prefix is NOT classified as MCP — those
      // are claude-code-shaped names handled by ToolCard fallback.
      expect(classifyOpenCodeTool('read_file')).toEqual({
        tool: 'Unknown',
        toolDisplay: 'read_file'
      })
    })

    it('returns Unknown for completely unrecognized name with display preserved', () => {
      expect(classifyOpenCodeTool('foobar')).toEqual({
        tool: 'Unknown',
        toolDisplay: 'foobar'
      })
    })
  })
})
