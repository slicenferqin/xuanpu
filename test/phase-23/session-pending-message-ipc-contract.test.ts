import { readFileSync } from 'fs'
import path from 'path'

const repoRoot = path.resolve(__dirname, '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf-8')
}

describe('session pending message IPC contract', () => {
  it('registers database IPC handlers for durable queue operations', () => {
    const source = readSource('src/main/ipc/database-handlers.ts')

    for (const channel of [
      'db:sessionPendingMessage:create',
      'db:sessionPendingMessage:get',
      'db:sessionPendingMessage:list',
      'db:sessionPendingMessage:claimNext',
      'db:sessionPendingMessage:claim',
      'db:sessionPendingMessage:complete',
      'db:sessionPendingMessage:restore',
      'db:sessionPendingMessage:fail',
      'db:sessionPendingMessage:cancel'
    ]) {
      expect(source).toContain(`'${channel}'`)
    }

    expect(source).toContain('createSessionPendingMessage(data)')
    expect(source).toContain('claimNextSessionPendingMessage(sessionId, options)')
    expect(source).toContain('claimSessionPendingMessage(id, options)')
    expect(source).toContain('completeSessionPendingMessage(id)')
    expect(source).toContain('restoreSessionPendingMessage(id, error)')
    expect(source).toContain('failSessionPendingMessage(id, error)')
    expect(source).toContain('cancelSessionPendingMessage(id)')
  })

  it('exposes the durable queue namespace through preload', () => {
    const source = readSource('src/preload/index.ts')

    expect(source).toContain('sessionPendingMessage: {')
    for (const channel of [
      'db:sessionPendingMessage:create',
      'db:sessionPendingMessage:get',
      'db:sessionPendingMessage:list',
      'db:sessionPendingMessage:claimNext',
      'db:sessionPendingMessage:claim',
      'db:sessionPendingMessage:complete',
      'db:sessionPendingMessage:restore',
      'db:sessionPendingMessage:fail',
      'db:sessionPendingMessage:cancel'
    ]) {
      expect(source).toContain(`ipcRenderer.invoke('${channel}'`)
    }
  })

  it('declares the durable queue types on window.db', () => {
    const source = readSource('src/preload/index.d.ts')

    expect(source).toContain('interface SessionPendingMessage')
    expect(source).toContain('interface SessionPendingMessageCreate')
    expect(source).toContain('interface SessionPendingMessageClaimOptions')
    expect(source).toContain('sessionPendingMessage: {')
    expect(source).toContain('claimNext: (')
    expect(source).toContain('claim: (')
    expect(source).toContain('Promise<SessionPendingMessage | null>')
  })
})
