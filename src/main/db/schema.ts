export const CURRENT_SCHEMA_VERSION = 21

export const SCHEMA_SQL = `
-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  description TEXT,
  tags TEXT,
  language TEXT,
  setup_script TEXT DEFAULT NULL,
  run_script TEXT DEFAULT NULL,
  archive_script TEXT DEFAULT NULL,
  custom_icon TEXT DEFAULT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  auto_assign_port INTEGER NOT NULL DEFAULT 0,
  model_profile_id TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Worktrees table
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_default INTEGER DEFAULT 0,
  branch_renamed INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER DEFAULT NULL,
  session_titles TEXT DEFAULT '[]',
  last_model_provider_id TEXT,
  last_model_id TEXT,
  last_model_variant TEXT,
  last_agent_sdk TEXT DEFAULT NULL,
  attachments TEXT DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  context TEXT DEFAULT NULL,
  github_pr_number INTEGER DEFAULT NULL,
  github_pr_url TEXT DEFAULT NULL,
  model_profile_id TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opencode_session_id TEXT,
  mode TEXT NOT NULL DEFAULT 'build',
  draft_input TEXT DEFAULT NULL,
  model_provider_id TEXT,
  model_id TEXT,
  model_variant TEXT,
  color TEXT DEFAULT NULL,
  first_message_at INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

-- Session messages table (legacy fallback only).
-- NOTE: Keep this table during OpenCode transcript migration; drop in a follow-up
-- migration after stabilization.
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  opencode_message_id TEXT,
  opencode_message_json TEXT,
  opencode_parts_json TEXT,
  opencode_timeline_json TEXT,
  created_at TEXT NOT NULL
);

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

-- Model profiles table
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  api_key TEXT,
  base_url TEXT,
  model_id TEXT,
  openai_api_key TEXT,
  openai_base_url TEXT,
  codex_config_toml TEXT,
  settings_json TEXT DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Spaces table
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_type TEXT NOT NULL DEFAULT 'default',
  icon_value TEXT NOT NULL DEFAULT 'Folder',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Project-Space assignments
CREATE TABLE IF NOT EXISTS project_spaces (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, space_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_worktree ON sessions(worktree_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_opencode
  ON session_messages(session_id, opencode_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_opencode_unique
  ON session_messages(session_id, opencode_message_id)
  WHERE opencode_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_activities_session_created
  ON session_activities(session_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_session_activities_session_turn
  ON session_activities(session_id, turn_id, created_at);
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
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_projects_accessed ON projects(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_project_spaces_space ON project_spaces(space_id);
CREATE INDEX IF NOT EXISTS idx_project_spaces_project ON project_spaces(project_id);
CREATE INDEX IF NOT EXISTS idx_model_profiles_default ON model_profiles(is_default);

-- Phase 21: Field Event Stream
CREATE TABLE IF NOT EXISTS field_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  timestamp INTEGER NOT NULL,
  worktree_id TEXT,
  project_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  related_event_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_events_worktree_ts ON field_events(worktree_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_project_ts ON field_events(project_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_type_ts ON field_events(type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_ts ON field_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_session_ts ON field_events(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_field_events_related ON field_events(related_event_id) WHERE related_event_id IS NOT NULL;

-- Phase 22B.1: Episodic Memory (per-worktree rolling summary)
CREATE TABLE IF NOT EXISTS field_episodic_memory (
  worktree_id TEXT PRIMARY KEY,
  summary_markdown TEXT NOT NULL,
  compactor_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  compacted_at INTEGER NOT NULL,
  source_event_count INTEGER NOT NULL,
  source_since INTEGER NOT NULL,
  source_until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_episodic_memory_compacted ON field_episodic_memory(compacted_at DESC);

-- Phase 24C: Session Checkpoint (per-worktree resume hints)
-- See docs/prd/phase-24c-session-checkpoint.md
CREATE TABLE IF NOT EXISTS field_session_checkpoints (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  worktree_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  branch TEXT,
  repo_head TEXT,
  source TEXT NOT NULL CHECK (source IN ('abort', 'shutdown')),
  summary TEXT NOT NULL,
  current_goal TEXT,
  next_action TEXT,
  blocking_reason TEXT,
  hot_files_json TEXT NOT NULL,
  hot_file_digests_json TEXT,
  packet_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_session_checkpoints_worktree_created
  ON field_session_checkpoints(worktree_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_field_session_checkpoints_worktree_hash
  ON field_session_checkpoints(worktree_id, packet_hash);
`

