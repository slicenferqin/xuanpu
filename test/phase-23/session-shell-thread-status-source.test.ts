import { describe, test, expect } from 'vitest'

describe('SessionShell thread status flow (source verification)', () => {
  test('stores running and compaction state in the streaming buffer', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const runtimeSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/stores/useSessionRuntimeStore.ts'),
      'utf-8'
    )

    expect(shellSource).toContain('runStartedAt')
    expect(shellSource).toContain('compactionState')
    expect(shellSource).toContain('const streamingMirror = useStreamingMirror(sessionId)')
    expect(runtimeSource).toContain('updateStreamingBuffer(')
    expect(runtimeSource).toContain("phase: 'running'")
    expect(runtimeSource).toContain("phase: 'completed'")
  })

  test('passes ephemeral thread status rows into AgentTimeline', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const statusRowsHookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/hooks/useSessionThreadStatusRows.ts'),
      'utf-8'
    )

    expect(shellSource).toContain(
      "import { useSessionThreadStatusRows } from '@/hooks/useSessionThreadStatusRows'"
    )
    expect(shellSource).toContain(
      'const { ephemeralStatusRows, inflightCompactionRow } = useSessionThreadStatusRows({'
    )
    expect(shellSource).toContain('ephemeralStatusRows={ephemeralStatusRows}')
    expect(statusRowsHookSource).toContain(
      'const ephemeralStatusRows = useMemo<ThreadStatusRowData[]>'
    )
    expect(statusRowsHookSource).toContain('hasDurableCompactionMessage')
    expect(statusRowsHookSource).toContain('compactionState: null')
  })

  test('keeps completed overlays readable after idle instead of clearing them in finally', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = [
      '../../src/renderer/src/components/session-hq/SessionShell.tsx',
      '../../src/renderer/src/hooks/useSessionEventSubscription.ts'
    ]
      .map((relativePath) => fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8'))
      .join('\n')

    expect(source).toContain('useSessionEventSubscription({')
    expect(source).toContain('void refresh()')
    expect(source).toContain('.finally(() => {')
    expect(source).toContain('do NOT clearStreamingBufferOverlay here')
    expect(source).toContain('already set isStreaming=false')
    expect(source).toContain('next user message will')
  })

  test('delegates active-session event subscription into a thin hook', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const eventHookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/hooks/useSessionEventSubscription.ts'),
      'utf-8'
    )

    expect(shellSource).toContain(
      "import { useSessionEventSubscription } from '@/hooks/useSessionEventSubscription'"
    )
    expect(shellSource).toContain('useSessionEventSubscription({')
    expect(eventHookSource).toContain('subscribeToSessionEvents(sessionId')
    expect(eventHookSource).toContain('applyCompletedMessageUsage(')
    expect(eventHookSource).toContain('applyMissionTaskToolEvent(toolName, state.input, toolUseId)')
    expect(eventHookSource).toContain('syncMissionTasksFromMessages(msgs)')
    expect(eventHookSource).toContain('void drainQueuedMessage()')
  })

  test('delegates runtime path, connect, reconnect, and steer capability wiring into a thin hook', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const runtimeConnectionSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/hooks/useSessionRuntimeConnection.ts'),
      'utf-8'
    )

    expect(shellSource).toContain(
      "import { useSessionRuntimeConnection } from '@/hooks/useSessionRuntimeConnection'"
    )
    expect(shellSource).toContain('useSessionRuntimeConnection({')
    expect(runtimeConnectionSource).toContain('window.connectionOps')
    expect(runtimeConnectionSource).toContain('.get(connectionId)')
    expect(runtimeConnectionSource).toContain('window.agentOps.reconnect(')
    expect(runtimeConnectionSource).toContain('window.agentOps.connect(')
    expect(runtimeConnectionSource).toContain('setOpenCodeSessionId(sessionId')
    expect(runtimeConnectionSource).toContain('window.db.session.update(sessionId')
    expect(runtimeConnectionSource).toContain('.capabilities(runtimeSessionId)')
  })

  test('delegates plan tool status transitions into a thin hook', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const toolStatusHookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/hooks/useTimelineToolStatusTransition.ts'),
      'utf-8'
    )

    expect(shellSource).toContain(
      "import { useTimelineToolStatusTransition } from '@/hooks/useTimelineToolStatusTransition'"
    )
    expect(shellSource).toContain('const transitionToolStatus = useTimelineToolStatusTransition({')
    expect(toolStatusHookSource).toContain('updateStreamingBuffer(')
    expect(toolStatusHookSource).toContain('timelineMessagesRef.current.map')
    expect(toolStatusHookSource).toContain('setMessages(updatedMessages)')
  })

  test('wires new UI user-message edit and fork flows into AgentTimeline', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/hooks/useSessionUserMessageActions.ts'),
      'utf-8'
    )

    expect(source).toContain(
      "import { useSessionUserMessageActions } from '@/hooks/useSessionUserMessageActions'"
    )
    expect(source).toContain('const userMessageActions = useSessionUserMessageActions({')
    expect(hookSource).toContain('const canEditUserMessage = useCallback(')
    expect(hookSource).toContain('const handleSaveUserMessageEdit = useCallback(')
    expect(hookSource).toContain('restoreMessageModePrefix(')
    expect(hookSource).toContain('const performForkFromUserMessage = useCallback(')
    expect(hookSource).toContain('getUserMessageForkCutoff(')
    expect(hookSource).toContain("updateSetting('skipForkFromMessageConfirm', true)")
    expect(source).toContain('<ForkFromMessageConfirmDialog')
    expect(source).toContain('editingMessageId={userMessageActions.editingMessageId}')
    expect(source).toContain('onForkUserMessage={userMessageActions.handleForkUserMessage}')
    expect(source).toContain('forkingMessageId={userMessageActions.forkingMessageId}')
  })

  test('routes HQ smart scroll through the shared session view registry hook', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )

    expect(source).toContain("import { ScrollToBottomFab } from '../sessions/ScrollToBottomFab'")
    expect(source).toContain(
      "import { useTimelineScrollController } from '@/hooks/useTimelineScrollController'"
    )
    expect(source).toContain('const timelineScroll = useTimelineScrollController({')
    expect(source).toContain('count={timelineScroll.unreadCount}')
    expect(source).toContain('scrollContainerRef={timelineScroll.scrollContainerRef}')
    expect(source).toContain('containerRef={composerBarRef}')
  })
})
