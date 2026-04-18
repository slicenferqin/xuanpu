import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rawMock, realpathSyncMock } = vi.hoisted(() => ({
  rawMock: vi.fn(),
  realpathSyncMock: vi.fn((worktreePath: string) =>
    worktreePath === '/repo' ? '/private/repo' : worktreePath
  )
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    realpathSync: realpathSyncMock
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    raw: rawMock
  }))
}))

import { GitService } from '../../../src/main/services/git-service'

describe('GitService branch diff merge-base semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    realpathSyncMock.mockImplementation((worktreePath: string) =>
      worktreePath === '/repo' ? '/private/repo' : worktreePath
    )
  })

  it('diffs branch file lists against merge-base', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        return 'abc123\n'
      }

      if (args[0] === 'diff' && args[1] === '--name-status') {
        return 'M\tsrc/app.ts\nA\tREADME.md\n'
      }

      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    const service = new GitService('/repo')

    await expect(service.getBranchDiffFiles('feature')).resolves.toEqual({
      success: true,
      files: [
        { relativePath: 'src/app.ts', status: 'M' },
        { relativePath: 'README.md', status: 'A' }
      ]
    })

    expect(rawMock).toHaveBeenNthCalledWith(1, ['merge-base', 'HEAD', 'feature'])
    expect(rawMock).toHaveBeenNthCalledWith(2, ['diff', '--name-status', '--no-renames', 'abc123'])
  })

  it('diffs a single file against merge-base', async () => {
    rawMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        return 'base456\n'
      }

      if (args[0] === 'diff') {
        return '@@ -1 +1 @@\n-old\n+new\n'
      }

      throw new Error(`Unexpected git args: ${args.join(' ')}`)
    })

    const service = new GitService('/repo')

    await expect(service.getBranchFileDiff('feature', 'src/app.ts')).resolves.toEqual({
      success: true,
      diff: '@@ -1 +1 @@\n-old\n+new\n'
    })

    expect(rawMock).toHaveBeenNthCalledWith(1, ['merge-base', 'HEAD', 'feature'])
    expect(rawMock).toHaveBeenNthCalledWith(2, ['diff', 'base456', '--', 'src/app.ts'])
  })

  it('uses merge-base refs when loading base content for compare views', async () => {
    rawMock.mockResolvedValue('base789\n')

    const service = new GitService('/repo')
    const getRefContent = vi
      .spyOn(service, 'getRefContent')
      .mockResolvedValue({ success: true, content: 'base content' })

    await expect(service.getBranchBaseContent('feature', 'src/app.ts')).resolves.toEqual({
      success: true,
      content: 'base content'
    })

    expect(getRefContent).toHaveBeenCalledWith('base789', 'src/app.ts')
  })

  it('falls back to the branch tip when merge-base lookup fails', async () => {
    rawMock.mockRejectedValueOnce(new Error('merge-base failed'))

    const service = new GitService('/repo')
    const getRefContent = vi
      .spyOn(service, 'getRefContent')
      .mockResolvedValue({ success: true, content: 'branch tip content' })

    await expect(service.getBranchBaseContent('origin/main', 'src/app.ts')).resolves.toEqual({
      success: true,
      content: 'branch tip content'
    })

    expect(getRefContent).toHaveBeenCalledWith('origin/main', 'src/app.ts')
  })
})
