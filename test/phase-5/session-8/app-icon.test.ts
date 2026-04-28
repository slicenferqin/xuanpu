import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { inflateSync } from 'zlib'

const resourcesDir = resolve(__dirname, '../../../resources')
const brandDir = resolve(resourcesDir, 'brand')
const rendererAssetsDir = resolve(__dirname, '../../../src/renderer/src/assets')
const docsDir = resolve(__dirname, '../../../docs')
const mobilePublicDir = resolve(__dirname, '../../../mobile/public')

function readPngRgba(path: string): { width: number; height: number; pixels: Buffer } {
  const data = readFileSync(path)
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(data.subarray(0, 8).equals(pngMagic)).toBe(true)

  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  const idatChunks: Buffer[] = []

  while (offset < data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('ascii')
    const chunk = data.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      colorType = chunk[9]
    } else if (type === 'IDAT') {
      idatChunks.push(chunk)
    } else if (type === 'IEND') {
      break
    }
  }

  expect(colorType === 2 || colorType === 6).toBe(true)

  const channels = colorType === 6 ? 4 : 3
  const inflated = inflateSync(Buffer.concat(idatChunks))
  const sourceStride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  const row = Buffer.alloc(sourceStride)
  const previousRow = Buffer.alloc(sourceStride)
  let sourceOffset = 0

  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset]
    sourceOffset += 1

    for (let x = 0; x < sourceStride; x++) {
      const raw = inflated[sourceOffset + x]
      const left = x >= channels ? row[x - channels] : 0
      const up = previousRow[x]
      const upLeft = x >= channels ? previousRow[x - channels] : 0

      if (filter === 0) {
        row[x] = raw
      } else if (filter === 1) {
        row[x] = (raw + left) & 0xff
      } else if (filter === 2) {
        row[x] = (raw + up) & 0xff
      } else if (filter === 3) {
        row[x] = (raw + Math.floor((left + up) / 2)) & 0xff
      } else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        row[x] = (raw + predictor) & 0xff
      } else {
        throw new Error(`Unsupported PNG filter: ${filter}`)
      }
    }

    for (let x = 0; x < width; x++) {
      const sourcePixel = x * channels
      const targetPixel = (y * width + x) * 4
      pixels[targetPixel] = row[sourcePixel]
      pixels[targetPixel + 1] = row[sourcePixel + 1]
      pixels[targetPixel + 2] = row[sourcePixel + 2]
      pixels[targetPixel + 3] = channels === 4 ? row[sourcePixel + 3] : 255
    }

    previousRow.set(row)
    sourceOffset += sourceStride
  }

  return { width, height, pixels }
}

function alphaAt(image: { width: number; pixels: Buffer }, x: number, y: number): number {
  return image.pixels[(y * image.width + x) * 4 + 3]
}

function averageRgb(
  image: { width: number; pixels: Buffer },
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { r: number; g: number; b: number } {
  let r = 0
  let g = 0
  let b = 0
  let count = 0

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pixel = (y * image.width + x) * 4
      r += image.pixels[pixel]
      g += image.pixels[pixel + 1]
      b += image.pixels[pixel + 2]
      count += 1
    }
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count)
  }
}

