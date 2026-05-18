import { describe, test, expect, vi, beforeEach } from 'vitest'

// Mock electron's app module so importing git-service doesn't crash in jsdom
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/mock-home')
  }
}))

// Mock fs so readdirSync can be controlled per-test
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn()
  }
})

// Mock simple-git — we will configure per-test
const mockRaw = vi.fn()
const mockBranch = vi.fn()
vi.mock('simple-git', () => ({
  default: vi.fn().mockReturnValue({
    branch: mockBranch,
    raw: mockRaw
  })
}))

describe('Worktree breed-name collision retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('createWorktree retries when git reports "already exists"', async () => {
    // Import after mocks are set up
    const { GitService } = await import('../../../src/main/services/git-service')

    // getAllBranches() returns [] (simulating silent failure / empty state)
    mockBranch.mockResolvedValue({ all: [], current: 'main' })

    // First git worktree add call fails with "already exists",
    // second call succeeds
    mockRaw
      .mockImplementationOnce(async (_args: string[]) => {
        // getCurrentBranch raw call — not used directly (branch() is)
        return ''
      })
      .mockRejectedValueOnce(new Error("fatal: 'labrador' already exists"))
      .mockResolvedValueOnce('')

    const service = new GitService('/tmp/mock-repo')

    // Spy on getAllBranches and listWorktrees to track call counts
    const getAllBranchesSpy = vi.spyOn(service, 'getAllBranches').mockResolvedValue([])
    const listWorktreesSpy = vi.spyOn(service, 'listWorktrees').mockResolvedValue([])
    const getCurrentBranchSpy = vi.spyOn(service, 'getCurrentBranch').mockResolvedValue('main')

    // Capture args to the underlying git.raw for worktree add calls
    const rawCalls: string[][] = []
    const gitInstance = (service as unknown as { git: { raw: typeof mockRaw } }).git
    gitInstance.raw = vi.fn().mockImplementation(async (args: string[]) => {
      rawCalls.push(args)
      if (args[0] === 'worktree' && args[1] === 'add') {
        if (rawCalls.filter((c) => c[0] === 'worktree').length === 1) {
          throw new Error("fatal: 'somename' already exists")
        }
      }
      return ''
    })

    const result = await service.createWorktree('my-project', 'dogs')

    expect(result.success).toBe(true)
    expect(result.branchName).toBeTruthy()
    expect(result.path).toBeTruthy()

    // getAllBranches should have been called at least twice (once per attempt)
    expect(getAllBranchesSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(listWorktreesSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

    // getCurrentBranch should only be called once (outside the loop)
    expect(getCurrentBranchSpy.mock.calls.length).toBe(1)
  })

  test('createWorktree returns failure after 3 collisions', async () => {
    const { GitService } = await import('../../../src/main/services/git-service')

    const service = new GitService('/tmp/mock-repo')

    vi.spyOn(service, 'getAllBranches').mockResolvedValue([])
    vi.spyOn(service, 'listWorktrees').mockResolvedValue([])
    vi.spyOn(service, 'getCurrentBranch').mockResolvedValue('main')

    const gitInstance = (service as unknown as { git: { raw: typeof mockRaw } }).git
    gitInstance.raw = vi.fn().mockRejectedValue(new Error("fatal: 'somename' already exists"))

    const result = await service.createWorktree('my-project', 'dogs')

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  test('createWorktree does not retry on non-collision errors', async () => {
    const { GitService } = await import('../../../src/main/services/git-service')

    const service = new GitService('/tmp/mock-repo')

    const getAllBranchesSpy = vi.spyOn(service, 'getAllBranches').mockResolvedValue([])
    vi.spyOn(service, 'listWorktrees').mockResolvedValue([])
    vi.spyOn(service, 'getCurrentBranch').mockResolvedValue('main')

    const gitInstance = (service as unknown as { git: { raw: typeof mockRaw } }).git
    gitInstance.raw = vi.fn().mockRejectedValue(new Error('fatal: not a git repository'))

    const result = await service.createWorktree('my-project', 'dogs')

    expect(result.success).toBe(false)
    // getAllBranches should only be called once — no retry on non-collision errors
    expect(getAllBranchesSpy.mock.calls.length).toBe(1)
  })

  test('createWorktree succeeds on first attempt with no collision', async () => {
    const { GitService } = await import('../../../src/main/services/git-service')

    const service = new GitService('/tmp/mock-repo')

    const getAllBranchesSpy = vi.spyOn(service, 'getAllBranches').mockResolvedValue(['main'])
    vi.spyOn(service, 'listWorktrees').mockResolvedValue([])
    vi.spyOn(service, 'getCurrentBranch').mockResolvedValue('main')

    const gitInstance = (service as unknown as { git: { raw: typeof mockRaw } }).git
    gitInstance.raw = vi.fn().mockResolvedValue('')

    const result = await service.createWorktree('my-project', 'dogs')

    expect(result.success).toBe(true)
    expect(getAllBranchesSpy.mock.calls.length).toBe(1)
  })

  test('git-service.ts createWorktree contains retry loop logic', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const content = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'main', 'services', 'git-service.ts'),
      'utf-8'
    )
    expect(content).toContain('MAX_ATTEMPTS')
    expect(content).toContain('already exists')
    expect(content).toContain('readdirSync')
    expect(content).toContain('createWorktree: name collision on attempt')
    expect(content).toContain('duplicateWorktree: name collision on attempt')
    expect(content).toContain('createWorktreeFromBranch: name collision on attempt')
  })
})
