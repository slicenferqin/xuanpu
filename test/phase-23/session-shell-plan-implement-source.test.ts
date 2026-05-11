import { describe, test, expect } from 'vitest'

describe('SessionShell plan implement flow (source verification)', () => {
  test('new UI approves pending plans before implementation and switches to build mode', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )

    expect(source).toContain('window.agentOps.planApprove(')
    expect(source).toContain("setSessionMode(sessionId, 'build')")
    expect(source).toContain("lastSendMode.set(sessionId, 'build')")
    expect(source).toContain('removeInterrupt(sessionId, pendingBeforeAction.requestId)')
    expect(source).toContain("transitionToolStatus(pendingBeforeAction.toolUseID, 'success')")
  })

  test('new UI uses plan content as implementation prompt for non-Claude runtimes', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )

    expect(source).toContain('buildPlanImplementationPrompt(pendingBeforeAction.planContent)')
    expect(source).toContain('const implementPrompt = isClaudeCode')
    expect(source).toContain("sessionRecord?.agent_sdk === 'codex'")
    expect(source).toContain("'Implement the plan.'")
  })

  test('new UI forwards the resolved session model when sending prompts', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )

    expect(source).toContain('const requestModel = useMemo(() => {')
    expect(source).toContain(
      'window.agentOps.prompt(wp, sid, messageParts ?? c, requestModel, promptOptions)'
    )
    expect(source).toContain('window.agentOps.prompt(wp, sid, c, requestModel, promptOptions)')
  })

  test('new UI auto-sends pending initial messages with launch-specific options', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )

    expect(source).toContain('dequeuePendingMessageWithOptions(sessionId)')
    expect(source).toContain('buildPendingPromptOptions(pending.options)')
    expect(source).toContain('window.agentOps.prompt(')
    expect(source).toContain('effectivePromptOptions')
    expect(source).toContain('requeuePendingMessage(sessionId, pending.message, pending.options)')
  })

  test('new UI handoff creates a build session and carries Codex goal options', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )

    expect(source).toContain('const handlePlanHandoff = useCallback(async () => {')
    expect(source).toContain(
      'const handoffPrompt = `Implement the following plan\\n${planContent}`'
    )
    expect(source).toContain("sourceAgentSdk === 'codex' && goalMode")
    expect(source).toContain('goalMode: true')
    expect(source).toContain(
      'sessionStore.setPendingMessage(result.session.id, handoffPrompt, pendingOptions)'
    )
    expect(source).toContain("sessionStore.setSessionMode(result.session.id, 'build')")
  })
})
