export type VoiceRuntimeProvider = 'managed' | 'docker' | 'external'

export type VoiceRuntimeStatus =
  | 'idle'
  | 'checking'
  | 'python_missing'
  | 'git_missing'
  | 'runtime_missing'
  | 'downloading_runtime'
  | 'installing_runtime'
  | 'starting_runtime'
  | 'stopping_runtime'
  | 'docker_missing'
  | 'downloading_docker'
  | 'docker_installer_ready'
  | 'docker_stopped'
  | 'image_missing'
  | 'pulling_image'
  | 'creating_container'
  | 'starting_container'
  | 'downloading_models'
  | 'warming_up'
  | 'ready'
  | 'error'

export type VoicePermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

export interface VoiceHotword {
  text: string
  weight: number
  enabled: boolean
}

export interface VoiceInputSettings {
  enabled: boolean
  runtimeProvider: VoiceRuntimeProvider
  autoInstallRuntime: boolean
  funasr: {
    wsUrl: string
    image: string
    hostPort: number
    mode: '2pass'
    sampleRate: 16000
    chunkSize: [number, number, number]
    useItn: boolean
    hotwords: VoiceHotword[]
  }
}

export interface VoiceRuntimeConfig {
  runtimeProvider?: VoiceRuntimeProvider
  funasr?: Partial<VoiceInputSettings['funasr']>
}

export interface VoiceRuntimeInfo {
  provider: VoiceRuntimeProvider
  status: VoiceRuntimeStatus
  wsUrl: string
  image?: string
  containerName?: string
  hostPort?: number
  message?: string
  error?: string
}

export interface VoiceRuntimeProgress {
  status: VoiceRuntimeStatus
  percent?: number
  message: string
  detail?: string
}

export interface VoiceTranscriptionSessionOptions {
  wsUrl: string
  mode: '2pass'
  sampleRate: 16000
  chunkSize: [number, number, number]
  useItn: boolean
  hotwords: VoiceHotword[]
}

export interface VoiceTranscriptionSession {
  sessionId: string
}

export interface VoiceTranscriptEvent {
  sessionId: string
  type: 'partial' | 'final'
  text: string
  raw?: unknown
}

export interface VoiceErrorEvent {
  sessionId?: string
  message: string
}

export const DEFAULT_FUNASR_IMAGE =
  'registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13'

export const DEFAULT_FUNASR_WS_URL = 'ws://127.0.0.1:10095'
export const DEFAULT_FUNASR_HOST_PORT = 10095
export const DEFAULT_DOCKER_FUNASR_WS_URL = 'ws://127.0.0.1:10096'
export const DEFAULT_DOCKER_FUNASR_HOST_PORT = 10096
export const DEFAULT_FUNASR_CONTAINER_PORT = 10095
export const DEFAULT_FUNASR_CONTAINER_NAME = 'xuanpu-funasr-runtime'

export const DEFAULT_VOICE_INPUT_SETTINGS: VoiceInputSettings = {
  enabled: true,
  runtimeProvider: 'managed',
  autoInstallRuntime: true,
  funasr: {
    wsUrl: DEFAULT_FUNASR_WS_URL,
    image: DEFAULT_FUNASR_IMAGE,
    hostPort: DEFAULT_FUNASR_HOST_PORT,
    mode: '2pass',
    sampleRate: 16000,
    chunkSize: [5, 10, 5],
    useItn: true,
    hotwords: []
  }
}
