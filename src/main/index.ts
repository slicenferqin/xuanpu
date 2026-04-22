import { loadShellEnv } from './services/shell-env'
import { app, shell, BrowserWindow, screen, ipcMain, clipboard } from 'electron'
import { join } from 'path'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { electronApp, is } from '@electron-toolkit/utils'
import { getDatabase, closeDatabase } from './db'
import { getFieldEventSink } from './field/sink'
import { getEpisodicMemoryUpdater } from './field/episodic-updater'
import {
  registerDatabaseHandlers,
  registerProjectHandlers,
  registerWorktreeHandlers,
  registerAgentHandlers,
  cleanupAgentHandlers,
  registerFileTreeHandlers,
  cleanupFileTreeWatchers,
  registerGitFileHandlers,
  cleanupWorktreeWatchers,
  cleanupBranchWatchers,
  registerSettingsHandlers,
  registerFileHandlers,
  registerScriptHandlers,
  cleanupScripts,
  registerTerminalHandlers,
  cleanupTerminals,
  registerUpdaterHandlers,
  registerConnectionHandlers,
  registerUsageHandlers,
  registerTimelineHandlers,
  registerFieldHandlers
} from './ipc'
import { buildMenu, updateMenuState } from './menu'
import type { MenuState } from './menu'
import { createLogger, getLogDir } from './services/logger'
import { detectAgentSdks } from './services/system-info'
import {
  openCommandInSystemTerminal,
  runOnboardingDoctor
} from './services/onboarding-doctor'
import { createResponseLog, appendResponseLog } from './services/response-logger'
import { notificationService } from './services/notification-service'
import { updaterService } from './services/updater'
import { ClaudeCodeImplementer } from './services/claude-code-implementer'
import { CodexImplementer } from './services/codex-implementer'
import { openCodeService } from './services/opencode-service'
import { AgentRuntimeManager } from './services/agent-runtime-manager'
import { resolveClaudeBinaryPath } from './services/claude-binary-resolver'
import { telemetryService } from './services/telemetry-service'
import { ensureForkDataDir } from './services/fork-data-migration'
import { APP_BUNDLE_ID, APP_CLI_NAME, APP_PRODUCT_NAME } from '@shared/app-identity'

const log = createLogger({ component: 'Main' })

const appStartTime = Date.now()

app.setName(APP_PRODUCT_NAME)

// Parse CLI flags
const cliArgs = process.argv.slice(2)
const isLogMode = cliArgs.includes('--log')
const isHeadless = cliArgs.includes('--headless')

// Module-level reference so shutdown hooks can call cleanupAll().
let agentRuntimeManager: AgentRuntimeManager | null = null
const headlessPort = cliArgs.includes('--port')
  ? parseInt(cliArgs[cliArgs.indexOf('--port') + 1])
  : undefined
const headlessBind = cliArgs.includes('--bind') ? cliArgs[cliArgs.indexOf('--bind') + 1] : undefined
const isRotateKey = cliArgs.includes('--rotate-key')
const isRegenCerts = cliArgs.includes('--regen-certs')
const isShowStatus = cliArgs.includes('--show-status')
const isKill = cliArgs.includes('--kill')
const isUnlock = cliArgs.includes('--unlock')

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized?: boolean
}

function getBoundsFile(): string {
  return join(app.getPath('userData'), 'window-bounds.json')
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const boundsFile = getBoundsFile()
    if (existsSync(boundsFile)) {
      const data = readFileSync(boundsFile, 'utf-8')
      const bounds = JSON.parse(data) as WindowBounds

      // Validate that the bounds are still valid (screen might have changed)
      const displays = screen.getAllDisplays()
      const isOnScreen = displays.some((display) => {
        const { x, y, width, height } = display.bounds
        return (
          bounds.x >= x &&
          bounds.y >= y &&
          bounds.x + bounds.width <= x + width &&
          bounds.y + bounds.height <= y + height
        )
      })

      if (isOnScreen) {
        return bounds
      }
    }
  } catch {
    // Ignore errors, use defaults
  }
  return null
}

