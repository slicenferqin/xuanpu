/**
 * Skill Hub registry + remote hub management.
 *
 * Hubs are one of:
 *   - `bundled` — packaged with the app under `resources/built-in-skills/`
 *   - `remote`  — a GitHub repo shallow-cloned to `~/.xuanpu/skills-cache/<hubId>`
 *
 * Registry lives in the SQLite `remote_skill_hubs` table (created in schema v14).
 * The bundled hub is virtual — always present, never stored.
 *
 * Source-of-truth for skill files is the filesystem; the table only tracks
 * which repos the user has added plus last-refresh metadata.
 */

import { app } from 'electron'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'path'
import simpleGit from 'simple-git'
import { randomUUID } from 'crypto'
import { getDatabase } from '../db'
import { createLogger } from './logger'
import {
  DEFAULT_REMOTE_HUB,
  type AddHubResult,
  type HubId,
  type RefreshHubResult,
  type RemoveHubResult,
  type SkillHub
} from '@shared/types/skill'

const log = createLogger({ component: 'HubService' })

export const BUNDLED_HUB_ID: HubId = 'bundled'

// ─── paths ──────────────────────────────────────────────────────────────────

export function bundledHubRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'built-in-skills')
    : path.join(app.getAppPath(), 'resources', 'built-in-skills')
}

export function remoteHubCacheRoot(): string {
  return path.join(homedir(), '.xuanpu', 'skills-cache')
}

export function remoteHubDir(hubId: string): string {
  return path.join(remoteHubCacheRoot(), hubId)
}

/**
 * Resolve the directory that holds a hub's `skills/<id>/SKILL.md` layout.
 * For bundled hubs that's the extraResources root; remote hubs put skills
 * under `skills/` inside the cloned repo.
 */
export function hubSkillsRoot(hub: SkillHub): string {
  if (hub.kind === 'bundled') return bundledHubRoot()
  const repoDir = remoteHubDir(hub.id)
  return path.join(repoDir, 'skills')
}

// ─── registry (DB-backed) ───────────────────────────────────────────────────

interface RemoteHubRow {
  id: string
  name: string
  repo: string
  ref: string
  last_refreshed_at: string | null
  last_sha: string | null
  builtin: number
}

function rowToHub(row: RemoteHubRow): SkillHub {
  return {
    id: row.id,
    kind: 'remote',
    name: row.name,
    repo: row.repo,
    ref: row.ref,
    lastRefreshedAt: row.last_refreshed_at ?? undefined,
    lastSha: row.last_sha ?? undefined,
    builtin: row.builtin === 1
  }
}

function bundledHub(): SkillHub {
  return {
    id: BUNDLED_HUB_ID,
    kind: 'bundled',
    name: '内置',
    builtin: true
  }
}

/**
 * List all hubs (bundled first, then remote in insertion order).
 * Seeds the default remote hub on first call.
 */
export async function listHubs(): Promise<SkillHub[]> {
  await ensureSeeded()
  const db = getDatabase().getDb()
  const rows = db
    .prepare(
      `SELECT id, name, repo, ref, last_refreshed_at, last_sha, builtin
       FROM remote_skill_hubs
       ORDER BY builtin DESC, created_at ASC`
    )
    .all() as RemoteHubRow[]
  return [bundledHub(), ...rows.map(rowToHub)]
}

export async function getHub(hubId: HubId): Promise<SkillHub | null> {
  if (hubId === BUNDLED_HUB_ID) return bundledHub()
  const db = getDatabase().getDb()
  const row = db
    .prepare(
      `SELECT id, name, repo, ref, last_refreshed_at, last_sha, builtin
       FROM remote_skill_hubs WHERE id = ?`
    )
    .get(hubId) as RemoteHubRow | undefined
  return row ? rowToHub(row) : null
}

let seeded = false
async function ensureSeeded(): Promise<void> {
  if (seeded) return
  seeded = true
  const db = getDatabase().getDb()
  const existing = db
    .prepare(`SELECT id FROM remote_skill_hubs WHERE builtin = 1 LIMIT 1`)
    .get() as { id: string } | undefined
  if (existing) return
  const id = randomUUID()
  db.prepare(
    `INSERT INTO remote_skill_hubs (id, name, repo, ref, builtin)
     VALUES (?, ?, ?, ?, 1)`
  ).run(id, DEFAULT_REMOTE_HUB.name, DEFAULT_REMOTE_HUB.repo, DEFAULT_REMOTE_HUB.ref)
  log.info('Seeded default remote skill hub', { id, repo: DEFAULT_REMOTE_HUB.repo })
}

