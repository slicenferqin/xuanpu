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
    case 1:
      return 'ia32'
    case 2:
      return 'x64'
    case 3:
      return 'armv7l'
    case 4:
      return 'arm64'
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

function getResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources'
    )
  }

  return path.join(context.appOutDir, 'resources')
}

exports.default = async function afterPackPrune(context) {
  const platform = context.electronPlatformName
  const arch = electronArchToNodeArch(context.arch)
  const keep = PI_NATIVE_FILENAMES[`${platform}:${arch}`]

  if (!keep) {
    return
  }

  const nativeDir = path.join(
    getResourcesDir(context),
    'app.asar.unpacked',
    'node_modules',
    '@oh-my-pi',
    'pi-natives',
    'native'
  )

  if (!(await pathExists(nativeDir))) {
    return
  }

  const entries = await fs.readdir(nativeDir)
  await Promise.all(
    entries
      .filter(
        (entry) => entry.startsWith('pi_natives.') && entry.endsWith('.node') && !keep.has(entry)
      )
      .map((entry) => fs.rm(path.join(nativeDir, entry), { force: true }))
  )
}
