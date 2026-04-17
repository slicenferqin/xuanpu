import { describe, test, expect } from 'vitest'

describe('SessionShell plan implement flow (source verification)', () => {
  test('new UI approves pending plans before implementation and switches to build mode', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/components/session-hq/SessionShell.tsx'
      ),
      'utf-8'
    )

    expect(source).toContain('window.agentOps.planApprove(')
    expect(source).toContain("setSessionMode(sessionId, 'build')")
    expect(source).toContain("lastSendMode.set(sessionId, 'build')")
    expect(source).toContain("removeInterrupt(sessionId, pendingBeforeAction.requestId)")
    expect(source).toContain("transitionToolStatus(pendingBeforeAction.toolUseID, 'success')")
  })

  test('new UI uses plan content as implementation prompt for non-Claude runtimes', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/components/session-hq/SessionShell.tsx'
      ),
      'utf-8'
    )

    expect(source).toContain('buildPlanImplementationPrompt(pendingBeforeAction.planContent)')
    expect(source).toContain("const implementPrompt = isClaudeCode")
    expect(source).toContain("sessionRecord?.agent_sdk === 'codex'")
    expect(source).toContain("'Implement the plan.'")
  })
})
