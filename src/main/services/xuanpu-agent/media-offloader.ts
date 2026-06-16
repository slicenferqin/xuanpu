import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

export interface ImageOffloadInput {
  data: string
  mimeType: string
  filename?: string | null
}

export interface ImageOffloadRecord {
  path: string
  mediaRef: string
  sha256: string
  bytes: number
  mimeType: string
  extension: string
  filename: string | null
}

export interface ImageObservationRefInput {
  path: string
  mediaRef: string
  sha256: string
  bytes: number
  mimeType: string
  filename?: string | null
}

export interface MediaOffloadStoreOptions {
  rootDir?: string
}

const DEFAULT_MEDIA_ROOT = join(homedir(), '.xuanpu', 'archive', 'media')

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg'
}

export function getDefaultMediaOffloadRoot(): string {
  return DEFAULT_MEDIA_ROOT
}

export function computeImageSha256FromBase64(data: string): string {
  return createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex')
}

export function estimateImageBytesFromBase64(data: string): number {
  return Buffer.from(data, 'base64').byteLength
}

export function resolveImageExtension(mimeType: string, filename?: string | null): string {
  const fromName = filename ? extname(basename(filename)).replace(/^\./, '').toLowerCase() : ''
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName
  return MIME_EXTENSION[mimeType.toLowerCase()] ?? 'bin'
}

export function buildImageOffloadPath(input: {
  rootDir?: string
  sha256: string
  mimeType: string
  filename?: string | null
}): string {
  const extension = resolveImageExtension(input.mimeType, input.filename)
  return join(input.rootDir ?? DEFAULT_MEDIA_ROOT, `${input.sha256}.${extension}`)
}

export function formatImageObservationRef(input: ImageObservationRefInput): string {
  const lines = [
    '<ImageObservationRef raw="omitted-after-first-vision-request">',
    input.filename ? `filename: ${input.filename}` : null,
    `mime: ${input.mimeType}`,
    `bytes: ${input.bytes}`,
    `sha256: ${input.sha256}`,
    `ref: ${input.mediaRef}`,
    `path: ${input.path}`,
    '</ImageObservationRef>'
  ].filter((line): line is string => line !== null)

  return lines.join('\n')
}

export function buildImageObservationRefFromBase64(
  input: ImageOffloadInput
): ImageObservationRefInput {
  const sha256 = computeImageSha256FromBase64(input.data)
  const bytes = estimateImageBytesFromBase64(input.data)
  return {
    path: buildImageOffloadPath({
      sha256,
      mimeType: input.mimeType,
      filename: input.filename
    }),
    mediaRef: `image-sha256:${sha256}`,
    sha256,
    bytes,
    mimeType: input.mimeType,
    filename: input.filename ?? null
  }
}

export class MediaOffloadStore {
  private readonly rootDir: string

  constructor(options: MediaOffloadStoreOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_MEDIA_ROOT
  }

  getRootDir(): string {
    return this.rootDir
  }

  async writeImage(input: ImageOffloadInput): Promise<ImageOffloadRecord> {
    if (!input.data || typeof input.data !== 'string') {
      throw new Error('MediaOffloadStore.writeImage: base64 data is required')
    }
    if (!input.mimeType.startsWith('image/')) {
      throw new Error(`MediaOffloadStore.writeImage: unsupported mime type ${input.mimeType}`)
    }

    const bytes = Buffer.from(input.data, 'base64')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const extension = resolveImageExtension(input.mimeType, input.filename)
    const finalPath = join(this.rootDir, `${sha256}.${extension}`)
    const tmpPath = `${finalPath}.${randomUUID().slice(0, 8)}.tmp`

    await fs.mkdir(this.rootDir, { recursive: true })
    try {
      await fs.access(finalPath)
    } catch {
      await fs.writeFile(tmpPath, bytes)
      try {
        await fs.rename(tmpPath, finalPath)
      } catch (error) {
        await fs.unlink(tmpPath).catch(() => {})
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
      }
    }

    return {
      path: finalPath,
      mediaRef: `image-sha256:${sha256}`,
      sha256,
      bytes: bytes.byteLength,
      mimeType: input.mimeType,
      extension,
      filename: input.filename ?? null
    }
  }
}
