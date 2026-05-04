/**
 * Tests for ContextOffloadStore (Token Saver stage 2a).
 *
 * Uses an OS temp directory rooted at the suite scope so we never touch the
 * user's real ~/.xuanpu/archive. Each test gets a fresh subdirectory.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextOffloadStore } from '../../src/main/services/token-saver/offload-store'

let testRoot: string

beforeEach(async () => {
  testRoot = await fs.mkdtemp(join(tmpdir(), 'xuanpu-offload-store-'))
})

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {})
})

describe('ContextOffloadStore', () => {
  it('writes a body to <root>/<sessionId>/<ts>-<seq>.txt', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    const rec = await store.write({
      sessionId: 'sess-1',
      body: 'hello world'
    })
    expect(rec.path.startsWith(join(testRoot, 'sess-1') + '/')).toBe(true)
    expect(rec.path.endsWith('.txt')).toBe(true)
    expect(rec.bytes).toBe(11)
    expect(rec.seq).toBe(1)
    const back = await store.read(rec.path)
    expect(back).toBe('hello world')
  })

  it('increments seq monotonically per session', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    const a = await store.write({ sessionId: 's', body: 'a' })
    const b = await store.write({ sessionId: 's', body: 'b' })
    const c = await store.write({ sessionId: 's', body: 'c' })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(a.path).not.toBe(b.path)
  })

  it('keeps separate seq counters per session', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    const a1 = await store.write({ sessionId: 's1', body: 'a' })
    const b1 = await store.write({ sessionId: 's2', body: 'b' })
    const a2 = await store.write({ sessionId: 's1', body: 'a2' })
    expect(a1.seq).toBe(1)
    expect(b1.seq).toBe(1)
    expect(a2.seq).toBe(2)
  })

  it('respects custom file extension', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    const rec = await store.write({
      sessionId: 's',
      body: '{"a":1}',
      ext: 'json'
    })
    expect(rec.path.endsWith('.json')).toBe(true)
  })

  it('strips a leading dot from custom ext', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    const rec = await store.write({
      sessionId: 's',
      body: 'x',
      ext: '.log'
    })
    expect(rec.path.endsWith('.log')).toBe(true)
    expect(rec.path).not.toContain('..log')
  })

  it('sanitises filesystem-unsafe characters in sessionId', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    const rec = await store.write({
      sessionId: '../../etc/passwd',
      body: 'oops'
    })
    expect(rec.path).not.toContain('../../etc')
    // Should land somewhere inside testRoot
    expect(rec.path.startsWith(testRoot + '/')).toBe(true)
  })

  it('rejects empty sessionId', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    await expect(
      store.write({ sessionId: '', body: 'x' })
    ).rejects.toThrow(/sessionId/)
  })

  it('rejects non-string body', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    await expect(
      // @ts-expect-error intentional bad input
      store.write({ sessionId: 's', body: 123 })
    ).rejects.toThrow(/body/)
  })

  it('handles multi-byte UTF-8 correctly', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    const body = '字段内存压缩测试 🚀'
    const rec = await store.write({ sessionId: 's', body })
    expect(rec.bytes).toBe(Buffer.byteLength(body, 'utf8'))
    const back = await store.read(rec.path)
    expect(back).toBe(body)
  })

  it('totalSizeBytes sums all archives', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    expect(await store.totalSizeBytes()).toBe(0)
    await store.write({ sessionId: 's', body: 'x'.repeat(100) })
    await store.write({ sessionId: 's', body: 'y'.repeat(50) })
    const total = await store.totalSizeBytes()
    expect(total).toBe(150)
  })

  it('totalSizeBytes returns 0 when root does not exist', async () => {
    const store = new ContextOffloadStore({
      rootDir: join(testRoot, 'never-created')
    })
    expect(await store.totalSizeBytes()).toBe(0)
  })

  it('clearAll removes all archives and reports count', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    await store.write({ sessionId: 'a', body: '1' })
    await store.write({ sessionId: 'a', body: '2' })
    await store.write({ sessionId: 'b', body: '3' })
    const removed = await store.clearAll()
    expect(removed).toBe(3)
    expect(await store.totalSizeBytes()).toBe(0)
  })

  it('clearAll on empty/missing root is a safe no-op', async () => {
    const store = new ContextOffloadStore({
      rootDir: join(testRoot, 'never-created')
    })
    expect(await store.clearAll()).toBe(0)
  })

  it('does not leave .tmp files on success', async () => {
    const store = new ContextOffloadStore({ rootDir: testRoot })
    await store.write({ sessionId: 's', body: 'x' })
    const dir = join(testRoot, 's')
    const entries = await fs.readdir(dir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})
