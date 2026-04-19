/**
 * Skill Hub service — discovers skills from any registered Hub (bundled or
 * remote), manages installations under the user's `~/.claude/skills/` or a
 * project/worktree's local `.claude/skills/`.
 *
 * Source-of-truth for skill files = filesystem. Frontmatter is parsed from
 * `SKILL.md` using a small hand-rolled YAML reader (no extra dependency).
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { createLogger } from './logger'
import { BUNDLED_HUB_ID, getHub, hubSkillsRoot } from './hub-service'
import type {
  HubId,
  InstallSkillResult,
  InstalledSkill,
  ReadSkillContentResult,
  Skill,
  SkillFrontmatter,
  SkillScope,
  UninstallSkillResult
} from '@shared/types/skill'

const log = createLogger({ component: 'SkillService' })

const SKILL_FILENAME = 'SKILL.md'
const CLAUDE_SKILLS_SUBPATH = path.join('.claude', 'skills')

// ─── path resolution ────────────────────────────────────────────────────────

/** Absolute path of the install directory for a given scope. */
export function resolveScopeDir(scope: SkillScope): string {
  if (scope.kind === 'user') {
    return path.join(homedir(), '.claude', 'skills')
  }
  return path.join(scope.path, CLAUDE_SKILLS_SUBPATH)
}

// ─── frontmatter parser ─────────────────────────────────────────────────────

/**
 * Parse the YAML frontmatter block at the top of a SKILL.md file.
 * Supports a flat key/value structure and arrays in either inline `[a, b]`
 * or block form (`- item`). Multi-line block scalars (`description: |`) are
 * concatenated into a single string.
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/)
  if (!match) {
    throw new Error('SKILL.md is missing the YAML frontmatter block')
  }

  const body = match[1]
  const lines = body.split('\n')
  const result: Record<string, unknown> = {}
  let currentArrayKey: string | null = null
  let blockScalarKey: string | null = null
  let blockScalarLines: string[] = []
  let blockScalarIndent = 0

  const flushBlockScalar = (): void => {
    if (blockScalarKey) {
      result[blockScalarKey] = blockScalarLines.join('\n').trim()
      blockScalarKey = null
      blockScalarLines = []
      blockScalarIndent = 0
    }
  }

  for (const rawLine of lines) {
    // While accumulating a block scalar (`key: |` or `>`)…
    if (blockScalarKey) {
      const stripped = rawLine.trimEnd()
      if (stripped === '') {
        blockScalarLines.push('')
        continue
      }
      const leading = rawLine.length - rawLine.trimStart().length
      if (blockScalarIndent === 0) {
        blockScalarIndent = leading
      }
      if (leading >= blockScalarIndent) {
        blockScalarLines.push(rawLine.slice(blockScalarIndent))
        continue
      }
      // De-dented → block scalar ended; fall through to normal parsing.
      flushBlockScalar()
    }

    const line = rawLine.replace(/\s+$/, '')
    if (!line || line.startsWith('#')) continue

    // block-array continuation: "  - item"
    if (currentArrayKey && /^\s*-\s+/.test(line)) {
      const value = line.replace(/^\s*-\s+/, '').trim()
      const arr = result[currentArrayKey] as string[]
      arr.push(stripQuotes(value))
      continue
    }

    currentArrayKey = null

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const raw = kv[2].trim()

    // Block scalar marker: `key: |` or `key: >`
    if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-') {
      blockScalarKey = key
      blockScalarLines = []
      blockScalarIndent = 0
      continue
    }

    if (raw === '') {
      // begin block array on next line
      result[key] = []
      currentArrayKey = key
      continue
    }

    if (raw.startsWith('[') && raw.endsWith(']')) {
      result[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean)
      continue
    }

    result[key] = stripQuotes(raw)
  }

  flushBlockScalar()

  if (typeof result.name !== 'string' || !result.name) {
    throw new Error('SKILL.md frontmatter is missing required field: name')
  }

  return {
    name: result.name as string,
    description: typeof result.description === 'string' ? result.description : undefined,
    version: typeof result.version === 'string' ? result.version : undefined,
    author: typeof result.author === 'string' ? result.author : undefined,
    tags: Array.isArray(result.tags) ? (result.tags as string[]) : undefined,
    icon: typeof result.icon === 'string' ? result.icon : undefined
  }
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: Awaited<ReturnType<typeof fs.readdir>> = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(full)
      if (stat.isFile()) total += stat.size
    } catch {
      // ignore
    }
  }
  return total
}

async function readSkillDir(dir: string): Promise<{
  id: string
  frontmatter: SkillFrontmatter
  sizeBytes: number
  installedAt: number
} | null> {
  const skillFile = path.join(dir, SKILL_FILENAME)
  try {
    const md = await fs.readFile(skillFile, 'utf-8')
    const frontmatter = parseSkillFrontmatter(md)
    const stat = await fs.stat(dir)
    const size = await dirSize(dir)
    return {
      id: path.basename(dir),
      frontmatter,
      sizeBytes: size,
      installedAt: stat.mtimeMs
    }
  } catch (err) {
    log.warn('Failed to read skill directory', {
      dir,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

// ─── public API ─────────────────────────────────────────────────────────────

/** List all skills available from a given hub. */
export async function listHubSkills(hubId: HubId): Promise<Skill[]> {
  const hub = await getHub(hubId)
  if (!hub) {
    log.warn('listHubSkills: hub not found', { hubId })
    return []
  }
  const root = hubSkillsRoot(hub)
  if (!(await exists(root))) {
    log.info('Hub skills directory not found (run refresh?)', { hubId, root })
    return []
  }
  const entries = await fs.readdir(root, { withFileTypes: true })
  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const info = await readSkillDir(dir)
    if (!info) continue
    skills.push({
      id: info.id,
      frontmatter: info.frontmatter,
      sourcePath: dir,
      sizeBytes: info.sizeBytes,
      hubId: hub.id
    })
  }
  return skills.sort((a, b) =>
    (a.frontmatter.name || a.id).localeCompare(b.frontmatter.name || b.id)
  )
}

