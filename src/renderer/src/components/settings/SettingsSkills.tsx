import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Check,
  Download,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Tag,
  Trash2,
  X,
  AlertCircle,
  Github,
  Package
} from 'lucide-react'
import { useSkillStore } from '@/stores/useSkillStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import type { SkillScope, SkillHub } from '@shared/types/skill'
import { scopeKey } from '@shared/types/skill'

type ScopeKind = SkillScope['kind']

export function SettingsSkills(): React.JSX.Element {
  const {
    hubs,
    selectedHubId,
    skillsByHub,
    installedByScope,
    selectedSkillId,
    scope,
    loading,
    refreshing,
    error,
    setScope,
    selectHub,
    selectSkill,
    loadHubs,
    loadSkills,
    loadInstalled,
    addHub,
    removeHub,
    refreshHub,
    install,
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

  const [skillMarkdown, setSkillMarkdown] = useState<string>('')
  const [markdownLoading, setMarkdownLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [addHubOpen, setAddHubOpen] = useState(false)
  const [newRepo, setNewRepo] = useState('')
  const [newRef, setNewRef] = useState('main')
  const [newName, setNewName] = useState('')

  const currentHub: SkillHub | null =
    hubs.find((h) => h.id === selectedHubId) ?? hubs[0] ?? null
  const skillsInCurrentHub = useMemo(
    () => (currentHub ? (skillsByHub[currentHub.id] ?? []) : []),
    [currentHub, skillsByHub]
  )

  useEffect(() => {
    loadHubs()
  }, [loadHubs])

  // Load skills for the currently-selected hub. For remote hubs that have
  // never been refreshed, kick off an automatic refresh so first-time users
  // aren't staring at an empty list.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHub?.id])

  useEffect(() => {
    if (scope.kind === 'user' || scope.path) {
      loadInstalled(scope)
    }
  }, [scope, loadInstalled])

  useEffect(() => {
    if (!selectedSkillId && skillsInCurrentHub.length > 0) {
      selectSkill(skillsInCurrentHub[0].id)
    }
  }, [skillsInCurrentHub, selectedSkillId, selectSkill])

  useEffect(() => {
    const skill = skillsInCurrentHub.find((s) => s.id === selectedSkillId)
    if (!skill) {
      setSkillMarkdown('')
      return
    }
    let cancelled = false
    setMarkdownLoading(true)
    window.skillOps
      .readContent(`${skill.sourcePath}/SKILL.md`)
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
  }, [selectedSkillId, skillsInCurrentHub])

  const currentSkill = skillsInCurrentHub.find((s) => s.id === selectedSkillId)
  const installedList = installedByScope[scopeKey(scope)] ?? []
  const installedIds = new Set(installedList.map((s) => s.id))
  const selectedInstalled = installedList.find((s) => s.id === selectedSkillId)

  const scopeAvailable = scope.kind === 'user' || Boolean(scope.path)

  const onScopeChange = (kind: ScopeKind): void => {
    if (kind === 'user') {
      setScope({ kind: 'user' })
    } else if (kind === 'project') {
      setScope({ kind: 'project', path: projectPath ?? '' })
    } else {
      setScope({ kind: 'worktree', path: worktreePath ?? '' })
    }
  }

  const handleInstall = async (): Promise<void> => {
    if (!currentSkill || !currentHub) return
    if (!scopeAvailable) {
      toast.error('请先在主界面选择一个项目 / Worktree')
      return
    }
    setBusy(true)
    try {
      const res = await install(currentHub.id, currentSkill.id, scope, false)
      if (res.success) {
        toast.success(`已安装「${currentSkill.frontmatter.name}」`)
      } else if (res.error === 'already_installed') {
        const ok = window.confirm(
          `「${currentSkill.frontmatter.name}」已安装。是否覆盖当前版本？`
        )
        if (ok) {
          const retry = await install(currentHub.id, currentSkill.id, scope, true)
          if (retry.success) {
            toast.success(`已覆盖安装「${currentSkill.frontmatter.name}」`)
          } else {
            toast.error(retry.message ?? '安装失败')
          }
        }
      } else {
        toast.error(res.message ?? '安装失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const handleUninstall = async (): Promise<void> => {
    if (!currentSkill) return
    const ok = window.confirm(`确定卸载「${currentSkill.frontmatter.name}」吗？`)
    if (!ok) return
    setBusy(true)
    try {
      const res = await uninstall(currentSkill.id, scope)
      if (res.success) {
        toast.success(`已卸载「${currentSkill.frontmatter.name}」`)
      } else {
        toast.error(res.message ?? '卸载失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const handleReveal = (): void => {
    if (!selectedInstalled) return
    window.skillOps.openLocation(`${selectedInstalled.installPath}/SKILL.md`)
  }

  const handleRefreshHub = async (): Promise<void> => {
    if (!currentHub) return
    const res = await refreshHub(currentHub.id)
    if (res.success) {
      toast.success(
        res.skillCount !== undefined
          ? `已刷新 ${currentHub.name}（${res.skillCount} 个 skill）`
          : `已刷新 ${currentHub.name}`
      )
    } else {
      toast.error(res.message ?? '刷新失败')
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
      toast.success(`已添加 Hub：${res.hub?.repo}`)
      setAddHubOpen(false)
      setNewRepo('')
      setNewRef('main')
      setNewName('')
    } else {
      toast.error(res.message ?? '添加失败')
    }
  }

  const handleRemoveHub = async (hub: SkillHub): Promise<void> => {
    if (hub.builtin || hub.kind === 'bundled') return
    const ok = window.confirm(`删除 Hub「${hub.name}」吗？本地缓存也会一并清理。`)
    if (!ok) return
    const res = await removeHub(hub.id)
    if (res.success) {
      toast.success(`已删除 ${hub.name}`)
    } else {
      toast.error(res.message ?? '删除失败')
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h3 className="text-base font-medium mb-1 flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          Skill Hub
        </h3>
        <p className="text-sm text-muted-foreground">
          浏览并安装 Claude Code skills，可切换不同 Hub（内置或 GitHub 远程仓库）。
        </p>
      </div>

      {/* Hub selector row */}
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <span className="text-muted-foreground shrink-0">来源：</span>
        <div className="inline-flex rounded-md border bg-muted/30 p-0.5 flex-wrap gap-0.5">
          {hubs.map((hub) => (
            <HubTab
              key={hub.id}
              hub={hub}
              active={currentHub?.id === hub.id}
              onClick={() => selectHub(hub.id)}
              onRemove={() => handleRemoveHub(hub)}
            />
          ))}
          <button
            onClick={() => setAddHubOpen((v) => !v)}
            className="px-2 py-1 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-background"
            title="添加自定义 GitHub Hub"
          >
            <Plus className="h-3.5 w-3.5 inline mr-0.5" />
            添加
          </button>
        </div>
        {currentHub && currentHub.kind === 'remote' && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshHub}
            disabled={refreshing}
            className="h-7"
            title={
              currentHub.lastRefreshedAt
                ? `上次刷新：${new Date(currentHub.lastRefreshedAt).toLocaleString()}`
                : '从 GitHub 拉取最新内容'
            }
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span className="ml-1">刷新</span>
          </Button>
        )}
      </div>

      {addHubOpen && (
        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <div className="text-xs font-medium flex items-center gap-1">
            <Github className="h-3.5 w-3.5" />
            添加 GitHub Hub
          </div>
          <div className="flex gap-2 flex-wrap">
            <Input
              value={newRepo}
              onChange={(e) => setNewRepo(e.target.value)}
              placeholder="owner/repo，例如 slicenferqin/xuanpu-skills-hub"
              className="flex-1 min-w-[260px] h-8 text-xs"
            />
            <Input
              value={newRef}
              onChange={(e) => setNewRef(e.target.value)}
              placeholder="分支/tag（默认 main）"
              className="w-40 h-8 text-xs"
            />
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="显示名（可选）"
              className="w-48 h-8 text-xs"
            />
            <Button size="sm" onClick={handleAddHub} disabled={!newRepo.trim()}>
              添加
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAddHubOpen(false)}>
              取消
            </Button>
          </div>
          <div className="text-[10px] text-muted-foreground">
            仅支持公共仓库，需要包含 <code>skills/&lt;id&gt;/SKILL.md</code> 结构。
          </div>
        </div>
      )}

      {/* Scope selector */}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">安装到：</span>
        <div className="inline-flex rounded-md border bg-muted/30 p-0.5">
          <ScopeTab
            active={scope.kind === 'user'}
            label="用户级"
            sub="~/.claude/skills"
            onClick={() => onScopeChange('user')}
          />
          <ScopeTab
            active={scope.kind === 'project'}
            label="项目级"
            sub={projectPath ?? '未选择项目'}
            disabled={!projectPath}
            onClick={() => onScopeChange('project')}
          />
          <ScopeTab
            active={scope.kind === 'worktree'}
            label="Worktree"
            sub={worktreePath ?? '未选择 Worktree'}
            disabled={!worktreePath}
            onClick={() => onScopeChange('worktree')}
          />
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Body: list + detail */}
      <div className="flex flex-1 min-h-0 gap-4">
        {/* Left: list */}
        <aside className="w-56 shrink-0 overflow-y-auto border rounded-md">
          <SectionLabel>
            {currentHub?.name ?? '—'} 中的 skills（{skillsInCurrentHub.length}）
          </SectionLabel>
          {loading && skillsInCurrentHub.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              加载中…
            </div>
          ) : skillsInCurrentHub.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {currentHub?.kind === 'remote'
                ? '暂无内容，点击上方「刷新」从 GitHub 拉取'
                : '暂无 skill'}
            </div>
          ) : (
            <ul>
              {skillsInCurrentHub.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => selectSkill(s.id)}
                    className={cn(
                      'w-full text-left px-3 py-2 text-sm border-l-2 transition-colors',
                      selectedSkillId === s.id
                        ? 'border-primary bg-accent'
                        : 'border-transparent hover:bg-accent/50'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">
                        {s.frontmatter.name || s.id}
                      </span>
                      {installedIds.has(s.id) && (
                        <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                      )}
                    </div>
                    {s.frontmatter.description && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {s.frontmatter.description}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <SectionLabel>
            当前 scope 已装（{installedList.length}）
          </SectionLabel>
          {installedList.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">暂无</div>
          ) : (
            <ul>
              {installedList.map((s) => (
                <li
                  key={s.id}
                  className="px-3 py-1.5 text-xs text-muted-foreground truncate"
                  title={s.installPath}
                >
                  {s.frontmatter.name || s.id}
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Right: detail */}
        <section className="flex-1 flex flex-col min-w-0 border rounded-md">
          {!currentSkill ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              从左侧选择一个 skill
            </div>
          ) : (
            <>
              <header className="border-b p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-base font-semibold truncate">
                      {currentSkill.frontmatter.name}
                      {currentSkill.frontmatter.version && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          v{currentSkill.frontmatter.version}
                        </span>
                      )}
                    </h4>
                    {currentSkill.frontmatter.description && (
                      <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">
                        {currentSkill.frontmatter.description}
                      </p>
                    )}
                    {currentSkill.frontmatter.tags &&
                      currentSkill.frontmatter.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {currentSkill.frontmatter.tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground"
                            >
                              <Tag className="h-2.5 w-2.5" />
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {selectedInstalled && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleReveal}
                        title="在 Finder 中打开"
                      >
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    )}
                    {installedIds.has(currentSkill.id) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={handleUninstall}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        卸载
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy || !scopeAvailable}
                        onClick={handleInstall}
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4 mr-1" />
                        )}
                        安装
                      </Button>
                    )}
                  </div>
                </div>
              </header>

              <div className="flex-1 overflow-y-auto p-4 text-sm">
                {markdownLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    加载 SKILL.md…
                  </div>
                ) : (
                  <MarkdownRenderer content={skillMarkdown} />
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/30 border-b">
      {children}
    </div>
  )
}

function HubTab({
  hub,
  active,
  onClick,
  onRemove
}: {
  hub: SkillHub
  active: boolean
  onClick: () => void
  onRemove: () => void
}): React.JSX.Element {
  const Icon = hub.kind === 'bundled' ? Package : Github
  const canRemove = hub.kind === 'remote' && !hub.builtin
  return (
    <div
      className={cn(
        'group relative flex items-center rounded text-xs transition-colors',
        active ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <button
        onClick={onClick}
        className="flex items-center gap-1 pl-2 pr-2 py-1"
        title={hub.repo ? `${hub.repo}@${hub.ref}` : '内置 Hub'}
      >
        <Icon className="h-3 w-3" />
        <span className={cn(active && 'font-medium')}>{hub.name}</span>
      </button>
      {canRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="opacity-0 group-hover:opacity-70 hover:opacity-100 pr-1.5 py-1 text-muted-foreground hover:text-destructive"
          title="删除这个 Hub"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

function ScopeTab({
  active,
  label,
  sub,
  disabled,
  onClick
}: {
  active: boolean
  label: string
  sub: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'px-3 py-1 rounded text-xs transition-colors',
        active
          ? 'bg-background shadow-sm font-medium'
          : 'text-muted-foreground hover:text-foreground',
        disabled && 'opacity-40 cursor-not-allowed hover:text-muted-foreground'
      )}
      title={sub}
    >
      <div>{label}</div>
      <div className="text-[10px] opacity-60 max-w-[160px] truncate">{sub}</div>
    </button>
  )
}
