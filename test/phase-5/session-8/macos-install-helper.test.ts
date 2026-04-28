import { describe, test, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

const repoRoot = resolve(__dirname, '../../../')
const installHelperPath = resolve(repoRoot, 'resources/install-xuanpu.command')
const dmgBackgroundPath = resolve(repoRoot, 'resources/dmg-background.png')
const retinaDmgBackgroundPath = resolve(repoRoot, 'resources/dmg-background@2x.png')
const electronBuilderConfigPath = resolve(repoRoot, 'electron-builder.yml')

function readPngDimensions(path: string): { width: number; height: number } {
  const data = readFileSync(path)
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  expect(data.subarray(0, 8).equals(pngMagic)).toBe(true)

  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20)
  }
}

describe('Session 8: macOS Install Helper', () => {
  test('DMG install helper exists and is executable', () => {
    expect(existsSync(installHelperPath)).toBe(true)

    const stats = statSync(installHelperPath)
    expect(stats.mode & 0o111).toBeGreaterThan(0)
  })

  test('install helper copies the app, removes quarantine, and opens Xuanpu', () => {
    const content = readFileSync(installHelperPath, 'utf-8')

    expect(content).toContain('APP_BUNDLE="玄圃.app"')
    expect(content).toContain('TARGET_APP="${TARGET_DIR}/${APP_BUNDLE}"')
    expect(content).toContain('/usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"')
    expect(content).toContain('/usr/bin/xattr -cr "$TARGET_APP"')
    expect(content).toContain('/usr/bin/open "$TARGET_APP"')
  })

  test('install helper handles existing app replacement conservatively', () => {
    const content = readFileSync(installHelperPath, 'utf-8')

    expect(content).toContain('APP_BUNDLE_ID="com.slicenfer.xuanpu"')
    expect(content).toContain('tell application id \\"${APP_BUNDLE_ID}\\" to quit')
    expect(content).toContain('Refusing to install to unexpected path')
    expect(content).toContain('/usr/bin/sudo -v')
    expect(content).toContain('/bin/rm -rf -- "$TARGET_APP"')
  })

  test('electron-builder DMG includes the helper and app icon', () => {
    const content = readFileSync(electronBuilderConfigPath, 'utf-8')

    expect(content).toContain('dmg:')
    expect(content).toContain('background: resources/dmg-background.png')
    expect(content).toContain('icon: icon.icns')
    expect(content).toContain('path: /Applications')
    expect(content).toContain('type: file')
    expect(content).toContain('path: install-xuanpu.command')
    expect(content).toContain("name: 'Install Xuanpu.command'")
  })

  test('DMG background assets match the configured Finder window size', () => {
    expect(readPngDimensions(dmgBackgroundPath)).toEqual({ width: 540, height: 420 })
    expect(readPngDimensions(retinaDmgBackgroundPath)).toEqual({ width: 1080, height: 840 })
  })
})
