import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

let electronMocksInstalled = false
const sqliteProbeState = {
  settings: new Map(),
  contextPackages: []
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
}

class FakeSqliteStatement {
  constructor(sql) {
    this.sql = sql
    this.normalized = normalizeSql(sql)
  }

  run(...args) {
    if (this.normalized.includes('insert into field_context_packages')) {
      sqliteProbeState.contextPackages.push({
        id: args[0],
        session_id: args[1],
        worktree_id: args[2],
        runtime_id: args[3],
        model_provider_id: args[4],
        model_id: args[5],
        created_at: args[6],
        budget_profile: args[7],
        approx_tokens: args[8],
        sections_json: args[9],
        rendered_markdown: args[10],
        decisions_json: args[11]
      })
    } else if (this.normalized.includes('settings')) {
      if (args.length >= 2) {
        sqliteProbeState.settings.set(String(args[0]), String(args[1]))
      }
    }

    return { changes: 1, lastInsertRowid: 1 }
  }

  get(...args) {
    if (this.normalized.includes('from settings')) {
      const value = sqliteProbeState.settings.get(String(args[0]))
      return value === undefined ? undefined : { value }
    }
    return undefined
  }

  all() {
    return []
  }
}

class FakeSqliteDatabase {
  pragma() {}

  exec() {}

  prepare(sql) {
    return new FakeSqliteStatement(sql)
  }

  transaction(fn) {
    return (...args) => fn(...args)
  }

  close() {}
}

export function resetBuiltProbeSqliteState() {
  sqliteProbeState.settings.clear()
  sqliteProbeState.contextPackages.length = 0
}

export function getBuiltProbeSqliteState() {
  return sqliteProbeState
}

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
    if (request === 'better-sqlite3' && process.env.XUANPU_AGENT_BUILT_PROBE_FAKE_SQLITE === '1') {
      return FakeSqliteDatabase
    }
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
  const XuanpuAgentImplementer =
    builtModule.xuanpuAgentImplementer?.XuanpuAgentImplementer ?? builtModule.XuanpuAgentImplementer
  if (!XuanpuAgentImplementer) {
    throw new Error('Built xuanpu-agent implementer export was not found.')
  }

  return { XuanpuAgentImplementer, implementerChunk }
}

export function noop() {}
