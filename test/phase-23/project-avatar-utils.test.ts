import { describe, expect, it } from 'vitest'
import {
  PROJECT_AVATAR_COLOR_CLASSES,
  getProjectAvatarColorClass,
  getProjectAvatarInitials
} from '../../src/renderer/src/components/projects/project-avatar-utils'

describe('project-avatar-utils', () => {
  describe('getProjectAvatarInitials', () => {
    it('uses first and last tokens for multi-word latin names', () => {
      expect(getProjectAvatarInitials('internal-starlight-base')).toBe('IB')
      expect(getProjectAvatarInitials('task_bpm_center')).toBe('TC')
      expect(getProjectAvatarInitials('task.bpm/center')).toBe('TC')
    })

    it('uses the first two latin characters for single-word names', () => {
      expect(getProjectAvatarInitials('xuanpu')).toBe('XU')
    })

    it('falls back to visible characters for non-latin names', () => {
      expect(getProjectAvatarInitials('玄圃 工作台')).toBe('玄圃')
    })

    it('returns a placeholder for empty or invalid names', () => {
      expect(getProjectAvatarInitials('')).toBe('?')
      expect(getProjectAvatarInitials(null)).toBe('?')
      expect(getProjectAvatarInitials(undefined)).toBe('?')
    })
  })

  describe('getProjectAvatarColorClass', () => {
    it('returns a stable color for the same project name', () => {
      const color = getProjectAvatarColorClass('xuanpu')
      expect(getProjectAvatarColorClass('xuanpu')).toBe(color)
    })

    it('always returns a color from the curated palette', () => {
      const color = getProjectAvatarColorClass('internal-starlight-base')
      expect(PROJECT_AVATAR_COLOR_CLASSES).toContain(color)
    })

    it('distributes different project names across more than one palette entry', () => {
      const colors = new Set(
        [
          'xuanpu',
          'internal-starlight-base',
          'task_bpm_center',
          'item-center',
          'order-center',
          'workspace-shell'
        ].map((name) => getProjectAvatarColorClass(name))
      )

      expect(colors.size).toBeGreaterThan(1)
    })
  })
})
