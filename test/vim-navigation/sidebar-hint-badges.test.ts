import { describe, it, expect } from 'vitest'
import {
  assignHints,
  buildNormalModeTargets,
  shouldShowHintBadge,
  type HintTarget
} from '@/lib/hint-utils'

describe('sidebar hint badges — normal mode', () => {
  describe('buildNormalModeTargets', () => {
    const projects = [
      { id: 'p1', name: 'Project One' },
      { id: 'p2', name: 'Project Two' },
      { id: 'p3', name: 'Project Three' }
    ]

    it('returns project targets for all projects', () => {
      const expandedProjectIds = new Set(['p1'])
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, expandedProjectIds, worktreesByProject)
      const projectTargets = targets.filter((t) => t.kind === 'project')

      expect(projectTargets).toHaveLength(3)
      expect(projectTargets.map((t) => t.projectId)).toEqual(['p1', 'p2', 'p3'])
    })

    it('includes worktree targets only for expanded projects', () => {
      const expandedProjectIds = new Set(['p1'])
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }, { id: 'w2', project_id: 'p1' }]],
        ['p2', [{ id: 'w3', project_id: 'p2' }]]
      ])

      const targets = buildNormalModeTargets(projects, expandedProjectIds, worktreesByProject)
      const worktreeTargets = targets.filter((t) => t.kind === 'worktree')

      // Only p1 is expanded, so only w1 and w2 should be included
      expect(worktreeTargets).toHaveLength(2)
      expect(worktreeTargets.map((t) => t.worktreeId)).toEqual(['w1', 'w2'])
    })

    it('does NOT include plus targets (only project + worktree)', () => {
      const expandedProjectIds = new Set(['p1'])
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, expandedProjectIds, worktreesByProject)
      const plusTargets = targets.filter((t) => t.kind === 'plus')

      expect(plusTargets).toHaveLength(0)
    })

    it('returns only project targets when no projects are expanded', () => {
      const expandedProjectIds = new Set<string>()
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, expandedProjectIds, worktreesByProject)

      expect(targets.filter((t) => t.kind === 'project')).toHaveLength(3)
      expect(targets.filter((t) => t.kind === 'worktree')).toHaveLength(0)
    })

    it('interleaves project then its worktrees for expanded projects', () => {
      const expandedProjectIds = new Set(['p1', 'p2'])
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]],
        ['p2', [{ id: 'w2', project_id: 'p2' }, { id: 'w3', project_id: 'p2' }]]
      ])

      const targets = buildNormalModeTargets(projects, expandedProjectIds, worktreesByProject)

      // Expected order: p1 project, w1, p2 project, w2, w3, p3 project
      expect(targets.map((t) => t.kind === 'project' ? `project:${t.projectId}` : t.worktreeId)).toEqual([
        'project:p1', 'w1', 'project:p2', 'w2', 'w3', 'project:p3'
      ])
    })

    it('handles empty projects list', () => {
      const targets = buildNormalModeTargets([], new Set(), new Map())
      expect(targets).toHaveLength(0)
    })

    it('handles projects with no worktrees', () => {
      const expandedProjectIds = new Set(['p1'])
      const worktreesByProject = new Map<string, Array<{ id: string; project_id: string }>>()

      const targets = buildNormalModeTargets(projects, expandedProjectIds, worktreesByProject)

      expect(targets.filter((t) => t.kind === 'project')).toHaveLength(3)
      expect(targets.filter((t) => t.kind === 'worktree')).toHaveLength(0)
    })
  })

  describe('normal mode hints exclude S-prefix', () => {
    it('assignHints with excludeFirstChars "S" produces no S-prefixed codes', () => {
      const targets: HintTarget[] = [
        { kind: 'project', projectId: 'p1' },
        { kind: 'worktree', worktreeId: 'w1', projectId: 'p1' }
      ]
      const { hintMap } = assignHints(targets, undefined, 'S')

      for (const code of hintMap.values()) {
        expect(code[0]).not.toBe('S')
      }
    })

    it('normal mode targets assigned with S-exclusion still produce valid two-char codes', () => {
      const projects = [{ id: 'p1', name: 'P1' }]
      const expandedProjectIds = new Set(['p1'])
      const worktreesByProject = new Map([
        ['p1', [{ id: 'w1', project_id: 'p1' }]]
      ])

      const targets = buildNormalModeTargets(projects, expandedProjectIds, worktreesByProject)
      const { hintMap } = assignHints(targets, undefined, 'S')

      expect(hintMap.size).toBe(2) // project + worktree
      for (const code of hintMap.values()) {
        expect(code).toMatch(/^[A-RT-Z][a-z0-9]$/) // no S prefix
      }
    })
  })

  describe('shouldShowHintBadge', () => {
    it('returns true when inputFocused is true (filter mode)', () => {
      expect(shouldShowHintBadge('Aa', true, 'insert')).toBe(true)
    })

    it('returns true when vimMode is normal (vim mode)', () => {
      expect(shouldShowHintBadge('Aa', false, 'normal')).toBe(true)
    })

    it('returns false when no hint code', () => {
      expect(shouldShowHintBadge(undefined, true, 'normal')).toBe(false)
    })

    it('returns false when hint exists but neither inputFocused nor normal mode', () => {
      expect(shouldShowHintBadge('Aa', false, 'insert')).toBe(false)
    })

    it('returns true when both inputFocused and normal mode', () => {
      expect(shouldShowHintBadge('Aa', true, 'normal')).toBe(true)
    })

    it('returns false for empty string hint code', () => {
      expect(shouldShowHintBadge('', false, 'normal')).toBe(false)
    })
  })
})