function saveWindowBounds(window: BrowserWindow): void {
  try {
    const bounds = window.getBounds()
    const isMaximized = window.isMaximized()

    // Ensure directory exists
    const dir = app.getPath('userData')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(getBoundsFile(), JSON.stringify({ ...bounds, isMaximized }))
  } catch {
    // Ignore save errors
  }
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const savedBounds = loadWindowBounds()

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1200,
    height: savedBounds?.height ?? 800,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 15, y: 10 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Restore maximized state
  if (savedBounds?.isMaximized) {
    mainWindow.maximize()
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Emit focus event to renderer for git refresh on window focus
  mainWindow.on('focus', () => {
    mainWindow!.webContents.send('app:windowFocused')
  })

  // Save window bounds on resize and move
  mainWindow.on('resize', () => saveWindowBounds(mainWindow))
  mainWindow.on('move', () => saveWindowBounds(mainWindow))
  mainWindow.on('close', () => saveWindowBounds(mainWindow))

  // Intercept Cmd+T (macOS) / Ctrl+T (Windows/Linux) before Chromium consumes it
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.key.toLowerCase() === 't' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      mainWindow!.webContents.send('shortcut:new-session')
    }

    // Intercept Cmd+D — forward to renderer to toggle file search dialog
    if (
      input.key.toLowerCase() === 'd' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      mainWindow!.webContents.send('shortcut:file-search')
    }

    // Intercept Cmd+W — never close the window, forward to renderer to close session tab
    if (
      input.key.toLowerCase() === 'w' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      mainWindow!.webContents.send('shortcut:close-session')
    }

    // Zoom In (Cmd+= / Cmd+Shift+=)
    if (
      (input.key === '=' || input.key === '+') &&
      (input.meta || input.control) &&
      !input.alt &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      const wc = mainWindow!.webContents
      const current = wc.getZoomLevel()
      wc.setZoomLevel(Math.min(current + 0.5, 5))
      mainWindow!.webContents.send('zoom:changed', wc.getZoomLevel())
    }

    // Zoom Out (Cmd+-)
    if (
      input.key === '-' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      const wc = mainWindow!.webContents
      const current = wc.getZoomLevel()
      wc.setZoomLevel(Math.max(current - 0.5, -5))
      mainWindow!.webContents.send('zoom:changed', wc.getZoomLevel())
    }

    // Reset Zoom (Cmd+0)
    if (
      input.key === '0' &&
      (input.meta || input.control) &&
      !input.alt &&
      !input.shift &&
      input.type === 'keyDown'
    ) {
      event.preventDefault()
      mainWindow!.webContents.setZoomLevel(0)
      mainWindow!.webContents.send('zoom:changed', 0)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer based on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Register system IPC handlers
function registerSystemHandlers(): void {
  // Get log directory path
  ipcMain.handle('system:getLogDir', () => {
    return getLogDir()
  })

  // Get app version
  ipcMain.handle('system:getAppVersion', () => {
    return app.getVersion()
  })

  // Get app paths
  ipcMain.handle('system:getAppPaths', () => {
    return {
      userData: app.getPath('userData'),
      home: app.getPath('home'),
      logs: getLogDir()
    }
  })

  // Check if response logging is enabled
  ipcMain.handle('system:isLogMode', () => isLogMode)

  // Open a URL in Chrome (or default browser) with optional custom command
  ipcMain.handle(
    'system:openInChrome',
    async (_event, { url, customCommand }: { url: string; customCommand?: string }) => {
      try {
        if (customCommand) {
          // If the command contains {url}, substitute it; otherwise append the URL
          const cmd = customCommand.includes('{url}')
            ? customCommand.replace(/\{url\}/g, url)
            : `${customCommand} ${url}`
          await new Promise<void>((resolve, reject) => {
            exec(cmd, (error) => {
              if (error) reject(error)
              else resolve()
            })
          })
        } else {
          await shell.openExternal(url)
        }
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  // Open a path in an external app (Cursor, Ghostty) or copy to clipboard
  ipcMain.handle('system:openInApp', async (_, appName: string, path: string) => {
    try {
      switch (appName) {
        case 'cursor':
          if (process.platform === 'darwin') {
            spawn('open', ['-a', 'Cursor', path], { detached: true, stdio: 'ignore' })
          } else if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', 'cursor', path], {
              detached: true,
              stdio: 'ignore'
            })
          } else {
            spawn('cursor', [path], { detached: true, stdio: 'ignore' })
          }
          break
        case 'ghostty':
          if (process.platform === 'win32') {
            return { success: false, error: 'Ghostty is not available on Windows' }
          }
          spawn('open', ['-a', 'Ghostty', path], { detached: true, stdio: 'ignore' })
          break
        case 'android-studio':
          if (process.platform === 'darwin') {
            spawn('open', ['-a', 'Android Studio', path], { detached: true, stdio: 'ignore' })
          } else if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', 'studio64.exe', path], {
              detached: true,
              stdio: 'ignore'
            })
          } else {
            spawn('studio', [path], { detached: true, stdio: 'ignore' })
          }
          break
        case 'copy-path':
          clipboard.writeText(path)
          break
        default:
          return { success: false, error: `Unknown app: ${appName}` }
      }
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open in app'
      }
    }
  })

  // Detect which agent SDKs are installed on the system (first-launch setup)
  ipcMain.handle('system:detectAgentRuntimes', () => {
    return detectAgentSdks()
  })

  ipcMain.handle('system:runOnboardingDoctor', () => {
    return runOnboardingDoctor()
  })

  ipcMain.handle(
    'system:openCommandInTerminal',
    async (
      _event,
      command: string,
      options?: { cwd?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        await openCommandInSystemTerminal(command, options)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to open command in terminal'
        }
      }
    }
  )

  // Quit the app (needed for macOS where window.close() doesn't quit)
  ipcMain.handle('system:quitApp', () => {
    app.quit()
  })

  // Check if the app is running in packaged mode (not dev)
  ipcMain.handle('system:isPackaged', () => {
    return app.isPackaged
  })

  // Get the current platform (darwin, win32, linux)
  ipcMain.handle('system:getPlatform', () => {
    return process.platform
  })

  // Set the UI zoom level (clamped to Electron's -5..5 range)
  ipcMain.handle('system:setZoomLevel', (_event, level: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const clamped = Math.max(-5, Math.min(5, level))
      mainWindow.webContents.setZoomLevel(clamped)
      return { success: true, level: clamped }
    }
    return { success: false }
  })

  // Get the current UI zoom level
  ipcMain.handle('system:getZoomLevel', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.webContents.getZoomLevel()
    }
    return 0
  })

  // Install xuanpu-server shell wrapper to PATH
  ipcMain.handle('system:installServerToPath', async () => {
    const execAsync = promisify(exec)
    const execPath = process.execPath

    if (process.platform === 'win32') {
      try {
        const installDir = join(
          process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'),
          'Xuanpu'
        )
        mkdirSync(installDir, { recursive: true })
        const targetPath = join(installDir, `${APP_CLI_NAME}.cmd`)
        const scriptContent = `@echo off\r\n"${execPath}" --headless %*\r\n`
        writeFileSync(targetPath, scriptContent)

        // Add to user PATH via PowerShell if not already present (escape single quotes for safe interpolation)
        const escapedDir = installDir.replace(/'/g, "''")
        const psCmd = `$d='${escapedDir}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if($p -split ';' -notcontains $d){ [Environment]::SetEnvironmentVariable('Path',$p+';'+$d,'User') }`
        await execAsync(`powershell -Command "${psCmd}"`, { timeout: 15000 })

        return { success: true, path: targetPath }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    }

    // macOS / Linux
    const targetPath = `/usr/local/bin/${APP_CLI_NAME}`
    try {
      const scriptContent =
        [
          '#!/bin/bash',
          `# ${APP_CLI_NAME} — Xuanpu headless mode launcher`,
          '# Installed by Xuanpu.app',
          `exec "${execPath}" --headless "$@"`
        ].join('\n') + '\n'

      // Write to a temp file first (no admin needed), then move with elevation
      const tmpPath = join(app.getPath('temp'), `${APP_CLI_NAME}-install`)
      writeFileSync(tmpPath, scriptContent, { mode: 0o755 })

      const osascript = `do shell script "mv '${tmpPath}' '${targetPath}' && chmod +x '${targetPath}'" with administrator privileges`
      await execAsync(`osascript -e '${osascript}'`, { timeout: 30000 })

      return { success: true, path: targetPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('User canceled') || message.includes('-128')) {
        return { success: false, error: 'Installation cancelled' }
      }
      return { success: false, error: message }
    }
  })

  // Uninstall xuanpu-server from PATH
  ipcMain.handle('system:uninstallServerFromPath', async () => {
    const execAsync = promisify(exec)

    if (process.platform === 'win32') {
      try {
        const installDir = join(
          process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'),
          'Xuanpu'
        )
        const targetPath = join(installDir, `${APP_CLI_NAME}.cmd`)
        if (!existsSync(targetPath)) {
          return { success: false, error: `${APP_CLI_NAME} is not installed` }
        }

        unlinkSync(targetPath)

        // Remove from user PATH via PowerShell (escape single quotes for safe interpolation)
        const escapedDir = installDir.replace(/'/g, "''")
        const psCmd = `$d='${escapedDir}'; $p = [Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path', ($p -split ';' | Where-Object { $_ -ne $d }) -join ';','User')`
        await execAsync(`powershell -Command "${psCmd}"`, { timeout: 15000 })

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: message }
      }
    }

    // macOS / Linux
    const targetPath = `/usr/local/bin/${APP_CLI_NAME}`
    try {
      if (!existsSync(targetPath)) {
        return { success: false, error: `${APP_CLI_NAME} is not installed` }
      }

      const osascript = `do shell script "rm '${targetPath}'" with administrator privileges`
      await execAsync(`osascript -e '${osascript}'`, { timeout: 30000 })

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('User canceled') || message.includes('-128')) {
        return { success: false, error: 'Uninstall cancelled' }
      }
      return { success: false, error: message }
    }
  })
}

