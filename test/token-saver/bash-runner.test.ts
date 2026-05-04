/**
 * Tests for runBashCommand (Token Saver stage 2a).
 *
 * Uses real /bin/sh on the host. The tests stick to commands that are
 * deterministic across darwin/linux + present in any minimal POSIX env.
 *
 * NOTE: this suite only runs on POSIX hosts (darwin/linux). Skip on win32.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { runBashCommand } from '../../src/main/services/token-saver/bash-runner'

const isPosix = platform() !== 'win32'
const describePosix = isPosix ? describe : describe.skip

let cwd: string

beforeEach(async () => {
  cwd = await fs.mkdtemp(join(tmpdir(), 'xuanpu-bash-runner-'))
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
})

describePosix('runBashCommand — happy paths', () => {
  it('captures stdout from echo', async () => {
    const r = await runBashCommand({ command: 'echo hello', cwd })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.stderr).toBe('')
    expect(r.combined).toContain('hello')
  })

  it('captures stderr separately', async () => {
    const r = await runBashCommand({
      command: 'printf err >&2; printf out',
      cwd
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('out')
    expect(r.stderr).toBe('err')
    expect(r.combined).toMatch(/out[\s\S]*--- stderr ---[\s\S]*err/)
  })

  it('exposes non-zero exit code without throwing', async () => {
    const r = await runBashCommand({ command: 'exit 3', cwd })
    expect(r.exitCode).toBe(3)
    expect(r.timedOut).toBe(false)
    expect(r.aborted).toBe(false)
  })

  it('runs in the configured cwd', async () => {
    const r = await runBashCommand({ command: 'pwd', cwd })
    // macOS may resolve /private/var symlink → check suffix instead.
    expect(r.stdout.trim().endsWith(cwd) || r.stdout.trim().endsWith(cwd.replace(/^\/private/, ''))).toBe(true)
  })

  it('honors a custom env', async () => {
    const r = await runBashCommand({
      command: 'echo $TOKEN_SAVER_TEST',
      cwd,
      env: { ...process.env, TOKEN_SAVER_TEST: 'pineapple' }
    })
    expect(r.stdout.trim()).toBe('pineapple')
  })

  it('reports duration', async () => {
    const r = await runBashCommand({
      command: 'sleep 0.1',
      cwd,
      timeoutMs: 5000
    })
    expect(r.durationMs).toBeGreaterThanOrEqual(80)
    expect(r.durationMs).toBeLessThan(2000)
  })
})

describePosix('runBashCommand — timeout', () => {
  it('kills a long-running command after timeoutMs and marks timedOut', async () => {
    const r = await runBashCommand({
      command: 'sleep 5',
      cwd,
      timeoutMs: 200
    })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBe(-1)
    expect(r.durationMs).toBeLessThan(3000)
  })
})

describePosix('runBashCommand — abort', () => {
  it('honors a caller-provided AbortSignal', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = await runBashCommand({
      command: 'sleep 5',
      cwd,
      timeoutMs: 10000,
      signal: ac.signal
    })
    expect(r.aborted).toBe(true)
    expect(r.exitCode).toBe(-1)
    expect(r.durationMs).toBeLessThan(3000)
  })

  it('handles already-aborted signal up-front', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runBashCommand({
      command: 'sleep 5',
      cwd,
      timeoutMs: 10000,
      signal: ac.signal
    })
    expect(r.aborted).toBe(true)
  })
})

describePosix('runBashCommand — buffer cap + tee', () => {
  it('truncates buffered stdout at maxBufferBytes and marks truncated', async () => {
    const r = await runBashCommand({
      // Print 4 KiB of "x" via printf; then we cap at 1 KiB.
      command: 'printf "%4096s" "" | tr " " x',
      cwd,
      maxBufferBytes: 1024
    })
    expect(r.stdout.length).toBe(1024)
    expect(r.truncated.stdout).toBe(true)
    expect(r.combined).toContain('[stdout truncated]')
  })

  it('still streams full output to tee callback', async () => {
    const chunks: string[] = []
    const r = await runBashCommand({
      command: 'printf "%4096s" "" | tr " " x',
      cwd,
      maxBufferBytes: 1024,
      tee: (chunk, stream) => {
        if (stream === 'stdout') chunks.push(chunk.toString('utf8'))
      }
    })
    const teedTotal = chunks.join('').length
    expect(teedTotal).toBeGreaterThanOrEqual(4000)
    expect(r.truncated.stdout).toBe(true)
  })

  it('isolates a throwing tee callback (does not break the runner)', async () => {
    const r = await runBashCommand({
      command: 'echo hi',
      cwd,
      tee: () => {
        throw new Error('boom')
      }
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hi')
  })
})

describePosix('runBashCommand — input validation', () => {
  it('rejects missing command', async () => {
    // @ts-expect-error intentional bad input
    await expect(runBashCommand({ cwd })).rejects.toThrow(/command/)
  })

  it('rejects missing cwd', async () => {
    // @ts-expect-error intentional bad input
    await expect(runBashCommand({ command: 'echo hi' })).rejects.toThrow(/cwd/)
  })
})
