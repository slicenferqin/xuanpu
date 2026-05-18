import { mergeVoiceInputSettings } from '../../src/renderer/src/stores/useSettingsStore'
import {
  DEFAULT_DOCKER_FUNASR_HOST_PORT,
  DEFAULT_DOCKER_FUNASR_WS_URL,
  DEFAULT_FUNASR_IMAGE,
  DEFAULT_FUNASR_WS_URL
} from '../../src/shared/types/voice'

describe('mergeVoiceInputSettings', () => {
  it('fills defaults for old settings without voice input', () => {
    const merged = mergeVoiceInputSettings(undefined)
    expect(merged.enabled).toBe(true)
    expect(merged.runtimeProvider).toBe('managed')
    expect(merged.funasr.wsUrl).toBe(DEFAULT_FUNASR_WS_URL)
    expect(merged.funasr.image).toBe(DEFAULT_FUNASR_IMAGE)
  })

  it('keeps persisted user overrides while adding nested defaults', () => {
    const merged = mergeVoiceInputSettings({
      enabled: false,
      funasr: {
        wsUrl: 'ws://localhost:19999',
        hotwords: [{ text: '玄圃', weight: 30, enabled: true }]
      }
    })

    expect(merged.enabled).toBe(false)
    expect(merged.funasr.wsUrl).toBe('ws://localhost:19999')
    expect(merged.funasr.hostPort).toBe(10095)
    expect(merged.funasr.hotwords).toEqual([{ text: '玄圃', weight: 30, enabled: true }])
  })

  it('migrates the legacy Docker default to the managed local runtime', () => {
    const merged = mergeVoiceInputSettings({
      runtimeProvider: 'docker',
      funasr: {
        wsUrl: DEFAULT_DOCKER_FUNASR_WS_URL,
        image: DEFAULT_FUNASR_IMAGE
      }
    })

    expect(merged.runtimeProvider).toBe('managed')
    expect(merged.funasr.wsUrl).toBe(DEFAULT_FUNASR_WS_URL)
    expect(merged.funasr.hostPort).toBe(10095)
  })

  it('preserves an explicitly customized Docker runtime', () => {
    const merged = mergeVoiceInputSettings({
      runtimeProvider: 'docker',
      funasr: {
        wsUrl: 'ws://127.0.0.1:19096',
        hostPort: 19096,
        image: DEFAULT_FUNASR_IMAGE
      }
    })

    expect(merged.runtimeProvider).toBe('docker')
    expect(merged.funasr.wsUrl).toBe('ws://127.0.0.1:19096')
    expect(merged.funasr.hostPort).toBe(19096)
  })

  it('preserves Docker when only the host port was customized', () => {
    const merged = mergeVoiceInputSettings({
      runtimeProvider: 'docker',
      funasr: {
        wsUrl: DEFAULT_DOCKER_FUNASR_WS_URL,
        hostPort: DEFAULT_DOCKER_FUNASR_HOST_PORT + 1,
        image: DEFAULT_FUNASR_IMAGE
      }
    })

    expect(merged.runtimeProvider).toBe('docker')
    expect(merged.funasr.wsUrl).toBe(DEFAULT_DOCKER_FUNASR_WS_URL)
    expect(merged.funasr.hostPort).toBe(DEFAULT_DOCKER_FUNASR_HOST_PORT + 1)
  })
})
