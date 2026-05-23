#!/usr/bin/env node

import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1',
  google: 'gemini-2.5-pro'
}

const PROVIDER_ENV_KEYS = {
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY']
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

function fail(message, extra = {}) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: message,
        ...extra
      },
      null,
      2
    )
  )
  process.exitCode = 1
}

function hasCredential(providerID) {
  const envKeys = PROVIDER_ENV_KEYS[providerID] ?? []
  return envKeys.some((key) => typeof process.env[key] === 'string' && process.env[key].trim())
}

function findBuiltImplementerChunk() {
  const outMain = resolve(process.cwd(), 'out/main')
  let files
  try {
    files = readdirSync(outMain)
  } catch {
    return null
  }

  const chunk = files.find(
    (file) => file.startsWith('xuanpu-agent-implementer-') && file.endsWith('.js')
  )
  return chunk ? resolve(outMain, chunk) : null
}

function installElectronMainMocks() {
  const Module = require('node:module')
  const originalLoad = Module._load
  const noop = () => {}
  const neverReady = new Promise(() => {})

  const electronMock = {
    app: {
      commandLine: { appendSwitch: noop },
      getName: () => 'Xuanpu Probe',
      getPath: (name) => (name === 'home' ? process.env.HOME || '/tmp' : '/tmp'),
      getVersion: () => '0.0.0-probe',
      on: noop,
      quit: noop,
      setName: noop,
      whenReady: () => neverReady
    },
    BrowserWindow: class {
      static getAllWindows() {
        return []
      }

      constructor() {
        this.webContents = {
          on: noop,
          send: noop,
          session: { webRequest: { onHeadersReceived: noop } },
          setWindowOpenHandler: noop
        }
      }

      isDestroyed() {
        return false
      }

      loadFile() {}

      loadURL() {}

      on() {}

      once() {}

      show() {}
    },
    clipboard: {
      readText: () => '',
      writeText: noop
    },
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] })
    },
    ipcMain: {
      handle: noop,
      on: noop,
      removeHandler: noop
    },
    Menu: {
      buildFromTemplate: () => ({}),
      setApplicationMenu: noop
    },
    nativeImage: {
      createFromDataURL: () => ({}),
      createFromPath: () => ({ isEmpty: () => true })
    },
    protocol: {
      handle: noop,
      registerSchemesAsPrivileged: noop
    },
    session: {
      defaultSession: { webRequest: { onHeadersReceived: noop } }
    },
    shell: {
      openExternal: noop,
      openPath: async () => ''
    }
  }

  Module._load = function loadWithProbeMocks(request, parent, isMain) {
    if (request === 'electron') return electronMock
    if (request === '@electron-toolkit/utils') {
      return {
        electronApp: { setAppUserModelId: noop },
        is: { dev: false },
        optimizer: { watchWindowShortcuts: noop }
      }
    }
    if (request === 'electron-updater') {
      return {
        autoUpdater: {
          checkForUpdatesAndNotify: noop,
          on: noop,
          quitAndInstall: noop
        }
      }
    }

    return originalLoad.apply(this, arguments)
  }
}

async function runProbe() {
  if (process.env.XUANPU_AGENT_REAL_PROVIDER_PROBE !== '1') {
    printJson({
      ok: true,
      status: 'skipped',
      reason: 'Set XUANPU_AGENT_REAL_PROVIDER_PROBE=1 to call a real provider.'
    })
    return
  }

  if (Object.prototype.hasOwnProperty.call(process.env, 'XUANPU_AGENT_MOCK_RESPONSE')) {
    fail('Unset XUANPU_AGENT_MOCK_RESPONSE before running the real provider probe.')
    return
  }

  const providerID = process.env.XUANPU_AGENT_PROVIDER_ID || process.env.XUANPU_AGENT_PROVIDER || 'anthropic'
  const modelID =
    process.env.XUANPU_AGENT_MODEL_ID ||
    process.env.XUANPU_AGENT_MODEL ||
    DEFAULT_MODELS[providerID] ||
    ''
  const prompt =
    process.env.XUANPU_AGENT_REAL_PROVIDER_PROMPT ||
    'Reply with one short sentence confirming the xuanpu-agent real provider probe succeeded.'

  if (!modelID) {
    fail('No model selected for real provider probe.', { providerID })
    return
  }

  if (!hasCredential(providerID)) {
    fail('Missing provider credential environment variable for real provider probe.', {
      providerID,
      expectedEnv: PROVIDER_ENV_KEYS[providerID] ?? []
    })
    return
  }

  const implementerChunk = findBuiltImplementerChunk()
  if (!implementerChunk) {
    fail('Built xuanpu-agent implementer chunk was not found. Run XUANPU_AGENT_RUNTIME=1 pnpm build first.')
    return
  }

  installElectronMainMocks()
  const builtModule = require(implementerChunk)
  const XuanpuAgentImplementer = builtModule.xuanpuAgentImplementer?.XuanpuAgentImplementer
  if (!XuanpuAgentImplementer) {
    fail('Built xuanpu-agent implementer export was not found.', { implementerChunk })
    return
  }

  const capturedMessages = []
  const implementer = new XuanpuAgentImplementer()
  implementer.setDatabaseService({
    createSessionMessage: (message) => capturedMessages.push(message),
    getSessionMessages: () => [],
    getWorktreeByPath: () => null,
    updateSession: noop
  })

  const worktreePath = process.cwd()
  const hiveSessionId = `xuanpu-agent-real-provider-probe-${Date.now()}`
  const timeoutMs = Number(process.env.XUANPU_AGENT_REAL_PROVIDER_TIMEOUT_MS || 60000)
  const { sessionId } = await implementer.connect(worktreePath, hiveSessionId)

  let didTimeOut = false
  const timeout = setTimeout(() => {
    didTimeOut = true
    void implementer.abort(worktreePath, sessionId).finally(() => {
      fail('Real provider probe timed out.', { providerID, modelID, timeoutMs })
      process.exit(1)
    })
  }, timeoutMs)

  try {
    implementer.setSelectedModel({ providerID, modelID })
    await implementer.prompt(worktreePath, sessionId, prompt, { providerID, modelID })
    if (didTimeOut) return

    const assistantMessage = capturedMessages
      .filter((message) => message.role === 'assistant')
      .at(-1)
    const responseText = assistantMessage?.content ?? ''

    printJson({
      ok: true,
      status: 'completed',
      providerID,
      modelID,
      responseChars: responseText.length,
      responsePreview: responseText.slice(0, 200),
      persistedMessageCount: capturedMessages.length
    })
  } catch (error) {
    if (!didTimeOut) {
      fail('Real provider probe failed.', {
        providerID,
        modelID,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
    }
  } finally {
    clearTimeout(timeout)
    await implementer.disconnect(worktreePath, sessionId).catch(() => {})
  }
}

function noop() {}

void runProbe()
