const fs = require('fs/promises')
const path = require('path')

const PI_NATIVE_FILENAMES = {
  'darwin:arm64': new Set(['pi_natives.darwin-arm64.node']),
  'darwin:x64': new Set(['pi_natives.darwin-x64-baseline.node']),
  'linux:arm64': new Set(['pi_natives.linux-arm64.node']),
  'linux:x64': new Set([
    'pi_natives.linux-x64-baseline.node',
    'pi_natives.linux-x64-modern.node'
  ]),
  'win32:x64': new Set(['pi_natives.win32-x64-baseline.node'])
}

function electronArchToNodeArch(arch) {
  if (typeof arch === 'string') return arch
  switch (arch) {
    case 0:
      return 'ia32'
    case 1:
      return 'x64'
    case 2:
      return 'armv7l'
    case 3:
      return 'arm64'
    case 4:
      return 'universal'
    default:
      return String(arch)
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function getResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const entries = await fs.readdir(context.appOutDir).catch(() => [])
    const appBundle = entries.find((entry) => entry.endsWith('.app'))
    const appName = appBundle ?? `${context.packager.appInfo.productFilename}.app`
    return path.join(context.appOutDir, appName, 'Contents', 'Resources')
  }

  return path.join(context.appOutDir, 'resources')
}

async function collectPiNativeDirs(rootDir) {
  const matches = []

  async function visit(dir, depthRemaining) {
    if (depthRemaining < 0) {
      return
    }

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    if (path.basename(dir) === 'native' && path.basename(path.dirname(dir)) === 'pi-natives') {
      matches.push(dir)
      return
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => visit(path.join(dir, entry.name), depthRemaining - 1))
    )
  }

  await visit(rootDir, 12)
  return matches
}

async function prunePiNativeDir(nativeDir, keep) {
  const entries = await fs.readdir(nativeDir)
  await Promise.all(
    entries
      .filter(
        (entry) => entry.startsWith('pi_natives.') && entry.endsWith('.node') && !keep.has(entry)
      )
      .map((entry) => fs.rm(path.join(nativeDir, entry), { force: true }))
  )
}

async function afterPackPrune(context) {
  const platform = context.electronPlatformName
  const arch = electronArchToNodeArch(context.arch)
  const keep = PI_NATIVE_FILENAMES[`${platform}:${arch}`]

  if (!keep) {
    return
  }

  const nodeModulesDir = path.join(
    await getResourcesDir(context),
    'app.asar.unpacked',
    'node_modules'
  )

  if (!(await pathExists(nodeModulesDir))) {
    return
  }

  const nativeDirs = await collectPiNativeDirs(nodeModulesDir)
  await Promise.all(nativeDirs.map((nativeDir) => prunePiNativeDir(nativeDir, keep)))
}

module.exports = afterPackPrune
module.exports.default = afterPackPrune