describe('Session 8: App Icon', () => {
  test('icon.icns exists in resources', () => {
    const icnsPath = resolve(resourcesDir, 'icon.icns')
    expect(existsSync(icnsPath)).toBe(true)

    const stats = readFileSync(icnsPath)
    expect(stats.length).toBeGreaterThan(0)
  })

  test('icon.ico exists in resources', () => {
    const icoPath = resolve(resourcesDir, 'icon.ico')
    expect(existsSync(icoPath)).toBe(true)

    const stats = readFileSync(icoPath)
    expect(stats.length).toBeGreaterThan(0)
  })

  test('icon.png exists in resources', () => {
    const pngPath = resolve(resourcesDir, 'icon.png')
    expect(existsSync(pngPath)).toBe(true)

    const data = readFileSync(pngPath)
    expect(data.length).toBeGreaterThan(0)
  })

  test('icon.png is a valid PNG file', () => {
    const pngPath = resolve(resourcesDir, 'icon.png')
    const data = readFileSync(pngPath)

    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(data.subarray(0, 8).equals(pngMagic)).toBe(true)
  })

  test('icon.png has transparent rounded corners', () => {
    const pngPath = resolve(resourcesDir, 'icon.png')
    const image = readPngRgba(pngPath)

    expect(alphaAt(image, 0, 0)).toBe(0)
    expect(alphaAt(image, image.width - 1, 0)).toBe(0)
    expect(alphaAt(image, 0, image.height - 1)).toBe(0)
    expect(alphaAt(image, image.width - 1, image.height - 1)).toBe(0)
    expect(alphaAt(image, Math.floor(image.width / 2), Math.floor(image.height / 2))).toBe(255)
  })

  test('renderer app icon matches rounded resource icon', () => {
    const rendererIconPath = resolve(rendererAssetsDir, 'icon.png')
    expect(existsSync(rendererIconPath)).toBe(true)

    const image = readPngRgba(rendererIconPath)
    expect(alphaAt(image, 0, 0)).toBe(0)
    expect(alphaAt(image, image.width - 1, image.height - 1)).toBe(0)
  })

  test('icon.icns has valid ICNS header', () => {
    const icnsPath = resolve(resourcesDir, 'icon.icns')
    const data = readFileSync(icnsPath)

    // ICNS magic bytes: 'icns' (69 63 6E 73)
    const magic = data.subarray(0, 4).toString('ascii')
    expect(magic).toBe('icns')
  })

  test('icon.ico has valid ICO header', () => {
    const icoPath = resolve(resourcesDir, 'icon.ico')
    const data = readFileSync(icoPath)

    // ICO header: reserved=0, type=1 (ICO)
    expect(data.readUInt16LE(0)).toBe(0) // Reserved
    expect(data.readUInt16LE(2)).toBe(1) // Type: ICO
    expect(data.readUInt16LE(4)).toBeGreaterThanOrEqual(1) // At least 1 image
  })

  test('icon.ico contains multiple resolutions', () => {
    const icoPath = resolve(resourcesDir, 'icon.ico')
    const data = readFileSync(icoPath)

    const imageCount = data.readUInt16LE(4)
    // Should have at least 4 resolutions (16, 32, 48, 64, 128, 256)
    expect(imageCount).toBeGreaterThanOrEqual(4)
  })

  test('electron-builder config exists and references icons', () => {
    const configPath = resolve(__dirname, '../../../electron-builder.yml')
    expect(existsSync(configPath)).toBe(true)

    const content = readFileSync(configPath, 'utf-8')

    // Verify mac icon config
    expect(content).toContain('icon.icns')

    // Verify win icon config
    expect(content).toContain('icon.ico')

    // Verify linux icon config
    expect(content).toContain('icon.png')
  })

  test('source icon is a valid PNG', () => {
    const sourcePath = resolve(resourcesDir, 'icon-source.png')
    const data = readFileSync(sourcePath)
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(data.subarray(0, 8).equals(pngMagic)).toBe(true)
  })

  test('brand source and preview assets have expected dimensions', () => {
    const source = readPngRgba(resolve(resourcesDir, 'icon-source.png'))
    const banner = readPngRgba(resolve(resourcesDir, 'banner.png'))
    const preview = readPngRgba(resolve(docsDir, 'social-preview.png'))
    const onboardingBg = readPngRgba(resolve(rendererAssetsDir, 'onboarding-bg.png'))
    const onboardingBgDark = readPngRgba(resolve(rendererAssetsDir, 'onboarding-bg-dark.png'))
    const mobile192 = readPngRgba(resolve(mobilePublicDir, 'icon-192.png'))
    const mobile512 = readPngRgba(resolve(mobilePublicDir, 'icon-512.png'))

    expect(source.width).toBe(1024)
    expect(source.height).toBe(1024)
    expect(banner.width).toBe(2064)
    expect(banner.height).toBe(512)
    expect(preview.width).toBe(1280)
    expect(preview.height).toBe(640)
    expect(onboardingBg.width).toBe(1200)
    expect(onboardingBg.height).toBe(896)
    expect(onboardingBgDark.width).toBe(1200)
    expect(onboardingBgDark.height).toBe(896)
    expect(mobile192.width).toBe(192)
    expect(mobile192.height).toBe(192)
    expect(mobile512.width).toBe(512)
    expect(mobile512.height).toBe(512)
  })

  test('app empty-state backgrounds stay compatible with Catppuccin surfaces', () => {
    const light = readPngRgba(resolve(rendererAssetsDir, 'onboarding-bg.png'))
    const dark = readPngRgba(resolve(rendererAssetsDir, 'onboarding-bg-dark.png'))
    const lightCenter = averageRgb(light, 420, 300, 780, 596)
    const darkCenter = averageRgb(dark, 420, 300, 780, 596)

    expect(lightCenter.b).toBeGreaterThanOrEqual(lightCenter.r)
    expect(lightCenter.b).toBeGreaterThanOrEqual(lightCenter.g)
    expect(lightCenter.r - lightCenter.b).toBeLessThan(4)
    expect(darkCenter.b).toBeGreaterThan(darkCenter.r + 8)
    expect(darkCenter.b).toBeGreaterThan(darkCenter.g + 2)
  })

  test('pinned v11 brand sources are present for reproducible asset generation', () => {
    const iconSource = readPngRgba(resolve(brandDir, 'v11/final/icon-source.png'))
    const bannerSource = readPngRgba(resolve(brandDir, 'banner-v11/final/banner.png'))
    const onboardingSource = readPngRgba(resolve(brandDir, 'onboarding-v11/final/onboarding-bg.png'))
    const onboardingDarkSource = readPngRgba(
      resolve(brandDir, 'onboarding-v11/final/onboarding-bg-dark.png')
    )
    const socialSource = readPngRgba(resolve(brandDir, 'social-v11/final/social-preview.png'))
    const dmgBaseSource = readPngRgba(resolve(brandDir, 'dmg-v11/final/background-base.png'))

    expect(iconSource.width).toBe(1024)
    expect(iconSource.height).toBe(1024)
    expect(bannerSource.width).toBe(2064)
    expect(bannerSource.height).toBe(512)
    expect(onboardingSource.width).toBe(1200)
    expect(onboardingSource.height).toBe(896)
    expect(onboardingDarkSource.width).toBe(1200)
    expect(onboardingDarkSource.height).toBe(896)
    expect(socialSource.width).toBe(1280)
    expect(socialSource.height).toBe(640)
    expect(dmgBaseSource.width).toBe(1088)
    expect(dmgBaseSource.height).toBe(848)
  })

  test('mobile SVG icon uses the folded doorway palette without the removed gold accent', () => {
    const iconPath = resolve(mobilePublicDir, 'icon.svg')
    expect(existsSync(iconPath)).toBe(true)

    const content = readFileSync(iconPath, 'utf-8')
    expect(content).toContain('viewBox="0 0 1024 1024"')
    expect(content).toContain('#F7F3EA')
    expect(content).toContain('#DCEBE2')
    expect(content).toContain('#30463D')
    expect(content).not.toContain('#D7B96C')
  })

  test('docs web icons are generated for repository pages', () => {
    const iconPath = resolve(docsDir, 'icon.png')
    const appleTouchIconPath = resolve(docsDir, 'apple-touch-icon.png')
    const faviconPath = resolve(docsDir, 'favicon.ico')

    expect(readPngRgba(iconPath).width).toBe(512)
    expect(readPngRgba(appleTouchIconPath).width).toBe(180)
    expect(existsSync(faviconPath)).toBe(true)
    expect(readFileSync(faviconPath).readUInt16LE(2)).toBe(1)
  })
})
