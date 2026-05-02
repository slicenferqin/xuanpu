import type { BrowserWindow } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { createLogger } from './logger'
import { notificationService } from './notification-service'
import { getDatabase } from '../db'
import { autoRenameWorktreeBranch } from './git-service'
import { getEventBus } from '../../server/event-bus'
import type { AgentSdkImplementer } from './agent-runtime-types'
import type { AgentRuntimeAdapter } from './agent-runtime-types'
import { OPENCODE_CAPABILITIES } from './agent-runtime-types'
import { beginSessionRun, emitAgentEvent } from '@shared/lib/normalize-agent-event'
import { classifyOpenCodeTool } from '@shared/lib/opencode-classify'
import { stripInjectedContextEnvelope } from '@shared/lib/timeline-mappers'
import {
  mapOpenCodeEventToActivity,
  type ToolStartedTracker
} from './opencode-activity-mapper'
import {
  generateOpenCodeSessionTitle,
  isPlaceholderSessionTitle,
  extractTitleSourceText
} from './opencode-session-title'
import {
  resolveOpenCodeLaunchSpec,
  type OpenCodeLaunchSpec
} from './opencode-binary-resolver'
import { getOpenCodeEventDumper } from './opencode-event-dumper'
import { spawnLaunchSpec } from './command-launch-utils'

const log = createLogger({ component: 'OpenCodeService' })
const opencodeDumper = getOpenCodeEventDumper()

// Default model configuration
const DEFAULT_MODEL = {
  providerID: 'anthropic',
  modelID: 'claude-opus-4-5-20251101'
}

const SELECTED_MODEL_DB_KEY = 'selected_model'

// Event types we care about for streaming
export interface StreamEvent {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  childSessionId?: string
  /** session.status event payload -- only present when type === 'session.status' */
  statusPayload?: {
    type: 'idle' | 'busy' | 'retry'
    attempt?: number
    message?: string
    next?: number
  }
}

// Type for the OpencodeClient from the SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpencodeClient = any

// Per-directory subscription info
interface DirectorySubscription {
  controller: AbortController
  sessionCount: number
}

interface OpenCodeMessageBuffer {
  /** Raw `info` object as last received from the SDK (Message metadata). */
  info: Record<string, unknown> | null
  /** Parts keyed by their stable id, so updates merge instead of overwrite. */
  parts: Map<string, Record<string, unknown>>
  /** Insertion order so the persisted JSON keeps stream-aligned ordering. */
  partOrder: string[]
  /** Role inferred from `info.role`; cached because some events drop it. */
  role: string | null
  /** Last `time.created` timestamp, used to populate created_at on the row. */
  createdAt: string | null
}

interface OpenCodeInstance {
  client: OpencodeClient
  server: {
    url: string
    close(): void
  }
  // Map of directory-scoped OpenCode session keys to Hive session IDs for routing events
  sessionMap: Map<string, string>
  // Map of directory-scoped OpenCode session keys to worktree paths
  sessionDirectories: Map<string, string>
  // Map of directory paths to their event subscriptions
  directorySubscriptions: Map<string, DirectorySubscription>
  // Map of directory-scoped child/subagent OpenCode session keys to parent OpenCode session IDs
  childToParentMap: Map<string, string>
  // Phase 1.4.5 (OpenCode parity): per-Hive-session set of tool callIDs we've
  // already emitted a `tool.started` activity for. Used by the activity mapper
  // to flip subsequent `running` updates into `tool.updated`.
  toolStartedTrackerByHiveSession: Map<string, Set<string>>
  // Phase 1.4.6: remember user-message ids seen on `message.updated` so we can
  // suppress OpenCode's later user-echo `message.part.updated` events carrying
  // the injected Field Context envelope.
  userMessageIdsByHiveSession: Map<string, Set<string>>
  // Phase 1.4.7 (OpenCode persistence parity): per-Hive-session in-memory
  // buffer of `messageId → { info, parts }` so we can flush a complete row to
  // `session_messages` whenever a `message.updated` event arrives. Codex /
  // Claude Code own this concept already; OpenCode used to lean on the SDK
  // server-side transcript instead. Persisting here lets the SQLite timeline
  // be the source of truth and removes the "history empty until first turn
  // ends" UX hole.
  messageBuffersByHiveSession: Map<string, Map<string, OpenCodeMessageBuffer>>
  /** Title generation guard, see `maybeStartTitleGeneration`. */
  titleGenerationStartedByHiveSession: Map<string, true>
  /**
   * Phase 1.4.8 (OpenCode plan parity): per-Hive-session set of OpenCode
   * assistant message IDs we've already turned into a `plan.ready` event.
   * Plan agents may emit several `message.updated` for the same message
   * (e.g. partial → final), and we want to fire `plan.ready` exactly once
   * per assistant turn so the renderer's pendingPlan slot doesn't clobber
   * itself or get re-armed after the user accepts/rejects.
   */
  planEmittedByHiveSession: Map<string, Set<string>>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function messageInfo(message: unknown): { id?: string; role?: string; parts: unknown[] } {
  const record = asRecord(message)
  const info = asRecord(record?.info)
  const id = asString(info?.id) ?? asString(record?.id)
  const role = asString(info?.role) ?? asString(record?.role)
  const parts = Array.isArray(record?.parts) ? record.parts : []
  return { id, role, parts }
}

function dumpSessionKey(directory: string | undefined, sessionId: string | undefined): string {
  const dir = directory && directory.length > 0 ? directory : 'no-dir'
  const sid = sessionId && sessionId.length > 0 ? sessionId : 'no-session'
  return `${dir}::${sid}`
}

function extractPromptTextFromMessage(message: unknown): string {
  const { parts } = messageInfo(message)
  let bestText = ''

  for (const part of parts) {
    const partRecord = asRecord(part)
    if (!partRecord) continue
    if (partRecord.type !== 'text') continue
    if (partRecord.synthetic === true || partRecord.ignored === true) continue

    const text = asString(partRecord.text) ?? ''
    if (text.length > bestText.length) {
      bestText = text
    }
  }

  return bestText
}

// Dynamic import helper for ESM SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOpenCodeSDK(): Promise<{ createOpencode: any; createOpencodeClient: any }> {
  // Dynamic import for ESM module
  const sdk = await import('@opencode-ai/sdk')
  return sdk
}

/**
 * Spawn `opencode serve` without forcing a port, letting it auto-assign one.
 * Parses the listening URL from stdout.
 */
function spawnOpenCodeServer(
  options: {
    hostname?: string
    timeout?: number
    signal?: AbortSignal
    launchSpec?: OpenCodeLaunchSpec
  } = {}
): Promise<{ url: string; close(): void }> {
  const hostname = options.hostname ?? '127.0.0.1'
  const timeout = options.timeout ?? 10000

  return (async () => {
    const launchSpec = options.launchSpec ?? (await resolveOpenCodeLaunchSpec())
    if (!launchSpec) {
      throw new Error('OpenCode CLI not found on PATH')
    }

    const args = ['serve', `--hostname=${hostname}`]
    const proc: ChildProcess = spawnLaunchSpec(launchSpec, args, {
      signal: options.signal,
      env: { ...process.env }
    })

    const url = new Promise<string>((resolve, reject) => {
      const id = setTimeout(() => {
        reject(new Error(`Timeout waiting for opencode server to start after ${timeout}ms`))
      }, timeout)

      let output = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const lines = output.split(/\r?\n/)
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('opencode server listening')) continue
          const match = trimmed.match(/on\s+(https?:\/\/[^\s]+)/)
          if (!match) {
            clearTimeout(id)
            reject(new Error(`Failed to parse server url from output: ${trimmed}`))
            return
          }
          clearTimeout(id)
          resolve(match[1])
          return
        }
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })

      proc.on('exit', (code) => {
        clearTimeout(id)
        let msg = `opencode server exited with code ${code}`
        if (output.trim()) {
          msg += `\nServer output: ${output}`
        }
        reject(new Error(msg))
      })

      proc.on('error', (error) => {
        clearTimeout(id)
        reject(error)
      })

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          clearTimeout(id)
          reject(new Error('Aborted'))
        })
      }
    })

    return url.then((resolvedUrl) => ({
      url: resolvedUrl,
      close() {
        if (process.platform === 'win32' && proc.pid && launchSpec.shell) {
          try {
            const killer = spawnLaunchSpec({ command: 'taskkill', shell: false }, ['/pid', String(proc.pid), '/t', '/f'])
            killer.once('error', () => {
              proc.kill()
            })
            return
          } catch {
            proc.kill()
            return
          }
        }
        proc.kill()
      }
    }))
  })()
}

class OpenCodeService implements AgentSdkImplementer, AgentRuntimeAdapter {
  readonly id = 'opencode' as const
  readonly capabilities = OPENCODE_CAPABILITIES

  // Single server instance (OpenCode handles multiple directories via query params)
  private instance: OpenCodeInstance | null = null
  private mainWindow: BrowserWindow | null = null
  private pendingConnection: Promise<OpenCodeInstance> | null = null
  private pendingQuestions = new Map<string, string>()
  private pendingApprovals = new Map<string, string>()

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private getSessionMapKey(directory: string, opencodeSessionId: string): string {
    return `${directory}::${opencodeSessionId}`
  }

  private getChildParentKey(directory: string, childSessionId: string): string {
    return `${directory}::${childSessionId}`
  }

  private setSessionMapping(
    instance: OpenCodeInstance,
    directory: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): void {
    const key = this.getSessionMapKey(directory, opencodeSessionId)
    instance.sessionMap.set(key, hiveSessionId)
    instance.sessionDirectories.set(key, directory)
  }

  private migrateLegacySessionMapping(
    instance: OpenCodeInstance,
    directory: string,
    opencodeSessionId: string
  ): void {
    // Legacy mapping keyed only by opencodeSessionId (pre-directory scoping).
    const legacyMapped = instance.sessionMap.get(opencodeSessionId)
    if (legacyMapped !== undefined) {
      this.setSessionMapping(instance, directory, opencodeSessionId, legacyMapped)
      instance.sessionMap.delete(opencodeSessionId)
    }

    const legacyDirectory = instance.sessionDirectories.get(opencodeSessionId)
    if (legacyDirectory !== undefined) {
      instance.sessionDirectories.delete(opencodeSessionId)
    }
  }

