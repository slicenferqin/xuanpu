import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { homedir, platform } from 'os'

export interface DetectedApp {
  id: string
  name: string
  command: string
  available: boolean
}

interface EditorDefinition {
  id: string
  name: string
  commands: string[]
  macAppNames?: string[]
  macBundleExecutables?: string[]
}

function findCommand(currentPlatform: NodeJS.Platform, commands: string[]): string {
  for (const cmd of commands) {
    if (existsSync(cmd)) return cmd
    try {
      const result = execSync(currentPlatform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
        encoding: 'utf-8',
        timeout: 2000
      }).trim()
      if (result) return result.split('\n')[0].replace(/\r$/, '')
    } catch {
      // Not found
    }
  }

  return ''
}

function findMacBundleExecutable(appNames: string[], executables: string[]): string {
  for (const appName of appNames) {
    const appDirs = [
      `/Applications/${appName}.app`,
      `${homedir()}/Applications/${appName}.app`
    ]

    for (const appDir of appDirs) {
      for (const executable of executables) {
        const candidate = `${appDir}/${executable}`
        if (existsSync(candidate)) return candidate
      }

      // Even if the internal CLI/binary isn't found, the app bundle itself is
      // enough for us to treat the editor as installed on macOS.
      if (existsSync(appDir)) return appDir
    }

    try {
      const result = execSync(`mdfind "kMDItemFSName == '${appName}.app'"`, {
        encoding: 'utf-8',
        timeout: 3000
      })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)

      for (const appDir of result) {
        for (const executable of executables) {
          const candidate = `${appDir}/${executable}`
          if (existsSync(candidate)) return candidate
        }

        if (existsSync(appDir)) return appDir
      }
    } catch {
      // Spotlight unavailable or app not indexed
    }
  }

  return ''
}

export function detectEditors(): DetectedApp[] {
  const currentPlatform = platform()
  const editors: DetectedApp[] = []

  const editorDefs: EditorDefinition[] = [
    {
      id: 'vscode',
      name: 'Visual Studio Code',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/code', 'code']
          : currentPlatform === 'win32'
            ? ['code.cmd', 'code']
            : ['code'],
      macAppNames: ['Visual Studio Code'],
      macBundleExecutables: ['Contents/Resources/app/bin/code']
    },
    {
      id: 'cursor',
      name: 'Cursor',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/cursor', 'cursor']
          : currentPlatform === 'win32'
            ? ['cursor.cmd', 'cursor']
            : ['cursor'],
      macAppNames: ['Cursor'],
      macBundleExecutables: ['Contents/Resources/app/bin/cursor']
    },
    {
      id: 'trae',
      name: 'Trae',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/trae', 'trae']
          : currentPlatform === 'win32'
            ? ['trae.cmd', 'trae.exe', 'trae']
            : ['trae'],
      macAppNames: ['Trae', 'Trae CN'],
      macBundleExecutables: [
        'Contents/Resources/app/bin/trae',
        'Contents/Resources/app/bin/marscode',
        'Contents/MacOS/Trae',
        'Contents/MacOS/Electron'
      ]
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/windsurf', 'windsurf']
          : currentPlatform === 'win32'
            ? ['windsurf.cmd', 'windsurf.exe', 'windsurf']
            : ['windsurf'],
      macAppNames: ['Windsurf'],
      macBundleExecutables: [
        'Contents/Resources/app/bin/windsurf',
        'Contents/MacOS/Windsurf'
      ]
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      commands:
        currentPlatform === 'darwin'
          ? [
              '/usr/local/bin/antigravity',
              `${homedir()}/.antigravity/antigravity/bin/antigravity`,
              'antigravity'
            ]
          : currentPlatform === 'win32'
            ? ['antigravity.cmd', 'antigravity.exe', 'antigravity']
            : ['antigravity'],
      macAppNames: ['Antigravity', 'Antigravity Desktop'],
      macBundleExecutables: [
        'Contents/Resources/app/bin/antigravity',
        'Contents/MacOS/Antigravity',
        'Contents/MacOS/Electron'
      ]
    },
    {
      id: 'sublime',
      name: 'Sublime Text',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/subl', 'subl']
          : currentPlatform === 'win32'
            ? ['subl.exe']
            : ['subl'],
      macAppNames: ['Sublime Text'],
      macBundleExecutables: ['Contents/SharedSupport/bin/subl']
    },
    {
      id: 'idea',
      name: 'IntelliJ IDEA',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/idea', 'idea']
          : currentPlatform === 'win32'
            ? ['idea64.exe', 'idea.exe', 'idea.cmd', 'idea']
            : ['idea'],
      macAppNames: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'],
      macBundleExecutables: ['Contents/MacOS/idea']
    },
    {
      id: 'webstorm',
      name: 'WebStorm',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/webstorm', 'webstorm']
          : currentPlatform === 'win32'
            ? ['webstorm64.exe', 'webstorm.cmd']
            : ['webstorm'],
      macAppNames: ['WebStorm'],
      macBundleExecutables: ['Contents/MacOS/webstorm']
    },
    {
      id: 'pycharm',
      name: 'PyCharm',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/pycharm', 'pycharm']
          : currentPlatform === 'win32'
            ? ['pycharm64.exe', 'pycharm.exe', 'pycharm.cmd', 'pycharm']
            : ['pycharm'],
      macAppNames: ['PyCharm', 'PyCharm CE', 'PyCharm Professional'],
      macBundleExecutables: ['Contents/MacOS/pycharm']
    },
    {
      id: 'goland',
      name: 'GoLand',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/goland', 'goland']
          : currentPlatform === 'win32'
            ? ['goland64.exe', 'goland.exe', 'goland.cmd', 'goland']
            : ['goland'],
      macAppNames: ['GoLand'],
      macBundleExecutables: ['Contents/MacOS/goland']
    },
    {
      id: 'zed',
      name: 'Zed',
      commands:
        currentPlatform === 'darwin'
          ? ['/usr/local/bin/zed', 'zed']
          : currentPlatform === 'win32'
            ? ['zed.exe']
            : ['zed'],
      macAppNames: ['Zed'],
      macBundleExecutables: ['Contents/MacOS/zed']
    }
  ]

  for (const def of editorDefs) {
    let resolvedCommand = findCommand(currentPlatform, def.commands)

    if (
      !resolvedCommand &&
      currentPlatform === 'darwin' &&
      def.macAppNames &&
      def.macBundleExecutables
    ) {
      resolvedCommand = findMacBundleExecutable(def.macAppNames, def.macBundleExecutables)
    }

    editors.push({
      id: def.id,
      name: def.name,
      command: resolvedCommand || def.commands[0],
      available: Boolean(resolvedCommand)
    })
  }

  return editors
}

