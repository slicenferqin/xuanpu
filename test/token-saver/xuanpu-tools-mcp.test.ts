/**
 * Tests for the Token Saver MCP server data path
 * (`runBashWithCompression` + `formatToolResultText`).
 *
 * The MCP transport itself (createXuanpuToolsMcpServerConfig) is NOT exercised
 * here — that requires the SDK to be running. We test the data layer that the
 * tool handler invokes: spawn → archive → pipeline → format.
 *
 * Uses a per-test tmp dir for archives.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import {
  ContextOffloadStore,
  OutputCompressionPipeline,
  type OutputStrategy
} from '../../src/main/services/token-saver'
import {
  formatToolResultText,
  runBashWithCompression
} from '../../src/main/services/token-saver/xuanpu-tools-mcp'

const isPosix = platform() !== 'win32'
const describePosix = isPosix ? describe : describe.skip

let archiveRoot: string
let cwd: string

beforeEach(async () => {
  archiveRoot = await fs.mkdtemp(join(tmpdir(), 'xuanpu-mcp-arch-'))
  cwd = await fs.mkdtemp(join(tmpdir(), 'xuanpu-mcp-cwd-'))
})

afterEach(async () => {
  await fs.rm(archiveRoot, { recursive: true, force: true }).catch(() => {})
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
})

describe('formatToolResultText', () => {
  it('returns body unchanged when no compression fired', () => {
    const text = formatToolResultText(
      { text: 'hello', beforeBytes: 5, afterBytes: 5, ruleHits: [] },
      {
        beforeBytes: 5,
        afterBytes: 5,
        savedBytes: 0,
        ruleHits: [],
        archivePath: null,
        exitCode: 0,
        durationMs: 10,
        timedOut: false,
        aborted: false
      }
    )
    expect(text).toBe('hello')
  })

  it('appends footer with savings + archive path when compression fired', () => {
    const text = formatToolResultText(
      {
        text: '<compressed>',
        beforeBytes: 1000,
        afterBytes: 100,
        ruleHits: [{ name: 'ansi-strip' }, { name: 'failure-focus' }]
      },
      {
        beforeBytes: 1000,
        afterBytes: 100,
        savedBytes: 900,
        ruleHits: [{ name: 'ansi-strip' }, { name: 'failure-focus' }],
        archivePath: '/tmp/arch/123.txt',
        exitCode: 1,
        durationMs: 10,
        timedOut: false,
        aborted: false
      }
    )
    expect(text).toContain('<compressed>')
    expect(text).toContain('[Token Saver]')
    expect(text).toContain('-90%')
    expect(text).toContain('ansi-strip, failure-focus')
    expect(text).toContain('original: /tmp/arch/123.txt')
  })

  it('omits archive line when path is null', () => {
    const text = formatToolResultText(
      { text: 'x', beforeBytes: 100, afterBytes: 50, ruleHits: [{ name: 'ansi-strip' }] },
      {
        beforeBytes: 100,
        afterBytes: 50,
        savedBytes: 50,
        ruleHits: [{ name: 'ansi-strip' }],
        archivePath: null,
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
        aborted: false
      }
    )
    expect(text).not.toContain('original:')
  })
})

describePosix('runBashWithCompression — happy paths', () => {
  it('captures, archives, compresses', async () => {
    const offload = new ContextOffloadStore({ rootDir: archiveRoot })
    const r = await runBashWithCompression(
      { command: 'echo hello' },
      { sessionId: 'sess', defaultCwd: cwd, offloadStore: offload }
    )
    expect(r.runResult.exitCode).toBe(0)
    expect(r.metadata.archivePath).toBeTruthy()
    expect(r.metadata.beforeBytes).toBeGreaterThan(0)
    // Echo output is small enough that no compression strategy fires.
    expect(r.metadata.ruleHits).toHaveLength(0)
    expect(r.text).toBe(r.runResult.combined)
  })

  it('compression footer fires when output is large + has compressible content', async () => {
    const offload = new ContextOffloadStore({ rootDir: archiveRoot })
    // Generate 50 identical lines (>4 same → progress-dedup), each 30 chars.
    const r = await runBashWithCompression(
      {
        command: 'for i in $(seq 50); do echo same-line-content-here-padding; done'
      },
      { sessionId: 'sess', defaultCwd: cwd, offloadStore: offload }
    )
    expect(r.runResult.exitCode).toBe(0)
    expect(r.metadata.ruleHits.length).toBeGreaterThan(0)
    expect(r.text).toContain('[Token Saver]')
    expect(r.text).toContain(r.metadata.archivePath ?? '')
  })

  it('honors abort signal', async () => {
    const offload = new ContextOffloadStore({ rootDir: archiveRoot })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 80)
    const r = await runBashWithCompression(
      { command: 'sleep 5' },
      { sessionId: 'sess', defaultCwd: cwd, offloadStore: offload },
      ac.signal
    )
    expect(r.runResult.aborted).toBe(true)
    expect(r.metadata.aborted).toBe(true)
  })

  it('archives even on non-zero exit', async () => {
    const offload = new ContextOffloadStore({ rootDir: archiveRoot })
    const r = await runBashWithCompression(
      { command: 'echo failing-command; exit 7' },
      { sessionId: 'sess', defaultCwd: cwd, offloadStore: offload }
    )
    expect(r.runResult.exitCode).toBe(7)
    expect(r.metadata.archivePath).toBeTruthy()
    const archived = await offload.read(r.metadata.archivePath as string)
    expect(archived).toContain('failing-command')
  })
})

describe('runBashWithCompression — failure isolation', () => {
  it('returns synthetic result on spawn failure (does not throw)', async () => {
    const offload = new ContextOffloadStore({ rootDir: archiveRoot })
    const r = await runBashWithCompression(
      { command: 'echo ok' },
      // Pointing cwd at a path that does not exist forces spawn to fail.
      {
        sessionId: 'sess',
        defaultCwd: '/this/path/should/not/exist/ever',
        offloadStore: offload
      }
    )
    expect(r.runResult.exitCode).toBe(-1)
    expect(r.runResult.stderr).toContain('failed to spawn')
  })

  it('continues when archive write fails', async () => {
    const failingStore = {
      write: vi.fn().mockRejectedValue(new Error('disk-full'))
    } as unknown as ContextOffloadStore
    const warn = vi.fn()
    const r = await runBashWithCompression(
      { command: 'echo hi' },
      {
        sessionId: 's',
        defaultCwd: cwd,
        offloadStore: failingStore,
        logger: { warn }
      }
    )
    if (isPosix) {
      expect(r.runResult.exitCode).toBe(0)
      expect(r.metadata.archivePath).toBeNull()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('archive write failed'),
        expect.any(Object)
      )
    }
  })

  it('falls back to raw output if pipeline crashes', async () => {
    if (!isPosix) return
    const offload = new ContextOffloadStore({ rootDir: archiveRoot })
    const crashingStrategy: OutputStrategy = {
      name: 'crashy',
      apply: () => {
        throw new Error('pipeline-crash')
      }
    }
    // Pipeline isolates strategy throws — we need the pipeline ITSELF to
    // crash, which only happens via a synthetic .run override.
    const pipeline = new OutputCompressionPipeline([crashingStrategy])
    const originalRun = pipeline.run.bind(pipeline)
    pipeline.run = (() => {
      throw new Error('pipeline-crash')
    }) as typeof pipeline.run
    void originalRun

    const warn = vi.fn()
    const r = await runBashWithCompression(
      { command: 'echo hi' },
      {
        sessionId: 's',
        defaultCwd: cwd,
        offloadStore: offload,
        pipeline,
        logger: { warn }
      }
    )
    expect(r.runResult.exitCode).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pipeline crashed'),
      expect.any(Object)
    )
    expect(r.metadata.ruleHits).toEqual([])
  })
})