// ─── add / remove ───────────────────────────────────────────────────────────

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export async function addRemoteHub(input: {
  repo: string
  ref?: string
  name?: string
}): Promise<AddHubResult> {
  const repo = input.repo.trim()
  const ref = (input.ref ?? 'main').trim() || 'main'
  if (!REPO_RE.test(repo)) {
    return { success: false, error: 'invalid_repo', message: `不是合法的 owner/repo: ${repo}` }
  }
  const db = getDatabase().getDb()
  const dup = db
    .prepare(`SELECT id FROM remote_skill_hubs WHERE repo = ? AND ref = ?`)
    .get(repo, ref) as { id: string } | undefined
  if (dup) return { success: false, error: 'duplicate', message: '该 Hub 已添加' }

  const id = randomUUID()
  const name = (input.name ?? repo).trim() || repo
  db.prepare(
    `INSERT INTO remote_skill_hubs (id, name, repo, ref, builtin) VALUES (?, ?, ?, ?, 0)`
  ).run(id, name, repo, ref)
  log.info('Added remote skill hub', { id, repo, ref })
  const hub = await getHub(id)
  return { success: true, hub: hub ?? undefined }
}

export async function removeRemoteHub(hubId: string): Promise<RemoveHubResult> {
  if (hubId === BUNDLED_HUB_ID) {
    return { success: false, error: 'protected', message: '内置 Hub 不可删除' }
  }
  const hub = await getHub(hubId)
  if (!hub) return { success: false, error: 'not_found' }
  if (hub.builtin) {
    return { success: false, error: 'protected', message: '默认 Hub 不可删除' }
  }
  const db = getDatabase().getDb()
  db.prepare(`DELETE FROM remote_skill_hubs WHERE id = ?`).run(hubId)

  // Best-effort: wipe the local cache.
  await fs.rm(remoteHubDir(hubId), { recursive: true, force: true }).catch(() => {})
  log.info('Removed remote skill hub', { hubId })
  return { success: true }
}

// ─── refresh (git clone / fetch) ────────────────────────────────────────────

/**
 * Refresh a remote hub by shallow-cloning (or updating) the repo into the
 * local cache. Bundled hubs always succeed with no-op.
 */
export async function refreshHub(hubId: HubId): Promise<RefreshHubResult> {
  const hub = await getHub(hubId)
  if (!hub) return { success: false, error: 'not_found' }
  if (hub.kind === 'bundled') return { success: true, hub, skillCount: undefined }
  if (!hub.repo) return { success: false, error: 'invalid_repo' }

  const ref = hub.ref ?? 'main'
  const url = `https://github.com/${hub.repo}.git`
  const dir = remoteHubDir(hub.id)
  const parent = path.dirname(dir)
  await fs.mkdir(parent, { recursive: true })

  const gitDirExists = await exists(path.join(dir, '.git'))

  try {
    if (!gitDirExists) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      log.info('Cloning remote hub', { repo: hub.repo, ref, dir })
      await simpleGit(parent).clone(url, dir, ['--depth', '1', '--branch', ref])
    } else {
      log.info('Fetching remote hub', { repo: hub.repo, ref })
      const git = simpleGit(dir)
      await git.fetch(['--depth', '1', 'origin', ref])
      await git.checkout(ref).catch(() => git.checkout(`origin/${ref}`))
      await git.reset(['--hard', `origin/${ref}`])
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('Failed to refresh hub', { repo: hub.repo, ref, error: message })
    const code =
      /not found|authentication|403|404/i.test(message) ? 'not_found' :
      /network|getaddrinfo|ECONN|timeout/i.test(message) ? 'network_error' :
      'clone_failed'
    return { success: false, error: code, message }
  }

  // Read resolved sha and persist
  let sha: string | undefined
  try {
    sha = (await simpleGit(dir).revparse(['HEAD'])).trim()
  } catch {
    // ignore
  }
  const nowIso = new Date().toISOString()
  const db = getDatabase().getDb()
  db.prepare(
    `UPDATE remote_skill_hubs
     SET last_refreshed_at = ?, last_sha = ?
     WHERE id = ?`
  ).run(nowIso, sha ?? null, hub.id)

  const skillsRoot = path.join(dir, 'skills')
  let skillCount = 0
  if (await exists(skillsRoot)) {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md')
        if (await exists(skillFile)) skillCount++
      }
    }
  }

  return { success: true, hub: { ...hub, lastRefreshedAt: nowIso, lastSha: sha }, skillCount }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}
