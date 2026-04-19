/**
 * Skill Hub — shared type definitions.
 *
 * A skill is a directory containing a `SKILL.md` file with YAML frontmatter
 * (name, description, version, …) plus any number of companion files. Xuanpu
 * surfaces skills from one or more **Hubs**:
 *
 *   - `bundled` — packaged with the app under `resources/built-in-skills/`
 *   - `remote`  — a GitHub repository cloned to `~/.xuanpu/skills-cache/`
 *
 * The same SKILL.md format is recognised by Claude Code, OpenAI Codex (since
 * 2025-12) and OpenCode (v1.0.190+); each provider scans its own directory
 * convention. A SkillScope therefore couples both **which provider** and
 * **which level** (user / project / worktree) the install targets.
 */

/** Agent providers that recognise SKILL.md-formatted skills. */
export type SkillProvider = 'claude-code' | 'codex' | 'opencode'

export const ALL_PROVIDERS: SkillProvider[] = ['claude-code', 'codex', 'opencode']

/** Pretty labels for UI display. */
export const PROVIDER_LABELS: Record<SkillProvider, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode'
}

/**
 * Maps our SkillProvider id to the key used by `system-info.detectAgentSdks()`
 * (which returns `{ claude, codex, opencode }`).
 */
export const PROVIDER_DETECTION_KEY: Record<SkillProvider, 'claude' | 'codex' | 'opencode'> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode'
}

/**
 * Which scope levels each provider supports today. OpenCode currently only
 * exposes a user-level `~/.config/opencode/skills/` directory; project-level
 * is left for a future iteration.
 */
export const SUPPORTED_SCOPES_BY_PROVIDER: Record<SkillProvider, Array<'user' | 'project' | 'worktree'>> = {
  'claude-code': ['user', 'project', 'worktree'],
  codex: ['user', 'project', 'worktree'],
  opencode: ['user']
}

/** YAML frontmatter fields recognised by the skill parser. */
export interface SkillFrontmatter {
  /** Required. Used as the install directory name and de-duplication key. */
  name: string
  description?: string
  version?: string
  author?: string
  tags?: string[]
  /** Optional lucide-react icon name, or an emoji. */
  icon?: string
}

/** Identity of a hub. `bundled` is a singleton; remote hubs use a UUID. */
export type HubId = 'bundled' | string

export type HubKind = 'bundled' | 'remote'

export interface SkillHub {
  id: HubId
  kind: HubKind
  /** Display label in the UI. */
  name: string
  /** For remote hubs: `owner/repo`. Empty for bundled. */
  repo?: string
  /** For remote hubs: branch / tag / sha. Defaults to `main`. */
  ref?: string
  /** ISO timestamp of last successful refresh (remote only). */
  lastRefreshedAt?: string
  /** Resolved commit SHA at last refresh (remote only). */
  lastSha?: string
  /** Whether this hub is the default seeded one and cannot be deleted. */
  builtin?: boolean
}

/** A skill available from a hub. */
export interface Skill {
  /** Stable id — folder name; must match frontmatter `name`. */
  id: string
  frontmatter: SkillFrontmatter
  /** Absolute path to the skill's source directory. */
  sourcePath: string
  /** Size of the skill folder in bytes (direct files only). */
  sizeBytes: number
  /** Which hub this skill came from. */
  hubId: HubId
}

/** Where a skill should be installed / is installed. */
export type SkillScope =
  | { provider: SkillProvider; kind: 'user' }
  | { provider: SkillProvider; kind: 'project'; path: string }
  | { provider: SkillProvider; kind: 'worktree'; path: string }

/** Serialized form of SkillScope, used as a map key in stores. */
export type SkillScopeKey = string

/** A skill found under a scope's provider-specific skills directory. */
export interface InstalledSkill {
  id: string
  frontmatter: SkillFrontmatter
  installPath: string
  provider: SkillProvider
  scopeKind: SkillScope['kind']
  installedAt: number
}

export interface InstallSkillResult {
  success: boolean
  installPath?: string
  error?:
    | 'already_installed'
    | 'source_not_found'
    | 'invalid_scope'
    | 'unsupported_scope'
    | 'permission_denied'
    | 'unknown_error'
  message?: string
}

/** Result of a multi-provider install — one entry per requested provider. */
export interface InstallSkillBatchResult {
  results: Array<InstallSkillResult & { provider: SkillProvider }>
}

export interface UninstallSkillResult {
  success: boolean
  error?: 'not_installed' | 'invalid_scope' | 'unsupported_scope' | 'permission_denied' | 'unknown_error'
  message?: string
}

export interface ReadSkillContentResult {
  success: boolean
  content?: string
  error?: string
}

export interface RefreshHubResult {
  success: boolean
  hub?: SkillHub
  skillCount?: number
  error?:
    | 'invalid_repo'
    | 'network_error'
    | 'clone_failed'
    | 'not_found'
    | 'unknown_error'
  message?: string
}

export interface AddHubResult {
  success: boolean
  hub?: SkillHub
  error?: 'duplicate' | 'invalid_repo' | 'unknown_error'
  message?: string
}

export interface RemoveHubResult {
  success: boolean
  error?: 'not_found' | 'protected' | 'unknown_error'
  message?: string
}

/** Per-provider availability — `true` means the CLI was found on $PATH. */
export type ProviderAvailability = Record<SkillProvider, boolean>

/** Serialize a SkillScope into a stable key — `provider:kind:path`. */
export function scopeKey(scope: SkillScope): SkillScopeKey {
  const tail = 'path' in scope ? scope.path : ''
  return `${scope.provider}:${scope.kind}:${tail}`
}

/** Default remote hub seeded on first launch. */
export const DEFAULT_REMOTE_HUB = {
  repo: 'slicenferqin/xuanpu-skills-hub',
  ref: 'main',
  name: 'Xuanpu Skills Hub'
} as const
