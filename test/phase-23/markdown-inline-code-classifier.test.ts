import { classifyInlineCode } from '../../src/renderer/src/components/session-hq/readable/markdown-inline-code-classifier'

describe('classifyInlineCode', () => {
  describe('symbol', () => {
    it('classifies function calls as symbol', () => {
      expect(classifyInlineCode('resolveUsageTokenTotals()')).toBe('symbol')
      expect(classifyInlineCode('foo.bar()')).toBe('symbol')
    })

    it('classifies PascalCase class names as symbol', () => {
      expect(classifyInlineCode('TextCard')).toBe('symbol')
      expect(classifyInlineCode('ReadableMarkdownRenderer')).toBe('symbol')
    })

    it('classifies built-in types as symbol', () => {
      expect(classifyInlineCode('Promise')).toBe('symbol')
      expect(classifyInlineCode('string')).toBe('symbol')
      expect(classifyInlineCode('boolean')).toBe('symbol')
      expect(classifyInlineCode('null')).toBe('symbol')
      expect(classifyInlineCode('undefined')).toBe('symbol')
    })

    it('classifies member access as symbol', () => {
      expect(classifyInlineCode('session.id')).toBe('symbol')
      expect(classifyInlineCode('state.getSession')).toBe('symbol')
    })
  })

  describe('command', () => {
    it('classifies shell commands as command', () => {
      expect(classifyInlineCode('pnpm dev')).toBe('command')
      expect(classifyInlineCode('git status')).toBe('command')
      expect(classifyInlineCode('npm install')).toBe('command')
      expect(classifyInlineCode('rg -n "foo"')).toBe('command')
    })

    it('classifies flags as command', () => {
      expect(classifyInlineCode('--verbose')).toBe('command')
      expect(classifyInlineCode('-o')).toBe('command')
    })

    it('classifies env assignments as command', () => {
      expect(classifyInlineCode('NODE_ENV=production')).toBe('command')
    })
  })

  describe('path', () => {
    it('classifies file paths as path', () => {
      expect(classifyInlineCode('src/renderer/foo.tsx')).toBe('path')
      expect(classifyInlineCode('docs/plans/2026-05-29.md')).toBe('path')
      expect(classifyInlineCode('~/.codex/sessions')).toBe('path')
      expect(classifyInlineCode('./relative/path.ts')).toBe('path')
    })

    it('classifies file extensions as path', () => {
      expect(classifyInlineCode('package.json')).toBe('path')
      expect(classifyInlineCode('globals.css')).toBe('path')
    })
  })

  describe('id', () => {
    it('classifies UUIDs as id', () => {
      expect(classifyInlineCode('019e5e95-a17e-7a21-8d3e-e89585dc62fe')).toBe('id')
    })

    it('classifies hex hashes as id', () => {
      expect(classifyInlineCode('a1b2c3d4e5f6a7b8')).toBe('id')
      expect(classifyInlineCode('63dc900e8f1b2a4c')).toBe('id')
    })

    it('does not classify short hex as id', () => {
      expect(classifyInlineCode('63dc900')).not.toBe('id')
    })
  })

  describe('metric', () => {
    it('classifies key-value pairs as metric', () => {
      expect(classifyInlineCode('cost: $1.20')).toBe('metric')
      expect(classifyInlineCode('page_count: 128')).toBe('metric')
      expect(classifyInlineCode('total_tokens=9919327')).toBe('metric')
    })
  })

  describe('phrase', () => {
    it('classifies Chinese text as phrase', () => {
      expect(classifyInlineCode('数据质量')).toBe('phrase')
      expect(classifyInlineCode('上下文压力')).toBe('phrase')
    })

    it('classifies long English phrases as phrase', () => {
      expect(classifyInlineCode('the quick brown fox jumps')).toBe('phrase')
    })
  })

  describe('unknown', () => {
    it('falls back to unknown for ambiguous content', () => {
      expect(classifyInlineCode('???')).toBe('unknown')
    })
  })

  describe('edge cases', () => {
    it('returns unknown for empty string', () => {
      expect(classifyInlineCode('')).toBe('unknown')
      expect(classifyInlineCode('   ')).toBe('unknown')
    })

    it('classifies single identifiers as symbol', () => {
      expect(classifyInlineCode('sessionId')).toBe('symbol')
      expect(classifyInlineCode('count')).toBe('symbol')
    })
  })
})
