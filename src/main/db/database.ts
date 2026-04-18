import Database from 'better-sqlite3'
import { app } from 'electron'
import { dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { MIGRATIONS } from './schema'
import { getActiveAppDatabasePath } from '@shared/app-identity'
import type {
  Project,
  ProjectCreate,
  ProjectUpdate,
  Worktree,
  WorktreeCreate,
  WorktreeUpdate,
  Session,
  SessionCreate,
  SessionUpdate,
  SessionMessage,
  SessionMessageCreate,
  SessionMessageUpdate,
  SessionMessageUpsertByOpenCode,
  SessionActivity,
  SessionActivityCreate,
  UsageEntry,
  UsageEntryCreate,
  UsageSyncState,
  UsageSyncStateUpsert,
  Setting,
  SessionSearchOptions,
  SessionWithWorktree,
  Space,
  SpaceCreate,
  SpaceUpdate,
  ProjectSpaceAssignment,
  Connection,
  ConnectionCreate,
  ConnectionMember,
  ConnectionMemberCreate,
  ConnectionWithMembers
} from './types'

export class DatabaseService {
  private db: Database.Database | null = null
  private dbPath: string

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath
    } else {
      const appDataFilePath = getActiveAppDatabasePath(app.getPath('home'))
      const appDataDir = dirname(appDataFilePath)
      if (!existsSync(appDataDir)) {
        mkdirSync(appDataDir, { recursive: true })
      }
      this.dbPath = appDataFilePath
    }
  }

  getDbPath(): string {
    return this.dbPath
  }

  init(): void {
    if (this.db) return

    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    this.runMigrations()
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.')
    }
    return this.db
  }

  // Maps SQLite INTEGER 0/1 to boolean for worktree rows
  private mapWorktreeRow(row: Record<string, unknown>): Worktree {
    return {
      ...row,
      is_default: !!row.is_default,
      branch_renamed: (row.branch_renamed as number) ?? 0,
      last_message_at: (row.last_message_at as number) ?? null,
      session_titles: (row.session_titles as string) ?? '[]',
      last_model_provider_id: (row.last_model_provider_id as string) ?? null,
      last_model_id: (row.last_model_id as string) ?? null,
      last_model_variant: (row.last_model_variant as string) ?? null,
      attachments: (row.attachments as string) ?? '[]',
      pinned: (row.pinned as number) ?? 0,
      context: (row.context as string) ?? null,
      github_pr_number: (row.github_pr_number as number) ?? null,
      github_pr_url: (row.github_pr_url as string) ?? null
    } as Worktree
  }

  private runMigrations(): void {
    const db = this.getDb()

    // Ensure settings table exists for version tracking
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    const currentVersion = this.getSetting('schema_version')
    const version = currentVersion ? parseInt(currentVersion, 10) : 0

    for (const migration of MIGRATIONS) {
      if (migration.version > version) {
        try {
          db.exec(migration.up)
        } catch (err) {
          // Log but don't crash -- partial migrations (e.g. duplicate column)
          // are handled by the idempotent repair step below.
          console.error(
            `[db] Migration v${migration.version} (${migration.name}) failed:`,
            err instanceof Error ? err.message : String(err)
          )
        }
        this.setSetting('schema_version', migration.version.toString())
      }
    }

    // Post-migration repair: idempotently ensure all expected tables/columns
    // exist. This handles partial migrations, merge conflicts, or version
    // skew between worktree builds.
    this.ensureConnectionTables()
    this.ensureUsageAnalyticsTables()
  }

  /**
   * Idempotently add a column to a table. No-op if column already exists.
   * Safe to call repeatedly (e.g. after merges that replay migrations).
   */
  private safeAddColumn(table: string, column: string, definition: string): void {
    const db = this.getDb()
    const columns = db.pragma(`table_info(${table})`) as { name: string }[]
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  /**
   * Idempotently ensure connection-related tables and columns exist.
   * Safe to run multiple times -- uses IF NOT EXISTS and checks column presence.
   */
  private ensureConnectionTables(): void {
    const db = this.getDb()

    db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        color TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connection_members (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        symlink_name TEXT NOT NULL,
        added_at TEXT NOT NULL,
        FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_connection_members_connection ON connection_members(connection_id);
      CREATE INDEX IF NOT EXISTS idx_connection_members_worktree ON connection_members(worktree_id);
    `)

    this.safeAddColumn(
      'sessions',
      'connection_id',
      'TEXT DEFAULT NULL REFERENCES connections(id) ON DELETE SET NULL'
    )
    this.safeAddColumn('sessions', 'agent_sdk', "TEXT NOT NULL DEFAULT 'opencode'")
    this.safeAddColumn('sessions', 'color', 'TEXT DEFAULT NULL')
    this.safeAddColumn('connections', 'color', 'TEXT DEFAULT NULL')
    this.safeAddColumn('connections', 'custom_name', 'TEXT DEFAULT NULL')
    this.safeAddColumn('worktrees', 'attachments', "TEXT DEFAULT '[]'")
    this.safeAddColumn('worktrees', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
    this.safeAddColumn('worktrees', 'context', 'TEXT DEFAULT NULL')
    this.safeAddColumn('worktrees', 'github_pr_number', 'INTEGER DEFAULT NULL')
    this.safeAddColumn('worktrees', 'github_pr_url', 'TEXT DEFAULT NULL')
    this.safeAddColumn('connections', 'pinned', 'INTEGER NOT NULL DEFAULT 0')

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id);
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_activities (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_session_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        item_id TEXT,
        request_id TEXT,
        kind TEXT NOT NULL,
        tone TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        sequence INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_activities_session_created
        ON session_activities(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_session_activities_session_turn
        ON session_activities(session_id, turn_id, created_at);
    `)
  }

  private ensureUsageAnalyticsTables(): void {
    const db = this.getDb()

    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
        agent_sdk TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        model_label TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_sync_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        agent_sdk TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        source_mtime_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        entry_count INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT,
        last_error TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_entries_session_source
        ON usage_entries(session_id, source_message_id);
      CREATE INDEX IF NOT EXISTS idx_usage_entries_occurred
        ON usage_entries(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_entries_agent_occurred
        ON usage_entries(agent_sdk, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_entries_project_occurred
        ON usage_entries(project_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_sync_state_status
        ON usage_sync_state(status, last_synced_at);
    `)
  }

  // Settings operations
  getSetting(key: string): string | null {
    const db = this.getDb()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | Setting
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    const db = this.getDb()
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }

  deleteSetting(key: string): void {
    const db = this.getDb()
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAllSettings(): Setting[] {
    const db = this.getDb()
    return db.prepare('SELECT key, value FROM settings').all() as Setting[]
  }

  // Project operations
  createProject(data: ProjectCreate): Project {
    const db = this.getDb()
    const now = new Date().toISOString()
    // New projects get sort_order 0 (top), bump all others down
    db.prepare('UPDATE projects SET sort_order = sort_order + 1').run()

    const project: Project = {
      id: randomUUID(),
      name: data.name,
      path: data.path,
      description: data.description ?? null,
      tags: data.tags ? JSON.stringify(data.tags) : null,
      language: null,
      custom_icon: null,
      setup_script: data.setup_script ?? null,
      run_script: data.run_script ?? null,
      archive_script: data.archive_script ?? null,
      auto_assign_port: false,
      sort_order: 0,
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO projects (id, name, path, description, tags, language, setup_script, run_script, archive_script, auto_assign_port, sort_order, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      project.id,
      project.name,
      project.path,
      project.description,
      project.tags,
      project.language,
      project.setup_script,
      project.run_script,
      project.archive_script,
      project.auto_assign_port ? 1 : 0,
      project.sort_order,
      project.created_at,
      project.last_accessed_at
    )

    return project
  }

  getProject(id: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | (Project & { auto_assign_port: number | boolean })
      | undefined
    if (!row) return null
    return {
      ...row,
      auto_assign_port: Boolean(row.auto_assign_port)
    }
  }

  getProjectByPath(path: string): Project | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
      | (Project & { auto_assign_port: number | boolean })
      | undefined
    if (!row) return null
    return {
      ...row,
      auto_assign_port: Boolean(row.auto_assign_port)
    }
  }

  getAllProjects(): Project[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY sort_order ASC, last_accessed_at DESC')
      .all() as Array<Project & { auto_assign_port: number | boolean }>

    return rows.map((row) => ({
      ...row,
      auto_assign_port: Boolean(row.auto_assign_port)
    }))
  }

  reorderProjects(orderedIds: string[]): void {
    const db = this.getDb()
    const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    const tx = db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, orderedIds[i])
      }
    })
    tx()
  }

  getProjectIdsSortedByLastMessage(): string[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        `SELECT p.id
         FROM projects p
         LEFT JOIN worktrees w ON w.project_id = p.id
         GROUP BY p.id
         ORDER BY
           CASE WHEN MAX(w.last_message_at) IS NULL THEN 1 ELSE 0 END ASC,
           MAX(w.last_message_at) DESC`
      )
      .all() as { id: string }[]
    return rows.map((r) => r.id)
  }

  updateProject(id: string, data: ProjectUpdate): Project | null {
    const db = this.getDb()
    const existing = this.getProject(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.description !== undefined) {
      updates.push('description = ?')
      values.push(data.description)
    }
    if (data.tags !== undefined) {
      updates.push('tags = ?')
      values.push(data.tags ? JSON.stringify(data.tags) : null)
    }
    if (data.language !== undefined) {
      updates.push('language = ?')
      values.push(data.language)
    }
    if (data.custom_icon !== undefined) {
      updates.push('custom_icon = ?')
      values.push(data.custom_icon)
    }
    if (data.setup_script !== undefined) {
      updates.push('setup_script = ?')
      values.push(data.setup_script)
    }
    if (data.run_script !== undefined) {
      updates.push('run_script = ?')
      values.push(data.run_script)
    }
    if (data.archive_script !== undefined) {
      updates.push('archive_script = ?')
      values.push(data.archive_script)
    }
    if (data.auto_assign_port !== undefined) {
      updates.push('auto_assign_port = ?')
      values.push(data.auto_assign_port ? 1 : 0)
    }
    if (data.last_accessed_at !== undefined) {
      updates.push('last_accessed_at = ?')
      values.push(data.last_accessed_at)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getProject(id)
  }

  deleteProject(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return result.changes > 0
  }

  touchProject(id: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare('UPDATE projects SET last_accessed_at = ? WHERE id = ?').run(now, id)
  }

  // Worktree operations
  createWorktree(data: WorktreeCreate): Worktree {
    const db = this.getDb()
    const now = new Date().toISOString()
    const isDefault = data.is_default ?? false
    const worktree: Worktree = {
      id: randomUUID(),
      project_id: data.project_id,
      name: data.name,
      branch_name: data.branch_name,
      path: data.path,
      status: 'active',
      is_default: isDefault,
      branch_renamed: 0,
      last_message_at: null,
      session_titles: '[]',
      last_model_provider_id: null,
      last_model_id: null,
      last_model_variant: null,
      attachments: '[]',
      pinned: 0,
      context: null,
      github_pr_number: null,
      github_pr_url: null,
      created_at: now,
      last_accessed_at: now
    }

    db.prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, branch_renamed, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      worktree.id,
      worktree.project_id,
      worktree.name,
      worktree.branch_name,
      worktree.path,
      worktree.status,
      isDefault ? 1 : 0,
      worktree.branch_renamed,
      worktree.created_at,
      worktree.last_accessed_at
    )

    return worktree
  }

  getWorktree(id: string): Worktree | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapWorktreeRow(row) : null
  }

  getWorktreeByPath(path: string): Worktree | null {
    const db = this.getDb()
    const row = db
      .prepare("SELECT * FROM worktrees WHERE path = ? AND status = 'active'")
      .get(path) as Record<string, unknown> | undefined
    return row ? this.mapWorktreeRow(row) : null
  }

  getWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        'SELECT * FROM worktrees WHERE project_id = ? ORDER BY is_default ASC, last_accessed_at DESC'
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getActiveWorktreesByProject(projectId: string): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE project_id = ? AND status = 'active' ORDER BY is_default ASC, last_accessed_at DESC"
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getRecentlyActiveWorktrees(cutoffMs: number): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE status = 'active' AND last_message_at IS NOT NULL AND last_message_at > ? ORDER BY last_message_at DESC"
      )
      .all(cutoffMs) as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getPinnedWorktrees(): Worktree[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM worktrees WHERE status = 'active' AND pinned = 1 ORDER BY last_accessed_at DESC"
      )
      .all() as Record<string, unknown>[]
    return rows.map((row) => this.mapWorktreeRow(row))
  }

  getPinnedConnections(): ConnectionWithMembers[] {
    const db = this.getDb()
    const rows = db
      .prepare(
        "SELECT * FROM connections WHERE status = 'active' AND pinned = 1 ORDER BY updated_at DESC"
      )
      .all() as Connection[]

    return rows.map((row) => {
      const members = db
        .prepare(
          `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                  w.path as worktree_path, p.name as project_name
           FROM connection_members cm
           JOIN worktrees w ON cm.worktree_id = w.id
           JOIN projects p ON cm.project_id = p.id
           WHERE cm.connection_id = ?
           ORDER BY cm.added_at ASC`
        )
        .all(row.id) as ConnectionWithMembers['members']
      return { ...row, members }
    })
  }

  updateWorktree(id: string, data: WorktreeUpdate): Worktree | null {
    const db = this.getDb()
    const existing = this.getWorktree(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.branch_name !== undefined) {
      updates.push('branch_name = ?')
      values.push(data.branch_name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.branch_renamed !== undefined) {
      updates.push('branch_renamed = ?')
      values.push(data.branch_renamed)
    }
    if (data.last_message_at !== undefined) {
      updates.push('last_message_at = ?')
      values.push(data.last_message_at)
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?')
      values.push(data.pinned)
    }
    if (data.last_accessed_at !== undefined) {
      updates.push('last_accessed_at = ?')
      values.push(data.last_accessed_at)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE worktrees SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getWorktree(id)
  }

  deleteWorktree(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM worktrees WHERE id = ?').run(id)
    return result.changes > 0
  }

  archiveWorktree(id: string): Worktree | null {
    return this.updateWorktree(id, { status: 'archived' })
  }

  touchWorktree(id: string): void {
    const db = this.getDb()
    const now = new Date().toISOString()
    db.prepare('UPDATE worktrees SET last_accessed_at = ? WHERE id = ?').run(now, id)
  }

  updateWorktreeContext(worktreeId: string, context: string | null): void {
    const db = this.getDb()
    db.prepare('UPDATE worktrees SET context = ? WHERE id = ?').run(context, worktreeId)
  }

  /**
   * Append a session title to the worktree's session_titles JSON array.
   * Skips duplicates.
   */
  appendSessionTitle(worktreeId: string, title: string): void {
    const db = this.getDb()
    const row = db.prepare('SELECT session_titles FROM worktrees WHERE id = ?').get(worktreeId) as
      | Record<string, unknown>
      | undefined
    const titles: string[] = JSON.parse((row?.session_titles as string) || '[]')
    if (!titles.includes(title)) {
      titles.push(title)
      db.prepare('UPDATE worktrees SET session_titles = ? WHERE id = ?').run(
        JSON.stringify(titles),
        worktreeId
      )
    }
  }

  /**
   * Add an attachment to a worktree's attachments JSON array.
   * Rejects duplicates by URL.
   */
  addAttachment(
    worktreeId: string,
    attachment: { type: 'jira' | 'figma'; url: string; label: string }
  ): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT attachments FROM worktrees WHERE id = ?').get(worktreeId) as
      | Record<string, unknown>
      | undefined
    if (!row) return { success: false, error: 'Worktree not found' }
    const attachments: Array<{
      id: string
      type: string
      url: string
      label: string
      created_at: string
    }> = JSON.parse((row.attachments as string) || '[]')
    if (attachments.some((a) => a.url === attachment.url)) {
      return { success: false, error: 'Already attached' }
    }
    const id = randomUUID()
    attachments.push({
      id,
      type: attachment.type,
      url: attachment.url,
      label: attachment.label,
      created_at: new Date().toISOString()
    })
    db.prepare('UPDATE worktrees SET attachments = ? WHERE id = ?').run(
      JSON.stringify(attachments),
      worktreeId
    )
    return { success: true }
  }

  /**
   * Remove an attachment from a worktree by attachment ID.
   */
  removeAttachment(worktreeId: string, attachmentId: string): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT attachments FROM worktrees WHERE id = ?').get(worktreeId) as
      | Record<string, unknown>
      | undefined
    if (!row) return { success: false, error: 'Worktree not found' }
    const attachments: Array<{ id: string }> = JSON.parse((row.attachments as string) || '[]')
    const filtered = attachments.filter((a) => a.id !== attachmentId)
    if (filtered.length === attachments.length) {
      return { success: false, error: 'Attachment not found' }
    }
    db.prepare('UPDATE worktrees SET attachments = ? WHERE id = ?').run(
      JSON.stringify(filtered),
      worktreeId
    )
    return { success: true }
  }

  /**
   * Attach a GitHub PR to a worktree.
   */
  attachPR(
    worktreeId: string,
    prNumber: number,
    prUrl: string
  ): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT id FROM worktrees WHERE id = ?').get(worktreeId)
    if (!row) return { success: false, error: 'Worktree not found' }
    db.prepare('UPDATE worktrees SET github_pr_number = ?, github_pr_url = ? WHERE id = ?').run(
      prNumber,
      prUrl,
      worktreeId
    )
    return { success: true }
  }

  /**
   * Detach a GitHub PR from a worktree.
   */
  detachPR(worktreeId: string): { success: boolean; error?: string } {
    const db = this.getDb()
    const row = db.prepare('SELECT id FROM worktrees WHERE id = ?').get(worktreeId)
    if (!row) return { success: false, error: 'Worktree not found' }
    db.prepare(
      'UPDATE worktrees SET github_pr_number = NULL, github_pr_url = NULL WHERE id = ?'
    ).run(worktreeId)
    return { success: true }
  }

  /**
   * Update the last-used model for a worktree.
   */
  updateWorktreeModel(
    worktreeId: string,
    modelProviderId: string,
    modelId: string,
    modelVariant: string | null
  ): void {
    const db = this.getDb()
    db.prepare(
      `UPDATE worktrees
       SET last_model_provider_id = ?, last_model_id = ?, last_model_variant = ?
       WHERE id = ?`
    ).run(modelProviderId, modelId, modelVariant, worktreeId)
  }

  /**
   * Look up the worktree that owns a given session.
   */
  getWorktreeBySessionId(sessionId: string): Worktree | null {
    const session = this.getSession(sessionId)
    if (!session?.worktree_id) return null
    return this.getWorktree(session.worktree_id)
  }

  // Session operations
  createSession(data: SessionCreate): Session {
    const db = this.getDb()
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      connection_id: data.connection_id ?? null,
      name: data.name ?? null,
      status: 'active',
      opencode_session_id: data.opencode_session_id ?? null,
      agent_sdk: data.agent_sdk ?? 'opencode',
      mode: 'build',
      model_provider_id: data.model_provider_id ?? null,
      model_id: data.model_id ?? null,
      model_variant: data.model_variant ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null
    }

    db.prepare(
      `INSERT INTO sessions (id, worktree_id, project_id, connection_id, name, status, opencode_session_id, agent_sdk, mode, model_provider_id, model_id, model_variant, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      session.id,
      session.worktree_id,
      session.project_id,
      session.connection_id,
      session.name,
      session.status,
      session.opencode_session_id,
      session.agent_sdk,
      session.mode,
      session.model_provider_id,
      session.model_id,
      session.model_variant,
      session.created_at,
      session.updated_at,
      session.completed_at
    )

    return session
  }

  getSession(id: string): Session | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined
    return row ?? null
  }

  getSessionByOpenCodeSessionId(opencodeSessionId: string): Session | null {
    const db = this.getDb()
    const row = db
      .prepare('SELECT * FROM sessions WHERE opencode_session_id = ? LIMIT 1')
      .get(opencodeSessionId) as Session | undefined
    return row ?? null
  }

  getAgentSdkForSession(
    agentSessionId: string
  ): 'opencode' | 'claude-code' | 'codex' | 'terminal' | null {
    const db = this.getDb()
    const row = db
      .prepare('SELECT agent_sdk FROM sessions WHERE opencode_session_id = ? LIMIT 1')
      .get(agentSessionId) as
      | { agent_sdk: 'opencode' | 'claude-code' | 'codex' | 'terminal' }
      | undefined
    return row?.agent_sdk ?? null
  }

  /** Canonical alias — maps session → runtime ID via the agent_sdk column.
   *  Checks both opencode_session_id and the primary key (id) to handle
   *  cases where the DB hasn't been updated after session materialization. */
  getRuntimeIdForSession(
    agentSessionId: string
  ): 'opencode' | 'claude-code' | 'codex' | 'terminal' | null {
    // Primary lookup: by opencode_session_id (SDK session ID)
    const byOpcId = this.getAgentSdkForSession(agentSessionId)
    if (byOpcId) return byOpcId

    // Fallback: treat agentSessionId as hive session ID (primary key)
    const db = this.getDb()
    const row = db
      .prepare('SELECT agent_sdk FROM sessions WHERE id = ? LIMIT 1')
      .get(agentSessionId) as
      | { agent_sdk: 'opencode' | 'claude-code' | 'codex' | 'terminal' }
      | undefined
    return row?.agent_sdk ?? null
  }

  getSessionsByWorktree(worktreeId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE worktree_id = ? ORDER BY updated_at DESC')
      .all(worktreeId) as Session[]
  }

  getSessionsByProject(projectId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as Session[]
  }

  getActiveSessionsByWorktree(worktreeId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT * FROM sessions WHERE worktree_id = ? AND status = 'active' ORDER BY updated_at DESC"
      )
      .all(worktreeId) as Session[]
  }

  updateSession(id: string, data: SessionUpdate): Session | null {
    const db = this.getDb()
    const existing = this.getSession(id)
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | null)[] = [new Date().toISOString()]

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.opencode_session_id !== undefined) {
      updates.push('opencode_session_id = ?')
      values.push(data.opencode_session_id)
    }
    if (data.agent_sdk !== undefined) {
      updates.push('agent_sdk = ?')
      values.push(data.agent_sdk)
    }
    if (data.mode !== undefined) {
      updates.push('mode = ?')
      values.push(data.mode)
    }
    if (data.model_provider_id !== undefined) {
      updates.push('model_provider_id = ?')
      values.push(data.model_provider_id)
    }
    if (data.model_id !== undefined) {
      updates.push('model_id = ?')
      values.push(data.model_id)
    }
    if (data.model_variant !== undefined) {
      updates.push('model_variant = ?')
      values.push(data.model_variant)
    }
    if (data.color !== undefined) {
      updates.push('color = ?')
      values.push(data.color)
    }
    if (data.completed_at !== undefined) {
      updates.push('completed_at = ?')
      values.push(data.completed_at)
    }

    values.push(id)
    db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getSession(id)
  }

  /**
   * Soft-archive a session. Sets status to 'archived' instead of deleting.
   * Session messages and activities are preserved.
   */
  archiveSession(id: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare(
        "UPDATE sessions SET status = 'archived', completed_at = COALESCE(completed_at, ?) WHERE id = ?"
      )
      .run(new Date().toISOString(), id)
    return result.changes > 0
  }

  restoreSession(id: string): Session | null {
    const db = this.getDb()
    const existing = this.getSession(id)
    if (!existing) return null

    db.prepare("UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id
    )

    return this.getSession(id)
  }

  /**
   * @internal Hard-delete a session and all associated data (CASCADE).
   * Only for data cleanup scripts — never exposed via IPC.
   */
  deleteSession(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }

  searchSessions(options: SessionSearchOptions): SessionWithWorktree[] {
    const db = this.getDb()
    const conditions: string[] = []
    const values: (string | null)[] = []

    let query = `
      SELECT
        s.*,
        w.name as worktree_name,
        w.branch_name as worktree_branch_name,
        w.status as worktree_status,
        p.name as project_name
      FROM sessions s
      LEFT JOIN worktrees w ON s.worktree_id = w.id
      LEFT JOIN projects p ON s.project_id = p.id
    `

    if (options.keyword) {
      conditions.push(`(
        s.name LIKE ? OR
        p.name LIKE ? OR
        w.name LIKE ? OR
        w.branch_name LIKE ?
      )`)
      const keyword = `%${options.keyword}%`
      values.push(keyword, keyword, keyword, keyword)
    }

    if (options.project_id) {
      conditions.push('s.project_id = ?')
      values.push(options.project_id)
    }

    if (options.worktree_id) {
      conditions.push('s.worktree_id = ?')
      values.push(options.worktree_id)
    }

    if (options.statusFilter === 'active') {
      conditions.push("s.status = 'active'")
    } else if (options.statusFilter === 'archived') {
      conditions.push("s.status = 'archived'")
    } else if (options.statusFilter === 'closed') {
      conditions.push("s.status = 'completed'")
    }

    if (options.dateFrom) {
      conditions.push('s.created_at >= ?')
      values.push(options.dateFrom)
    }

    if (options.dateTo) {
      conditions.push('s.created_at <= ?')
      values.push(options.dateTo)
    }

    if (!options.includeArchived) {
      conditions.push("(w.status = 'active' OR w.id IS NULL)")
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }

    query += ' ORDER BY s.updated_at DESC'

    return db.prepare(query).all(...values) as SessionWithWorktree[]
  }

  // Session draft operations
  getSessionDraft(sessionId: string): string | null {
    const db = this.getDb()
    const row = db.prepare('SELECT draft_input FROM sessions WHERE id = ?').get(sessionId) as
      | { draft_input: string | null }
      | undefined
    return row?.draft_input ?? null
  }

  updateSessionDraft(sessionId: string, draft: string | null): void {
    const db = this.getDb()
    db.prepare('UPDATE sessions SET draft_input = ? WHERE id = ?').run(draft, sessionId)
  }

  // Session message operations
  createSessionMessage(data: SessionMessageCreate): SessionMessage {
    const db = this.getDb()
    const now = data.created_at ?? new Date().toISOString()
    const message: SessionMessage = {
      id: randomUUID(),
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      opencode_message_id: data.opencode_message_id ?? null,
      opencode_message_json: data.opencode_message_json ?? null,
      opencode_parts_json: data.opencode_parts_json ?? null,
      opencode_timeline_json: data.opencode_timeline_json ?? null,
      created_at: now
    }

    db.prepare(
      `INSERT INTO session_messages (
        id,
        session_id,
        role,
        content,
        opencode_message_id,
        opencode_message_json,
        opencode_parts_json,
        opencode_timeline_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      message.session_id,
      message.role,
      message.content,
      message.opencode_message_id,
      message.opencode_message_json,
      message.opencode_parts_json,
      message.opencode_timeline_json,
      message.created_at
    )

    // Update session updated_at
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id)

    return message
  }

  updateSessionMessage(id: string, data: SessionMessageUpdate): SessionMessage | null {
    const db = this.getDb()
    const existing = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | SessionMessage
      | undefined
    if (!existing) return null

    const updates: string[] = []
    const values: (string | null)[] = []

    if (data.content !== undefined) {
      updates.push('content = ?')
      values.push(data.content)
    }
    if (data.opencode_message_json !== undefined) {
      updates.push('opencode_message_json = ?')
      values.push(data.opencode_message_json)
    }
    if (data.opencode_parts_json !== undefined) {
      updates.push('opencode_parts_json = ?')
      values.push(data.opencode_parts_json)
    }
    if (data.opencode_timeline_json !== undefined) {
      updates.push('opencode_timeline_json = ?')
      values.push(data.opencode_timeline_json)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE session_messages SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    const updated = db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | SessionMessage
      | undefined
    if (!updated) return null

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      updated.session_id
    )

    return updated
  }

  getSessionMessageByOpenCodeId(
    sessionId: string,
    opencodeMessageId: string
  ): SessionMessage | null {
    const db = this.getDb()
    const row = db
      .prepare(
        `SELECT * FROM session_messages
         WHERE session_id = ? AND opencode_message_id = ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(sessionId, opencodeMessageId) as SessionMessage | undefined
    return row ?? null
  }

  upsertSessionMessageByOpenCodeId(data: SessionMessageUpsertByOpenCode): SessionMessage {
    const existing = this.getSessionMessageByOpenCodeId(data.session_id, data.opencode_message_id)
    if (existing) {
      const updated = this.updateSessionMessage(existing.id, {
        content: data.content,
        opencode_message_json: data.opencode_message_json ?? existing.opencode_message_json,
        opencode_parts_json: data.opencode_parts_json ?? existing.opencode_parts_json,
        opencode_timeline_json: data.opencode_timeline_json ?? existing.opencode_timeline_json
      })
      if (!updated) return existing
      return updated
    }

    return this.createSessionMessage({
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      opencode_message_id: data.opencode_message_id,
      opencode_message_json: data.opencode_message_json ?? null,
      opencode_parts_json: data.opencode_parts_json ?? null,
      opencode_timeline_json: data.opencode_timeline_json ?? null,
      created_at: data.created_at
    })
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as SessionMessage[]
  }

  deleteSessionMessage(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM session_messages WHERE id = ?').run(id)
    return result.changes > 0
  }

  replaceSessionMessages(sessionId: string, messages: SessionMessageCreate[]): SessionMessage[] {
    const db = this.getDb()

    // Safety: refuse to wipe existing messages with an empty array.
    // This guards against accidental data loss from empty in-memory caches.
    if (messages.length === 0) {
      const existing = db
        .prepare('SELECT COUNT(*) as cnt FROM session_messages WHERE session_id = ?')
        .get(sessionId) as { cnt: number } | undefined
      if (existing && existing.cnt > 0) {
        console.error(
          `[Database] replaceSessionMessages: refusing to delete ${existing.cnt} existing messages with empty array for session ${sessionId}`
        )
        return this.getSessionMessages(sessionId)
      }
      return []
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
      const created: SessionMessage[] = []
      for (const message of messages) {
        created.push(
          this.createSessionMessage({
            ...message,
            session_id: sessionId
          })
        )
      }
      return created
    })
    return tx()
  }

  upsertSessionActivity(data: SessionActivityCreate): SessionActivity {
    const db = this.getDb()
    const now = data.created_at ?? new Date().toISOString()
    const id = data.id ?? randomUUID()

    db.prepare(
      `INSERT INTO session_activities (
        id,
        session_id,
        agent_session_id,
        thread_id,
        turn_id,
        item_id,
        request_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_session_id = excluded.agent_session_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        item_id = excluded.item_id,
        request_id = excluded.request_id,
        kind = excluded.kind,
        tone = excluded.tone,
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        sequence = excluded.sequence,
        created_at = excluded.created_at`
    ).run(
      id,
      data.session_id,
      data.agent_session_id ?? null,
      data.thread_id ?? null,
      data.turn_id ?? null,
      data.item_id ?? null,
      data.request_id ?? null,
      data.kind,
      data.tone,
      data.summary,
      data.payload_json ?? null,
      data.sequence ?? null,
      now
    )

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, data.session_id)

    const row = db.prepare('SELECT * FROM session_activities WHERE id = ?').get(id) as
      | SessionActivity
      | undefined
    if (!row) {
      throw new Error(`Failed to load session activity after upsert: ${id}`)
    }
    return row
  }

  getSessionActivities(sessionId: string): SessionActivity[] {
    const db = this.getDb()
    return db
      .prepare(
        `SELECT * FROM session_activities
         WHERE session_id = ?
         ORDER BY
           CASE WHEN sequence IS NULL THEN 1 ELSE 0 END,
           sequence ASC,
           created_at ASC,
           id ASC`
      )
      .all(sessionId) as SessionActivity[]
  }

  upsertUsageEntry(data: UsageEntryCreate): UsageEntry {
    const db = this.getDb()
    const now = data.created_at ?? new Date().toISOString()
    const totalTokens =
      data.total_tokens ??
      (data.input_tokens ?? 0) +
        (data.output_tokens ?? 0) +
        (data.cache_write_tokens ?? 0) +
        (data.cache_read_tokens ?? 0)

    const id = data.id ?? randomUUID()

    db.prepare(
      `INSERT INTO usage_entries (
        id,
        session_id,
        project_id,
        worktree_id,
        agent_sdk,
        source_kind,
        source_message_id,
        provider_id,
        model_id,
        model_label,
        input_tokens,
        output_tokens,
        cache_write_tokens,
        cache_read_tokens,
        total_tokens,
        cost,
        occurred_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, source_message_id) DO UPDATE SET
        project_id = excluded.project_id,
        worktree_id = excluded.worktree_id,
        agent_sdk = excluded.agent_sdk,
        source_kind = excluded.source_kind,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        model_label = excluded.model_label,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        total_tokens = excluded.total_tokens,
        cost = excluded.cost,
        occurred_at = excluded.occurred_at,
        created_at = excluded.created_at`
    ).run(
      id,
      data.session_id,
      data.project_id,
      data.worktree_id ?? null,
      data.agent_sdk,
      data.source_kind,
      data.source_message_id,
      data.provider_id ?? null,
      data.model_id ?? null,
      data.model_label ?? null,
      data.input_tokens ?? 0,
      data.output_tokens ?? 0,
      data.cache_write_tokens ?? 0,
      data.cache_read_tokens ?? 0,
      totalTokens,
      data.cost ?? 0,
      data.occurred_at,
      now
    )

    const row = db
      .prepare(
        'SELECT * FROM usage_entries WHERE session_id = ? AND source_message_id = ? LIMIT 1'
      )
      .get(data.session_id, data.source_message_id) as UsageEntry | undefined

    if (!row) {
      throw new Error(`Failed to load usage entry after upsert: ${data.session_id}`)
    }

    return row
  }

  deleteUsageEntriesForSession(
    sessionId: string,
    sourceKind?: 'claude-transcript' | 'codex-message'
  ): void {
    const db = this.getDb()
    if (sourceKind) {
      db.prepare('DELETE FROM usage_entries WHERE session_id = ? AND source_kind = ?').run(
        sessionId,
        sourceKind
      )
      return
    }

    db.prepare('DELETE FROM usage_entries WHERE session_id = ?').run(sessionId)
  }

  getUsageEntriesBySession(sessionId: string): UsageEntry[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM usage_entries WHERE session_id = ? ORDER BY occurred_at ASC')
      .all(sessionId) as UsageEntry[]
  }

  listUsageEntries(options?: {
    agentSdks?: Array<'claude-code' | 'codex'>
    dateFrom?: string | null
    dateTo?: string | null
  }): UsageEntry[] {
    const db = this.getDb()
    const conditions: string[] = []
    const values: (string | number)[] = []

    if (options?.agentSdks?.length) {
      const placeholders = options.agentSdks.map(() => '?').join(', ')
      conditions.push(`agent_sdk IN (${placeholders})`)
      values.push(...options.agentSdks)
    }

    if (options?.dateFrom) {
      conditions.push('occurred_at >= ?')
      values.push(options.dateFrom)
    }

    if (options?.dateTo) {
      conditions.push('occurred_at < ?')
      values.push(options.dateTo)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return db
      .prepare(`SELECT * FROM usage_entries ${where} ORDER BY occurred_at DESC`)
      .all(...values) as UsageEntry[]
  }

  getUsageAnalyticsSessions(
    agentSdks?: Array<'claude-code' | 'codex'>,
    sessionStatus: 'all' | 'active' | 'archived' = 'all'
  ): Array<
    Session & {
      project_name: string
      project_path: string
      worktree_name: string | null
      worktree_path: string | null
      worktree_status: 'active' | 'archived' | null
    }
  > {
    const db = this.getDb()
    const conditions: string[] = []
    const values: string[] = []

    if (agentSdks?.length) {
      const placeholders = agentSdks.map(() => '?').join(', ')
      conditions.push(`s.agent_sdk IN (${placeholders})`)
      values.push(...agentSdks)
    }

    if (sessionStatus === 'active') {
      conditions.push("s.status = 'active'")
    } else if (sessionStatus === 'archived') {
      conditions.push("s.status = 'archived'")
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return db
      .prepare(
        `SELECT
          s.*,
          p.name AS project_name,
          p.path AS project_path,
          w.name AS worktree_name,
          w.status AS worktree_status,
          COALESCE(w.path, c.path) AS worktree_path
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        LEFT JOIN worktrees w ON s.worktree_id = w.id
        LEFT JOIN connections c ON s.connection_id = c.id
        ${where}
        ORDER BY s.updated_at DESC`
      )
      .all(...values) as Array<
      Session & {
        project_name: string
        project_path: string
        worktree_name: string | null
        worktree_path: string | null
        worktree_status: 'active' | 'archived' | null
      }
    >
  }

  getUsageSyncState(sessionId: string): UsageSyncState | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM usage_sync_state WHERE session_id = ?').get(sessionId) as
      | UsageSyncState
      | undefined
    return row ?? null
  }

  getUsageSyncStates(): UsageSyncState[] {
    const db = this.getDb()
    return db.prepare('SELECT * FROM usage_sync_state').all() as UsageSyncState[]
  }

  upsertUsageSyncState(data: UsageSyncStateUpsert): UsageSyncState {
    const db = this.getDb()
    db.prepare(
      `INSERT INTO usage_sync_state (
        session_id,
        agent_sdk,
        source_kind,
        source_ref,
        source_mtime_ms,
        status,
        entry_count,
        last_synced_at,
        last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        agent_sdk = excluded.agent_sdk,
        source_kind = excluded.source_kind,
        source_ref = excluded.source_ref,
        source_mtime_ms = excluded.source_mtime_ms,
        status = excluded.status,
        entry_count = excluded.entry_count,
        last_synced_at = excluded.last_synced_at,
        last_error = excluded.last_error`
    ).run(
      data.session_id,
      data.agent_sdk,
      data.source_kind,
      data.source_ref ?? null,
      data.source_mtime_ms ?? null,
      data.status,
      data.entry_count ?? 0,
      data.last_synced_at ?? null,
      data.last_error ?? null
    )

    const row = db
      .prepare('SELECT * FROM usage_sync_state WHERE session_id = ?')
      .get(data.session_id) as UsageSyncState | undefined

    if (!row) {
      throw new Error(`Failed to load usage sync state after upsert: ${data.session_id}`)
    }

    return row
  }

  // Connection operations
  createConnection(data: ConnectionCreate): Connection {
    const db = this.getDb()
    const now = new Date().toISOString()
    const connection: Connection = {
      id: randomUUID(),
      name: data.name,
      custom_name: data.custom_name ?? null,
      path: data.path,
      color: data.color ?? null,
      pinned: 0,
      status: 'active',
      created_at: now,
      updated_at: now
    }

    db.prepare(
      `INSERT INTO connections (id, name, custom_name, path, color, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      connection.id,
      connection.name,
      connection.custom_name,
      connection.path,
      connection.color,
      connection.status,
      connection.created_at,
      connection.updated_at
    )

    return connection
  }

  getConnection(id: string): ConnectionWithMembers | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | Connection
      | undefined
    if (!row) return null

    const members = db
      .prepare(
        `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                w.path as worktree_path, p.name as project_name
         FROM connection_members cm
         JOIN worktrees w ON cm.worktree_id = w.id
         JOIN projects p ON cm.project_id = p.id
         WHERE cm.connection_id = ?
         ORDER BY cm.added_at ASC`
      )
      .all(id) as ConnectionWithMembers['members']

    return { ...row, members }
  }

  getAllConnections(): ConnectionWithMembers[] {
    const db = this.getDb()
    const rows = db
      .prepare("SELECT * FROM connections WHERE status = 'active' ORDER BY updated_at DESC")
      .all() as Connection[]

    return rows.map((row) => {
      const members = db
        .prepare(
          `SELECT cm.*, w.name as worktree_name, w.branch_name as worktree_branch,
                  w.path as worktree_path, p.name as project_name
           FROM connection_members cm
           JOIN worktrees w ON cm.worktree_id = w.id
           JOIN projects p ON cm.project_id = p.id
           WHERE cm.connection_id = ?
           ORDER BY cm.added_at ASC`
        )
        .all(row.id) as ConnectionWithMembers['members']
      return { ...row, members }
    })
  }

  updateConnection(id: string, data: Partial<Connection>): Connection | null {
    const db = this.getDb()
    const existing = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
      | Connection
      | undefined
    if (!existing) return null

    const updates: string[] = ['updated_at = ?']
    const values: (string | number | null)[] = [new Date().toISOString()]

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.custom_name !== undefined) {
      updates.push('custom_name = ?')
      values.push(data.custom_name ?? null)
    }
    if (data.path !== undefined) {
      updates.push('path = ?')
      values.push(data.path)
    }
    if (data.status !== undefined) {
      updates.push('status = ?')
      values.push(data.status)
    }
    if (data.color !== undefined) {
      updates.push('color = ?')
      values.push(data.color)
    }
    if (data.pinned !== undefined) {
      updates.push('pinned = ?')
      values.push(data.pinned)
    }

    values.push(id)
    db.prepare(`UPDATE connections SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Connection
  }

  deleteConnection(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM connections WHERE id = ?').run(id)
    return result.changes > 0
  }

  createConnectionMember(data: ConnectionMemberCreate): ConnectionMember {
    const db = this.getDb()
    const now = new Date().toISOString()
    const member: ConnectionMember = {
      id: randomUUID(),
      connection_id: data.connection_id,
      worktree_id: data.worktree_id,
      project_id: data.project_id,
      symlink_name: data.symlink_name,
      added_at: now
    }

    db.prepare(
      `INSERT INTO connection_members (id, connection_id, worktree_id, project_id, symlink_name, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      member.id,
      member.connection_id,
      member.worktree_id,
      member.project_id,
      member.symlink_name,
      member.added_at
    )

    return member
  }

  deleteConnectionMember(connectionId: string, worktreeId: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare('DELETE FROM connection_members WHERE connection_id = ? AND worktree_id = ?')
      .run(connectionId, worktreeId)
    return result.changes > 0
  }

  getConnectionMembersByWorktree(worktreeId: string): ConnectionMember[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM connection_members WHERE worktree_id = ?')
      .all(worktreeId) as ConnectionMember[]
  }

  getActiveSessionsByConnection(connectionId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT * FROM sessions WHERE connection_id = ? AND status = 'active' ORDER BY updated_at DESC"
      )
      .all(connectionId) as Session[]
  }

  getSessionsByConnection(connectionId: string): Session[] {
    const db = this.getDb()
    return db
      .prepare('SELECT * FROM sessions WHERE connection_id = ? ORDER BY updated_at DESC')
      .all(connectionId) as Session[]
  }

  // Space operations
  createSpace(data: SpaceCreate): Space {
    const db = this.getDb()
    const now = new Date().toISOString()

    // New spaces get sort_order at the end
    const maxOrder = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM spaces')
      .get() as { max_order: number }

    const space: Space = {
      id: randomUUID(),
      name: data.name,
      icon_type: data.icon_type ?? 'default',
      icon_value: data.icon_value ?? 'Folder',
      sort_order: maxOrder.max_order + 1,
      created_at: now
    }

    db.prepare(
      `INSERT INTO spaces (id, name, icon_type, icon_value, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      space.id,
      space.name,
      space.icon_type,
      space.icon_value,
      space.sort_order,
      space.created_at
    )

    return space
  }

  getSpace(id: string): Space | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined
    return row ?? null
  }

  listSpaces(): Space[] {
    const db = this.getDb()
    return db.prepare('SELECT * FROM spaces ORDER BY sort_order ASC').all() as Space[]
  }

  updateSpace(id: string, data: SpaceUpdate): Space | null {
    const db = this.getDb()
    const existing = this.getSpace(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.icon_type !== undefined) {
      updates.push('icon_type = ?')
      values.push(data.icon_type)
    }
    if (data.icon_value !== undefined) {
      updates.push('icon_value = ?')
      values.push(data.icon_value)
    }
    if (data.sort_order !== undefined) {
      updates.push('sort_order = ?')
      values.push(data.sort_order)
    }

    if (updates.length === 0) return existing

    values.push(id)
    db.prepare(`UPDATE spaces SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getSpace(id)
  }

  deleteSpace(id: string): boolean {
    const db = this.getDb()
    const result = db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
    return result.changes > 0
  }

  reorderSpaces(orderedIds: string[]): void {
    const db = this.getDb()
    const stmt = db.prepare('UPDATE spaces SET sort_order = ? WHERE id = ?')
    const tx = db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, orderedIds[i])
      }
    })
    tx()
  }

  // Project-Space assignment operations
  assignProjectToSpace(projectId: string, spaceId: string): void {
    const db = this.getDb()
    db.prepare('INSERT OR IGNORE INTO project_spaces (project_id, space_id) VALUES (?, ?)').run(
      projectId,
      spaceId
    )
  }

  removeProjectFromSpace(projectId: string, spaceId: string): void {
    const db = this.getDb()
    db.prepare('DELETE FROM project_spaces WHERE project_id = ? AND space_id = ?').run(
      projectId,
      spaceId
    )
  }

  getProjectIdsForSpace(spaceId: string): string[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT project_id FROM project_spaces WHERE space_id = ?')
      .all(spaceId) as { project_id: string }[]
    return rows.map((r) => r.project_id)
  }

  getAllProjectSpaceAssignments(): ProjectSpaceAssignment[] {
    const db = this.getDb()
    return db
      .prepare('SELECT project_id, space_id FROM project_spaces')
      .all() as ProjectSpaceAssignment[]
  }

  // Utility methods
  getSchemaVersion(): number {
    const version = this.getSetting('schema_version')
    return version ? parseInt(version, 10) : 0
  }

  // Check if tables exist
  tableExists(tableName: string): boolean {
    const db = this.getDb()
    const result = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName) as { name: string } | undefined
    return !!result
  }

  // Get all indexes
  getIndexes(): { name: string; tbl_name: string }[] {
    const db = this.getDb()
    return db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string; tbl_name: string }[]
  }

  // Transaction wrapper
  transaction<T>(fn: () => T): T {
    const db = this.getDb()
    return db.transaction(fn)()
  }
}

// Singleton instance
let dbService: DatabaseService | null = null

export function getDatabase(): DatabaseService {
  if (!dbService) {
    dbService = new DatabaseService()
    dbService.init()
  }
  return dbService
}

export function closeDatabase(): void {
  if (dbService) {
    dbService.close()
    dbService = null
  }
}
