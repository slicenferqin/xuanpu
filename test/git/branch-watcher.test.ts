import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

import { isGitHeadPath } from '../../src/main/services/branch-watcher'

describe('branch watcher path filtering', () => {
  it('matches HEAD events from relative and absolute chokidar paths', () => {
    expect(isGitHeadPath('HEAD', '/repo/.git')).toBe(true)
    expect(isGitHeadPath('/repo/.git/HEAD', '/repo/.git')).toBe(true)
    expect(isGitHeadPath('/repo/.git/refs/heads/main', '/repo/.git')).toBe(false)
    expect(isGitHeadPath('/repo/.git/logs/HEAD', '/repo/.git')).toBe(false)
  })

  it('normalizes Windows separators', () => {
    expect(isGitHeadPath('C:\\repo\\.git\\HEAD', 'C:\\repo\\.git')).toBe(true)
  })
})
