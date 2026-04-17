import { describe, test, expect } from 'vitest'

describe('SessionShell thread status flow (source verification)', () => {
  test('stores running and compaction state in the streaming buffer', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/components/session-hq/SessionShell.tsx'
      ),
      'utf-8'
    )

    expect(source).toContain('runStartedAt')
    expect(source).toContain('compactionState')
    expect(source).toContain('setRunStartedAt((current) => current ?? Date.now())')
    expect(source).toContain("phase: 'running'")
    expect(source).toContain("phase: 'completed'")
  })

  test('passes ephemeral thread status rows into AgentTimeline', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/components/session-hq/SessionShell.tsx'
      ),
      'utf-8'
    )

    expect(source).toContain('const ephemeralStatusRows = useMemo<ThreadStatusRowData[]>')
    expect(source).toContain('ephemeralStatusRows={ephemeralStatusRows}')
    expect(source).toContain('hasDurableCompactionMessage')
  })
})