export function detectTerminals(): DetectedApp[] {
  const currentPlatform = platform()
  const terminals: DetectedApp[] = []

  const terminalDefs =
    currentPlatform === 'darwin'
      ? [
          {
            id: 'terminal',
            name: 'Terminal',
            commands: ['/System/Applications/Utilities/Terminal.app']
          },
          { id: 'iterm', name: 'iTerm2', commands: ['/Applications/iTerm.app'] },
          { id: 'warp', name: 'Warp', commands: ['/Applications/Warp.app'] },
          {
            id: 'alacritty',
            name: 'Alacritty',
            commands: ['/Applications/Alacritty.app', '/usr/local/bin/alacritty']
          },
          {
            id: 'kitty',
            name: 'kitty',
            commands: ['/Applications/kitty.app', '/usr/local/bin/kitty']
          },
          {
            id: 'ghostty',
            name: 'Ghostty',
            commands: ['/Applications/Ghostty.app', '/usr/local/bin/ghostty']
          }
        ]
      : currentPlatform === 'win32'
        ? [
            { id: 'terminal', name: 'Windows Terminal', commands: ['wt.exe'] },
            { id: 'powershell', name: 'PowerShell', commands: ['pwsh.exe', 'powershell.exe'] },
            { id: 'cmd', name: 'Command Prompt', commands: ['cmd.exe'] }
          ]
        : [
            { id: 'terminal', name: 'Default Terminal', commands: ['x-terminal-emulator'] },
            { id: 'alacritty', name: 'Alacritty', commands: ['alacritty'] },
            { id: 'kitty', name: 'kitty', commands: ['kitty'] }
          ]

  for (const def of terminalDefs) {
    let available = false
    let resolvedCommand = ''

    for (const cmd of def.commands) {
      if (existsSync(cmd)) {
        available = true
        resolvedCommand = cmd
        break
      }
      try {
        const result = execSync(currentPlatform === 'win32' ? `where ${cmd}` : `which ${cmd}`, {
          encoding: 'utf-8',
          timeout: 2000
        }).trim()
        if (result) {
          available = true
          resolvedCommand = result.split('\n')[0].replace(/\r$/, '')
          break
        }
      } catch {
        // Not found
      }
    }

    terminals.push({
      id: def.id,
      name: def.name,
      command: resolvedCommand || def.commands[0],
      available
    })
  }

  return terminals
}