  private getMappedHiveSessionId(
    instance: OpenCodeInstance,
    opencodeSessionId: string,
    directory?: string
  ): string | undefined {
    if (directory) {
      const scoped = instance.sessionMap.get(this.getSessionMapKey(directory, opencodeSessionId))
      if (scoped) return scoped
    }

    const legacy = instance.sessionMap.get(opencodeSessionId)
    if (legacy) return legacy

    if (!directory) return undefined

    // Compatibility fallback for mixed-state maps.
    const scopedSuffix = `::${opencodeSessionId}`
    for (const [key, hiveSessionId] of instance.sessionMap.entries()) {
      if (key.endsWith(scopedSuffix)) {
        return hiveSessionId
      }
    }

    return undefined
  }

  /**
   * Get or create the OpenCode instance
   */
  private async getOrCreateInstance(): Promise<OpenCodeInstance> {
    // Check if instance already exists
    if (this.instance) {
      return this.instance
    }

    // Check if connection is already in progress
    if (this.pendingConnection) {
      log.info('Waiting for pending connection')
      return this.pendingConnection
    }

    // Start new connection
    log.info('Starting OpenCode server')

    this.pendingConnection = (async (): Promise<OpenCodeInstance> => {
      try {
        // Load SDK dynamically (we only need the client, we spawn the server ourselves)
        const { createOpencodeClient } = await loadOpenCodeSDK()

        // Spawn opencode serve without --port so it auto-assigns an available port
        const server = await spawnOpenCodeServer()
        log.info('OpenCode server started', { url: server.url })

        // Create the SDK client pointing at the auto-assigned URL
        const client = createOpencodeClient({ baseUrl: server.url })

        const instance: OpenCodeInstance = {
          client,
          server,
          sessionMap: new Map(),
          sessionDirectories: new Map(),
          directorySubscriptions: new Map(),
          childToParentMap: new Map(),
          toolStartedTrackerByHiveSession: new Map(),
          titleGenerationStartedByHiveSession: new Map(),
          userMessageIdsByHiveSession: new Map(),
          messageBuffersByHiveSession: new Map(),
          planEmittedByHiveSession: new Map()
        }

        this.instance = instance
        return instance
      } finally {
        // Always clean up pending connection
        this.pendingConnection = null
      }
    })()

    return this.pendingConnection
  }

  /**
   * Subscribe to events for a specific directory
   */
  private subscribeToDirectory(instance: OpenCodeInstance, directory: string): void {
    // Check if already subscribed
    if (instance.directorySubscriptions.has(directory)) {
      const sub = instance.directorySubscriptions.get(directory)!
      sub.sessionCount++
      log.info('Incremented subscription count for directory', {
        directory,
        count: sub.sessionCount
      })
      return
    }

    const controller = new AbortController()
    instance.directorySubscriptions.set(directory, {
      controller,
      sessionCount: 1
    })

    log.info('Starting event subscription for directory', { directory })

    // Start consuming events for this directory
    this.consumeDirectoryEvents(instance, directory, controller.signal)
  }

  /**
   * Unsubscribe from events for a directory (decrements count, cancels when 0)
   */
  private unsubscribeFromDirectory(instance: OpenCodeInstance, directory: string): void {
    const sub = instance.directorySubscriptions.get(directory)
    if (!sub) return

    sub.sessionCount--
    log.info('Decremented subscription count for directory', { directory, count: sub.sessionCount })

    if (sub.sessionCount <= 0) {
      log.info('Cancelling event subscription for directory', { directory })
      sub.controller.abort()
      instance.directorySubscriptions.delete(directory)
    }
  }

