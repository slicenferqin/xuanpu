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
    expect(shellSource).not.toContain('data-testid="session-composer-boundary"')
    expect(composerSource).toContain("'relative z-20'")
    expect(composerSource).not.toContain("'absolute bottom-6 z-20'")
  })
})
