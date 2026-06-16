import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContextBudgetManager } from '../../src/main/services/xuanpu-agent/context/budget-manager'
import {
  computeImageSha256FromBase64,
  MediaOffloadStore
} from '../../src/main/services/xuanpu-agent/media-offloader'

describe('xuanpu-agent media offload', () => {
  it('stores image bytes under a stable sha256 path', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'xuanpu-agent-media-'))
    try {
      const store = new MediaOffloadStore({ rootDir })
      const data = Buffer.from('image-bytes').toString('base64')

      const first = await store.writeImage({
        data,
        mimeType: 'image/png',
        filename: 'screen.png'
      })
      const second = await store.writeImage({
        data,
        mimeType: 'image/png',
        filename: 'screen.png'
      })

      expect(first.path).toBe(join(rootDir, `${first.sha256}.png`))
      expect(second.path).toBe(first.path)
      expect(first.mediaRef).toBe(`image-sha256:${first.sha256}`)
      expect(first.bytes).toBe(Buffer.byteLength('image-bytes'))
      expect(readFileSync(first.path, 'utf8')).toBe('image-bytes')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('keeps an image block once, then rewrites it to ImageObservationRef', async () => {
    const manager = new ContextBudgetManager({ maxTokens: 100_000 })
    const data = Buffer.from('image-bytes').toString('base64')
    const sha256 = computeImageSha256FromBase64(data)
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect this screenshot' },
          { type: 'image', data, mimeType: 'image/png' }
        ],
        timestamp: 1
      }
    ]

    const first = (await manager.transformContext(messages as never, undefined as never)) as Array<{
      content: Array<Record<string, unknown>>
    }>
    const second = (await manager.transformContext(
      messages as never,
      undefined as never
    )) as Array<{
      content: Array<Record<string, unknown>>
    }>

    expect(first[0].content.some((part) => part.type === 'image')).toBe(true)
    expect(second[0].content.some((part) => part.type === 'image')).toBe(false)

    const secondText = second[0].content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
    expect(secondText).toContain('<ImageObservationRef')
    expect(secondText).toContain(`sha256: ${sha256}`)
    expect(secondText).toContain('path:')
    expect(secondText).not.toContain(data)
    expect(manager.state.imageBlocksSeen).toBe(1)
    expect(manager.state.imageBlocksOmitted).toBe(1)
    expect(manager.state.imageBytesOmitted).toBe(Buffer.byteLength('image-bytes'))
  })
})
