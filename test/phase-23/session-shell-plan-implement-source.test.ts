import { describe, test, expect } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  const fs = await import('fs')
  const path = await import('path')
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8')
}

async function readSessionShellSource(): Promise<string> {
  return readSource('../../src/renderer/src/components/session-hq/SessionShell.tsx')
}

async function readComposerFlowSource(): Promise<string> {
  const sessionShellSource = await readSessionShellSource()
  const composerActionsSource = await readSource(
    '../../src/renderer/src/hooks/useSessionComposerActions.ts'
  )
  const planActionsSource = await readSource('../../src/renderer/src/hooks/useSessionPlanActions.ts')
  const abortReadinessSource = await readSource(
    '../../src/renderer/src/hooks/useSessionAbortReadiness.ts'
  )
  return `${sessionShellSource}\n${composerActionsSource}\n${planActionsSource}\n${abortReadinessSource}`
}

async function readPendingInitialMessageSource(): Promise<string> {
  const sessionShellSource = await readSessionShellSource()
  const pendingInitialSource = await readSource(
    '../../src/renderer/src/hooks/usePendingInitialMessageSender.ts'
  )
  return `${sessionShellSource}\n${pendingInitialSource}`
}

async function readPendingMessageDrainSource(): Promise<string> {
  const sessionShellSource = await readSessionShellSource()
  const pendingDrainSource = await readSource(
    '../../src/renderer/src/hooks/usePendingMessageDrain.ts'
  )
  return `${sessionShellSource}\n${pendingDrainSource}`
}

async function readPlanActionsSource(): Promise<string> {
  const sessionShellSource = await readSessionShellSource()
  const planActionsSource = await readSource('../../src/renderer/src/hooks/useSessionPlanActions.ts')
  return `${sessionShellSource}\n${planActionsSource}`
}

