import { describe, expect, test } from 'vitest'

describe('agent stream ingress source guard', () => {
  test('keeps useAgentEventBridge as the only raw agent stream subscriber', async () => {
    const fs = await import('fs')
    const path = await import('path')

    const rendererRoot = path.resolve(__dirname, '../../src/renderer/src')
    const allowedFile = path.join(rendererRoot, 'hooks/useAgentEventBridge.ts')
    const matches: string[] = []

    const scan = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          scan(fullPath)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue

        const source = fs.readFileSync(fullPath, 'utf-8')
        if (source.includes('agentOps.onStream')) {
          matches.push(path.relative(rendererRoot, fullPath))
        }
      }
    }

    scan(rendererRoot)

    expect(matches).toEqual([path.relative(rendererRoot, allowedFile)])
  })

  test('keeps PR detection behind accepted runtime events', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/hooks/usePRDetection.ts'),
      'utf-8'
    )

    expect(source).not.toContain('agentOps.onStream')
    expect(source).not.toContain('.onStream(')
    expect(source).toContain('subscribeToSessionEvents(sessionId')
  })
})
