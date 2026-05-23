import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

import type { DatabaseService } from '../db/database'
import type {
  AgentRuntimeAdapter,
  AgentSdkCapabilities,
  PromptOptions
} from './agent-runtime-types'
import { XUANPU_AGENT_CAPABILITIES } from './agent-runtime-types'
import { createLogger } from './logger'
import { beginSessionRun, emitAgentEvent } from '@shared/lib/normalize-agent-event'

const log = createLogger({ component: 'XuanpuAgentImplementer' })

interface XuanpuAgentSessionState {
  sessionId: string
  hiveSessionId: string
  worktreePath: string
  status: 'ready' | 'running' | 'closed' | 'error'
  abortController: AbortController | null
}

type PiAgentCoreProbe = {
  ok: true
  exportedKeys: string[]
} | {
  ok: false
  error: string
}

function extractPromptText(
  message:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; url: string; filename?: string }
      >
): string {
  if (typeof message === 'string') return message

  return message
    .map((part) => {
      if (part.type === 'text') return part.text
      return `[Attached file: ${part.filename ?? part.url}]`
    })
    .join('\n')
}

async function probePiAgentCore(): Promise<PiAgentCoreProbe> {
  try {
    // Keep this out of static analysis for now. pi-agent-core@15.2.4 exports
    // TypeScript source, and Electron main currently externalizes dependencies.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<Record<string, unknown>>
    const mod = await dynamicImport('@oh-my-pi/pi-agent-core')
    return { ok: true, exportedKeys: Object.keys(mod).sort() }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export class XuanpuAgentImplementer implements AgentRuntimeAdapter {
  readonly id = 'xuanpu-agent' as const
  readonly capabilities: AgentSdkCapabilities = XUANPU_AGENT_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private dbService: DatabaseService | null = null
  private sessions = new Map<string, XuanpuAgentSessionState>()
  private selectedModel: { providerID: string; modelID: string; variant?: string } | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.dbService = db
  }

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    const sessionId = `xuanpu-agent-${randomUUID()}`
    this.sessions.set(sessionId, {
      sessionId,
      hiveSessionId,
      worktreePath,
      status: 'ready',
      abortController: null
    })

    log.info('Connected xuanpu-agent session', { worktreePath, hiveSessionId, sessionId })
    this.emitStatus(hiveSessionId, 'idle')
    return { sessionId }
  }

  async reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{ success: boolean; sessionStatus?: 'idle' | 'busy' | 'retry' }> {
    this.sessions.set(agentSessionId, {
      sessionId: agentSessionId,
      hiveSessionId,
      worktreePath,
      status: 'ready',
      abortController: null
    })
    return { success: true, sessionStatus: 'idle' }
  }

  async disconnect(_worktreePath: string, agentSessionId: string): Promise<void> {
    const session = this.sessions.get(agentSessionId)
    session?.abortController?.abort()
    if (session) session.status = 'closed'
    this.sessions.delete(agentSessionId)
  }

  async cleanup(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.abortController?.abort()
    }
    this.sessions.clear()
  }

  async prompt(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    _modelOverride?: { providerID: string; modelID: string; variant?: string },
    _options?: PromptOptions
  ): Promise<void> {
    const session = this.requireSession(agentSessionId, worktreePath)
    const text = extractPromptText(message).trim()
    if (!text) return

    beginSessionRun(session.hiveSessionId)
    this.persistMessage(session.hiveSessionId, 'user', text)
    session.status = 'running'
    session.abortController = new AbortController()
    this.emitStatus(session.hiveSessionId, 'busy')

    const probe = await probePiAgentCore()
    if (!probe.ok) {
      const errorMessage = [
        'xuanpu-agent Phase 0 probe failed to load @oh-my-pi/pi-agent-core.',
        'The package currently exports TypeScript source and Xuanpu still externalizes main-process dependencies.',
        `Import error: ${probe.error}`
      ].join('\n')
      this.persistMessage(session.hiveSessionId, 'assistant', errorMessage)
      session.status = 'error'
      this.emitError(session.hiveSessionId, errorMessage)
      this.emitStatus(session.hiveSessionId, 'idle')
      throw new Error(errorMessage)
    }

    const assistantText = [
      'xuanpu-agent Phase 0 loaded @oh-my-pi/pi-agent-core successfully.',
      `Exports: ${probe.exportedKeys.join(', ') || '(none)'}`,
      'Provider execution is intentionally disabled until the managed context bridge is wired.'
    ].join('\n')

    this.persistMessage(session.hiveSessionId, 'assistant', assistantText)
    emitAgentEvent(this.mainWindow, {
      type: 'message.updated',
      sessionId: session.hiveSessionId,
      data: {
        id: `xuanpu-agent-${Date.now()}`,
        role: 'assistant',
        content: assistantText,
        parts: [{ type: 'text', text: assistantText, timestamp: new Date().toISOString() }]
      }
    })
    session.status = 'ready'
    this.emitStatus(session.hiveSessionId, 'idle')
  }

  async abort(_worktreePath: string, agentSessionId: string): Promise<boolean> {
    const session = this.sessions.get(agentSessionId)
    if (!session?.abortController) return false
    session.abortController.abort()
    session.abortController = null
    session.status = 'ready'
    this.emitStatus(session.hiveSessionId, 'idle')
    return true
  }

  async getMessages(_worktreePath: string, agentSessionId: string): Promise<unknown[]> {
    const session = this.sessions.get(agentSessionId)
    if (!session || !this.dbService) return []
    return this.dbService.getSessionMessages(session.hiveSessionId)
  }

  async getAvailableModels(): Promise<unknown> {
    return {
      providers: {
        'xuanpu-agent': {
          id: 'xuanpu-agent',
          name: 'Xuanpu Agent',
          models: []
        }
      }
    }
  }

  async getModelInfo(): Promise<null> {
    return null
  }

  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    this.selectedModel = model
  }

  async getSessionInfo(): Promise<{ revertMessageID: string | null; revertDiff: string | null }> {
    return { revertMessageID: null, revertDiff: null }
  }

  async questionReply(): Promise<void> {}

  async questionReject(): Promise<void> {}

  async permissionReply(): Promise<void> {}

  async permissionList(): Promise<unknown[]> {
    return []
  }

  async undo(): Promise<unknown> {
    throw new Error('UNDO_NOT_SUPPORTED')
  }

  async redo(): Promise<unknown> {
    throw new Error('REDO_NOT_SUPPORTED')
  }

  async listCommands(): Promise<unknown[]> {
    return []
  }

  async sendCommand(): Promise<void> {
    throw new Error('COMMANDS_NOT_SUPPORTED')
  }

  async renameSession(
    _worktreePath: string,
    _agentSessionId: string,
    name: string
  ): Promise<void> {
    if (!this.dbService) return
    const session = this.sessions.get(_agentSessionId)
    if (!session) return
    this.dbService.updateSession(session.hiveSessionId, { name })
  }

  private requireSession(agentSessionId: string, worktreePath: string): XuanpuAgentSessionState {
    const session = this.sessions.get(agentSessionId)
    if (!session) {
      throw new Error(`Unknown xuanpu-agent session: ${agentSessionId}`)
    }
    if (session.worktreePath !== worktreePath) {
      log.warn('xuanpu-agent session worktree mismatch', {
        expected: session.worktreePath,
        actual: worktreePath,
        agentSessionId
      })
    }
    return session
  }

  private persistMessage(
    hiveSessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string
  ): void {
    this.dbService?.createSessionMessage({
      session_id: hiveSessionId,
      role,
      content,
      opencode_message_id: `xuanpu-agent-${randomUUID()}`,
      opencode_message_json: JSON.stringify({
        id: `xuanpu-agent-${randomUUID()}`,
        role,
        parts: [{ type: 'text', text: content, timestamp: new Date().toISOString() }]
      })
    })
  }

  private emitStatus(hiveSessionId: string, status: 'idle' | 'busy' | 'retry'): void {
    const statusPayload = { type: status }
    emitAgentEvent(this.mainWindow, {
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: statusPayload },
      statusPayload
    })
  }

  private emitError(hiveSessionId: string, message: string): void {
    emitAgentEvent(this.mainWindow, {
      type: 'session.error',
      sessionId: hiveSessionId,
      data: { error: message }
    })
  }
}