describe('SessionShell plan implement flow (source verification)', () => {
  test('new UI approves pending plans before implementation and switches to build mode', async () => {
    const source = await readPlanActionsSource()

    expect(source).toContain('useSessionPlanActions({')
    expect(source).toContain('window.agentOps.planApprove(')
    expect(source).toContain("setSessionMode(sessionId, 'build')")
    expect(source).toContain("lastSendMode.set(sessionId, 'build')")
    expect(source).toContain('removeInterrupt(sessionId, pendingBeforeAction.requestId)')
    expect(source).toContain("transitionToolStatus(pendingBeforeAction.toolUseID, 'success')")
  })

  test('new UI uses plan content as implementation prompt for non-Claude runtimes', async () => {
    const source = await readPlanActionsSource()

    expect(source).toContain('buildPlanImplementationPrompt(pendingBeforeAction.planContent)')
    expect(source).toContain('const implementPrompt = isClaudeCode')
    expect(source).toContain("agentSdk === 'codex'")
    expect(source).toContain("'Implement the plan.'")
  })

  test('new UI forwards the resolved session model when sending prompts', async () => {
    const source = await readComposerFlowSource()

    expect(source).toContain('const requestModel = useMemo(() => {')
    expect(source).toContain(
      'window.agentOps.prompt(wp, sid, messageParts ?? c, requestModel, promptOptions)'
    )
    // Plan implement uses implementOptions (forced build mode), not stale promptOptions
    expect(source).toContain('window.agentOps.prompt(wp, sid, c, requestModel, implementOptions)')
  })

  test('new UI auto-sends pending initial messages with launch-specific options', async () => {
    const source = await readPendingInitialMessageSource()

    expect(source).toContain('usePendingInitialMessageSender({')
    expect(source).toContain('dequeuePendingMessageWithOptions(sessionId)')
    expect(source).toContain('buildPendingPromptOptions(pending.options)')
    expect(source).toContain('window.agentOps.prompt(')
    expect(source).toContain('effectivePromptOptions')
    expect(source).toContain('requeuePendingMessage(sessionId, pending.message, pending.options)')
  })

  test('new UI handoff creates a build session and carries goal options', async () => {
    const source = await readPlanActionsSource()

    expect(source).toContain('const handlePlanHandoff = useCallback(async () => {')
    expect(source).toContain(
      'const handoffPrompt = `Implement the following plan\\n${planContent}`'
    )
    expect(source).toContain("sourceAgentSdk === 'codex' || sourceAgentSdk === 'claude-code'")
    expect(source).toContain('goalMode: true')
    expect(source).toContain(
      'sessionStore.setPendingMessage(result.session.id, handoffPrompt, pendingOptions)'
    )
    expect(source).toContain("sessionStore.setSessionMode(result.session.id, 'build')")
  })

  test('composer send success clears transient runtime goal input state', async () => {
    const source = await readComposerFlowSource()

    expect(source).toContain('const shouldClearGoalComposer =')
    expect(source).toContain('supportsSessionGoalMode &&')
    expect(source).toContain("action === 'send' || action === 'stop_and_send'")
    expect(source).toContain('if (shouldClearGoalComposer) {')
    expect(source).toContain('setGoalMode(false)')
    expect(source).toContain("setSuccessCriteria('')")
  })

  test('composer queue and stop-and-send use runtime boundaries, not guessed sleeps', async () => {
    const source = await readComposerFlowSource()

    expect(source).toContain('function waitForSessionIdleAfterAbort')
    expect(source).toContain('queueSessionId: sessionId')
    expect(source).toContain('const waitForAbortReady = useSessionAbortReadiness(sessionId)')
    expect(source).toContain('waitForAbortReady,')
    expect(source).toContain("if (action === 'send' || action === 'stop_and_send') {")
  })

  test('auto-drain uses a per-session drain controller instead of direct concurrent sends', async () => {
    const source = await readPendingMessageDrainSource()

    expect(source).toContain('usePendingMessageDrain({')
    expect(source).toContain('createPendingDrainController')
    expect(source).toContain(
      'const pendingDrainController = useMemo(() => createPendingDrainController(), [])'
    )
    expect(source).toContain('pendingDrainController')
    expect(source).toContain('.drainNextPending(')
    expect(source).toContain('claimNextPendingMessage(sid)')
    expect(source).toContain('restorePendingMessage(sid, message.id)')
    expect(source).toContain('completePendingMessage(sid, message.id)')
  })

  test('SessionShell hydrates durable pending queue before auto-drain can observe it', async () => {
    const source = await readComposerFlowSource()

    expect(source).toContain('hydratePendingMessages(sessionId)')
    expect(source).toContain('runtimeId: agentSdk ?? undefined')
  })

  test('SessionShell drains hydrated pending queue when an idle session is opened', async () => {
    const source = await readPendingMessageDrainSource()

    expect(source).toContain('const drainQueuedMessage = useCallback')
    expect(source).toContain("if (lifecycle !== 'idle' || pendingCount === 0) return")
    expect(source).toContain('void drainQueuedMessage()')
  })

  test('composer prefers Codex active-turn steer without changing Claude queue semantics', async () => {
    const source = await readSessionShellSource()

    expect(source).toContain("const preferSteerWhenBusy = agentSdk === 'codex'")
    expect(source).toContain('preferSteerWhenBusy={preferSteerWhenBusy}')
  })

  test('composer steer keeps the live overlay while send and stop-and-send reset it', async () => {
    const source = await readComposerFlowSource()

    expect(source).toContain("if (action === 'send' || action === 'stop_and_send')")
    expect(source).toContain('resetLiveOverlay(true)')
    expect(source).toContain("action === 'steer'")
    expect(source).toContain("action === 'queue'")
    expect(source).toContain("deliveryStatus: action === 'queue' ? 'queued' : undefined")
    expect(source).toContain('attachmentsToMessageParts(attachments)')
    expect(source).toContain('resetLiveOverlay(false)')
    expect(source).not.toContain(
      "if (action === 'send' || action === 'stop_and_send' || action === 'steer') {\n        resetLiveOverlay"
    )
  })
})
