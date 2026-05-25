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
    const scrollFabSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/sessions/ScrollToBottomFab.tsx'),
      'utf-8'
    )
    const planFabSource = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/components/sessions/PlanReadyImplementFab.tsx'
      ),
      'utf-8'
    )

    expect(shellSource).toContain('data-testid="session-composer-dock"')
    expect(shellSource).toContain('data-testid="session-transcript-region"')
    expect(shellSource).toContain('data-testid="session-bottom-stack"')
    expect(shellSource).toContain('grid-rows-[minmax(0,1fr)_auto]')
    expect(shellSource).toContain('flex h-full min-h-0 flex-col overflow-hidden')
    expect(shellSource).toContain('row-start-1 row-end-2 min-h-0 overflow-hidden')
    expect(shellSource).toContain('row-start-2 row-end-3 min-h-0 overflow-visible')
    expect(shellSource).not.toContain('data-testid="session-composer-boundary"')
    expect(shellSource).not.toContain('absolute bottom-0 left-0 right-0 z-30')
    expect(composerSource).toContain("'relative z-20'")
    expect(composerSource).not.toContain("'absolute bottom-6 z-20'")
    expect(scrollFabSource).toContain('absolute right-4 z-10')
    expect(planFabSource).toContain('absolute bottom-36 right-4 z-30')
  })

  test('constrains the timeline to a single scroll row above the composer', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const timelineSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/AgentTimeline.tsx'),
      'utf-8'
    )

    expect(timelineSource).toContain('data-testid="hq-agent-timeline-scroll"')
    expect(timelineSource).toContain(
      'className="h-full min-h-0 overflow-y-auto overscroll-contain"'
    )
    expect(timelineSource).toContain('shortContentTopSpacer')
  })
})
