import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { Info } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

export function SettingsModels(): React.JSX.Element {
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'opencode'
  const supportsModes = defaultAgentSdk === 'claude-code' || defaultAgentSdk === 'codex'
  const { t } = useI18n()
  // Show the effective model for the current SDK (what new sessions will actually use)
  const effectiveModel = useSettingsStore((s) =>
    resolveModelForSdk(defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk, s)
  )
  const defaultModels = useSettingsStore((state) => state.defaultModels)
  const compactionModel = useSettingsStore((state) => state.xuanpuAgentCompactionModel)
  const setSelectedModel = useSettingsStore((state) => state.setSelectedModel)
  const setSelectedModelForSdk = useSettingsStore((state) => state.setSelectedModelForSdk)
  const setModeDefaultModel = useSettingsStore((state) => state.setModeDefaultModel)
  const setCompactionModel = useSettingsStore((state) => state.setXuanpuAgentCompactionModel)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">{t('settings.models.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.models.description')}</p>
      </div>

      {/* Info box explaining priority */}
      <div className="flex gap-2 p-3 rounded-md bg-muted/30 border border-border">
        <Info className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            <strong>{t('settings.models.priority.title')}</strong>
          </p>
          <ol className="list-decimal list-inside space-y-0.5 ml-2">
            <li>{t('settings.models.priority.worktree')}</li>
            {supportsModes && <li>{t('settings.models.priority.mode')}</li>}
            <li>{t('settings.models.priority.global')}</li>
            <li>{t('settings.models.priority.fallback')}</li>
          </ol>
        </div>
      </div>

      {/* Global default */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('settings.models.global.label')}</label>
        <p className="text-xs text-muted-foreground">
          {supportsModes
            ? t('settings.models.global.fallbackDescription')
            : t('settings.models.global.sessionDescription')}
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={effectiveModel}
            onChange={(model) => {
              // Update both legacy selectedModel and per-SDK entry so
              // resolveModelForSdk returns the new model for new sessions
              const sdk = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
              setSelectedModel(model)
              setSelectedModelForSdk(sdk, model)
            }}
          />
          {effectiveModel && (
            <button
              onClick={() => {
                const sdk = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
                setSelectedModel(null)
                setSelectedModelForSdk(sdk, null)
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('settings.models.global.clear')}
            </button>
          )}
        </div>
      </div>

      {/* Compaction model (xuanpu-agent) */}
      <div className="space-y-2">
        <label className="text-sm font-medium">压缩模型</label>
        <p className="text-xs text-muted-foreground">
          xuanpu-agent 历史轮次摘要使用的轻量模型。留空则自动从主模型 provider 推导；无可用候选时降级为规则摘要。
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={compactionModel}
            onChange={(model) => setCompactionModel(model)}
          />
          {compactionModel && (
            <button
              onClick={() => setCompactionModel(null)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              自动
            </button>
          )}
        </div>
        {!compactionModel && (
          <p className="text-xs text-muted-foreground/70">
            当前：自动推导（从主模型 provider 选择轻量候选）
          </p>
        )}
      </div>

      {supportsModes && (
        <>
          <div className="border-t pt-4" />

          {/* Build mode */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.models.build.label')}</label>
            <p className="text-xs text-muted-foreground">
              {t('settings.models.build.description')}
            </p>
            <div className="flex items-center gap-2">
              <ModelSelector
                value={defaultModels?.build || null}
                onChange={(model) => setModeDefaultModel('build', model)}
              />
              {defaultModels?.build && (
                <button
                  onClick={() => setModeDefaultModel('build', null)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('settings.models.useGlobal')}
                </button>
              )}
            </div>
          </div>

          {/* Plan mode */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.models.plan.label')}</label>
            <p className="text-xs text-muted-foreground">{t('settings.models.plan.description')}</p>
            <div className="flex items-center gap-2">
              <ModelSelector
                value={defaultModels?.plan || null}
                onChange={(model) => setModeDefaultModel('plan', model)}
              />
              {defaultModels?.plan && (
                <button
                  onClick={() => setModeDefaultModel('plan', null)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('settings.models.useGlobal')}
                </button>
              )}
            </div>
          </div>

          {/* Ask command */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.models.ask.label')}</label>
            <p className="text-xs text-muted-foreground">{t('settings.models.ask.description')}</p>
            <div className="flex items-center gap-2">
              <ModelSelector
                value={defaultModels?.ask || null}
                onChange={(model) => setModeDefaultModel('ask', model)}
              />
              {defaultModels?.ask && (
                <button
                  onClick={() => setModeDefaultModel('ask', null)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('settings.models.useGlobal')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
