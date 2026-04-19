/**
 * Skill Hub — shared type definitions for Claude Code skills.
 *
 * A skill is a directory containing a `SKILL.md` file with YAML frontmatter
 * (name, description, version, …) plus any number of companion files. Xuanpu
 * surfaces skills from one or more **Hubs**:
 *
 *   - `bundled` — packaged with the app under `resources/built-in-skills/`
 *   - `remote`  — a GitHub repository cloned to `~/.xuanpu/skills-cache/`
 *
 * Both kinds are presented uniformly in the UI; the `source` field on a Skill
 * tells you which hub it came from.
 */

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
  | { kind: 'user' }
  | { kind: 'project'; path: string }
  | { kind: 'worktree'; path: string }

/** Serialized form of SkillScope, used as a map key in stores. */
export type SkillScopeKey = 'user' | `project:${string}` | `worktree:${string}`

/** A skill found under a scope's `.claude/skills/` directory. */
export interface InstalledSkill {
  id: string
  frontmatter: SkillFrontmatter
  installPath: string
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
    | 'permission_denied'
    | 'unknown_error'
  message?: string
}

export interface UninstallSkillResult {
  success: boolean
  error?: 'not_installed' | 'invalid_scope' | 'permission_denied' | 'unknown_error'
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

/** Serialize a SkillScope into a stable key. */
export function scopeKey(scope: SkillScope): SkillScopeKey {
  if (scope.kind === 'user') return 'user'
  return `${scope.kind}:${scope.path}` as SkillScopeKey
}

/** Default remote hub seeded on first launch. */
export const DEFAULT_REMOTE_HUB = {
  repo: 'slicenferqin/xuanpu-skills-hub',
  ref: 'main',
  name: 'Xuanpu Skills Hub'
} as const