export async function listInstalledSkills(scope: SkillScope): Promise<InstalledSkill[]> {
  const dir = resolveScopeDir(scope)
  if (!(await exists(dir))) return []

  const entries = await fs.readdir(dir, { withFileTypes: true })
  const installed: InstalledSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skillDir = path.join(dir, entry.name)
    const info = await readSkillDir(skillDir)
    if (!info) continue
    installed.push({
      id: info.id,
      frontmatter: info.frontmatter,
      installPath: skillDir,
      scopeKind: scope.kind,
      installedAt: info.installedAt
    })
  }
  return installed.sort((a, b) =>
    (a.frontmatter.name || a.id).localeCompare(b.frontmatter.name || b.id)
  )
}

/** Install a skill from a specific hub into the chosen scope. */
export async function installSkill(
  args: { hubId: HubId; skillId: string },
  scope: SkillScope,
  options: { overwrite?: boolean } = {}
): Promise<InstallSkillResult> {
  const hub = await getHub(args.hubId)
  if (!hub) {
    return {
      success: false,
      error: 'source_not_found',
      message: `Hub not found: ${args.hubId}`
    }
  }
  const source = path.join(hubSkillsRoot(hub), args.skillId)
  if (!(await exists(source))) {
    return {
      success: false,
      error: 'source_not_found',
      message: `Skill not found in hub: ${args.skillId}`
    }
  }

  if (scope.kind !== 'user' && !scope.path) {
    return { success: false, error: 'invalid_scope', message: 'Scope path is required' }
  }

  const targetRoot = resolveScopeDir(scope)
  const target = path.join(targetRoot, args.skillId)

  if (!options.overwrite && (await exists(target))) {
    return {
      success: false,
      error: 'already_installed',
      message: `Skill already installed at ${target}`
    }
  }

  try {
    await fs.mkdir(targetRoot, { recursive: true })
    if (await exists(target)) {
      await fs.rm(target, { recursive: true, force: true })
    }
    await fs.cp(source, target, { recursive: true })
    log.info('Installed skill', {
      hubId: args.hubId,
      skillId: args.skillId,
      scope: scope.kind,
      target
    })
    return { success: true, installPath: target }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Failed to install skill', {
      skillId: args.skillId,
      scope: scope.kind,
      error: message
    })
    const code =
      message.includes('EACCES') || message.includes('EPERM')
        ? 'permission_denied'
        : 'unknown_error'
    return { success: false, error: code, message }
  }
}

export async function uninstallSkill(
  skillId: string,
  scope: SkillScope
): Promise<UninstallSkillResult> {
  if (scope.kind !== 'user' && !scope.path) {
    return { success: false, error: 'invalid_scope', message: 'Scope path is required' }
  }

  const target = path.join(resolveScopeDir(scope), skillId)
  if (!(await exists(target))) {
    return { success: false, error: 'not_installed', message: `Not installed: ${target}` }
  }

  try {
    await fs.rm(target, { recursive: true, force: true })
    log.info('Uninstalled skill', { skillId, scope: scope.kind, target })
    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code =
      message.includes('EACCES') || message.includes('EPERM')
        ? 'permission_denied'
        : 'unknown_error'
    return { success: false, error: code, message }
  }
}

export async function readSkillContent(absPath: string): Promise<ReadSkillContentResult> {
  if (path.basename(absPath) !== SKILL_FILENAME) {
    return { success: false, error: 'Only SKILL.md files may be read via this API' }
  }
  try {
    const content = await fs.readFile(absPath, 'utf-8')
    return { success: true, content }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── back-compat aliases (kept for the existing test suite) ─────────────────

/** @deprecated Use listHubSkills(BUNDLED_HUB_ID) instead. */
export async function listBuiltInSkills(): Promise<Skill[]> {
  return listHubSkills(BUNDLED_HUB_ID)
}

/** @deprecated Use installSkill({ hubId: BUNDLED_HUB_ID, skillId }, scope) instead. */
export async function installBuiltInSkill(
  skillId: string,
  scope: SkillScope,
  options: { overwrite?: boolean } = {}
): Promise<InstallSkillResult> {
  return installSkill({ hubId: BUNDLED_HUB_ID, skillId }, scope, options)
}
