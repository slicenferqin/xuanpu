import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { Activity, CheckCircle2, Copy, Loader2, Mic, Play, Square, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import type {
  VoicePermissionStatus,
  VoiceRuntimeProvider,
  VoiceRuntimeInfo,
  VoiceRuntimeProgress,
  VoiceRuntimeStatus
} from '@shared/types/voice'
import {
  DEFAULT_DOCKER_FUNASR_HOST_PORT,
  DEFAULT_DOCKER_FUNASR_WS_URL,
  DEFAULT_FUNASR_HOST_PORT,
  DEFAULT_FUNASR_WS_URL
} from '@shared/types/voice'

type TFunction = (key: string, params?: Record<string, string | number | boolean>) => string

function statusLabel(t: TFunction, status?: VoiceRuntimeStatus): string {
  return t(`settings.voicePage.status.${status ?? 'notChecked'}`)
}

function permissionLabel(t: TFunction, status?: VoicePermissionStatus | null): string {
  return t(`settings.voicePage.permission.${status ?? 'notChecked'}`)
}

function providerLabel(t: TFunction, provider: VoiceRuntimeProvider): string {
  return t(`settings.voicePage.providers.${provider}.label`)
}

function statusTone(status?: VoiceRuntimeStatus): string {
  if (status === 'ready') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
  if (
    status === 'error' ||
    status === 'python_missing' ||
    status === 'git_missing' ||
    status === 'docker_missing' ||
    status === 'docker_stopped' ||
    status === 'docker_installer_ready'
  ) {
    return 'border-amber-500/25 bg-amber-500/10 text-amber-700'
  }
  return 'border-border/70 bg-muted/40 text-muted-foreground'
}

export function SettingsVoice(): React.JSX.Element {
  const { t } = useI18n()
  const voiceInput = useSettingsStore((s) => s.voiceInput)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [runtime, setRuntime] = useState<VoiceRuntimeInfo | null>(null)
  const [progress, setProgress] = useState<VoiceRuntimeProgress | null>(null)
  const [permission, setPermission] = useState<VoicePermissionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState('')
  const providerDefaultWsUrl =
    voiceInput.runtimeProvider === 'docker' ? DEFAULT_DOCKER_FUNASR_WS_URL : DEFAULT_FUNASR_WS_URL
  const providerDefaultHostPort =
    voiceInput.runtimeProvider === 'docker'
      ? DEFAULT_DOCKER_FUNASR_HOST_PORT
      : DEFAULT_FUNASR_HOST_PORT
  const runtimeStatus = runtime?.status ?? progress?.status
  const runtimeDescription = runtime?.error
    ? runtime.error
    : runtimeStatus
      ? statusLabel(t, runtimeStatus)
      : t('settings.voicePage.runtime.checkHint')

  useEffect(() => {
    return window.voiceOps.onRuntimeProgress((next) => {
      setProgress(next)
      setRuntime((current) =>
        current
          ? { ...current, status: next.status, message: next.message }
          : {
              provider: voiceInput.runtimeProvider,
              status: next.status,
              wsUrl: voiceInput.funasr.wsUrl,
              message: next.message
            }
      )
    })
  }, [voiceInput.funasr.wsUrl, voiceInput.runtimeProvider])

  const updateVoice = useCallback(
    (patch: Partial<typeof voiceInput>) => {
      updateSetting('voiceInput', { ...voiceInput, ...patch })
    },
    [updateSetting, voiceInput]
  )

  const updateFunAsr = useCallback(
    (patch: Partial<typeof voiceInput.funasr>) => {
      updateSetting('voiceInput', {
        ...voiceInput,
        funasr: { ...voiceInput.funasr, ...patch }
      })
    },
    [updateSetting, voiceInput]
  )

  const updateProvider = useCallback(
    (provider: VoiceRuntimeProvider) => {
      const funasrPatch =
        provider === 'docker'
          ? {
              wsUrl: DEFAULT_DOCKER_FUNASR_WS_URL,
              hostPort: DEFAULT_DOCKER_FUNASR_HOST_PORT
            }
          : provider === 'managed'
            ? {
                wsUrl: DEFAULT_FUNASR_WS_URL,
                hostPort: DEFAULT_FUNASR_HOST_PORT
              }
            : {}

      updateSetting('voiceInput', {
        ...voiceInput,
        runtimeProvider: provider,
        autoInstallRuntime: provider !== 'external',
        funasr: {
          ...voiceInput.funasr,
          ...funasrPatch
        }
      })
    },
    [updateSetting, voiceInput]
  )

  const detectRuntime = useCallback(async () => {
    setBusy(true)
    try {
      const next = await window.voiceOps.detectRuntime(voiceInput)
      setRuntime(next)
      toast.info(statusLabel(t, next.status))
    } finally {
      setBusy(false)
    }
  }, [t, voiceInput])

  const ensureRuntime = useCallback(async () => {
    setBusy(true)
    try {
      const next = await window.voiceOps.ensureRuntime(voiceInput)
      setRuntime(next)
      if (next.status === 'ready') {
        toast.success(t('settings.voicePage.toasts.runtimeReady'))
      } else if (next.error) {
        toast.error(next.error)
      } else {
        toast.warning(statusLabel(t, next.status))
      }
    } finally {
      setBusy(false)
    }
  }, [t, voiceInput])

  const stopRuntime = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.voiceOps.stopRuntime()
      if (result.success) {
        toast.success(t('settings.voicePage.toasts.runtimeStopped'))
        await detectRuntime()
      } else {
        toast.error(result.error || t('settings.voicePage.toasts.runtimeStopFailed'))
      }
    } finally {
      setBusy(false)
    }
  }, [detectRuntime, t])

  const loadLogs = useCallback(async () => {
    const next = await window.voiceOps.getRuntimeLogs()
    setLogs(next.serverLog || next.installLog || t('settings.voicePage.diagnostics.noLogs'))
  }, [t])

  const checkPermission = useCallback(async () => {
    setPermission(await window.voiceOps.getMicrophonePermissionStatus())
  }, [])

  const requestPermission = useCallback(async () => {
    const next = await window.voiceOps.requestMicrophonePermission()
    setPermission(next)
    if (next === 'granted' || next === 'unknown') {
      toast.success(t('settings.voicePage.toasts.microphoneAvailable'))
    } else {
      toast.error(
        t('settings.voicePage.toasts.microphonePermission', { status: permissionLabel(t, next) })
      )
    }
  }, [t])

  const copyDiagnostics = useCallback(async () => {
    const text = JSON.stringify({ runtime, progress, permission, settings: voiceInput }, null, 2)
    await navigator.clipboard.writeText(`${text}\n\n${logs}`)
    toast.success(t('settings.voicePage.toasts.diagnosticsCopied'))
  }, [logs, permission, progress, runtime, t, voiceInput])

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">{t('settings.voicePage.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.voicePage.description')}</p>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/35 p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-medium">{t('settings.voicePage.runtime.title')}</h4>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-xs font-medium',
                  statusTone(runtimeStatus)
                )}
              >
                {statusLabel(t, runtimeStatus)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{runtimeDescription}</p>
            {progress?.detail ? (
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{progress.detail}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={detectRuntime} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 />}
              {t('settings.voicePage.runtime.check')}
            </Button>
            <Button size="sm" onClick={ensureRuntime} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench />}
              {t('settings.voicePage.runtime.prepare')}
            </Button>
            <Button variant="outline" size="sm" onClick={stopRuntime} disabled={busy}>
              <Square />
              {t('settings.voicePage.runtime.stop')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 text-xs">
          <RuntimeStat
            label={t('settings.voicePage.runtime.provider')}
            value={providerLabel(t, runtime?.provider || voiceInput.runtimeProvider)}
          />
          <RuntimeStat
            label={t('settings.voicePage.runtime.websocket')}
            value={runtime?.wsUrl || voiceInput.funasr.wsUrl}
          />
          <RuntimeStat
            label={t('settings.voicePage.runtime.port')}
            value={String(runtime?.hostPort || voiceInput.funasr.hostPort)}
          />
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/35 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-medium">{t('settings.voicePage.engine.title')}</h4>
        </div>

        <SettingRow
          title={t('settings.voicePage.engine.enableTitle')}
          description={t('settings.voicePage.engine.enableDescription')}
        >
          <Switch
            checked={voiceInput.enabled}
            onCheckedChange={(checked) => updateVoice({ enabled: checked })}
          />
        </SettingRow>

        <div className="space-y-2">
          <div className="text-sm font-medium">{t('settings.voicePage.engine.providerTitle')}</div>
          <div className="grid gap-2 md:grid-cols-3">
            <ProviderCard
              provider="managed"
              selected={voiceInput.runtimeProvider === 'managed'}
              title={t('settings.voicePage.providers.managed.title')}
              description={t('settings.voicePage.providers.managed.description')}
              badge={t('settings.voicePage.providers.managed.badge')}
              onSelect={updateProvider}
            />
            <ProviderCard
              provider="external"
              selected={voiceInput.runtimeProvider === 'external'}
              title={t('settings.voicePage.providers.external.title')}
              description={t('settings.voicePage.providers.external.description')}
              onSelect={updateProvider}
            />
            <ProviderCard
              provider="docker"
              selected={voiceInput.runtimeProvider === 'docker'}
              title={t('settings.voicePage.providers.docker.title')}
              description={t('settings.voicePage.providers.docker.description')}
              badge={t('settings.voicePage.providers.docker.badge')}
              onSelect={updateProvider}
            />
          </div>
        </div>

        <SettingRow
          title={t('settings.voicePage.engine.autoInstallTitle')}
          description={
            voiceInput.runtimeProvider === 'external'
              ? t('settings.voicePage.engine.autoInstallExternal')
              : t('settings.voicePage.engine.autoInstallManaged')
          }
        >
          <Switch
            checked={voiceInput.autoInstallRuntime && voiceInput.runtimeProvider !== 'external'}
            disabled={voiceInput.runtimeProvider === 'external'}
            onCheckedChange={(checked) => updateVoice({ autoInstallRuntime: checked })}
          />
        </SettingRow>

        <div className="rounded-lg border border-cyan-300/25 bg-cyan-500/10 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-3">
            <span>{t('settings.voicePage.engine.pushToTalkHint')}</span>
            <kbd className="rounded-md border border-cyan-300/40 bg-background/75 px-2 py-1 text-[11px] font-semibold text-foreground">
              Ctrl
            </kbd>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3">
          <label className="space-y-1.5">
            <span className="text-xs font-medium">{t('settings.voicePage.engine.wsUrlLabel')}</span>
            <Input
              value={voiceInput.funasr.wsUrl}
              onChange={(event) => updateFunAsr({ wsUrl: event.target.value })}
              placeholder={providerDefaultWsUrl}
            />
          </label>
          {voiceInput.runtimeProvider === 'docker' ? (
            <label className="space-y-1.5">
              <span className="text-xs font-medium">
                {t('settings.voicePage.engine.dockerImageLabel')}
              </span>
              <Input
                value={voiceInput.funasr.image}
                onChange={(event) => updateFunAsr({ image: event.target.value })}
              />
            </label>
          ) : null}
          <label className="space-y-1.5">
            <span className="text-xs font-medium">
              {t('settings.voicePage.engine.hostPortLabel')}
            </span>
            <Input
              type="number"
              value={voiceInput.funasr.hostPort}
              onChange={(event) =>
                updateFunAsr({ hostPort: Number(event.target.value) || providerDefaultHostPort })
              }
            />
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/35 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h4 className="text-sm font-medium">{t('settings.voicePage.microphone.title')}</h4>
            <p className="text-xs text-muted-foreground">
              {t('settings.voicePage.microphone.currentPermission', {
                status: permissionLabel(t, permission)
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={checkPermission}>
              {t('settings.voicePage.microphone.check')}
            </Button>
            <Button size="sm" onClick={requestPermission}>
              {t('settings.voicePage.microphone.request')}
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card/35 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-medium">{t('settings.voicePage.diagnostics.title')}</h4>
            <p className="text-xs text-muted-foreground">
              {t('settings.voicePage.diagnostics.description')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadLogs}>
              <Play />
              {t('settings.voicePage.diagnostics.loadLogs')}
            </Button>
            <Button variant="outline" size="sm" onClick={copyDiagnostics}>
              <Copy />
              {t('settings.voicePage.diagnostics.copy')}
            </Button>
          </div>
        </div>
        {logs ? (
          <Textarea
            value={logs}
            readOnly
            className="min-h-[160px] font-mono text-xs"
            data-testid="settings-voice-logs"
          />
        ) : null}
      </div>
    </div>
  )
}

function RuntimeStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-background/45 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-medium">{value}</div>
    </div>
  )
}

function ProviderCard({
  provider,
  selected,
  title,
  description,
  badge,
  onSelect
}: {
  provider: VoiceRuntimeProvider
  selected: boolean
  title: string
  description: string
  badge?: string
  onSelect: (provider: VoiceRuntimeProvider) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'min-h-[98px] rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow]',
        selected
          ? 'border-cyan-300/70 bg-cyan-500/10 shadow-[0_0_0_1px_rgba(103,232,249,0.22),0_12px_34px_rgba(6,182,212,0.12)]'
          : 'border-border/70 bg-background/35 hover:border-border hover:bg-background/55'
      )}
      onClick={() => onSelect(provider)}
      aria-pressed={selected}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {badge ? (
          <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground">
            {badge}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </button>
  )
}

function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  )
}
