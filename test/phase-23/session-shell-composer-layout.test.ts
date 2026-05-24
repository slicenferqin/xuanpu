import { describe, expect, test } from 'vitest'

describe('SessionShell composer layout source guard', () => {
  test('docks the composer in normal layout instead of overlapping the timeline', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const composerSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/ComposerBar.tsx'),
      'utf-8'
    )

    expect(shellSource).toContain('data-testid="session-composer-dock"')
    expect(shellSource).toContain('grid-rows-[minmax(0,1fr)_auto_auto]')
    expect(shellSource).toContain('flex h-full min-h-0 flex-col overflow-hidden')
    expect(shellSource).not.toContain('data-testid="session-composer-boundary"')
    expect(composerSource).toContain("'relative z-20'")
    expect(composerSource).not.toContain("'absolute bottom-6 z-20'")
  })

  test('constrains the timeline to a single scroll row above the composer', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const timelineSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/AgentTimeline.tsx'),
      'utf-8'
    )

    expect(timelineSource).toContain('data-testid="hq-agent-timeline-scroll"')
    expect(timelineSource).toContain('className="min-h-0 overflow-y-auto"')
  })
})
