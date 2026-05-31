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

    // Overlay model: composer is absolute bottom overlay, not a grid row
    expect(shellSource).toContain('data-testid="session-composer-dock"')
    expect(shellSource).toContain('data-testid="session-bottom-overlay"')
    expect(shellSource).toContain('pointer-events-none absolute inset-x-0 bottom-0 z-20')
    expect(shellSource).toContain('relative h-full min-h-0 overflow-hidden')
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
      'className="relative h-full min-h-0 overflow-y-auto overscroll-contain"'
    )
    // The clear-screen spacer renders with the height supplied by the scroll controller.
    expect(timelineSource).toContain('data-testid="timeline-clear-screen-spacer"')
    expect(timelineSource).toContain('clearScreenSpacerHeight')
  })

  test('keeps clear-screen spacer geometry in the scroll controller', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const timelineSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/AgentTimeline.tsx'),
      'utf-8'
    )
    const controllerSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/hooks/useTimelineScrollController.ts'),
      'utf-8'
    )

    expect(shellSource).toContain(
      'clearScreenSpacerHeight={timelineScroll.focusFillerHeight}'
    )
    expect(shellSource).toContain('timelineContentRef={timelineScroll.timelineContentRef}')
    expect(timelineSource).toContain('clearScreenSpacerHeight')
    expect(timelineSource).toContain('timelineContentRef')
    expect(timelineSource).not.toContain('contentHeightRef')
    expect(timelineSource).not.toContain('getClearScreenBottomInset')
    expect(timelineSource).not.toContain('CLEAR_SCREEN_SPACER_SELECTOR')
    expect(controllerSource).toContain('CLEAR_SCREEN_SPACER_SELECTOR')
    expect(controllerSource).toContain('timelineContentRef')
  })
})
