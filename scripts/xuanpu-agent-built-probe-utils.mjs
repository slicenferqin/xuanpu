import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

let electronMocksInstalled = false

export function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

export function fail(message, extra = {}) {
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

export function findBuiltImplementerChunk() {
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

export function installElectronMainMocks() {
  if (electronMocksInstalled) return

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

  electronMocksInstalled = true
}

export function loadBuiltXuanpuAgentImplementer() {
  const implementerChunk = findBuiltImplementerChunk()
  if (!implementerChunk) {
    throw new Error(
      'Built xuanpu-agent implementer chunk was not found. Run XUANPU_AGENT_RUNTIME=1 pnpm build first.'
    )
  }

  installElectronMainMocks()
  const builtModule = require(implementerChunk)
  const XuanpuAgentImplementer = builtModule.xuanpuAgentImplementer?.XuanpuAgentImplementer
  if (!XuanpuAgentImplementer) {
    throw new Error('Built xuanpu-agent implementer export was not found.')
  }

  return { XuanpuAgentImplementer, implementerChunk }
}

export function noop() {}