// Register response logging IPC handlers (only when --log is active)
function registerLoggingHandlers(): void {
  ipcMain.handle('logging:createResponseLog', (_, sessionId: string) => {
    return createResponseLog(sessionId)
  })

  ipcMain.handle('logging:appendResponseLog', (_, filePath: string, data: unknown) => {
    appendResponseLog(filePath, data)
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Load full shell environment for macOS when launched from Finder/Dock/Spotlight.
  // Must run before any child process spawning (opencode, scripts, Claude Code SDK).
  loadShellEnv()

  // Resolve system-wide Claude binary (must run after loadShellEnv)
  const claudeBinaryPath = resolveClaudeBinaryPath()

  log.info('App starting', {
    version: app.getVersion(),
    platform: process.platform,
    claudeBinary: claudeBinaryPath ?? 'not found'
  })

  if (isLogMode) {
    log.info('Response logging enabled via --log flag')
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId(APP_BUNDLE_ID)

  const forkDataDir = ensureForkDataDir()
  if (forkDataDir.created) {
    log.info('Created isolated fork data directory', { ...forkDataDir })
  } else if (forkDataDir.usingLegacyPath) {
    log.info('Using legacy app data directory for compatibility', { ...forkDataDir })
  }

  // --- Headless mode ---
  if (isHeadless) {
    log.info('Starting in headless mode')

    // Handle one-shot management commands
    if (isRotateKey || isRegenCerts || isShowStatus || isKill || isUnlock) {
      const { handleManagementCommand } = await import('../server/headless-bootstrap')
      await handleManagementCommand({
        rotateKey: isRotateKey,
        regenCerts: isRegenCerts,
        showStatus: isShowStatus,
        kill: isKill,
        unlock: isUnlock
      })
      app.quit()
      return
    }

    // Normal headless startup
    const { headlessBootstrap } = await import('../server/headless-bootstrap')
    await headlessBootstrap({ port: headlessPort, bind: headlessBind })
    return
  }
  // --- End headless mode ---

  // Initialize database
  log.info('Initializing database')
  getDatabase()

  // Phase 21: eager-init the field event sink so the before-quit shutdown hook
  // is registered before any quit signal can fire. See PRD §3.4.
  log.info('Initializing field event sink')
  getFieldEventSink()

  // Phase 22B.1: eager-init the episodic memory updater so it subscribes to
  // the bus and registers its periodic sweep before any field events flow.
  log.info('Initializing episodic memory updater')
  getEpisodicMemoryUpdater()

  // Initialize telemetry (must come after DB init since it reads/writes settings)
  telemetryService.init()

  // Register IPC handlers
  log.info('Registering IPC handlers')
  registerDatabaseHandlers()
  registerProjectHandlers()
  registerWorktreeHandlers()
  registerSystemHandlers()
  registerSettingsHandlers()
  registerFileHandlers()
  registerConnectionHandlers()
  registerUsageHandlers()
  registerFieldHandlers()

  // Telemetry IPC
  ipcMain.handle(
    'telemetry:track',
    (_event, eventName: string, properties?: Record<string, unknown>) => {
      telemetryService.track(eventName, properties)
    }
  )

  ipcMain.handle('telemetry:setEnabled', (_event, enabled: boolean) => {
    return telemetryService.setEnabled(enabled)
  })

  ipcMain.handle('telemetry:isEnabled', () => {
    return telemetryService.isEnabled()
  })

  // Register response logging handlers only when --log is active
  if (isLogMode) {
    log.info('Registering response logging handlers')
    registerLoggingHandlers()
  }

  createWindow()

  // Register OpenCode handlers after window is created
  if (mainWindow) {
    // Build the full application menu (File, Edit, Session, Git, View, Window, Help)
    log.info('Building application menu')
    buildMenu(mainWindow, is.dev)

    // Register menu state update handler (renderer tells main which items to enable/disable)
    ipcMain.handle('menu:updateState', (_event, state: MenuState) => {
      updateMenuState(state)
    })

    // Instantiate agent implementers. All three (OpenCode, Claude Code, Codex)
    // conform to AgentRuntimeAdapter and share the same AgentRuntimeManager below.
    const claudeImpl = new ClaudeCodeImplementer()
    claudeImpl.setDatabaseService(getDatabase())
    claudeImpl.setClaudeBinaryPath(claudeBinaryPath)
    const codexImpl = new CodexImplementer()
    codexImpl.setDatabaseService(getDatabase())

    // Create the canonical runtime manager
    const runtimeManager = new AgentRuntimeManager([openCodeService, claudeImpl, codexImpl])
    runtimeManager.setMainWindow(mainWindow)
    agentRuntimeManager = runtimeManager

    const databaseService = getDatabase()

    log.info('Registering Agent handlers (canonical)')
    registerAgentHandlers(mainWindow, runtimeManager, databaseService)
    log.info('Registering Timeline handlers')
    registerTimelineHandlers(runtimeManager)
    log.info('Registering FileTree handlers')
    registerFileTreeHandlers(mainWindow)
    log.info('Registering GitFile handlers')
    registerGitFileHandlers(mainWindow)
    log.info('Registering Script handlers')
    registerScriptHandlers(mainWindow)
    log.info('Registering Terminal handlers')
    registerTerminalHandlers(mainWindow)

    // Set up notification service with main window reference
    notificationService.setMainWindow(mainWindow)

    // Register updater IPC handlers and initialize auto-updater
    registerUpdaterHandlers()
    updaterService.init(mainWindow)

    // Track app launch telemetry
    telemetryService.track('app_launched')
    telemetryService.identify({
      platform: process.platform,
      app_version: app.getVersion(),
      electron_version: process.versions.electron
    })
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Cleanup when app is about to quit
app.on('will-quit', async () => {
  // Phase 22B.1: shut down the episodic memory updater first (before the sink),
  // so it stops scheduling new compactions that would race with sink flush.
  try {
    await getEpisodicMemoryUpdater().shutdown()
  } catch (err) {
    log.warn('episodic memory updater shutdown failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
  // Phase 21: ensure the field event sink has flushed before we close the DB.
  // The sink's own `before-quit` hook normally handles this, but we call
  // shutdown() defensively here too — it's idempotent.
  try {
    await getFieldEventSink().shutdown()
  } catch (err) {
    log.warn('field event sink shutdown failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
  // Cleanup updater timers
  updaterService.cleanup()
  // Cleanup terminal PTYs
  cleanupTerminals()
  // Cleanup running scripts
  cleanupScripts()
  // Cleanup file tree watchers
  await cleanupFileTreeWatchers()
  // Cleanup worktree watchers (git status monitoring)
  await cleanupWorktreeWatchers()
  // Cleanup branch watchers (sidebar branch names)
  await cleanupBranchWatchers()
  // Cleanup canonical agent handlers
  await cleanupAgentHandlers(agentRuntimeManager ?? undefined)
  // Flush telemetry before closing database
  telemetryService.track('app_session_ended', {
    session_duration_ms: Date.now() - appStartTime
  })
  await telemetryService.shutdown()
  // Close database
  closeDatabase()
})
