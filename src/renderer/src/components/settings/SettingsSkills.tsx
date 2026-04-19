import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Check,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  X,
  AlertCircle,
  Github,
  Package,
  Search,
  ChevronDown,
  Info,
  Layers,
  ShoppingBag
} from 'lucide-react'
import { useSkillStore } from '@/stores/useSkillStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import {
  ALL_PROVIDERS,
  PROVIDER_LABELS,
  SUPPORTED_SCOPES_BY_PROVIDER,
  scopeKey
} from '@shared/types/skill'
import type { SkillScope, SkillHub, SkillProvider } from '@shared/types/skill'
import { InstallSkillDialog } from './InstallSkillDialog'

type ScopeKind = SkillScope['kind']
type TabType = 'installed' | 'browse'

export function SettingsSkills(): React.JSX.Element {
  const { t } = useI18n()
  const {
    hubs,
    selectedHubId,
    skillsByHub,
    installedByScope,
    selectedSkillId,
    scope,
    providerAvailability,
    loading,
    refreshing,
    error,
    setScope,
    selectHub,
    selectSkill,
    loadHubs,
    loadSkills,
    loadInstalled,
    loadProviders,
    addHub,
    removeHub,
    refreshHub,
    uninstall
  } = useSkillStore()

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)

  const projectPath = useMemo(() => {
    if (!selectedProjectId) return null
    return projects.find((p) => p.id === selectedProjectId)?.path ?? null
  }, [selectedProjectId, projects])

  const worktreePath = useMemo(() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt.path
    }
    return null
  }, [selectedWorktreeId, worktreesByProject])

  const [activeTab, setActiveTab] = useState<TabType>('installed')
  const [skillMarkdown, setSkillMarkdown] = useState<string>('')
  const [markdownLoading, setMarkdownLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [addHubOpen, setAddHubOpen] = useState(false)
  const [hubPopoverOpen, setHubPopoverOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [newRepo, setNewRepo] = useState('')
  const [newRef, setNewRef] = useState('main')
  const [newName, setNewName] = useState('')
  const [installDialogOpen, setInstallDialogOpen] = useState(false)

  const currentHub: SkillHub | null =
    hubs.find((h) => h.id === selectedHubId) ?? hubs[0] ?? null

  const skillsInCurrentHub = useMemo(
    () => (currentHub ? (skillsByHub[currentHub.id] ?? []) : []),
    [currentHub, skillsByHub]
  )

  const installedList = useMemo(() => {
    return installedByScope[scopeKey(scope)] ?? []
  }, [installedByScope, scope])

  const displayedSkills = useMemo(() => {
    const base = activeTab === 'installed' ? installedList : skillsInCurrentHub
    if (!searchQuery.trim()) return base
    const q = searchQuery.toLowerCase()
    return base.filter(
      (s) =>
        (s.frontmatter.name || s.id).toLowerCase().includes(q) ||
        s.frontmatter.description?.toLowerCase().includes(q)
    )
  }, [activeTab, installedList, skillsInCurrentHub, searchQuery])

  useEffect(() => {
    loadHubs()
    loadProviders()
  }, [loadHubs, loadProviders])

  useEffect(() => {
    if (!currentHub) return
    let cancelled = false
    const go = async (): Promise<void> => {
      await loadSkills(currentHub.id)
      if (cancelled) return
      if (currentHub.kind === 'remote' && !currentHub.lastRefreshedAt) {
        await refreshHub(currentHub.id)
      }
    }
    go()
    return (): void => {
      cancelled = true
    }
  }, [currentHub, loadSkills, refreshHub])

  useEffect(() => {
    if (scope.kind === 'user' || scope.path) {
      loadInstalled(scope)
    }
  }, [scope, loadInstalled])

  /**
   * Pre-load all *user-scope* installed lists for every provider so the
   * skill cards can show "installed in CC/CX/OC" chips without per-card
   * IPC chatter. Project/worktree scope chips fall back to the current
   * `scope`'s installed list.
   */
  useEffect(() => {
    for (const p of ALL_PROVIDERS) {
      if (providerAvailability[p]) {
        loadInstalled({ provider: p, kind: 'user' })
      }
    }
  }, [providerAvailability, loadInstalled])

  // Reset selection when switching tabs or scope
  useEffect(() => {
    if (displayedSkills.length > 0) {
      if (!displayedSkills.some((s) => s.id === selectedSkillId)) {
        selectSkill(displayedSkills[0].id)
      }
    } else {
      selectSkill(null)
    }
  }, [activeTab, scope, displayedSkills, selectedSkillId, selectSkill])

  useEffect(() => {
    const allAvailable = [...skillsInCurrentHub, ...installedList]
    const skill = allAvailable.find((s) => s.id === selectedSkillId)
    if (!skill) {
      setSkillMarkdown('')
      return
    }
    let cancelled = false
    setMarkdownLoading(true)
    const path = 'installPath' in skill ? skill.installPath : skill.sourcePath
    window.skillOps
      .readContent(`${path}/SKILL.md`)
      .then((res) => {
        if (cancelled) return
        setSkillMarkdown(res.success ? (res.content ?? '') : '')
        setMarkdownLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setSkillMarkdown('')
          setMarkdownLoading(false)
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [selectedSkillId, skillsInCurrentHub, installedList])

  const currentSkill = useMemo(() => {
    const allAvailable = [...skillsInCurrentHub, ...installedList]
    return allAvailable.find((s) => s.id === selectedSkillId)
  }, [selectedSkillId, skillsInCurrentHub, installedList])

  const installedIdsInCurrentScope = new Set(installedList.map((s) => s.id))
  const selectedInstalled = installedList.find((s) => s.id === selectedSkillId)

  /**
   * For a given skill id, return the providers that have it installed at
   * USER scope. Used by the per-card provider chips. (Project/worktree
   * checks would require knowing every project — too noisy for chips.)
   */
  const installedProvidersOf = useMemo(
    () =>
      (skillId: string): SkillProvider[] =>
        ALL_PROVIDERS.filter((p) =>
          (installedByScope[scopeKey({ provider: p, kind: 'user' })] ?? []).some(
            (s) => s.id === skillId
          )
        ),
    [installedByScope]
  )

  const onProviderTab = (p: SkillProvider): void => {
    // If switching providers and the current scope kind isn't supported by
    // the new provider (OpenCode + project today), drop back to user scope.
    const supports = SUPPORTED_SCOPES_BY_PROVIDER[p]
    const nextKind: ScopeKind = supports.includes(scope.kind) ? scope.kind : 'user'
    if (nextKind === 'user') {
      setScope({ provider: p, kind: 'user' })
    } else if (nextKind === 'project') {
      setScope({ provider: p, kind: 'project', path: projectPath ?? '' })
    } else {
      setScope({ provider: p, kind: 'worktree', path: worktreePath ?? '' })
    }
  }

  const onScopeChange = (kind: ScopeKind): void => {
    if (kind === 'user') {
      setScope({ provider: scope.provider, kind: 'user' })
    } else if (kind === 'project') {
      setScope({ provider: scope.provider, kind: 'project', path: projectPath ?? '' })
    } else {
      setScope({ provider: scope.provider, kind: 'worktree', path: worktreePath ?? '' })
    }
  }

  const handleUninstall = async (): Promise<void> => {
    if (!currentSkill) return
    const ok = window.confirm(
      t('settings.skills.detail.uninstallConfirm', {
        name: currentSkill.frontmatter.name || currentSkill.id
      })
    )
    if (!ok) return
    setBusy(true)
    try {
      const res = await uninstall(currentSkill.id, scope)
      if (res.success) {
        toast.success(
          t('settings.skills.detail.uninstallSuccess', {
            name: currentSkill.frontmatter.name || currentSkill.id
          })
        )
      } else {
        toast.error(res.message ?? t('settings.skills.detail.error.uninstallFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleReveal = (): void => {
    if (!selectedInstalled) return
    window.skillOps.openLocation(`${selectedInstalled.installPath}/SKILL.md`)
    toast.success(
      t('settings.skills.detail.revealSuccess', {
        name: selectedInstalled.frontmatter.name || selectedInstalled.id
      })
    )
  }

  const handleRefreshHub = async (): Promise<void> => {
    if (!currentHub) return
    const res = await refreshHub(currentHub.id)
    if (res.success) {
      toast.success(t('settings.skills.hubs.refresh'))
    } else {
      toast.error(
        res.message ?? t('settings.skills.hubs.refreshFailed', { defaultValue: 'Refresh failed' })
      )
    }
  }

  const handleAddHub = async (): Promise<void> => {
    if (!newRepo.trim()) return
    const res = await addHub({
      repo: newRepo.trim(),
      ref: newRef.trim() || 'main',
      name: newName.trim() || undefined
    })
    if (res.success) {
      toast.success(`Hub added: ${res.hub?.repo}`)
      setAddHubOpen(false)
      setNewRepo('')
      setNewRef('main')
      setNewName('')
    } else {
      toast.error(res.message ?? 'Failed to add hub')
    }
  }

  const handleRemoveHub = async (hub: SkillHub): Promise<void> => {
    if (hub.builtin || hub.kind === 'bundled') return
    const ok = window.confirm(t('settings.skills.hubs.removeConfirm', { name: hub.name }))
    if (!ok) return
    const res = await removeHub(hub.id)
    if (res.success) {
      toast.success(`Removed ${hub.name}`)
    } else {
      toast.error(res.message ?? 'Failed to remove hub')
    }
  }

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-base font-medium mb-1 flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            {t('settings.skills.title')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('settings.skills.description')}</p>
        </div>

        <div className="flex items-center gap-1 bg-muted/30 p-1 rounded-xl border border-border/50">
          <TabButton
            active={activeTab === 'installed'}
            onClick={() => setActiveTab('installed')}
            icon={<Layers className="h-3.5 w-3.5" />}
          >
            {t('settings.skills.tabs.installed')}
          </TabButton>
          <TabButton
            active={activeTab === 'browse'}
            onClick={() => setActiveTab('browse')}
            icon={<ShoppingBag className="h-3.5 w-3.5" />}
          >
            {t('settings.skills.tabs.browse')}
          </TabButton>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 min-h-0">
        {/* Provider tabs (CC/CX/OC) — picks which provider's installed list
            and chip we look at. Install dialog handles cross-provider fan-out. */}
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-muted/20 p-3 shrink-0">
          <span className="text-xs font-semibold text-muted-foreground/80 px-1">
            {t('settings.skills.install.providerLabel')}
          </span>
          <div className="flex gap-1.5">
            {ALL_PROVIDERS.map((p) => (
              <ProviderTab
                key={p}
                active={scope.provider === p}
                label={PROVIDER_LABELS[p]}
                detected={providerAvailability[p]}
                onClick={() => onProviderTab(p)}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs font-semibold text-muted-foreground/80 px-1">
              {t('settings.skills.scope.title')}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground/50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                {t('settings.skills.scope.selectContextHint')}
              </TooltipContent>
            </Tooltip>
            <div className="flex flex-wrap gap-2">
              {(['user', 'project', 'worktree'] as ScopeKind[]).map((kind) => {
                const supported = SUPPORTED_SCOPES_BY_PROVIDER[scope.provider].includes(kind)
                const noPath =
                  (kind === 'project' && !projectPath) ||
                  (kind === 'worktree' && !worktreePath)
                return (
                  <ScopePill
                    key={kind}
                    active={scope.kind === kind}
                    label={t(`settings.skills.scope.${kind}` as const)}
                    sub={
                      kind === 'user'
                        ? t('settings.skills.scope.userHint')
                        : kind === 'project'
                          ? projectPath || t('settings.skills.scope.noProject')
                          : worktreePath || t('settings.skills.scope.noWorktree')
                    }
                    disabled={!supported || noPath}
                    disabledReason={
                      !supported
                        ? t('settings.skills.install.providerUnsupportedScope')
                        : undefined
                    }
                    onClick={() => onScopeChange(kind)}
                  />
                )
              })}
            </div>
          </div>
        </div>

        {error && (activeTab === 'browse' || !displayedSkills.length) && (
          <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive shrink-0">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <div className="flex flex-1 min-h-0 gap-6 overflow-hidden">
          <aside className="w-72 shrink-0 flex flex-col gap-3 min-h-0">
            <div className="relative shrink-0">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('settings.skills.search.placeholder')}
                className="pl-9 h-9 text-sm rounded-xl bg-muted/20 border-border/70"
              />
            </div>

            {activeTab === 'browse' && (
              <div className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-muted/20 p-2 overflow-hidden shrink-0">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground/70">
                    {t('settings.skills.hubs.title')}
                  </span>
                  <div className="flex items-center gap-1">
                    {currentHub?.kind === 'remote' && (
                      <button
                        onClick={handleRefreshHub}
                        disabled={refreshing}
                        className="p-1 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                        title={t('settings.skills.hubs.pullHint')}
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
                      </button>
                    )}
                    <button
                      onClick={() => setAddHubOpen(true)}
                      className="p-1 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
                      title={t('settings.skills.hubs.add')}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <Popover open={hubPopoverOpen} onOpenChange={setHubPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium rounded-xl bg-background border border-border/70 hover:bg-accent/30 transition-colors group">
                      <div className="flex items-center gap-2 truncate">
                        {currentHub?.kind === 'bundled' ? (
                          <Package className="h-4 w-4" />
                        ) : (
                          <Github className="h-4 w-4" />
                        )}
                        <span className="truncate">{currentHub?.name || 'Select Hub'}</span>
                      </div>
                      <ChevronDown className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="p-1 w-[260px] rounded-xl shadow-lg border-border/70"
                    align="start"
                  >
                    <div className="max-h-[300px] overflow-y-auto">
                      {hubs.map((hub) => (
                        <button
                          key={hub.id}
                          onClick={() => {
                            selectHub(hub.id)
                            setHubPopoverOpen(false)
                          }}
                          className={cn(
                            'flex items-center justify-between w-full px-3 py-2 text-sm rounded-lg transition-colors text-left',
                            selectedHubId === hub.id
                              ? 'bg-primary text-primary-foreground'
                              : 'hover:bg-accent/70'
                          )}
                        >
                          <div className="flex items-center gap-2 truncate">
                            {hub.kind === 'bundled' ? (
                              <Package className="h-3.5 w-3.5" />
                            ) : (
                              <Github className="h-3.5 w-3.5" />
                            )}
                            <span className="truncate font-medium">{hub.name}</span>
                          </div>
                          {hub.kind === 'remote' && !hub.builtin && (
                            <X
                              className="h-3.5 w-3.5 opacity-60 hover:opacity-100 shrink-0"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleRemoveHub(hub)
                              }}
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>

                {addHubOpen && (
                  <div className="mt-1 p-3 rounded-xl border border-border/70 bg-background/50 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold">
                        {t('settings.skills.hubs.addTitle')}
                      </span>
                      <X
                        className="h-3.5 w-3.5 cursor-pointer text-muted-foreground hover:text-foreground"
                        onClick={() => setAddHubOpen(false)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Input
                        value={newRepo}
                        onChange={(e) => setNewRepo(e.target.value)}
                        placeholder={t('settings.skills.hubs.repoPlaceholder')}
                        className="h-8 text-xs rounded-lg"
                      />
                      <Input
                        value={newRef}
                        onChange={(e) => setNewRef(e.target.value)}
                        placeholder={t('settings.skills.hubs.refPlaceholder')}
                        className="h-8 text-xs rounded-lg"
                      />
                      <Input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder={t('settings.skills.hubs.namePlaceholder')}
                        className="h-8 text-xs rounded-lg"
                      />
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm"
                          className="flex-1 h-7 rounded-lg text-xs"
                          onClick={handleAddHub}
                          disabled={!newRepo.trim()}
                        >
                          {t('settings.skills.hubs.add')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-hidden flex flex-col rounded-2xl border border-border/70 bg-muted/10">
              <div className="px-4 py-2 text-[10px] uppercase font-bold tracking-widest text-muted-foreground/60 border-b border-border/50">
                {activeTab === 'installed'
                  ? t('settings.skills.list.installedSkills', { count: displayedSkills.length })
                  : t('settings.skills.list.hubSkills', { count: displayedSkills.length })}
              </div>
              <div className="flex-1 overflow-y-auto p-1.5 custom-scrollbar">
                {loading && activeTab === 'browse' && skillsInCurrentHub.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-20 gap-2 text-muted-foreground/60">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-xs">{t('settings.skills.list.loading')}</span>
                  </div>
                ) : displayedSkills.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 px-4 text-center gap-3 text-muted-foreground/60">
                    <div className="p-3 rounded-full bg-muted/30">
                      {activeTab === 'installed' ? (
                        <Layers className="h-8 w-8 opacity-20" />
                      ) : (
                        <ShoppingBag className="h-8 w-8 opacity-20" />
                      )}
                    </div>
                    <span className="text-xs font-medium">
                      {activeTab === 'installed'
                        ? t('settings.skills.list.noneInstalled')
                        : t('settings.skills.list.empty')}
                    </span>
                    {activeTab === 'browse' &&
                      currentHub?.kind === 'remote' &&
                      skillsInCurrentHub.length === 0 && (
                        <p className="text-[10px] leading-relaxed opacity-70">
                          {t('settings.skills.list.refreshToLoad')}
                        </p>
                      )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {displayedSkills.map((s) => {
                      const presentIn = installedProvidersOf(s.id)
                      return (
                        <button
                          key={s.id}
                          onClick={() => selectSkill(s.id)}
                          className={cn(
                            'w-full text-left px-3 py-2.5 rounded-xl transition-all border',
                            selectedSkillId === s.id
                              ? 'bg-background border-primary/20 shadow-sm'
                              : 'border-transparent hover:bg-background/50 hover:border-border/50'
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={cn(
                                'truncate text-sm transition-colors',
                                selectedSkillId === s.id
                                  ? 'font-semibold text-foreground'
                                  : 'font-medium text-muted-foreground'
                              )}
                            >
                              {s.frontmatter.name || s.id}
                            </span>
                            {/* Provider chips: which providers have this skill at user-scope */}
                            {presentIn.length > 0 && (
                              <div className="flex items-center gap-0.5 shrink-0">
                                {presentIn.map((p) => (
                                  <span
                                    key={p}
                                    title={`${PROVIDER_LABELS[p]} (user)`}
                                    className="text-[9px] font-bold uppercase tracking-tight rounded px-1 py-0.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                                  >
                                    {p === 'claude-code' ? 'CC' : p === 'codex' ? 'CX' : 'OC'}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          {s.frontmatter.description && (
                            <div className="text-[11px] text-muted-foreground/80 truncate mt-1">
                              {s.frontmatter.description}
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </aside>

          <section className="flex-1 flex flex-col min-w-0 rounded-2xl border border-border/70 bg-background overflow-hidden shadow-sm">
            {!currentSkill ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
                <div className="p-6 rounded-3xl bg-muted/20">
                  <BookOpen className="h-16 w-16 opacity-10" />
                </div>
                <span className="text-sm font-medium">
                  {t('settings.skills.detail.selectHint')}
                </span>
              </div>
            ) : (
              <>
                <header className="border-b border-border/50 bg-muted/5 p-6 pb-5 space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-3">
                        <h4 className="text-2xl font-bold tracking-tight truncate">
                          {currentSkill.frontmatter.name || currentSkill.id}
                        </h4>
                        {currentSkill.frontmatter.version && (
                          <span className="px-2 py-0.5 rounded-full bg-muted text-[10px] font-bold text-muted-foreground border">
                            v{currentSkill.frontmatter.version}
                          </span>
                        )}
                      </div>
                      {currentSkill.frontmatter.description && (
                        <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
                          {currentSkill.frontmatter.description}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2 mt-4">
                        {currentSkill.frontmatter.tags?.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-1 rounded-lg bg-accent/50 px-2.5 py-1 text-[11px] font-medium text-accent-foreground border border-border/50"
                          >
                            <Tag className="h-3 w-3" />
                            {tag}
                          </span>
                        ))}
                        {installedIdsInCurrentScope.has(currentSkill.id) && (
                          <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                            <Check className="h-3 w-3" />
                            {PROVIDER_LABELS[scope.provider]} · {scope.kind}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 pt-1">
                      {selectedInstalled && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={handleReveal}
                          className="rounded-xl h-9 w-9"
                          title={t('settings.skills.detail.openInFinder')}
                        >
                          <FolderOpen className="h-4 w-4" />
                        </Button>
                      )}
                      {installedIdsInCurrentScope.has(currentSkill.id) && (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={handleUninstall}
                          className="rounded-xl px-4 h-9 font-semibold"
                        >
                          <Trash2 className="h-4 w-4 mr-1.5" />
                          {t('settings.skills.detail.uninstall')}
                        </Button>
                      )}
                      {/* Install button always opens the dialog — provider/scope
                          chosen there, never grayed out by main-window state. */}
                      <Button
                        size="sm"
                        disabled={busy || !currentHub}
                        onClick={() => setInstallDialogOpen(true)}
                        className="rounded-xl px-4 h-9 font-semibold shadow-md"
                      >
                        {t('settings.skills.install.openDialog')}
                      </Button>
                    </div>
                  </div>
                </header>

                <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                  {markdownLoading ? (
                    <div className="flex flex-col items-center justify-center h-40 gap-3 text-muted-foreground/60">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span className="text-sm font-medium">
                        {t('settings.skills.detail.loadingMarkdown')}
                      </span>
                    </div>
                  ) : (
                    <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-headings:tracking-tight">
                      <MarkdownRenderer content={skillMarkdown} />
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      <InstallSkillDialog
        skill={currentSkill ?? null}
        hubId={currentHub?.id ?? null}
        open={installDialogOpen}
        onOpenChange={setInstallDialogOpen}
      />
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  children
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-all',
        active
          ? 'bg-background text-foreground shadow-sm ring-1 ring-border/20'
          : 'text-muted-foreground hover:text-foreground hover:bg-background/40'
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function ProviderTab({
  active,
  label,
  detected,
  onClick
}: {
  active: boolean
  label: string
  detected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border',
        active
          ? 'bg-background border-primary text-foreground shadow-sm ring-1 ring-primary/20'
          : 'bg-background/40 border-border/70 text-muted-foreground hover:border-border hover:bg-background/60'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          detected ? 'bg-emerald-500' : 'bg-muted-foreground/30'
        )}
      />
      {label}
    </button>
  )
}

function ScopePill({
  active,
  label,
  sub,
  disabled,
  disabledReason,
  onClick
}: {
  active: boolean
  label: string
  sub: string
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex flex-col items-start px-4 py-2 rounded-xl border transition-all text-left group relative',
        active
          ? 'bg-background border-primary text-foreground shadow-sm ring-1 ring-primary/20'
          : 'bg-background/40 border-border/70 text-muted-foreground hover:border-border hover:bg-background/60',
        disabled && 'opacity-40 cursor-not-allowed'
      )}
      title={disabledReason || sub}
    >
      <span className="text-xs font-bold leading-none">{label}</span>
      <span className="text-[10px] font-medium opacity-60 max-w-[140px] truncate mt-1">{sub}</span>
    </button>
  )
}