export interface Migration {
  version: number
  name: string
  up: string
  down: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: SCHEMA_SQL,
    down: `
      DROP INDEX IF EXISTS idx_project_spaces_project;
      DROP INDEX IF EXISTS idx_project_spaces_space;
      DROP INDEX IF EXISTS idx_projects_accessed;
      DROP INDEX IF EXISTS idx_sessions_updated;
      DROP INDEX IF EXISTS idx_messages_session_opencode_unique;
      DROP INDEX IF EXISTS idx_messages_session_opencode;
      DROP INDEX IF EXISTS idx_messages_session;
      DROP INDEX IF EXISTS idx_session_activities_session_turn;
      DROP INDEX IF EXISTS idx_session_activities_session_created;
      DROP INDEX IF EXISTS idx_usage_sync_state_status;
      DROP INDEX IF EXISTS idx_usage_entries_project_occurred;
      DROP INDEX IF EXISTS idx_usage_entries_agent_occurred;
      DROP INDEX IF EXISTS idx_usage_entries_occurred;
      DROP INDEX IF EXISTS idx_usage_entries_session_source;
      DROP INDEX IF EXISTS idx_sessions_project;
      DROP INDEX IF EXISTS idx_sessions_worktree;
      DROP INDEX IF EXISTS idx_worktrees_project;
      DROP TABLE IF EXISTS project_spaces;
      DROP TABLE IF EXISTS spaces;
      DROP TABLE IF EXISTS settings;
      DROP TABLE IF EXISTS usage_sync_state;
      DROP TABLE IF EXISTS usage_entries;
      DROP TABLE IF EXISTS session_activities;
      DROP TABLE IF EXISTS session_messages;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS worktrees;
      DROP TABLE IF EXISTS projects;
    `
  },
  {
    version: 2,
    name: 'add_agent_sdk_column',
    up: `-- NOTE: ALTER TABLE for agent_sdk is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 3,
    name: 'add_connections',
    up: `
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pinned INTEGER NOT NULL DEFAULT 0,
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

      -- NOTE: ALTER TABLE for connection_id is handled idempotently by
      -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.

      CREATE INDEX IF NOT EXISTS idx_sessions_connection ON sessions(connection_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_sessions_connection;
      DROP INDEX IF EXISTS idx_connection_members_worktree;
      DROP INDEX IF EXISTS idx_connection_members_connection;
      DROP TABLE IF EXISTS connection_members;
      DROP TABLE IF EXISTS connections;
    `
  },
  {
    version: 4,
    name: 'add_connection_color',
    up: `-- NOTE: ALTER TABLE for color is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 5,
    name: 'add_connection_custom_name',
    up: `-- NOTE: ALTER TABLE for custom_name is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 6,
    name: 'add_worktree_attachments',
    up: `ALTER TABLE worktrees ADD COLUMN attachments TEXT DEFAULT '[]'`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 7,
    name: 'add_pinned_columns',
    up: `-- NOTE: ALTER TABLE for pinned is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 8,
    name: 'add_worktree_context',
    up: `ALTER TABLE worktrees ADD COLUMN context TEXT DEFAULT NULL`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 9,
    name: 'add_session_activities',
    up: `
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
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_activities_session_turn;
      DROP INDEX IF EXISTS idx_session_activities_session_created;
      DROP TABLE IF EXISTS session_activities;
    `
  },
  {
    version: 10,
    name: 'add_worktree_github_pr',
    up: `ALTER TABLE worktrees ADD COLUMN github_pr_number INTEGER DEFAULT NULL;
         ALTER TABLE worktrees ADD COLUMN github_pr_url TEXT DEFAULT NULL`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 11,
    name: 'add_composite_indexes',
    up: `
      -- Composite index for session queries by worktree + status + recency
      CREATE INDEX IF NOT EXISTS idx_sessions_worktree_status
        ON sessions(worktree_id, status, updated_at DESC);

      -- Composite index for session queries by connection + status + recency
      CREATE INDEX IF NOT EXISTS idx_sessions_connection_status
        ON sessions(connection_id, status, updated_at DESC);

      -- Composite index for worktree queries by project + status + access time
      CREATE INDEX IF NOT EXISTS idx_worktrees_project_status
        ON worktrees(project_id, status, last_accessed_at DESC);

      -- Composite index for worktree queries by status + message activity
      CREATE INDEX IF NOT EXISTS idx_worktrees_status_message
        ON worktrees(status, last_message_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_sessions_worktree_status;
      DROP INDEX IF EXISTS idx_sessions_connection_status;
      DROP INDEX IF EXISTS idx_worktrees_project_status;
      DROP INDEX IF EXISTS idx_worktrees_status_message;
    `
  },
  {
    version: 12,
    name: 'add_usage_analytics',
    up: `
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
    `,
    down: `
      DROP INDEX IF EXISTS idx_usage_sync_state_status;
      DROP INDEX IF EXISTS idx_usage_entries_project_occurred;
      DROP INDEX IF EXISTS idx_usage_entries_agent_occurred;
      DROP INDEX IF EXISTS idx_usage_entries_occurred;
      DROP INDEX IF EXISTS idx_usage_entries_session_source;
      DROP TABLE IF EXISTS usage_sync_state;
      DROP TABLE IF EXISTS usage_entries;
    `
  },
  {
    version: 13,
    name: 'add_session_color',
    up: `-- NOTE: ALTER TABLE for color is handled idempotently by
         -- ensureSessionColumns() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 14,
    name: 'add_session_level_provider_lock',
    // NOTE: ALTER TABLE for sessions.first_message_at and worktrees.last_agent_sdk
    // is handled idempotently by ensureConnectionTables() in database.ts via
    // safeAddColumn(). This migration also backfills first_message_at for any
    // historical sessions that already have activity, locking them so the
    // provider/model can no longer be changed mid-conversation.
    up: `
      UPDATE sessions
         SET first_message_at = CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)
       WHERE first_message_at IS NULL
         AND id IN (SELECT DISTINCT session_id FROM session_activities);
    `,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  },
  {
    version: 15,
    name: 'add_remote_skill_hubs',
    up: `
      CREATE TABLE IF NOT EXISTS remote_skill_hubs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT 'main',
        last_refreshed_at TEXT,
        last_sha TEXT,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (repo, ref)
      );
    `,
    down: `DROP TABLE IF EXISTS remote_skill_hubs;`
  },
  {
    version: 16,
    name: 'backfill_first_message_at_from_messages',
    // v14 only backfilled from session_activities (Codex path). Sessions whose
    // SDK was Claude Code or OpenCode never wrote activities, so their
    // first_message_at stayed NULL and the provider/model selectors never
    // locked. Backfill from session_messages too.
    up: `
      UPDATE sessions
         SET first_message_at = COALESCE(
           (
             SELECT CAST((julianday(MIN(sm.created_at)) - 2440587.5) * 86400000 AS INTEGER)
               FROM session_messages sm
              WHERE sm.session_id = sessions.id
                AND sm.role IN ('user', 'assistant')
           ),
           first_message_at
         )
       WHERE first_message_at IS NULL
         AND EXISTS (
           SELECT 1 FROM session_messages sm
            WHERE sm.session_id = sessions.id
              AND sm.role IN ('user', 'assistant')
         );
    `,
    down: `-- backfill is one-way; nothing to undo`
  },
  {
    version: 17,
    name: 'add_hub_tables',
    // Hub mode: mobile/remote control over claude-code/codex sessions.
    // See src/main/services/hub/* and docs/architecture/hub.md
    up: `
      CREATE TABLE IF NOT EXISTS hub_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hub_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        hash TEXT NOT NULL,
        prefix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used INTEGER,
        last_device_id TEXT,
        disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_hub_tokens_prefix ON hub_tokens(prefix);

      CREATE TABLE IF NOT EXISTS hub_cookie_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hub_cookie_sessions_expires
        ON hub_cookie_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS hub_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hostname TEXT,
        last_seen INTEGER,
        online INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS hub_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS hub_settings;
      DROP TABLE IF EXISTS hub_devices;
      DROP INDEX IF EXISTS idx_hub_cookie_sessions_expires;
      DROP TABLE IF EXISTS hub_cookie_sessions;
      DROP INDEX IF EXISTS idx_hub_tokens_prefix;
      DROP TABLE IF EXISTS hub_tokens;
      DROP TABLE IF EXISTS hub_users;
    `
  },
  {
    version: 18,
    name: 'add_field_events',
    up: `
      -- Phase 21: Field Event Stream
      -- Append-only structured log of user actions observed by the main process.
      -- See docs/prd/phase-21-field-events.md
      --
      -- No FKs to worktrees/sessions/projects: events are historical and survive
      -- subject deletion. project_id is denormalized for cheap grouping.
      -- seq AUTOINCREMENT gives stable total order even within the same millisecond.
      CREATE TABLE IF NOT EXISTS field_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        timestamp INTEGER NOT NULL,
        worktree_id TEXT,
        project_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        related_event_id TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_field_events_worktree_ts
        ON field_events(worktree_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_field_events_project_ts
        ON field_events(project_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_field_events_type_ts
        ON field_events(type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_field_events_ts
        ON field_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_field_events_session_ts
        ON field_events(session_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_field_events_related
        ON field_events(related_event_id) WHERE related_event_id IS NOT NULL;
    `,
    down: `
      DROP INDEX IF EXISTS idx_field_events_related;
      DROP INDEX IF EXISTS idx_field_events_session_ts;
      DROP INDEX IF EXISTS idx_field_events_ts;
      DROP INDEX IF EXISTS idx_field_events_type_ts;
      DROP INDEX IF EXISTS idx_field_events_project_ts;
      DROP INDEX IF EXISTS idx_field_events_worktree_ts;
      DROP TABLE IF EXISTS field_events;
    `
  },
  {
    version: 19,
    name: 'add_field_episodic_memory',
    up: `
      -- Phase 22B.1: Episodic Memory (per-worktree rolling summary)
      -- See docs/prd/phase-22b-episodic-memory.md
      CREATE TABLE IF NOT EXISTS field_episodic_memory (
        worktree_id TEXT PRIMARY KEY,
        summary_markdown TEXT NOT NULL,
        compactor_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        compacted_at INTEGER NOT NULL,
        source_event_count INTEGER NOT NULL,
        source_since INTEGER NOT NULL,
        source_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_field_episodic_memory_compacted
        ON field_episodic_memory(compacted_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_field_episodic_memory_compacted;
      DROP TABLE IF EXISTS field_episodic_memory;
    `
  },
  {
    version: 20,
    name: 'add_field_session_checkpoints',
    up: `
      -- Phase 24C: Session Checkpoint
      -- Per-worktree resume hints generated on abort/shutdown.
      -- See docs/prd/phase-24c-session-checkpoint.md
      --
      -- No status/stale_reason columns on purpose: verifier is a pure
      -- read-only function that computes staleness from branch/HEAD/digest
      -- at lookup time. Stale rows are superseded naturally by the next
      -- generate (verifier only reads the most recent row).
      CREATE TABLE IF NOT EXISTS field_session_checkpoints (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        worktree_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        branch TEXT,
        repo_head TEXT,
        source TEXT NOT NULL CHECK (source IN ('abort', 'shutdown')),
        summary TEXT NOT NULL,
        current_goal TEXT,
        next_action TEXT,
        blocking_reason TEXT,
        hot_files_json TEXT NOT NULL,
        hot_file_digests_json TEXT,
        packet_hash TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_field_session_checkpoints_worktree_created
        ON field_session_checkpoints(worktree_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_field_session_checkpoints_worktree_hash
        ON field_session_checkpoints(worktree_id, packet_hash);
    `,
    down: `
      DROP INDEX IF EXISTS idx_field_session_checkpoints_worktree_hash;
      DROP INDEX IF EXISTS idx_field_session_checkpoints_worktree_created;
      DROP TABLE IF EXISTS field_session_checkpoints;
    `
  },
  {
    version: 21,
    name: 'add_model_profiles',
    up: `
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        api_key TEXT,
        base_url TEXT,
        model_id TEXT,
        openai_api_key TEXT,
        openai_base_url TEXT,
        codex_config_toml TEXT,
        settings_json TEXT DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_profiles_default ON model_profiles(is_default);
      -- NOTE: ALTER TABLE for model_profile_id on projects, worktrees, connections
      -- is handled idempotently by ensureModelProfileTables() in database.ts.
    `,
    down: `
      DROP TABLE IF EXISTS model_profiles;
    `
  }
]
