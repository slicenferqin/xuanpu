# Codex Model Profile Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend model profiles to support Codex (OpenAI) by adding `openai_api_key` / `openai_base_url` fields, injecting them into the Codex child process env, and auto-refreshing idle sessions when profiles change.

**Architecture:** The single `model_profiles` table gains two new columns (`openai_api_key`, `openai_base_url`). The `ModelProvider` type widens to `'claude' | 'codex'`. `CodexStartSessionOptions` gets an `env` field. The Codex implementer resolves the profile on `connect()`, passes env overrides to the manager. On `model-profile:changed` events, idle Codex sessions auto-restart via `disconnect()` + `reconnect(resumeThreadId)`. Busy sessions set a `pendingEnvRefresh` flag and restart when they transition to idle.

**Tech Stack:** Electron + better-sqlite3 + TypeScript + React + Zustand

---

### Task 1: Shared Types — Widen ModelProvider and Add OpenAI Fields

**Files:**
- Modify: `src/shared/types/model-profile.ts`

- [ ] **Step 1: Update the types**

```ts
export type ModelProvider = 'claude' | 'codex'

export interface ModelProfile {
  id: string
  name: string
  provider: ModelProvider
  api_key: string | null
  base_url: string | null
  model_id: string | null
  openai_api_key: string | null
  openai_base_url: string | null
  settings_json: string
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface ModelProfileCreate {
  name: string
  provider: ModelProvider
  api_key?: string | null
  base_url?: string | null
  model_id?: string | null
  openai_api_key?: string | null
  openai_base_url?: string | null
  settings_json?: string
  is_default?: boolean
}

export interface ModelProfileUpdate {
  name?: string
  provider?: ModelProvider
  api_key?: string | null
  base_url?: string | null
  model_id?: string | null
  openai_api_key?: string | null
  openai_base_url?: string | null
  settings_json?: string
  is_default?: boolean
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit 2>&1 | head -30`
Expected: Errors in DB/UI code referencing old types (missing new fields). This confirms the type change propagates.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/model-profile.ts
git commit -m "feat: widen ModelProvider to 'claude' | 'codex', add openai_api_key/openai_base_url fields"
```

---

### Task 2: DB Migration v14 — Add OpenAI Columns

**Files:**
- Modify: `src/main/db/schema.ts` (bump version, add migration, update SCHEMA_SQL)
- Modify: `src/main/db/database.ts` (ensureModelProfileTables, createModelProfile, updateModelProfile, getModelProfile, getModelProfiles)

- [ ] **Step 1: Bump CURRENT_SCHEMA_VERSION to 14**

In `src/main/db/schema.ts`, line 1:
```ts
export const CURRENT_SCHEMA_VERSION = 14
```

- [ ] **Step 2: Add migration entry**

Append to the `MIGRATIONS` array (after the version 13 entry):
```ts
  {
    version: 14,
    name: 'add_openai_profile_fields',
    up: `
      ALTER TABLE model_profiles ADD COLUMN openai_api_key TEXT;
      ALTER TABLE model_profiles ADD COLUMN openai_base_url TEXT;
    `,
    down: `
      -- SQLite does not support DROP COLUMN in older versions
    `
  }
```

- [ ] **Step 3: Update SCHEMA_SQL**

In the canonical `CREATE TABLE model_profiles` block in `SCHEMA_SQL`, add the two new columns after `model_id`:
```sql
        openai_api_key TEXT,
        openai_base_url TEXT,
```

- [ ] **Step 4: Update ensureModelProfileTables**

In `src/main/db/database.ts`, method `ensureModelProfileTables()`, after the existing `safeAddColumn` calls (line 303-304), add:
```ts
    this.safeAddColumn('model_profiles', 'openai_api_key', 'TEXT')
    this.safeAddColumn('model_profiles', 'openai_base_url', 'TEXT')