  /**
   * Consume events for a specific directory
   */
  private async consumeDirectoryEvents(
    instance: OpenCodeInstance,
    directory: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const result = await instance.client.event.subscribe({
        signal,
        query: { directory }
      })

      log.info('Event subscription established for directory', { directory })

      // Iterate over the stream - this is REQUIRED for events to flow
      for await (const event of result.stream) {
        await this.handleEvent(instance, { data: event }, directory)
      }

      log.info('Event stream ended normally for directory', { directory })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        log.info('Event subscription aborted for directory', { directory })
      } else {
        log.error('Event stream error for directory', { directory, error })
      }
    }
  }

  /**
   * Connect to OpenCode for a worktree (lazy starts server if needed)
   */
  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    log.info('Connecting to OpenCode', { worktreePath, hiveSessionId })

    const instance = await this.getOrCreateInstance()

    // Create a new OpenCode session for this directory
    try {
      const result = await instance.client.session.create({
        query: { directory: worktreePath }
      })
      const sessionId = result.data?.id

      if (!sessionId) {
        throw new Error('Failed to create OpenCode session: no session ID returned')
      }

      this.setSessionMapping(instance, worktreePath, sessionId, hiveSessionId)

      // Subscribe to events for this directory
      this.subscribeToDirectory(instance, worktreePath)

      log.info('Created OpenCode session', {
        sessionId,
        hiveSessionId,
        worktreePath,
        totalSessions: instance.sessionMap.size
      })

      return { sessionId }
    } catch (error) {
      log.error('Failed to create OpenCode session', { worktreePath, error })
      throw error
    }
  }

  /**
   * Query the current status of an OpenCode session (idle/busy/retry).
   * Returns undefined if the status could not be determined.
   */
  private async querySessionStatus(
    instance: OpenCodeInstance,
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<'idle' | 'busy' | 'retry' | undefined> {
    try {
      const result = await instance.client.session.status({
        query: { directory: worktreePath }
      })
      // result.data is { [sessionId]: SessionStatus }
      const statusMap = result.data as Record<string, { type: string }> | undefined
      if (statusMap && statusMap[opencodeSessionId]) {
        return statusMap[opencodeSessionId].type as 'idle' | 'busy' | 'retry'
      }
    } catch (error) {
      log.warn('Failed to query session status', { opencodeSessionId, error })
    }
    return undefined
  }

  /**
   * Try to reconnect to an existing OpenCode session
   */
  async reconnect(
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> {
    log.info('Attempting to reconnect to OpenCode session', {
      worktreePath,
      opencodeSessionId,
      hiveSessionId
    })

    try {
      const instance = await this.getOrCreateInstance()
      const scopedKey = this.getSessionMapKey(worktreePath, opencodeSessionId)
      this.migrateLegacySessionMapping(instance, worktreePath, opencodeSessionId)

      // If session is already registered (e.g., user switched projects and back),
      // just update the Hive session mapping. Skip subscription to avoid count leak.
      if (instance.sessionMap.has(scopedKey)) {
        instance.sessionMap.set(scopedKey, hiveSessionId)
        log.info('Session already registered, updated mapping', {
          opencodeSessionId,
          hiveSessionId
        })
        const sessionStatus = await this.querySessionStatus(
          instance,
          worktreePath,
          opencodeSessionId
        )
        // Fetch revert state so callers always get it
        const sessionResult = await instance.client.session.get({
          path: { id: opencodeSessionId },
          query: { directory: worktreePath }
        })
        const revert = asRecord(asRecord(sessionResult.data)?.revert)
        const revertMessageID = asString(revert?.messageID) ?? null
        // Phase 1.4.7: top-up SQLite even on the fast-path so user-visible
        // history doesn't depend on whether the previous session was already
        // registered.
        void this.hydrateOpenCodeMessagesFromServer(
          hiveSessionId,
          worktreePath,
          opencodeSessionId
        ).catch(() => {})
        return { success: true, sessionStatus, revertMessageID }
      }

      // Try to get the session
      const result = await instance.client.session.get({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })

      if (result.data) {
        this.setSessionMapping(instance, worktreePath, opencodeSessionId, hiveSessionId)

        // Subscribe to events for this directory
        this.subscribeToDirectory(instance, worktreePath)

        // Phase 1.4.7 (OpenCode persistence parity): right after a successful
        // reconnect we may have missed live events between server start and
        // the subscription returning. Hydrating once means SQLite reflects
        // the SDK transcript before any UI refresh runs.
        void this.hydrateOpenCodeMessagesFromServer(
          hiveSessionId,
          worktreePath,
          opencodeSessionId
        ).catch(() => {})

        const sessionStatus = await this.querySessionStatus(
          instance,
          worktreePath,
          opencodeSessionId
        )
        const revert = asRecord(result.data)?.revert
        const revertMessageID = asString(asRecord(revert)?.messageID) ?? null
        log.info('Successfully reconnected to OpenCode session', {
          opencodeSessionId,
          hiveSessionId,
          sessionStatus,
          revertMessageID
        })
        return { success: true, sessionStatus, revertMessageID }
      }
    } catch (error) {
      log.warn('Failed to reconnect to OpenCode session', { opencodeSessionId, error })
    }

    return { success: false }
  }

  /**
   * Get available models from all configured providers
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAvailableModels(): Promise<any> {
    log.info('Getting available models')

    const instance = await this.getOrCreateInstance()

    try {
      const result = await instance.client.config.providers()
      const providers = result.data?.providers || []
      log.info('Got available models', { providerCount: providers.length })
      return providers
    } catch (error) {
      log.error('Failed to get available models', { error })
      throw error
    }
  }

  /**
   * Get model info (name, context limit) for a specific model
   */
  async getModelInfo(
    _worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    log.info('Getting model info', { modelId })

    const instance = await this.getOrCreateInstance()

    try {
      const result = await instance.client.config.providers()
      const providers = result.data?.providers || []

      for (const provider of providers) {
        const models = provider.models || {}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const model = models[modelId] as any
        if (model) {
          return {
            id: modelId,
            name: model.name || modelId,
            limit: {
              context: model.limit?.context || 0,
              input: model.limit?.input,
              output: model.limit?.output || 0
            }
          }
        }
      }

      log.warn('Model not found in any provider', { modelId })
      return null
    } catch (error) {
      log.error('Failed to get model info', { modelId, error })
      throw error
    }
  }

  /**
   * Get the selected model from settings DB, or fallback to DEFAULT_MODEL
   */
  private getSelectedModel(): { providerID: string; modelID: string; variant?: string } {
    try {
      const db = getDatabase()
      const value = db.getSetting(SELECTED_MODEL_DB_KEY)
      if (value) {
        const parsed = JSON.parse(value)
        if (parsed.providerID && parsed.modelID) {
          return parsed
        }
      }
    } catch (error) {
      log.warn('Failed to load selected model from DB, using default', { error })
    }
    return DEFAULT_MODEL
  }

  /**
   * Set the selected model in settings DB
   */
  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    try {
      const db = getDatabase()
      db.setSetting(SELECTED_MODEL_DB_KEY, JSON.stringify(model))
      log.info('Selected model saved', { model })
    } catch (error) {
      log.error('Failed to save selected model', { error })
      throw error
    }
  }

  clearSelectedModel(): void {
    try {
      const db = getDatabase()
      db.deleteSetting(SELECTED_MODEL_DB_KEY)
      log.info('Selected model cleared from backend')
    } catch (error) {
      log.error('Failed to clear selected model from backend', { error })
      throw error
    }
  }

  /**
   * Send a prompt to an OpenCode session.
   * Accepts either a parts array (text + file parts) or a plain string for backward compatibility.
   */
  async prompt(
    worktreePath: string,
    opencodeSessionId: string,
    messageOrParts:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    modelOverride?: { providerID: string; modelID: string; variant?: string },
    options?: { codexFastMode?: boolean; mode?: 'build' | 'plan' }
  ): Promise<void> {
    const parts =
      typeof messageOrParts === 'string'
        ? [{ type: 'text' as const, text: messageOrParts }]
        : messageOrParts

    log.info('Sending prompt to OpenCode', {
      worktreePath,
      opencodeSessionId,
      partsCount: parts.length,
      mode: options?.mode
    })
    opencodeDumper?.recordMarker(dumpSessionKey(worktreePath, opencodeSessionId), {
      type: 'prompt.start',
      worktreePath,
      opencodeSessionId,
      parts,
      modelOverride: modelOverride ?? null,
      mode: options?.mode ?? null
    })

    if (!this.instance) {
      throw new Error('No OpenCode instance available')
    }

    const hiveSessionId =
      this.getMappedHiveSessionId(this.instance, opencodeSessionId, worktreePath) ??
      getDatabase().getSessionByOpenCodeSessionId(opencodeSessionId)?.id
    if (hiveSessionId) {
      beginSessionRun(hiveSessionId)
    }

    const { variant, ...model } = modelOverride ?? this.getSelectedModel()
    log.info('Using model for prompt', { model, variant, agent: options?.mode })

    try {
      // Use promptAsync for non-blocking behavior - events will stream the response
      await this.instance.client.session.promptAsync({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath },
        body: {
          model,
          variant,
          parts,
          // Pass agent name to select plan/build agent in OpenCode
          agent: options?.mode === 'plan' ? 'plan' : undefined
        }
      })

      log.info('Prompt sent successfully', { opencodeSessionId, agent: options?.mode })
      opencodeDumper?.recordMarker(dumpSessionKey(worktreePath, opencodeSessionId), {
        type: 'prompt.accepted',
        worktreePath,
        opencodeSessionId,
        agent: options?.mode ?? null
      })

      // Phase 1.4.5 (OpenCode parity): kick off async title generation on the
      // first user prompt for this session, mirroring Codex's pattern. Fire
      // and forget — failures must never block the prompt path. The
      // `session.updated` handler will still pick up any later, better title
      // emitted by OpenCode's server.
      if (hiveSessionId) {
        this.maybeStartTitleGeneration(hiveSessionId, opencodeSessionId, worktreePath, parts)
      }
    } catch (error) {
      log.error('Failed to send prompt', { opencodeSessionId, error })
      throw error
    }
  }

  /**
   * Abort a streaming session
   */
  async abort(worktreePath: string, opencodeSessionId: string): Promise<boolean> {
    if (!this.instance?.client) {
      throw new Error('No OpenCode instance for worktree')
    }

    const hiveSessionId =
      this.getMappedHiveSessionId(this.instance, opencodeSessionId, worktreePath) ??
      getDatabase().getSessionByOpenCodeSessionId(opencodeSessionId)?.id ??
      null

    const result = await this.instance.client.session.abort({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath }
    })

    // P3: best-effort draft flush for OpenCode. Unlike Claude Code we don't
    // own an in-memory authoritative assistant draft in the main process, but
    // we can still materialize the latest persisted assistant message back into
    // the renderer and force the lifecycle to idle so partial streamed content
    // does not stay visually stuck forever after abort.
    if (result.data === true && hiveSessionId) {
      opencodeDumper?.recordMarker(dumpSessionKey(worktreePath, opencodeSessionId), {
        type: 'abort.accepted',
        worktreePath,
        opencodeSessionId,
        hiveSessionId
      })
      await this.flushAbortDraft(worktreePath, opencodeSessionId, hiveSessionId).catch((error) => {
        log.warn('OpenCode abort draft flush failed', {
          worktreePath,
          opencodeSessionId,
          hiveSessionId,
          error
        })
      })
    }

    return result.data === true
  }

  /**
   * Reply to a pending question from the AI
   * Uses direct HTTP since v1 SDK lacks the question namespace (available in v2)
   */
  async questionReply(
    requestId: string,
    answers: string[][],
    worktreePath?: string
  ): Promise<void> {
    const instance = await this.getOrCreateInstance()
    const url = new URL(`/question/${encodeURIComponent(requestId)}/reply`, instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers })
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Question reply failed (${resp.status}): ${text}`)
    }
    this.pendingQuestions.delete(requestId)
  }

  /**
   * Reject/dismiss a pending question from the AI
   * Uses direct HTTP since v1 SDK lacks the question namespace (available in v2)
   */
  async questionReject(requestId: string, worktreePath?: string): Promise<void> {
    const instance = await this.getOrCreateInstance()
    const url = new URL(`/question/${encodeURIComponent(requestId)}/reject`, instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Question reject failed (${resp.status}): ${text}`)
    }
    this.pendingQuestions.delete(requestId)
  }

  /**
   * Reply to a pending permission request from the AI
   * Uses direct HTTP since v1 SDK lacks the permission namespace
   */
  async permissionReply(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    worktreePath?: string,
    message?: string
  ): Promise<void> {
    const instance = await this.getOrCreateInstance()
    const url = new URL(`/permission/${encodeURIComponent(requestId)}/reply`, instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const body: Record<string, string> = { reply }
    if (message) body.message = message
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Permission reply failed (${resp.status}): ${text}`)
    }
    this.pendingApprovals.delete(requestId)
  }

  /**
   * List pending permission requests
   * Uses direct HTTP since v1 SDK lacks the permission namespace
   */
  async permissionList(worktreePath?: string): Promise<unknown[]> {
    const instance = await this.getOrCreateInstance()
    const url = new URL('/permission', instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Permission list failed (${resp.status}): ${text}`)
    }
    const data = await resp.json()
    return Array.isArray(data) ? data : (data?.data ?? [])
  }

  hasPendingQuestion(requestId: string): boolean {
    return this.pendingQuestions.has(requestId)
  }

  hasPendingApproval(requestId: string): boolean {
    return this.pendingApprovals.has(requestId)
  }

  /**
   * Get session info including revert state from OpenCode
   */
  async getSessionInfo(
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{ revertMessageID: string | null; revertDiff: string | null }> {
    const instance = await this.getOrCreateInstance()

    const result = await instance.client.session.get({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath }
    })

    const sessionData = asRecord(result.data)
    const revert = asRecord(sessionData?.revert)
    return {
      revertMessageID: asString(revert?.messageID) ?? null,
      revertDiff: asString(revert?.diff) ?? null
    }
  }

  /**
   * Get messages from an OpenCode session
   */
  async getMessages(worktreePath: string, opencodeSessionId: string): Promise<unknown[]> {
    if (!this.instance) {
      throw new Error('No OpenCode instance available')
    }

    try {
      const result = await this.instance.client.session.messages({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })
      const messages = Array.isArray(result.data) ? result.data : []

      return messages
    } catch (error) {
      log.error('Failed to get messages', { opencodeSessionId, error })
      throw error
    }
  }

  async undo(
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{ revertMessageID: string; restoredPrompt: string; revertDiff: string | null }> {
    const instance = await this.getOrCreateInstance()

    const status = await this.querySessionStatus(instance, worktreePath, opencodeSessionId)
    if (status && status !== 'idle') {
      await this.abort(worktreePath, opencodeSessionId).catch(() => {})
    }

    const [sessionResult, messagesResult] = await Promise.all([
      instance.client.session.get({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      }),
      instance.client.session.messages({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })
    ])

    const revertMessageID = asString(asRecord(asRecord(sessionResult.data)?.revert)?.messageID)
    const messages = Array.isArray(messagesResult.data) ? messagesResult.data : []

    let targetMessage: unknown
    for (const message of messages) {
      const info = messageInfo(message)
      if (info.role !== 'user') continue
      if (revertMessageID && info.id && info.id >= revertMessageID) continue
      targetMessage = message
    }

    const targetMessageID = messageInfo(targetMessage).id
    if (!targetMessage || !targetMessageID) {
      throw new Error('Nothing to undo')
    }

    await instance.client.session.revert({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath },
      body: {
        messageID: targetMessageID
      }
    })

    // Read back session to get the authoritative revert state (including diff)
    const updatedSession = await instance.client.session.get({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath }
    })
    const updatedRevert = asRecord(asRecord(updatedSession.data)?.revert)
    const actualRevertMessageID = asString(updatedRevert?.messageID) ?? targetMessageID
    const revertDiff = asString(updatedRevert?.diff) ?? null

    return {
      revertMessageID: actualRevertMessageID,
      restoredPrompt: extractPromptTextFromMessage(targetMessage),
      revertDiff
    }
  }

  async redo(
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<{ revertMessageID: string | null }> {
    const instance = await this.getOrCreateInstance()

    const sessionResult = await instance.client.session.get({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath }
    })

    const revertMessageID = asString(asRecord(asRecord(sessionResult.data)?.revert)?.messageID)
    if (!revertMessageID) {
      throw new Error('Nothing to redo')
    }

    const messagesResult = await instance.client.session.messages({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath }
    })
    const messages = Array.isArray(messagesResult.data) ? messagesResult.data : []

    const nextUserMessageID = messages
      .map((message) => messageInfo(message))
      .filter(
        (info) => info.role === 'user' && typeof info.id === 'string' && info.id > revertMessageID
      )
      .map((info) => info.id as string)
      .sort()[0]

    if (!nextUserMessageID) {
      await instance.client.session.unrevert({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })
      return { revertMessageID: null }
    }

    await instance.client.session.revert({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath },
      body: {
        messageID: nextUserMessageID
      }
    })

    return { revertMessageID: nextUserMessageID }
  }

  /**
   * Disconnect a session (may kill server if last session)
   */
  async disconnect(worktreePath: string, opencodeSessionId: string): Promise<void> {
    log.info('Disconnecting OpenCode session', { worktreePath, opencodeSessionId })

    if (!this.instance) {
      log.warn('No instance found for disconnect')
      return
    }

    // Unsubscribe from directory events
    this.unsubscribeFromDirectory(this.instance, worktreePath)

    const scopedKey = this.getSessionMapKey(worktreePath, opencodeSessionId)
    const trackedHiveSessionId =
      this.instance.sessionMap.get(scopedKey) ?? this.instance.sessionMap.get(opencodeSessionId)
    this.instance.sessionMap.delete(scopedKey)
    this.instance.sessionDirectories.delete(scopedKey)
    // Legacy cleanup
    this.instance.sessionMap.delete(opencodeSessionId)
    this.instance.sessionDirectories.delete(opencodeSessionId)
    if (trackedHiveSessionId) {
      this.instance.toolStartedTrackerByHiveSession.delete(trackedHiveSessionId)
      this.instance.titleGenerationStartedByHiveSession.delete(trackedHiveSessionId)
      this.instance.userMessageIdsByHiveSession.delete(trackedHiveSessionId)
      this.instance.messageBuffersByHiveSession.delete(trackedHiveSessionId)
      this.instance.planEmittedByHiveSession.delete(trackedHiveSessionId)
      this.clearPendingRequestsForSession(trackedHiveSessionId)
    }

    // Clean up child-to-parent mappings that reference this parent
    for (const [childId, parentId] of this.instance.childToParentMap) {
      if (parentId === opencodeSessionId) {
        this.instance.childToParentMap.delete(childId)
      }
    }

    log.info('Session disconnected', {
      opencodeSessionId,
      remainingSessions: this.instance.sessionMap.size
    })

    // Kill server when no more sessions
    if (this.instance.sessionMap.size === 0) {
      log.info('Killing OpenCode server (no more sessions)')
      this.shutdownServer()
    }
  }

  /**
   * Shutdown the OpenCode server
   */
  private shutdownServer(): void {
    if (!this.instance) return

    // Cancel all directory subscriptions
    for (const [directory, sub] of this.instance.directorySubscriptions) {
      log.info('Aborting subscription for directory', { directory })
      sub.controller.abort()
    }
    this.instance.directorySubscriptions.clear()
    this.instance.childToParentMap.clear()
    this.instance.toolStartedTrackerByHiveSession.clear()
    this.instance.titleGenerationStartedByHiveSession.clear()
    this.instance.userMessageIdsByHiveSession.clear()
    this.instance.messageBuffersByHiveSession.clear()
    this.instance.planEmittedByHiveSession.clear()
    this.pendingQuestions.clear()
    this.pendingApprovals.clear()

    // Close the server
    try {
      this.instance.server.close()
    } catch (error) {
      log.warn('Error closing OpenCode server', { error })
    }

    this.instance = null
  }

  /**
   * Handle a single event from OpenCode
   */
  private async handleEvent(
    instance: OpenCodeInstance,
    rawEvent: { data: unknown; event?: string },
    directory?: string
  ): Promise<void> {
    // The event data might be a GlobalEvent (with directory/payload) or a direct event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let event = rawEvent.data as any

    if (!event) {
      return
    }

    // Capture directory from GlobalEvent wrapper before unwrapping
    let eventDirectory = directory
    if (event.directory && event.payload) {
      eventDirectory = event.directory
      event = event.payload
    }

    const eventType = event.type || rawEvent.event

    opencodeDumper?.recordSdkEvent(dumpSessionKey(eventDirectory, undefined), {
      rawEvent,
      unwrappedEvent: event,
      directory: eventDirectory,
      eventType
    })

    // Skip noisy events
    if (eventType === 'server.heartbeat' || eventType === 'server.connected') {
      return
    }

    // Log errors, skip logging for routine events
    if (eventType === 'session.error') {
      log.error('OpenCode session error', {
        sessionId: event.properties?.sessionID,
        error: event.properties?.error
      })
    }

    if (!eventType) {
      return
    }

    // Extract session ID based on event type structure
    let sessionId: string | undefined

    if (event.properties) {
      if (event.properties.part?.sessionID) {
        sessionId = event.properties.part.sessionID
      } else if (event.properties.info?.sessionID) {
        // message.updated uses properties.info (a Message object with `sessionID`)
        sessionId = event.properties.info.sessionID
      } else if (event.properties.info?.id) {
        // session.created/updated/deleted use properties.info (a Session object with `id`)
        sessionId = event.properties.info.id
      } else if (event.properties.sessionID) {
        sessionId = event.properties.sessionID
      }
    }

    if (!sessionId) {
      // Skip events without session ID
      return
    }

    // Get the Hive session ID for routing — check parent session if this is a child/subagent
    const directHiveId = this.getMappedHiveSessionId(instance, sessionId, eventDirectory)
    let hiveSessionId = directHiveId

    if (!hiveSessionId) {
      const parentId = await this.resolveParentSession(instance, sessionId, eventDirectory)
      if (parentId) {
        hiveSessionId = this.getMappedHiveSessionId(instance, parentId, eventDirectory)
      }
    }

    if (!hiveSessionId) {
      log.warn('No Hive session found for OpenCode session', { sessionId })
      return
    }

    const info = asRecord(event.properties?.info)
    if (eventType === 'message.updated' && asString(info?.role) === 'user' && asString(info?.id)) {
      let userIds = instance.userMessageIdsByHiveSession.get(hiveSessionId)
      if (!userIds) {
        userIds = new Set<string>()
        instance.userMessageIdsByHiveSession.set(hiveSessionId, userIds)
      }
      userIds.add(asString(info?.id)!)
    }

    const partRecord = asRecord(event.properties?.part)
    // Phase 1.4.6: OpenCode echoes the user-message text (including the
    // injected Field Context envelope) back as a `message.part.updated`
    // event carrying `type: 'text'` with `messageID` belonging to the
    // user message. We do NOT want the renderer streaming overlay to pick
    // that up — it would leak the envelope into the chat surface. But we
    // MUST still let the persistence pipeline see this part; otherwise the
    // corresponding user row in `session_messages` ends up with empty
    // content and the timeline refresh shows a phantom empty bubble next
    // to the optimistic one.
    const isUserEchoTextPart =
      eventType === 'message.part.updated' &&
      !!partRecord &&
      partRecord.type === 'text' &&
      typeof partRecord.messageID === 'string' &&
      instance.userMessageIdsByHiveSession.get(hiveSessionId)?.has(partRecord.messageID)

    if (isUserEchoTextPart) {
      log.debug('Suppressing OpenCode user-echo text emit; keeping persistence', {
        hiveSessionId,
        sessionId,
        messageID: partRecord!.messageID
      })
      opencodeDumper?.recordMarker(dumpSessionKey(eventDirectory, sessionId), {
        type: 'skip.user_echo_part',
        hiveSessionId,
        messageID: asString(partRecord!.messageID) ?? null,
        preview: asString(partRecord!.text)?.slice(0, 120) ?? null
      })
      // Feed the part into the persistence buffer so the durable user row
      // eventually holds the original (envelope-stripped) prompt text.
      try {
        this.persistOpenCodeMessageEvent(hiveSessionId, eventType, event)
      } catch (err) {
        log.debug('OpenCode user-echo persistence failed; continuing', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
      return
    }

    // Detect child/subagent events: no direct mapping but resolved through parent
    const isChildEvent = !directHiveId && !!hiveSessionId

    // Log session lifecycle events and trigger notification when unfocused
    if (eventType === 'session.idle') {
      log.info('Forwarding session.idle to renderer', {
        opencodeSessionId: sessionId,
        hiveSessionId,
        isChildEvent
      })
      // Only notify for parent session completion, not child/subagent sessions
      if (!isChildEvent) {
        this.maybeNotifySessionComplete(hiveSessionId)
      }
    }

    if (
      eventType === 'question.asked' ||
      eventType === 'permission.asked' ||
      eventType === 'command.approval_needed'
    ) {
      this.trackPendingRequest(hiveSessionId, eventType, event.properties)
      this.maybeNotifyPendingUserFeedback(
        hiveSessionId,
        eventType === 'question.asked' ? 'question' : 'approval'
      )
    }

    // Handle session.updated events — persist title to DB before forwarding to renderer
    // The SDK event structure is: { properties: { info: Session } } where Session has { id, title, ... }
    if (eventType === 'session.updated') {
      const sessionInfo = event.properties?.info
      const sessionTitle = sessionInfo?.title || event.properties?.title
      if (hiveSessionId && sessionTitle) {
        try {
          const db = getDatabase()

          // Detect placeholder titles that shouldn't trigger branch renames:
          // - Hive default: "Session 1", "Session 2", etc.
          // - OpenCode default: "New Session 2026-02-12T21:15:03.818Z"
          const isPlaceholderTitle =
            /^Session \d+$/i.test(sessionTitle) ||
            /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(sessionTitle)

          // DEBUG: Log every session.updated title to diagnose branch rename issues
          const worktreeForLog = db.getWorktreeBySessionId(hiveSessionId)
          log.info('session.updated title received', {
            sessionTitle,
            isPlaceholderTitle,
            hiveSessionId,
            branchRenamed: worktreeForLog?.branch_renamed,
            currentBranch: worktreeForLog?.branch_name
          })

          // Only persist non-placeholder titles to the DB (avoid overwriting
          // a good Hive name like "Session 1" with OpenCode's timestamp default)
          if (!isPlaceholderTitle) {
            db.updateSession(hiveSessionId, { name: sessionTitle })
          }
          // Auto-rename branch for the session's direct worktree
          const worktree = db.getWorktreeBySessionId(hiveSessionId)
          if (worktree && !worktree.branch_renamed && !isPlaceholderTitle) {
            try {
              const result = await autoRenameWorktreeBranch({
                worktreeId: worktree.id,
                worktreePath: worktree.path,
                currentBranchName: worktree.branch_name,
                sessionTitle,
                db
              })
              if (result.renamed) {
                this.sendToRenderer('worktree:branchRenamed', {
                  worktreeId: worktree.id,
                  newBranch: result.newBranch
                })
                log.info('Auto-renamed branch from session title', {
                  worktreeId: worktree.id,
                  oldBranch: worktree.branch_name,
                  newBranch: result.newBranch
                })
              } else if (result.error) {
                log.warn('Failed to auto-rename branch', { error: result.error })
              } else if (result.skipped) {
                log.debug('Skipped auto-rename', { reason: result.skipped })
              }
            } catch (err) {
              db.updateWorktree(worktree.id, { branch_renamed: 1 })
              log.warn('Failed to auto-rename branch', { err })
            }
          }

          // Auto-rename branches for all connection member worktrees
          if (!isPlaceholderTitle) {
            const session = db.getSession(hiveSessionId)
            if (session?.connection_id) {
              const connection = db.getConnection(session.connection_id)
              if (connection) {
                for (const member of connection.members) {
                  // Skip if already handled as the direct worktree above
                  if (worktree && member.worktree_id === worktree.id) continue

                  try {
                    const memberWorktree = db.getWorktree(member.worktree_id)
                    if (!memberWorktree || memberWorktree.branch_renamed) continue

                    const result = await autoRenameWorktreeBranch({
                      worktreeId: memberWorktree.id,
                      worktreePath: memberWorktree.path,
                      currentBranchName: memberWorktree.branch_name,
                      sessionTitle,
                      db
                    })
                    if (result.renamed) {
                      this.sendToRenderer('worktree:branchRenamed', {
                        worktreeId: memberWorktree.id,
                        newBranch: result.newBranch
                      })
                      log.info('Auto-renamed connection member branch', {
                        connectionId: session.connection_id,
                        worktreeId: memberWorktree.id,
                        oldBranch: memberWorktree.branch_name,
                        newBranch: result.newBranch
                      })
                    } else if (result.error) {
                      log.warn('Failed to auto-rename connection member branch', {
                        connectionId: session.connection_id,
                        worktreeId: memberWorktree.id,
                        error: result.error
                      })
                    }
                  } catch (err) {
                    log.warn('Error renaming connection member branch', {
                      connectionId: session.connection_id,
                      worktreeId: member.worktree_id,
                      err
                    })
                  }
                }
              }
            }
          }
        } catch (err) {
          log.warn('Failed to persist session title from server', { err })
        }
      }
    }

    // Send event to renderer
    const streamEvent: StreamEvent = {
      type: eventType,
      sessionId: hiveSessionId,
      data: event.properties || event,
      ...(isChildEvent ? { childSessionId: sessionId } : {}),
      ...(eventType === 'session.status' && event.properties?.status
        ? { statusPayload: event.properties.status }
        : {})
    }

    opencodeDumper?.recordSdkEvent(dumpSessionKey(eventDirectory, sessionId), {
      stage: 'resolved',
      eventType,
      hiveSessionId,
      directHiveId,
      isChildEvent,
      sessionId,
      directory: eventDirectory,
      properties: event.properties ?? null
    })

    // P0 (OpenCode parity): Token 用量数据已在 `message.updated.properties.info`
    // 里存在，玄圃之前没有提取。这里在不改变原始 `message.updated` 转发的前提下，
    // 额外发出一条 `session.context_usage` 供 Session HQ / Hub 使用。
    if (!isChildEvent && eventType === 'message.updated') {
      this.maybeEmitContextUsage(hiveSessionId, event)
    }

    // P0 (OpenCode parity): SDK 类型里已有 compaction part / session.compacted
    // 事件。我们把它们映射到通用协议，供 renderer 显示「正在压缩上下文」和
    // 「上下文已压缩」提示。
    if (!isChildEvent && eventType === 'message.part.updated') {
      this.maybeEmitCompactionStarted(hiveSessionId, event)
    }
    if (!isChildEvent && eventType === 'session.compacted') {
      emitAgentEvent(this.mainWindow, {
        type: 'session.context_compacted',
        sessionId: hiveSessionId,
        data: event.properties || {}
      })
      opencodeDumper?.recordMarker(dumpSessionKey(eventDirectory, sessionId), {
        type: 'session.context_compacted',
        properties: event.properties ?? null
      })
    }

    // Phase 1.4.5 (OpenCode parity): rewrite tool parts so `part.tool` carries
    // the CanonicalToolName (Bash/Read/Edit/...) the agent-protocol contract
    // expects. Original lowercase name is preserved on `toolDisplay`. Both the
    // live stream and the durable message snapshot benefit from canonical
    // names; ToolCard's case-insensitive fallback remains as a safety net.
    if (eventType === 'message.part.updated') {
      this.canonicalizeToolPart(streamEvent.data)
    }

    emitAgentEvent(this.mainWindow, streamEvent)
    opencodeDumper?.recordCanonicalEvent(dumpSessionKey(eventDirectory, sessionId), streamEvent)

    // Phase 1.4.7 (OpenCode persistence parity): fold every message.* event
    // into the in-memory buffer and flush on `message.updated` so SQLite
    // becomes the source of truth for OpenCode transcripts. We do this AFTER
    // the canonical emit so renderers still see the same events; the DB write
    // is best-effort.
    if (!isChildEvent) {
      try {
        this.persistOpenCodeMessageEvent(hiveSessionId, eventType, event)
      } catch (err) {
        log.debug('OpenCode message persistence failed; continuing', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // Phase 1.4.5 (OpenCode parity): persist a SessionActivity row so the
    // history view can replay this turn just like Codex does. Skip child /
    // subagent events at this layer — only parent-session activities show up
    // in the timeline (matches existing Phase 21.5 emit-agent-tool gating).
    if (!isChildEvent) {
      try {
        this.persistOpenCodeActivity(hiveSessionId, sessionId, event)
      } catch (err) {
        log.debug('OpenCode activity persistence failed; continuing', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // Phase 21.5: emit agent.* field event when a tool part completes.
    // OpenCode streams tool parts via `message.part.updated`; we only emit
    // when state.status transitions to a terminal state (completed/error).
    // Sub-agent / child-session tool calls are skipped entirely (V1).
    if (eventType === 'message.part.updated' && !isChildEvent) {
      try {
        this.maybeEmitAgentToolField(hiveSessionId, event)
      } catch (err) {
        log.debug('Phase 21.5 emit failed; continuing', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  /**
   * Resolve a child/subagent session ID to its parent session ID.
   * Checks the cache first, then queries the SDK.
   */
  private async resolveParentSession(
    instance: OpenCodeInstance,
    childSessionId: string,
    directory?: string
  ): Promise<string | undefined> {
    if (!directory) return undefined

    const key = this.getChildParentKey(directory, childSessionId)
    // Check cache first (empty string = known non-child, skip lookup)
    const cached = instance.childToParentMap.get(key)
    if (cached !== undefined) {
      return cached || undefined
    }

    try {
      const result = await instance.client.session.get({
        path: { id: childSessionId },
        query: { directory }
      })

      const parentID = result.data?.parentID
      if (parentID) {
        instance.childToParentMap.set(key, parentID)
        log.info('Resolved child session to parent', { childSessionId, parentSessionId: parentID })
        return parentID
      }

      // Not a child session — cache to avoid repeated lookups
      instance.childToParentMap.set(key, '')
      return undefined
    } catch (error) {
      log.warn('Failed to resolve parent session', { childSessionId, error })
      return undefined
    }
  }

  /**
   * Send data to the renderer process
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendToRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    } else {
      log.warn('Cannot send to renderer: window not available')
    }
    try {
      const bus = getEventBus()
      if (channel === 'agent:stream') bus.emit('agent:stream', data)
      else if (channel === 'worktree:branchRenamed') bus.emit('worktree:branchRenamed', data)
    } catch {
      // EventBus not available
    }
  }

  /**
   * Show a native notification when a session completes while the app window is unfocused
   */
  private maybeNotifySessionComplete(hiveSessionId: string): void {
    try {
      // Only notify when the window is not focused
      if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.isFocused()) {
        return
      }

      const db = getDatabase()
      const session = db.getSession(hiveSessionId)
      if (!session) {
        log.warn('Cannot notify: session not found', { hiveSessionId })
        return
      }

      const project = db.getProject(session.project_id)
      if (!project) {
        log.warn('Cannot notify: project not found', { projectId: session.project_id })
        return
      }

      notificationService.showSessionComplete({
        projectName: project.name,
        sessionName: session.name || 'Untitled',
        projectId: session.project_id,
        worktreeId: session.worktree_id || '',
        sessionId: hiveSessionId
      })
    } catch (error) {
      log.warn('Failed to show session completion notification', { hiveSessionId, error })
    }
  }

  private maybeNotifyPendingUserFeedback(
    hiveSessionId: string,
    kind: 'question' | 'approval'
  ): void {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.isFocused()) {
        return
      }

      const db = getDatabase()
      const session = db.getSession(hiveSessionId)
      if (!session) {
        log.warn('Cannot notify pending feedback: session not found', { hiveSessionId, kind })
        return
      }

      const project = db.getProject(session.project_id)
      if (!project) {
        log.warn('Cannot notify pending feedback: project not found', {
          hiveSessionId,
          projectId: session.project_id,
          kind
        })
        return
      }

      notificationService.showPendingUserFeedback(
        {
          projectName: project.name,
          sessionName: session.name || 'Untitled',
          projectId: session.project_id,
          worktreeId: session.worktree_id || '',
          sessionId: hiveSessionId
        },
        kind
      )
    } catch (error) {
      log.warn('Failed to show pending user feedback notification', {
        hiveSessionId,
        kind,
        error
      })
    }
  }

  /**
   * List available slash commands from the OpenCode SDK
   */
  async listCommands(worktreePath: string): Promise<
    Array<{
      name: string
      description?: string
      template: string
      agent?: string
      model?: string
      source?: string
      subtask?: boolean
      hints?: string[]
    }>
  > {
    const instance = await this.getOrCreateInstance()

    try {
      const result = await instance.client.command.list({
        query: { directory: worktreePath }
      })
      return result.data || []
    } catch (error) {
      log.warn('Failed to list commands', { worktreePath, error })
      return []
    }
  }

  /**
   * Send a slash command to a session via the SDK command endpoint
   */
  async sendCommand(
    worktreePath: string,
    opencodeSessionId: string,
    command: string,
    args: string,
    modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void> {
    if (!this.instance) {
      throw new Error('No OpenCode instance available')
    }
    const { variant, ...model } = modelOverride ?? this.getSelectedModel()
    await this.instance.client.session.command({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath },
      body: {
        command,
        arguments: args,
        model: `${model.providerID}/${model.modelID}`,
        variant
      }
    })
  }

  /**
   * Rename a session's title via the OpenCode PATCH API
   */
  async renameSession(
    opencodeSessionId: string,
    title: string,
    worktreePath?: string
  ): Promise<void> {
    const instance = await this.getOrCreateInstance()
    await instance.client.session.patch({
      path: { sessionID: opencodeSessionId },
      query: worktreePath ? { directory: worktreePath } : undefined,
      body: { title }
    })
  }

  /**
   * Fork an existing OpenCode session at an optional message boundary.
   */
  async forkSession(
    worktreePath: string,
    opencodeSessionId: string,
    messageId?: string
  ): Promise<{ sessionId: string }> {
    const instance = await this.getOrCreateInstance()

    const result = await instance.client.session.fork({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath },
      body: messageId ? { messageID: messageId } : undefined
    })

    const forkedSessionId = asString(asRecord(result.data)?.id)
    if (!forkedSessionId) {
      throw new Error('Fork succeeded but no session id returned')
    }

    return { sessionId: forkedSessionId }
  }

  /**
   * Cleanup the OpenCode instance
   */
  async cleanup(): Promise<void> {
    log.info('Cleaning up OpenCode instance')
    this.shutdownServer()
  }

  /**
   * Phase 1.4.5 (OpenCode parity): kick off async session-title generation on
   * the first user prompt for a Hive session, mirroring Codex's pattern in
   * `codex-implementer.ts:760-762`.
   *
   * - Idempotent per Hive session (guarded by `titleGenerationStartedByHiveSession`)
   * - Fire-and-forget: errors are logged, never thrown
   * - Skips empty messages
   * - Only applies the generated title when the current DB title is still a
   *   placeholder ("Session N" / "New session 2026-..."), letting the
   *   `session.updated` handler win if OpenCode itself produces a better
   *   title in the meantime
   * - Also calls `renameSession` so the OpenCode server-side title stays in
   *   sync (best-effort)
   */
  private maybeStartTitleGeneration(
    hiveSessionId: string,
    opencodeSessionId: string,
    worktreePath: string,
    parts: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; mime: string; url: string; filename?: string }
    >
  ): void {
    const instance = this.instance
    if (!instance) return
    if (instance.titleGenerationStartedByHiveSession.get(hiveSessionId)) return

    const sourceText = extractTitleSourceText(parts)
    if (!sourceText) return

    instance.titleGenerationStartedByHiveSession.set(hiveSessionId, true)

    void (async () => {
      try {
        const title = await generateOpenCodeSessionTitle(sourceText, worktreePath)
        if (!title) return

        const db = getDatabase()
        const current = db.getSession(hiveSessionId)?.name ?? null
        if (!isPlaceholderSessionTitle(current)) {
          log.info('Skipping generated title — session already has a non-placeholder name', {
            hiveSessionId,
            current
          })
          return
        }

        db.updateSession(hiveSessionId, { name: title })
        log.info('Applied generated OpenCode session title', { hiveSessionId, title })

        // Best-effort sync to OpenCode server so its session record matches.
        try {
          await this.renameSession(opencodeSessionId, title, worktreePath)
        } catch (syncErr) {
          log.warn('Failed to sync generated title to OpenCode server', {
            opencodeSessionId,
            error: syncErr instanceof Error ? syncErr.message : String(syncErr)
          })
        }
      } catch (err) {
        log.warn('Title generation failed', {
          hiveSessionId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })()
  }

  /**
   * P0 (OpenCode parity): extract assistant token usage from
   * `message.updated.properties.info.tokens` and emit a canonical
   * `session.context_usage` event.
   *
   * OpenCode's AssistantMessage already carries:
   *   tokens: { input, output, reasoning, cache: { read, write } }
   *
   * We forward that as-is into the shared agent protocol:
   *   tokens: { input, cacheRead, cacheWrite, output, reasoning }
   *
   * Notes:
   * - user-message echoes are skipped (`role !== 'assistant'`)
   * - child-session updates are skipped by the caller (`!isChildEvent`)
   * - no contextWindow is available on the message object, so we omit it
   */
  private maybeEmitContextUsage(
    hiveSessionId: string,
    event: { properties?: Record<string, unknown> }
  ): void {
    const info = asRecord(event.properties?.info)
    if (!info) return
    if (asString(info.role) !== 'assistant') return

    const tokens = asRecord(info.tokens)
    if (!tokens) return
    const cache = asRecord(tokens.cache)

    const input = asNumber(tokens.input) ?? 0
    const output = asNumber(tokens.output) ?? 0
    const reasoning = asNumber(tokens.reasoning) ?? 0
    const cacheRead = asNumber(cache?.read) ?? 0
    const cacheWrite = asNumber(cache?.write) ?? 0

    if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) {
      return
    }

    const providerID = asString(info.providerID)
    const modelID = asString(info.modelID)

    emitAgentEvent(this.mainWindow, {
      type: 'session.context_usage',
      sessionId: hiveSessionId,
      data: {
        tokens: {
          input,
          cacheRead,
          cacheWrite,
          output,
          reasoning
        },
        ...(providerID && modelID
          ? {
              model: {
                providerID,
                modelID
              }
            }
          : {})
      }
    })
    opencodeDumper?.recordMarker(dumpSessionKey(undefined, hiveSessionId), {
      type: 'session.context_usage',
      tokens: { input, cacheRead, cacheWrite, output, reasoning },
      model: providerID && modelID ? { providerID, modelID } : null
    })
  }

  /**
   * P0 (OpenCode parity): emit `session.compaction_started` when the SDK sends
   * a `message.part.updated` event whose part is a `compaction` marker.
   */
  private maybeEmitCompactionStarted(
    hiveSessionId: string,
    event: { properties?: Record<string, unknown> }
  ): void {
    const part = asRecord(event.properties?.part)
    if (!part || part.type !== 'compaction') return

    emitAgentEvent(this.mainWindow, {
      type: 'session.compaction_started',
      sessionId: hiveSessionId,
      data: {
        ...(typeof part.auto === 'boolean' ? { auto: part.auto } : {})
      }
    })
    opencodeDumper?.recordMarker(dumpSessionKey(undefined, hiveSessionId), {
      type: 'session.compaction_started',
      auto: typeof part.auto === 'boolean' ? part.auto : null
    })
  }

  private trackPendingRequest(
    hiveSessionId: string,
    eventType: string,
    properties?: Record<string, unknown>
  ): void {
    const props = asRecord(properties) ?? {}
    const requestId =
      asString(props.requestId) ??
      asString(props.permissionID) ??
      asString(props.id) ??
      asString(props.questionID)
    if (!requestId) return

    if (eventType === 'question.asked') {
      this.pendingQuestions.set(requestId, hiveSessionId)
      return
    }

    if (eventType === 'permission.asked' || eventType === 'command.approval_needed') {
      this.pendingApprovals.set(requestId, hiveSessionId)
    }
  }

  private clearPendingRequestsForSession(hiveSessionId: string): void {
    for (const [requestId, owner] of this.pendingQuestions.entries()) {
      if (owner === hiveSessionId) this.pendingQuestions.delete(requestId)
    }
    for (const [requestId, owner] of this.pendingApprovals.entries()) {
      if (owner === hiveSessionId) this.pendingApprovals.delete(requestId)
    }
  }

  private async flushAbortDraft(
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<void> {
    if (!this.instance) return

    let latestAssistant: Record<string, unknown> | null = null

    try {
      const result = await this.instance.client.session.messages({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })
      const messages = Array.isArray(result.data) ? result.data : []

      for (const message of messages) {
        const info = messageInfo(message)
        if (info.role === 'assistant') {
          latestAssistant = message as Record<string, unknown>
        }
      }

      if (latestAssistant) {
        // Phase 1.4.8 (parity with Claude Code's markRunningToolsAborted):
        // walk the latest assistant message's parts and synthesize a
        // `message.part.updated` for any tool that's still 'running' /
        // 'pending'. The SDK's own `state.status: completed` may arrive
        // moments later (or never, on hard aborts), but the renderer's
        // streaming buffer needs an immediate transition so the tool card
        // flips out of "Running..." right when the user clicks Stop.
        const parts = (latestAssistant as { parts?: unknown }).parts
        if (Array.isArray(parts)) {
          const now = Date.now()
          for (const rawPart of parts) {
            if (!rawPart || typeof rawPart !== 'object') continue
            const part = rawPart as Record<string, unknown>
            if (part.type !== 'tool') continue
            const state = (part.state as Record<string, unknown> | undefined) ?? {}
            const status = state.status as string | undefined
            if (status !== 'running' && status !== 'pending') continue

            const stateTime =
              (state.time as Record<string, unknown> | undefined) ?? {}
            const abortedState: Record<string, unknown> = {
              ...state,
              status: 'error',
              error:
                typeof state.error === 'string' && state.error
                  ? state.error
                  : 'Aborted by user',
              time: {
                ...stateTime,
                end: typeof stateTime.end === 'number' ? stateTime.end : now
              }
            }
            const abortedPart: Record<string, unknown> = {
              ...part,
              state: abortedState
            }
            // Mutate the latestAssistant snapshot so the message.updated
            // emit + persistence below sees the aborted status too.
            ;(part as Record<string, unknown>).state = abortedState

            const partEvent: Record<string, unknown> = {
              sessionID: opencodeSessionId,
              part: abortedPart
            }
            // canonicalizeToolPart expects the same shape as live SDK events
            // (event.data.part). Run it so the event we synthesise carries
            // the canonical tool name / metadata.
            this.canonicalizeToolPart(partEvent)
            emitAgentEvent(this.mainWindow, {
              type: 'message.part.updated',
              sessionId: hiveSessionId,
              data: partEvent
            })
            opencodeDumper?.recordMarker(
              dumpSessionKey(worktreePath, opencodeSessionId),
              {
                type: 'abort.flush.tool_aborted',
                hiveSessionId,
                callID: typeof part.callID === 'string' ? part.callID : null,
                tool: typeof part.tool === 'string' ? part.tool : null
              }
            )
          }
        }

        emitAgentEvent(this.mainWindow, {
          type: 'message.updated',
          sessionId: hiveSessionId,
          data: latestAssistant
        })
        opencodeDumper?.recordMarker(dumpSessionKey(worktreePath, opencodeSessionId), {
          type: 'abort.flush.latest_assistant',
          hiveSessionId,
          message: latestAssistant
        })
      }
    } catch (error) {
      log.debug('OpenCode abort draft flush: unable to read latest messages', {
        worktreePath,
        opencodeSessionId,
        error
      })
    }

    emitAgentEvent(this.mainWindow, {
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: { type: 'idle' } },
      statusPayload: { type: 'idle' }
    })
    opencodeDumper?.recordMarker(dumpSessionKey(worktreePath, opencodeSessionId), {
      type: 'abort.flush.force_idle',
      hiveSessionId
    })

    // Phase 1.4.7: top up SQLite once the abort flush settles. The live
    // subscription may have lost the very last `message.updated` if abort
    // races with completion, so this hydrate guarantees the persisted row
    // matches what the user sees post-abort.
    void this.hydrateOpenCodeMessagesFromServer(
      hiveSessionId,
      worktreePath,
      opencodeSessionId
    ).catch(() => {})
  }

  /**
   * Phase 1.4.5 (OpenCode parity): persist a SessionActivity record for the
   * given OpenCode event so the history pane can replay the turn (parity with
   * Codex which goes through `mapCodexManagerEventToActivity`).
   *
   * - Tracker (per-Hive-session Set<callID>) lives on the instance so
   *   `running` → `running` transitions correctly emit `tool.updated` instead
   *   of duplicating `tool.started`.
   * - DB writes are best-effort: caller already wraps in try/catch.
   */
  private persistOpenCodeActivity(
    hiveSessionId: string,
    agentSessionId: string,
    event: { type?: string; properties?: Record<string, unknown> }
  ): void {
    const instance = this.instance
    if (!instance) return

    let tracker: ToolStartedTracker | undefined =
      instance.toolStartedTrackerByHiveSession.get(hiveSessionId)
    if (!tracker) {
      tracker = new Set<string>()
      instance.toolStartedTrackerByHiveSession.set(hiveSessionId, tracker)
    }

    const activity = mapOpenCodeEventToActivity(hiveSessionId, agentSessionId, event, tracker)
    if (!activity) return

    const db = getDatabase()
    db.upsertSessionActivity(activity)
  }

  /**
   * Phase 1.4.7: dispatch a `message.*` SDK event into the persistence buffer.
   *
   * - `message.updated`            → merge info, then flush row.
   * - `message.part.updated`       → merge part into the buffer; flush is
   *                                  deferred to the next `message.updated`
   *                                  to avoid write amplification.
   * - `message.removed`            → drop both buffer entry and SQLite row.
   *
   * `event.properties` is the SDK's payload shape from the iterator.
   */
  private persistOpenCodeMessageEvent(
    hiveSessionId: string,
    eventType: string | undefined,
    event: { properties?: Record<string, unknown> }
  ): void {
    if (!eventType) return
    const properties = asRecord(event.properties)
    if (!properties) return

    if (eventType === 'message.updated') {
      const info = asRecord(properties.info)
      if (!info) return
      const merged = this.mergeMessageInfoIntoBuffer(hiveSessionId, info)
      if (!merged) return
      this.persistOpenCodeMessageRow(hiveSessionId, merged.messageId)
      // Phase 1.4.8 (OpenCode plan parity): if this is a plan-agent turn that
      // just finished, synthesize a `plan.ready` event for the renderer.
      // Persist first so the plan markdown is in SQLite by the time the user
      // accepts/rejects (same ordering Codex uses).
      this.maybeEmitPlanReady(hiveSessionId, info)
      return
    }

    if (eventType === 'message.part.updated') {
      const part = asRecord(properties.part)
      if (!part) return
      this.mergeMessagePartIntoBuffer(hiveSessionId, part)
      return
    }

    if (eventType === 'message.removed') {
      const messageId =
        asString(properties.messageID) ??
        asString(asRecord(properties.info)?.id)
      if (!messageId) return
      this.removeOpenCodeMessage(hiveSessionId, messageId)
    }
  }

  // ─── Phase 1.4.5 OpenCode parity (existing helpers below) ────────────────
  /**
   * Phase 1.4.5 (OpenCode parity): rewrite a `message.part.updated` payload
   * in place so any tool part carries a CanonicalToolName.
   *
   * OpenCode's SDK emits lowercase native names ('bash' / 'read' / ...) on
   * `part.tool`. The agent-protocol contract (src/shared/types/agent-protocol.ts)
   * requires CanonicalToolName ('Bash' / 'Read' / ...). We mutate the part
   * object so:
   *   - `tool`         → CanonicalToolName (Bash / Read / Edit / Grep / ...)
   *   - `toolDisplay`  → original raw name (preserved for UI display)
   *   - `mcpServer`    → server segment when classified as 'McpTool'
   *
   * Mutation is shallow and safe because `streamEvent.data` is fresh per event
   * (event.properties from the SDK iterator). Non-tool parts are ignored.
   */
  private canonicalizeToolPart(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const dataRecord = data as Record<string, unknown>
    const part = dataRecord.part as Record<string, unknown> | undefined
    if (!part || part.type !== 'tool') return
    const rawName = part.tool
    if (typeof rawName !== 'string' || rawName.length === 0) return

    const classified = classifyOpenCodeTool(rawName)
    part.tool = classified.tool
    if (classified.toolDisplay && !part.toolDisplay) {
      part.toolDisplay = classified.toolDisplay
    }
    if (classified.mcpServer && !part.mcpServer) {
      part.mcpServer = classified.mcpServer
    }

    // Phase 1.4.8 (OpenCode parity): OpenCode's Edit/Write tools only surface
    // the unified diff on `state.metadata.diff` / `state.metadata.filediff`,
    // while Claude/Codex expose it directly on the tool input. The renderer's
    // FileWriteCard already accepts `input.diff` / `input.additions` /
    // `input.deletions`, so lifting the diff onto the input here lets the
    // same card render OpenCode Edit cards with file path + inline diff,
    // matching the Claude Code / Codex experience.
    const state = asRecord(part.state)
    if (!state) return
    const input = asRecord(state.input)
    if (!input) return
    const metadata = asRecord(state.metadata)
    if (!metadata) return

    const filediff = asRecord(metadata.filediff)
    const unifiedDiff =
      asString(metadata.diff) ?? asString(filediff?.patch) ?? null
    if (unifiedDiff && !asString(input.diff)) {
      input.diff = unifiedDiff
    }
    const additions = asNumber(filediff?.additions)
    if (additions !== undefined && asNumber(input.additions) === undefined) {
      input.additions = additions
    }
    const deletions = asNumber(filediff?.deletions)
    if (deletions !== undefined && asNumber(input.deletions) === undefined) {
      input.deletions = deletions
    }
  }

  // ─── Phase 1.4.7 OpenCode persistence parity ─────────────────────────────
  //
  // Codex / Claude Code already shadow every assistant + user turn into the
  // `session_messages` SQLite table so the timeline survives runtime restarts,
  // works offline, drives usage analytics, and lets the Hub surface the same
  // history. OpenCode used to lean on the SDK server-side transcript for that,
  // which left the new UI staring at an empty pane until the runtime
  // reconnected. The helpers below mirror Codex's persistence model: we keep
  // an in-memory buffer of `messageId → { info, parts }`, fold every
  // `message.updated` / `message.part.updated` into it, and on each
  // `message.updated` flush the merged shape into `session_messages` via
  // `upsertSessionMessageByOpenCodeId`.

  private getMessageBuffer(hiveSessionId: string, messageId: string): OpenCodeMessageBuffer {
    const instance = this.instance
    if (!instance) {
      // Caller already guarded; this only protects against late-fire from
      // disposed listeners.
      return { info: null, parts: new Map(), partOrder: [], role: null, createdAt: null }
    }
    let perSession = instance.messageBuffersByHiveSession.get(hiveSessionId)
    if (!perSession) {
      perSession = new Map()
      instance.messageBuffersByHiveSession.set(hiveSessionId, perSession)
    }
    let buffer = perSession.get(messageId)
    if (!buffer) {
      buffer = { info: null, parts: new Map(), partOrder: [], role: null, createdAt: null }
      perSession.set(messageId, buffer)
    }
    return buffer
  }

  private mergeMessageInfoIntoBuffer(
    hiveSessionId: string,
    info: Record<string, unknown>
  ): { messageId: string; role: string; completed: boolean } | null {
    const messageId = asString(info.id)
    if (!messageId) return null
    const role = asString(info.role) ?? null
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return null

    const buffer = this.getMessageBuffer(hiveSessionId, messageId)
    buffer.info = info
    buffer.role = role
    const time = asRecord(info.time)
    const createdMs = asNumber(time?.created)
    if (createdMs && !buffer.createdAt) {
      buffer.createdAt = new Date(createdMs).toISOString()
    }
    const completedMs = asNumber(time?.completed)
    return { messageId, role, completed: completedMs !== undefined }
  }

  private mergeMessagePartIntoBuffer(
    hiveSessionId: string,
    part: Record<string, unknown>
  ): { messageId: string; partId: string } | null {
    const messageId = asString(part.messageID)
    const partId = asString(part.id)
    if (!messageId || !partId) return null

    const buffer = this.getMessageBuffer(hiveSessionId, messageId)
    if (!buffer.parts.has(partId)) {
      buffer.partOrder.push(partId)
    }
    buffer.parts.set(partId, part)
    return { messageId, partId }
  }

  private removeOpenCodeMessage(hiveSessionId: string, messageId: string): void {
    const instance = this.instance
    if (!instance) return
    const perSession = instance.messageBuffersByHiveSession.get(hiveSessionId)
    perSession?.delete(messageId)
    try {
      const db = getDatabase()
      const existing = db.getSessionMessageByOpenCodeId(hiveSessionId, messageId)
      if (existing) db.deleteSessionMessage(existing.id)
    } catch (error) {
      log.warn('Failed to delete persisted OpenCode message', {
        hiveSessionId,
        messageId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private buildPersistedRowFromBuffer(
    hiveSessionId: string,
    messageId: string,
    buffer: OpenCodeMessageBuffer
  ): {
    rawContent: string
    persistedContent: string
    partsJson: unknown[]
    role: string
    createdAt: string
    messageJson: unknown
  } | null {
    const role = buffer.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return null

    const partsJson = buffer.partOrder
      .map((id) => buffer.parts.get(id))
      .filter((part): part is Record<string, unknown> => Boolean(part))

    const rawContent = partsJson
      .map((part) => {
        if (part.type === 'text') return asString(part.text) ?? ''
        if (part.type === 'reasoning') return asString(part.text) ?? ''
        return ''
      })
      .join('')

    const persistedContent =
      role === 'user' ? stripInjectedContextEnvelope(rawContent) : rawContent

    return {
      rawContent,
      persistedContent,
      partsJson,
      role,
      createdAt: buffer.createdAt ?? new Date().toISOString(),
      messageJson: { info: buffer.info ?? {}, parts: partsJson },
    }
  }

  private persistOpenCodeMessageRow(hiveSessionId: string, messageId: string): void {
    const instance = this.instance
    if (!instance) return
    const perSession = instance.messageBuffersByHiveSession.get(hiveSessionId)
    const buffer = perSession?.get(messageId)
    if (!buffer) return
    if (!buffer.info && buffer.parts.size === 0) return

    const built = this.buildPersistedRowFromBuffer(hiveSessionId, messageId, buffer)
    if (!built) return

    try {
      const db = getDatabase()
      db.upsertSessionMessageByOpenCodeId({
        session_id: hiveSessionId,
        role: built.role,
        content: built.persistedContent,
        opencode_message_id: messageId,
        opencode_message_json: JSON.stringify(built.messageJson),
        opencode_parts_json: JSON.stringify(built.partsJson),
        created_at: built.createdAt
      })
    } catch (error) {
      log.warn('Failed to persist OpenCode message', {
        hiveSessionId,
        messageId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Phase 1.4.8 (OpenCode plan parity): when a plan-mode assistant turn
   * finishes, synthesize a `plan.ready` event so the renderer's
   * `useAgentEventBridge` arms its pendingPlan slot and the plan FAB / card
   * appear (parity with Codex's plan-mode flow in
   * `codex-implementer.ts:983-1015`).
   *
   * Detection signal (verified against the 2026-05-02T02:09 plan-mode dump):
   *   - `info.role === 'assistant'`
   *   - `info.agent === 'plan'`           (the plan agent is active)
   *   - `info.finish === 'stop'`          (the model emitted a stop, not tool-calls)
   *   - `info.time.completed != null`     (turn ended cleanly, not still streaming)
   *   - `info.error == null`              (skip aborted / errored turns)
   *
   * Emitted exactly once per messageId via `planEmittedByHiveSession`. The
   * plan content is the concatenated text of the buffered assistant parts
   * (same source the SQLite row is built from), so any mid-turn
   * `<proposed_plan>` block — or a free-form markdown plan — flows through.
   *
   * `requestId` is `opencode-plan:<hiveSessionId>:<messageId>` — stable for
   * the same plan, distinct across plans. Renderer keeps `requestId` as the
   * key for pendingPlan / approvals / interrupt-queue, so this lets multiple
   * plans coexist if the user keeps asking for revisions.
   */
  private maybeEmitPlanReady(
    hiveSessionId: string,
    info: Record<string, unknown>
  ): void {
    const instance = this.instance
    if (!instance) return

    if (asString(info.role) !== 'assistant') return
    if (asString(info.agent) !== 'plan') return
    if (asString(info.finish) !== 'stop') return
    const time = asRecord(info.time)
    if (!time || !asNumber(time.completed)) return
    if (asRecord(info.error)) return

    const messageId = asString(info.id)
    if (!messageId) return

    let emitted = instance.planEmittedByHiveSession.get(hiveSessionId)
    if (!emitted) {
      emitted = new Set<string>()
      instance.planEmittedByHiveSession.set(hiveSessionId, emitted)
    }
    if (emitted.has(messageId)) return

    const perSession = instance.messageBuffersByHiveSession.get(hiveSessionId)
    const buffer = perSession?.get(messageId)
    if (!buffer) return

    // Pull the plan markdown from the buffered text parts. Same source the
    // SQLite row uses, so what users approve is what they read.
    const planText = buffer.partOrder
      .map((id) => buffer.parts.get(id))
      .filter((part): part is Record<string, unknown> => Boolean(part))
      .map((part) => (part.type === 'text' ? asString(part.text) ?? '' : ''))
      .join('')
      .trim()
    if (!planText) return

    emitted.add(messageId)

    const requestId = `opencode-plan:${hiveSessionId}:${messageId}`
    const opencodeSessionId = asString(info.sessionID) ?? null

    // Phase 1.4.8: persist `plan.ready` SessionActivity *before* the live
    // event fires. PlanCard rendering in the durable timeline goes through
    // `parsePlanPartFromActivity` (timeline-mappers.ts:722), which only
    // recognizes activity rows with kind === 'plan.ready'. Without this row,
    // the FAB pops up (via the live event → useAgentEventBridge) but no card
    // appears in the message stream, and a later refresh / restart loses the
    // plan entirely. Codex does the same in `persistSyntheticActivity`
    // (codex-implementer.ts:996-1005).
    try {
      const db = getDatabase()
      db.upsertSessionActivity({
        id: requestId,
        session_id: hiveSessionId,
        agent_session_id: opencodeSessionId,
        thread_id: opencodeSessionId,
        turn_id: null,
        item_id: messageId,
        request_id: requestId,
        kind: 'plan.ready',
        tone: 'info',
        summary: 'Plan ready',
        payload_json: JSON.stringify({
          plan: planText,
          toolUseID: messageId,
          requestId
        })
      })
    } catch (err) {
      log.warn('Failed to persist OpenCode plan.ready activity', {
        hiveSessionId,
        messageId,
        error: err instanceof Error ? err.message : String(err)
      })
    }

    emitAgentEvent(this.mainWindow, {
      type: 'plan.ready',
      sessionId: hiveSessionId,
      data: {
        id: requestId,
        requestId,
        plan: planText,
        toolUseID: messageId
      }
    })
    opencodeDumper?.recordMarker(undefined, {
      type: 'plan.ready.synth',
      hiveSessionId,
      messageId,
      requestId,
      planLength: planText.length
    })
    log.info('OpenCode plan.ready synthesized from plan-mode turn', {
      hiveSessionId,
      messageId,
      requestId,
      planLength: planText.length
    })
  }

  /**
   * Phase 1.4.7: hydrate `session_messages` from the OpenCode server-side
   * transcript. Used right after `connect` / `reconnect` / `abort` so SQLite
   * picks up any messages we missed (e.g. before the live event subscription
   * was active). Best-effort; logs and swallows errors.
   */
  private async hydrateOpenCodeMessagesFromServer(
    hiveSessionId: string,
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<void> {
    const instance = this.instance
    if (!instance) return

    let messages: unknown[] = []
    try {
      const result = await instance.client.session.messages({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })
      messages = Array.isArray(result.data) ? result.data : []
    } catch (error) {
      log.debug('hydrateOpenCodeMessagesFromServer: messages fetch failed', {
        hiveSessionId,
        opencodeSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    let persisted = 0
    for (const message of messages) {
      const record = asRecord(message)
      const info = asRecord(record?.info)
      if (!info) continue
      const merged = this.mergeMessageInfoIntoBuffer(hiveSessionId, info)
      if (!merged) continue
      const parts = Array.isArray(record?.parts) ? record.parts : []
      for (const part of parts) {
        const partRecord = asRecord(part)
        if (!partRecord) continue
        // Make sure the part carries the message id so the buffer keying works
        // even if the SDK drops it on history fetches.
        const partWithMessage =
          asString(partRecord.messageID) === merged.messageId
            ? partRecord
            : { ...partRecord, messageID: merged.messageId }
        this.mergeMessagePartIntoBuffer(hiveSessionId, partWithMessage)
      }
      this.persistOpenCodeMessageRow(hiveSessionId, merged.messageId)
      persisted += 1
    }

    if (persisted > 0) {
      log.info('Hydrated OpenCode messages into SQLite', {
        hiveSessionId,
        opencodeSessionId,
        persisted
      })
    }
  }


  /**
   * Phase 21.5: emit an agent.* field event when an OpenCode tool part
   * reaches a terminal state (completed/error).
   *
   * OpenCode streams tool parts via `message.part.updated` events. A tool
   * part carries `{ type: 'tool', callID, tool, state: { status, input,
   * output, error, time } }`. Non-tool parts (text/reasoning) are ignored.
   *
   * Only terminal statuses trigger emission — mid-stream updates would
   * produce duplicate events for the same tool_use_id.
   */
  private maybeEmitAgentToolField(
    hiveSessionId: string,
    event: {
      properties?: {
        part?: Record<string, unknown>
      }
    }
  ): void {
    const part = event.properties?.part
    if (!part || part.type !== 'tool') return

    const state = (part.state as Record<string, unknown> | undefined) ?? {}
    const status = state.status as string | undefined
    // Only emit on terminal transitions — avoids double-counting the stream
    // of 'running' updates OpenCode sends as input_json_delta arrives.
    if (status !== 'completed' && status !== 'error') return

    const toolUseId = (part.callID as string) || (part.id as string) || ''
    if (!toolUseId) return

    const toolName = (part.tool as string) || 'unknown'
    const input = (state.input as Record<string, unknown> | undefined) ?? {}
    const outputText = state.output as string | undefined
    const errorText = state.error as string | undefined
    const stateTime = state.time as Record<string, number> | undefined
    const durationMs =
      stateTime?.start && stateTime?.end ? stateTime.end - stateTime.start : undefined

    const db = getDatabase()
    const hiveSession = db.getSession(hiveSessionId)
    if (!hiveSession?.worktree_id) return
    const worktreeRow = db.getWorktree(hiveSession.worktree_id)
    if (!worktreeRow) return

    void import('../field/emit-agent-tool').then(({ emitAgentToolEvent }) => {
      emitAgentToolEvent({
        worktreeId: worktreeRow.id,
        projectId: worktreeRow.project_id ?? null,
        sessionId: hiveSessionId,
        worktreePath: worktreeRow.path,
        toolName,
        toolUseId,
        // Child/subagent events are filtered at the caller (`!isChildEvent`).
        parentToolUseId: null,
        input,
        output: {
          text: status === 'error' ? undefined : outputText,
          error: status === 'error' ? errorText ?? outputText : undefined,
          exitCode: status === 'error' ? 1 : undefined,
          durationMs
        }
      })
    })
  }
}

// Export singleton instance
export const openCodeService = new OpenCodeService()
