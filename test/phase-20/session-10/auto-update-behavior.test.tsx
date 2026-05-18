import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Toaster } from '../../../src/renderer/src/components/ui/sonner'
import { useAutoUpdate } from '../../../src/renderer/src/hooks/useAutoUpdate'

const toastMocks = vi.hoisted(() => ({
  info: vi.fn(),
  loading: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
  error: vi.fn()
}))

const sonnerToasterMock = vi.hoisted(() => vi.fn(() => null))
const sonnerToastMocks = vi.hoisted(() => ({
  custom: vi.fn().mockReturnValue('prompt-toast'),
  dismiss: vi.fn()
}))

vi.mock('@/lib/toast', () => ({
  toast: toastMocks
}))

vi.mock('sonner', () => ({
  Toaster: sonnerToasterMock,
  toast: sonnerToastMocks
}))

type UpdateAvailableData = { version: string; releaseNotes?: string; releaseDate?: string }
type UpdateDownloadedData = { version: string; releaseNotes?: string }

let onUpdateAvailableCb: ((data: UpdateAvailableData) => void) | null = null
let onUpdateDownloadedCb: ((data: UpdateDownloadedData) => void) | null = null

const installUpdateMock = vi.fn().mockResolvedValue(undefined)

describe('Auto update behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    onUpdateAvailableCb = null
    onUpdateDownloadedCb = null

    toastMocks.info.mockReturnValue('toast-available')
    toastMocks.loading.mockReturnValue('toast-progress')
    toastMocks.success.mockReturnValue('toast-downloaded')
    sonnerToastMocks.custom.mockReturnValue('prompt-toast')

    Object.defineProperty(window, 'updaterOps', {
      configurable: true,
      writable: true,
      value: {
        checkForUpdate: vi.fn().mockResolvedValue(undefined),
        downloadUpdate: vi.fn().mockResolvedValue(undefined),
        installUpdate: installUpdateMock,
        onChecking: vi.fn().mockReturnValue(() => {}),
        onUpdateAvailable: vi.fn((cb: (data: UpdateAvailableData) => void) => {
          onUpdateAvailableCb = cb
          return () => {
            onUpdateAvailableCb = null
          }
        }),
        onUpdateNotAvailable: vi.fn().mockReturnValue(() => {}),
        onProgress: vi.fn().mockReturnValue(() => {}),
        onUpdateDownloaded: vi.fn((cb: (data: UpdateDownloadedData) => void) => {
          onUpdateDownloadedCb = cb
          return () => {
            onUpdateDownloadedCb = null
          }
        }),
        onError: vi.fn().mockReturnValue(() => {})
      }
    })

    Object.defineProperty(window, 'systemOps', {
      configurable: true,
      writable: true,
      value: {
        openInChrome: vi.fn().mockResolvedValue(undefined)
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('update available uses custom prompt and does not auto-download', () => {
    renderHook(() => useAutoUpdate())

    act(() => {
      onUpdateAvailableCb?.({ version: '1.2.3' })
    })

    expect(sonnerToastMocks.custom).toHaveBeenCalledTimes(1)
    expect(window.updaterOps.downloadUpdate).not.toHaveBeenCalled()
  })

  test('downloaded toast exposes restart action that installs update', () => {
    renderHook(() => useAutoUpdate())

    act(() => {
      onUpdateDownloadedCb?.({ version: '1.2.3' })
    })

    expect(toastMocks.success).toHaveBeenCalledTimes(1)
    const options = toastMocks.success.mock.calls[0]?.[1] as
      | { action?: { label: string; onClick: () => void } }
      | undefined

    expect(options?.action?.label).toBe('Restart to Update')

    act(() => {
      options?.action?.onClick()
    })

    expect(installUpdateMock).toHaveBeenCalledTimes(1)
  })

  test('toaster renders in dark theme mode', () => {
    render(<Toaster />)

    expect(sonnerToasterMock).toHaveBeenCalledTimes(1)
    const props = sonnerToasterMock.mock.calls[0]?.[0] as { theme?: string } | undefined
    expect(props?.theme).toBe('dark')
  })
})
