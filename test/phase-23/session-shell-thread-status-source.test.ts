import { describe, test, expect } from 'vitest'

describe('SessionShell thread status flow (source verification)', () => {
  test('stores running and compaction state in the streaming buffer', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const shellSource = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/components/session-hq/SessionShell.tsx'
      ),
      'utf-8'
    )
    const runtimeSource = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/stores/useSessionRuntimeStore.ts'
      ),
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

  test('wires new UI user-message edit and fork flows into AgentTimeline', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/components/session-hq/SessionShell.tsx'
      ),
      'utf-8'
    )

    expect(source).toContain('const canEditUserMessage = useCallback(')
    expect(source).toContain('const handleSaveUserMessageEdit = useCallback(')
    expect(source).toContain('restoreMessageModePrefix(')
    expect(source).toContain('const performForkFromUserMessage = useCallback(')
    expect(source).toContain('getUserMessageForkCutoff(')
    expect(source).toContain("updateSetting('skipForkFromMessageConfirm', true)")
    expect(source).toContain('<ForkFromMessageConfirmDialog')
    expect(source).toContain('editingMessageId={editingMessageId}')
    expect(source).toContain('onForkUserMessage={handleForkUserMessage}')
    expect(source).toContain('forkingMessageId={forkingMessageId}')
  })
})
