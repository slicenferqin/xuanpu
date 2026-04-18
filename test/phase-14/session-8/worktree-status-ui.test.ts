import { describe, expect, test } from 'vitest'

/**
 * Session 8: Worktree Row Structure (New UI) — Tests
 *
 * These tests verify:
 * 1. WorktreeItem uses fixed semantic icons instead of status-driven icons
 * 2. New UI exposes primary and meta rows rather than status text
 * 3. Long labels use middle truncation
 * 4. Selected rows keep the actions trigger visible
 */

describe('Session 8: Worktree Row Structure (New UI)', () => {
  describe('WorktreeItem source verification', () => {
    let source: string

    test('load WorktreeItem source', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )
      expect(source).toBeTruthy()
    })

    test('adds a middle truncation helper for primary labels', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      expect(source).toContain('function truncateMiddle')
      expect(source).toContain('PRIMARY_LABEL_MAX_LENGTH')
      expect(source).toContain('SECONDARY_LABEL_MAX_LENGTH')
      expect(source).toContain('displayNamePreview = truncateMiddle(displayName')
    })

    test('renders primary and metadata rows instead of status text', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      expect(source).toContain('data-testid="worktree-primary-name"')
      expect(source).toContain('data-testid="worktree-meta-type"')
      expect(source).not.toContain('worktree-status-text')
      expect(source).toContain("t('pinned.meta.branch')")
      expect(source).toContain("t('pinned.meta.default')")
    })

    test('uses fixed semantic icons for normal and default worktrees', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      expect(source).toContain('{worktree.is_default ? (')
      expect(source).toContain('<Folder className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />')
      expect(source).toContain(
        '<GitBranch className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />'
      )
      expect(source).not.toContain('AlertCircle')
      expect(source).not.toContain('PulseAnimation')
      expect(source).not.toContain('ModelIcon')
    })

    test('keeps the actions button visible for selected rows and hover', async () => {
      const fs = await import('fs')
      const path = await import('path')
      source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/worktrees/WorktreeItem.tsx'),
        'utf-8'
      )

      expect(source).toContain('group-hover:opacity-100')
      expect(source).toContain("isSelected && 'opacity-100'")
      expect(source).toContain('data-testid={`worktree-actions-${worktree.id}`}')
    })
  })

  describe('truncateMiddle helper behavior', () => {
    function truncateMiddle(value: string, maxLength: number): string {
      if (value.length <= maxLength) return value
      if (maxLength <= 1) return value.slice(0, maxLength)

      const ellipsis = '…'
      const lastSeparatorIndex = Math.max(
        value.lastIndexOf('/'),
        value.lastIndexOf('-'),
        value.lastIndexOf('_')
      )

      if (lastSeparatorIndex > 0 && lastSeparatorIndex < value.length - 1) {
        const suffixToken = value.slice(lastSeparatorIndex + 1)
        const prefixLength = maxLength - ellipsis.length - suffixToken.length

        if (prefixLength >= 4) {
          return `${value.slice(0, prefixLength)}${ellipsis}${suffixToken}`
        }
      }

      const visibleChars = maxLength - ellipsis.length
      let prefixLength = Math.ceil(visibleChars / 2)
      let suffixLength = Math.floor(visibleChars / 2)
      let prefix = value.slice(0, prefixLength)
      let suffix = value.slice(-suffixLength)

      while (/[/_-]$/.test(prefix) && prefixLength > 1) {
        prefixLength -= 1
        prefix = value.slice(0, prefixLength)
      }

      while (/^[/_-]/.test(suffix) && suffixLength > 1) {
        suffixLength -= 1
        suffix = value.slice(-suffixLength)
      }

      return `${prefix}${ellipsis}${suffix}`
    }

    test('keeps short labels unchanged', () => {
      expect(truncateMiddle('feature/auth', 28)).toBe('feature/auth')
    })

    test('truncates long labels from the middle', () => {
      expect(truncateMiddle('fix_20260417_uiux', 13)).toBe('fix_2026…uiux')
    })

    test('preserves both prefix and suffix on long slash-separated labels', () => {
      expect(truncateMiddle('fix/codex-transcript-stabilize', 19)).toBe('fix/codex…stabilize')
    })
  })
})