```

- [ ] **Step 5: Update createModelProfile**

In `src/main/db/database.ts`, method `createModelProfile()`:

1. Add to the profile object creation (after `model_id` line):
```ts
      openai_api_key: data.openai_api_key ?? null,
      openai_base_url: data.openai_base_url ?? null,
```

2. Update the INSERT statement to include the new columns:
```ts
    db.prepare(
      `INSERT INTO model_profiles (id, name, provider, api_key, base_url, model_id, openai_api_key, openai_base_url, settings_json, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profile.id,
      profile.name,
      profile.provider,
      profile.api_key,
      profile.base_url,
      profile.model_id,
      profile.openai_api_key,
      profile.openai_base_url,
      profile.settings_json,
      profile.is_default ? 1 : 0,
      profile.created_at,
      profile.updated_at
    )
```

- [ ] **Step 6: Update updateModelProfile**

In the `updateModelProfile` method, add two new blocks after the `model_id` block:
```ts
    if (data.openai_api_key !== undefined) {
      updates.push('openai_api_key = ?')
      values.push(data.openai_api_key)
    }
    if (data.openai_base_url !== undefined) {
      updates.push('openai_base_url = ?')
      values.push(data.openai_base_url)
    }
```

- [ ] **Step 7: Update getModelProfile and getModelProfiles inline mapping**

In `getModelProfile` (returns a single profile) and `getModelProfiles` (returns array), the inline boolean mapping already does `is_default: Boolean(row.is_default)`. Add the new fields to the spread. Since the row from SQLite already has the columns after migration, and the mapping just does `{ ...row, is_default: Boolean(row.is_default) }`, the new columns are already included via the spread. No code change needed here — but verify that `openai_api_key` and `openai_base_url` appear in the returned object.

- [ ] **Step 8: Type-check**

Run: `pnpm exec tsc --noEmit 2>&1 | head -30`
Expected: Clean (or only unrelated pre-existing errors).

- [ ] **Step 9: Commit**

```bash
git add src/main/db/schema.ts src/main/db/database.ts
git commit -m "feat: migration v14 — add openai_api_key/openai_base_url to model_profiles"
```

---

### Task 3: Codex Manager — Accept env Overrides

**Files:**
- Modify: `src/main/services/codex-app-server-manager.ts`

- [ ] **Step 1: Add `env` field to CodexStartSessionOptions**

At line 93-100, add the field:
```ts
export interface CodexStartSessionOptions {
  cwd: string
  model?: string
  resumeThreadId?: string
  resumeCursor?: string
  codexBinaryPath?: string
  codexHomePath?: string
  env?: Record<string, string>
}
```

- [ ] **Step 2: Merge env overrides into spawn**

At lines 350-358, update the spawn env:
```ts
      const child = spawn(codexBinaryPath, ['app-server'], {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          ...(options.codexHomePath ? { CODEX_HOME: options.codexHomePath } : {}),
          ...(options.env ?? {})
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      })
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit 2>&1 | head -10`
Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add src/main/services/codex-app-server-manager.ts
git commit -m "feat: CodexStartSessionOptions accepts env overrides"
```

---

### Task 4: Codex Implementer — Resolve Profile and Inject Env

**Files:**
- Modify: `src/main/services/codex-implementer.ts`

- [ ] **Step 1: Add import**

At the top imports section, add:
```ts
import type { ModelProfile } from '@shared/types/model-profile'
```

- [ ] **Step 2: Add helper method to resolve profile env**

Add a private method to the `CodexImplementer` class (after `setDatabaseService`):
```ts
  /**
   * Resolve the model profile for a session and return OpenAI env overrides.
   */
  private resolveProfileEnv(hiveSessionId: string): Record<string, string> {
    if (!this.dbService) return {}

    try {
      const dbSession = this.dbService.getSession(hiveSessionId)
      if (!dbSession) return {}

      const profile: ModelProfile | null = this.dbService.resolveModelProfile(
        dbSession.worktree_id ?? undefined,
        dbSession.project_id
      )
      if (!profile) return {}

      const env: Record<string, string> = {}
      if (profile.openai_api_key) {
        env.OPENAI_API_KEY = profile.openai_api_key
      }
      if (profile.openai_base_url) {
        env.OPENAI_BASE_URL = profile.openai_base_url
      }

      log.info('Codex: resolved model profile env', {
        profileId: profile.id,
        profileName: profile.name,
        hasOpenaiKey: !!profile.openai_api_key,
        openaiBaseUrl: profile.openai_base_url ?? '(default)'
      })

      return env
    } catch (err) {
      log.warn('Codex: failed to resolve model profile', {
        hiveSessionId,
        error: err instanceof Error ? err.message : String(err)
      })
      return {}
    }
  }
```

- [ ] **Step 3: Update connect() to pass env**

In the `connect()` method (line 332-335), update the `startSession` call:
```ts
    const profileEnv = this.resolveProfileEnv(hiveSessionId)

    const providerSession = await this.manager.startSession({
      cwd: worktreePath,
      model: resolvedModel,
      env: profileEnv
    })
```

- [ ] **Step 4: Update reconnect() to pass env**

In the `reconnect()` method (line 400-404), update the `startSession` call:
```ts
    const profileEnv = this.resolveProfileEnv(hiveSessionId)

    const providerSession = await this.manager.startSession({
      cwd: worktreePath,
      model: resolvedModel,
      resumeThreadId: agentSessionId,
      env: profileEnv
    })
```

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit 2>&1 | head -10`
Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/codex-implementer.ts
git commit -m "feat: Codex implementer resolves model profile and injects OpenAI env"
```

---

### Task 5: Codex Implementer — Auto-Refresh on Profile Change

**Files:**
- Modify: `src/main/services/codex-implementer.ts`

- [ ] **Step 1: Add pendingEnvRefresh field to CodexSessionState**

Find the `CodexSessionState` interface (around line 46-60 in the file). Add:
```ts
  pendingEnvRefresh?: boolean
```

- [ ] **Step 2: Add public method `onModelProfileChanged`**

Add a public method to the class:
```ts
  /**
   * Called by IPC handlers when a model profile changes.
   * For idle sessions: immediately restart with new env.
   * For busy sessions: set flag to restart when idle.
   */
  onModelProfileChanged(worktreeIds: string[]): void {
    const affectedWorktreeIds = new Set(worktreeIds)

    for (const [key, session] of this.sessions.entries()) {
      if (!affectedWorktreeIds.has(this.getWorktreeIdForSession(session))) continue

      if (session.status === 'running') {
        // Busy — defer refresh until idle
        session.pendingEnvRefresh = true
        log.info('Codex: session busy, deferring env refresh', {
          hiveSessionId: session.hiveSessionId,
          threadId: session.threadId
        })
      } else {
        // Idle — restart now
        this.refreshSessionEnv(session).catch((err) => {
          log.warn('Codex: failed to refresh session env', {
            hiveSessionId: session.hiveSessionId,
            error: err instanceof Error ? err.message : String(err)
          })
        })
      }
    }
  }

  /**
   * Get the worktree ID for a session by looking up the DB session record.
   */
  private getWorktreeIdForSession(session: CodexSessionState): string {
    if (!this.dbService) return ''
    try {
      const dbSession = this.dbService.getSession(session.hiveSessionId)
      return dbSession?.worktree_id ?? ''
    } catch {
      return ''
    }
  }

  /**
   * Kill the current codex app-server and restart with fresh env via thread resume.
   */
  private async refreshSessionEnv(session: CodexSessionState): Promise<void> {
    session.pendingEnvRefresh = false

    const { worktreePath, threadId, hiveSessionId } = session
    log.info('Codex: refreshing session env', { hiveSessionId, threadId })

    // Stop the old process
    this.manager.stopSession(threadId)
    const key = this.getSessionKey(worktreePath, threadId)
    this.sessions.delete(key)
    this.cleanupPendingForThread(threadId)

    // Reconnect with fresh env (resume the thread)
    try {
      await this.reconnect(worktreePath, threadId, hiveSessionId)
      log.info('Codex: session env refreshed successfully', { hiveSessionId, threadId })
    } catch (err) {
      log.warn('Codex: failed to reconnect after env refresh', {
        hiveSessionId,
        threadId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
```

- [ ] **Step 3: Check pendingEnvRefresh on idle transition**

In the `prompt()` method, at the idle emission point (line 767-768), after `this.emitStatus(session.hiveSessionId, 'idle')`, add:
```ts
      // If a profile change happened while busy, refresh the session env now
      if (session.pendingEnvRefresh) {
        this.refreshSessionEnv(session).catch((err) => {
          log.warn('Codex: deferred env refresh failed', {
            hiveSessionId: session.hiveSessionId,
            error: err instanceof Error ? err.message : String(err)
          })
        })
      }
```

Do the same at the abort idle point (line 815-817) and the error idle point (line 784-791).

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit 2>&1 | head -10`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/codex-implementer.ts
git commit -m "feat: Codex auto-refreshes session env on model profile change"
```

---

### Task 6: Wire Profile Change Events to Codex Implementer

**Files:**
- Modify: `src/main/ipc/model-profile-handlers.ts`
- Modify: `src/main/ipc/database-handlers.ts`
- Modify: `src/main/index.ts`

The Codex implementer needs to be notified when profiles change. The simplest approach: pass the `CodexImplementer` instance to the handlers that need it, or use a module-level reference.

- [ ] **Step 1: Export a setter for the codex implementer in model-profile-handlers.ts**

At the top of `src/main/ipc/model-profile-handlers.ts`, add a module-level reference:
```ts
import type { CodexImplementer } from '../services/codex-implementer'

let codexImpl: CodexImplementer | null = null

export function setCodexImplementer(impl: CodexImplementer): void {
  codexImpl = impl
}
```

- [ ] **Step 2: Call codexImpl.onModelProfileChanged in the sync function**

In `syncAllActiveWorktrees()`, after `notifyRenderer(...)`, add:
```ts
    if (codexImpl && allWorktreeIds.length > 0) {
      codexImpl.onModelProfileChanged(allWorktreeIds)
    }
```

- [ ] **Step 3: Same pattern for database-handlers.ts**

At the top of `src/main/ipc/database-handlers.ts`, add:
```ts
import type { CodexImplementer } from '../services/codex-implementer'

let codexImpl: CodexImplementer | null = null

export function setCodexImplementerForDbHandlers(impl: CodexImplementer): void {
  codexImpl = impl
}
```

In the `db:project:update` handler, after `notifyRenderer('model-profile:changed', ...)`, add:
```ts
        if (codexImpl) codexImpl.onModelProfileChanged(worktreeIds)
```

In the `db:worktree:update` handler, after `notifyRenderer('model-profile:changed', ...)`, add:
```ts
        if (codexImpl) codexImpl.onModelProfileChanged([id])
```

- [ ] **Step 4: Wire in main/index.ts**

In `src/main/index.ts`, after the codexImpl is created (around line 658) and after `registerModelProfileHandlers()` / `registerDatabaseHandlers()` are called, add:
```ts
import { setCodexImplementer } from './ipc/model-profile-handlers'
import { setCodexImplementerForDbHandlers } from './ipc/database-handlers'

// After codexImpl creation:
setCodexImplementer(codexImpl)
setCodexImplementerForDbHandlers(codexImpl)
```

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit 2>&1 | head -10`
Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/model-profile-handlers.ts src/main/ipc/database-handlers.ts src/main/index.ts
git commit -m "feat: wire model profile change events to Codex implementer"
```

---

### Task 7: UI — Add OpenAI Fields to Profile Form

**Files:**
- Modify: `src/renderer/src/components/settings/ModelProfileDialog.tsx`
- Modify: `src/renderer/src/i18n/messages.ts`

- [ ] **Step 1: Add i18n keys (EN)**

In the EN `profiles:` section (around line 135), add after the existing keys:
```ts
          openaiApiKey: 'OpenAI API Key',
          openaiApiKeyPlaceholder: 'sk-...',
          openaiBaseUrl: 'OpenAI Base URL',
          openaiBaseUrlPlaceholder: 'https://api.openai.com/v1 (optional)',
```

- [ ] **Step 2: Add i18n keys (ZH-CN)**

In the ZH-CN `profiles:` section (around line 2229), add the same keys:
```ts
          openaiApiKey: 'OpenAI API Key',
          openaiApiKeyPlaceholder: 'sk-...',
          openaiBaseUrl: 'OpenAI Base URL',
          openaiBaseUrlPlaceholder: 'https://api.openai.com/v1（可选）',
```

- [ ] **Step 3: Add Codex option to provider dropdown**

In `ModelProfileDialog.tsx`, the provider select (line 128-134), add the option:
```tsx
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ModelProvider)}
              className="flex h-9 w-full rounded-lg border border-input/80 bg-background/70 px-3.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/15 focus-visible:border-ring/50"
            >
              <option value="claude">Claude (Anthropic)</option>
              <option value="codex">Codex (OpenAI)</option>
            </select>
```

- [ ] **Step 4: Add state and useEffect for OpenAI fields**

Add state variables (after line 36):
```ts
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('')
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false)
```

In the `useEffect` (line 39-53), add:
```ts
      setOpenaiApiKey(profile?.openai_api_key ?? '')
      setOpenaiBaseUrl(profile?.openai_base_url ?? '')
      setShowOpenaiApiKey(false)
```

- [ ] **Step 5: Update handleSave to include OpenAI fields**

In `handleSave` (lines 70-88), add the new fields to both the update and create calls:
```ts
          openai_api_key: openaiApiKey.trim() || null,
          openai_base_url: openaiBaseUrl.trim() || null,
```

- [ ] **Step 6: Add OpenAI form fields**

After the existing Base URL field (line 170) and before Model ID (line 172), add:
```tsx
          {/* OpenAI API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.openaiApiKey')}
            </label>
            <div className="relative">
              <Input
                type={showOpenaiApiKey ? 'text' : 'password'}
                value={openaiApiKey}
                onChange={(e) => setOpenaiApiKey(e.target.value)}
                placeholder={t('settings.models.profiles.openaiApiKeyPlaceholder')}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showOpenaiApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* OpenAI Base URL */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.openaiBaseUrl')}
            </label>
            <Input
              value={openaiBaseUrl}
              onChange={(e) => setOpenaiBaseUrl(e.target.value)}
              placeholder={t('settings.models.profiles.openaiBaseUrlPlaceholder')}
            />
          </div>
```

- [ ] **Step 7: Type-check and build**

Run: `pnpm exec tsc --noEmit 2>&1 | head -10`
Run: `pnpm build 2>&1 | tail -5`
Expected: Both clean.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/settings/ModelProfileDialog.tsx src/renderer/src/i18n/messages.ts
git commit -m "feat: add OpenAI API key/URL fields to model profile form"
```

---

### Task 8: Verification — Full Build + Lint

**Files:** None (verification only)

- [ ] **Step 1: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: Clean (no new errors).

- [ ] **Step 2: Lint**

Run: `pnpm lint 2>&1 | tail -10`
Expected: Only pre-existing warnings/errors (in generated files and server/).

- [ ] **Step 3: Build**

Run: `pnpm build 2>&1 | tail -5`
Expected: `✓ built in Xs`
