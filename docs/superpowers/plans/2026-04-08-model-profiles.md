# Model Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named model configuration profiles (API key, base URL, settings JSON) that can be assigned to projects and worktrees, starting with Claude provider support.

**Architecture:** New `model_profiles` SQLite table with CRUD operations accessible via IPC → preload → Zustand store. Profile selector added to Settings Models panel and ProjectSettingsDialog. Resolution chain: worktree → project → global default.

**Tech Stack:** SQLite (better-sqlite3), Electron IPC, Zustand, React, shadcn/ui Dialog/Select, Tailwind CSS 4

**Design spec:** `docs/superpowers/specs/2026-04-08-model-profiles-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/shared/types/model-profile.ts` | Shared TypeScript types for ModelProfile, ModelProfileCreate, ModelProfileUpdate |
| `src/main/ipc/model-profile-handlers.ts` | IPC handler registration for model-profile:* channels |
| `src/renderer/src/stores/useModelProfileStore.ts` | Zustand store for profile state + CRUD actions |
| `src/renderer/src/components/settings/ModelProfileDialog.tsx` | Create/Edit profile dialog component |

### Modified files
| File | Changes |
|------|---------|
| `src/shared/types/index.ts` | Add `export * from './model-profile'` |
| `src/shared/types/project.ts` | Add `model_profile_id: string \| null` field |
| `src/shared/types/worktree.ts` | Add `model_profile_id: string \| null` field |
| `src/main/db/schema.ts` | Add migration v13 (create table + ALTER columns) |
| `src/main/db/database.ts` | Add ModelProfile CRUD + resolve methods |
| `src/main/db/types.ts` | Add ModelProfile types, extend ProjectUpdate/WorktreeUpdate |
| `src/main/ipc/index.ts` | Export registerModelProfileHandlers |
| `src/main/index.ts` | Call registerModelProfileHandlers() |
| `src/preload/index.ts` | Add modelProfileOps namespace + contextBridge exposure |
| `src/preload/index.d.ts` | Add Window.modelProfileOps type declarations |
| `src/renderer/src/stores/index.ts` | Export useModelProfileStore |
| `src/renderer/src/components/settings/SettingsModels.tsx` | Add profiles section above existing model selectors |
| `src/renderer/src/components/projects/ProjectSettingsDialog.tsx` | Add profile selector dropdown |
| `src/renderer/src/i18n/messages.ts` | Add i18n keys for profiles (en + zh-CN) |

---

### Task 1: Shared Types

**Files:**
- Create: `src/shared/types/model-profile.ts`
- Modify: `src/shared/types/index.ts`
- Modify: `src/shared/types/project.ts`
- Modify: `src/shared/types/worktree.ts`

- [ ] **Step 1: Create model-profile.ts shared types**

```ts
// src/shared/types/model-profile.ts
export type ModelProvider = 'claude'

export interface ModelProfile {
  id: string
  name: string
  provider: ModelProvider
  api_key: string | null
  base_url: string | null
  model_id: string | null
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
  settings_json?: string
  is_default?: boolean
}

export interface ModelProfileUpdate {
  name?: string
  provider?: ModelProvider
  api_key?: string | null
  base_url?: string | null
  model_id?: string | null
  settings_json?: string
  is_default?: boolean
}
```

- [ ] **Step 2: Add re-export to shared types barrel**

In `src/shared/types/index.ts`, add at the end:

```ts
export * from './model-profile'
```

- [ ] **Step 3: Add model_profile_id to Project type**

In `src/shared/types/project.ts`, add before the closing brace of the `Project` interface:

```ts
  model_profile_id: string | null
```

- [ ] **Step 4: Add model_profile_id to Worktree type**

In `src/shared/types/worktree.ts`, add before the closing brace of the `Worktree` interface:

```ts
  model_profile_id: string | null
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/model-profile.ts src/shared/types/index.ts src/shared/types/project.ts src/shared/types/worktree.ts
git commit -m "feat(types): add ModelProfile shared types and model_profile_id to Project/Worktree"
```

---

### Task 2: Database Migration v13

**Files:**
- Modify: `src/main/db/schema.ts`

- [ ] **Step 1: Bump CURRENT_SCHEMA_VERSION to 13**

In `src/main/db/schema.ts`, change line 1:

```ts
export const CURRENT_SCHEMA_VERSION = 13
```

- [ ] **Step 2: Add model_profiles to SCHEMA_SQL**

In `src/main/db/schema.ts`, add the following SQL right before the `CREATE TABLE IF NOT EXISTS settings` block (around line 129):

```sql
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  api_key TEXT,
  base_url TEXT,
  model_id TEXT,
  settings_json TEXT DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Also add `model_profile_id TEXT` column to the `projects` and `worktrees` CREATE TABLE statements in `SCHEMA_SQL` (for fresh installs).

In the `projects` table definition, add after `auto_assign_port`:

```sql
  model_profile_id TEXT,
```

In the `worktrees` table definition, add after `github_pr_url`:

```sql
  model_profile_id TEXT,
```

Add an index in the indexes section:

```sql
CREATE INDEX IF NOT EXISTS idx_model_profiles_default ON model_profiles(is_default);
```

- [ ] **Step 3: Add migration v13 to MIGRATIONS array**

Append to the `MIGRATIONS` array in `src/main/db/schema.ts`:

```ts
  {
    version: 13,
    name: 'add_model_profiles',
    up: `
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        api_key TEXT,
        base_url TEXT,
        model_id TEXT,
        settings_json TEXT DEFAULT '{}',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_profiles_default ON model_profiles(is_default);
      ALTER TABLE projects ADD COLUMN model_profile_id TEXT;
      ALTER TABLE worktrees ADD COLUMN model_profile_id TEXT;
    `,
    down: `
      DROP TABLE IF EXISTS model_profiles;
      -- SQLite does not support DROP COLUMN in older versions
    `
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/main/db/schema.ts
git commit -m "feat(db): add migration v13 for model_profiles table"
```

---

### Task 3: Database CRUD Methods

**Files:**
- Modify: `src/main/db/types.ts`
- Modify: `src/main/db/database.ts`

- [ ] **Step 1: Add model_profile_id to DB types**

In `src/main/db/types.ts`, add to the `ProjectUpdate` interface:

```ts
  model_profile_id?: string | null
```

Add to the `WorktreeUpdate` interface:

```ts
  model_profile_id?: string | null
```

- [ ] **Step 2: Add ModelProfile import to database.ts**

In `src/main/db/database.ts`, extend the import from `'./types'` (or from `'@shared/types'`) to include:

```ts
import type { ModelProfile, ModelProfileCreate, ModelProfileUpdate } from '@shared/types/model-profile'
```

- [ ] **Step 3: Add ModelProfile CRUD methods to DatabaseService**

Add the following methods to the `DatabaseService` class in `src/main/db/database.ts`, after the settings operations section:

```ts
  // Model Profile operations

  getModelProfiles(): ModelProfile[] {
    const db = this.getDb()
    const rows = db
      .prepare('SELECT * FROM model_profiles ORDER BY is_default DESC, created_at ASC')
      .all() as Array<ModelProfile & { is_default: number }>
    return rows.map((row) => ({
      ...row,
      is_default: Boolean(row.is_default)
    }))
  }

  getModelProfile(id: string): ModelProfile | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM model_profiles WHERE id = ?').get(id) as
      | (ModelProfile & { is_default: number })
      | undefined
    if (!row) return null
    return { ...row, is_default: Boolean(row.is_default) }
  }

  createModelProfile(data: ModelProfileCreate): ModelProfile {
    const db = this.getDb()
    const now = new Date().toISOString()

    const profile: ModelProfile = {
      id: randomUUID(),
      name: data.name,
      provider: data.provider,
      api_key: data.api_key ?? null,
      base_url: data.base_url ?? null,
      model_id: data.model_id ?? null,
      settings_json: data.settings_json ?? '{}',
      is_default: data.is_default ?? false,
      created_at: now,
      updated_at: now
    }

    if (profile.is_default) {
      db.prepare('UPDATE model_profiles SET is_default = 0 WHERE is_default = 1').run()
    }

    db.prepare(
      `INSERT INTO model_profiles (id, name, provider, api_key, base_url, model_id, settings_json, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profile.id,
      profile.name,
      profile.provider,
      profile.api_key,
      profile.base_url,
      profile.model_id,
      profile.settings_json,
      profile.is_default ? 1 : 0,
      profile.created_at,
      profile.updated_at
    )

    return profile
  }

  updateModelProfile(id: string, data: ModelProfileUpdate): ModelProfile | null {
    const db = this.getDb()
    const existing = this.getModelProfile(id)
    if (!existing) return null

    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.provider !== undefined) {
      updates.push('provider = ?')
      values.push(data.provider)
    }
    if (data.api_key !== undefined) {
      updates.push('api_key = ?')
      values.push(data.api_key)
    }
    if (data.base_url !== undefined) {
      updates.push('base_url = ?')
      values.push(data.base_url)
    }
    if (data.model_id !== undefined) {
      updates.push('model_id = ?')
      values.push(data.model_id)
    }
    if (data.settings_json !== undefined) {
      updates.push('settings_json = ?')
      values.push(data.settings_json)
    }
    if (data.is_default !== undefined) {
      if (data.is_default) {
        db.prepare('UPDATE model_profiles SET is_default = 0 WHERE is_default = 1').run()
      }
      updates.push('is_default = ?')
      values.push(data.is_default ? 1 : 0)
    }

    if (updates.length === 0) return existing

    updates.push('updated_at = ?')
    values.push(new Date().toISOString())

    values.push(id)
    db.prepare(`UPDATE model_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values)

    return this.getModelProfile(id)
  }

  deleteModelProfile(id: string): boolean {
    const db = this.getDb()
    // Nullify references in projects and worktrees
    db.prepare('UPDATE projects SET model_profile_id = NULL WHERE model_profile_id = ?').run(id)
    db.prepare('UPDATE worktrees SET model_profile_id = NULL WHERE model_profile_id = ?').run(id)
    const result = db.prepare('DELETE FROM model_profiles WHERE id = ?').run(id)
    return result.changes > 0
  }

  setDefaultModelProfile(id: string): void {
    const db = this.getDb()
    const tx = db.transaction(() => {
      db.prepare('UPDATE model_profiles SET is_default = 0 WHERE is_default = 1').run()
      db.prepare('UPDATE model_profiles SET is_default = 1, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id
      )
    })
    tx()
  }

  getDefaultModelProfile(): ModelProfile | null {
    const db = this.getDb()
    const row = db.prepare('SELECT * FROM model_profiles WHERE is_default = 1').get() as
      | (ModelProfile & { is_default: number })
      | undefined
    if (!row) return null
    return { ...row, is_default: Boolean(row.is_default) }
  }

  resolveModelProfile(worktreeId?: string, projectId?: string): ModelProfile | null {
    // 1. Check worktree's profile
    if (worktreeId) {
      const db = this.getDb()
      const row = db
        .prepare('SELECT model_profile_id FROM worktrees WHERE id = ?')
        .get(worktreeId) as { model_profile_id: string | null } | undefined
      if (row?.model_profile_id) {
        const profile = this.getModelProfile(row.model_profile_id)
        if (profile) return profile
      }
    }
    // 2. Check project's profile
    if (projectId) {
      const db = this.getDb()
      const row = db
        .prepare('SELECT model_profile_id FROM projects WHERE id = ?')
        .get(projectId) as { model_profile_id: string | null } | undefined
      if (row?.model_profile_id) {
        const profile = this.getModelProfile(row.model_profile_id)
        if (profile) return profile
      }
    }
    // 3. Fall back to global default
    return this.getDefaultModelProfile()
  }
```

- [ ] **Step 4: Add model_profile_id handling to updateProject**

In `src/main/db/database.ts`, in the `updateProject` method, add before `if (updates.length === 0)`:

```ts
    if (data.model_profile_id !== undefined) {
      updates.push('model_profile_id = ?')
      values.push(data.model_profile_id)
    }
```

- [ ] **Step 5: Add model_profile_id handling to updateWorktree**

In `src/main/db/database.ts`, in the `updateWorktree` method, add before `if (updates.length === 0)`:

```ts
    if (data.model_profile_id !== undefined) {
      updates.push('model_profile_id = ?')
      values.push(data.model_profile_id)
    }
```

- [ ] **Step 6: Commit**

```bash
git add src/main/db/types.ts src/main/db/database.ts
git commit -m "feat(db): add ModelProfile CRUD methods and model_profile_id to project/worktree updates"
```

---

### Task 4: IPC Handlers

**Files:**
- Create: `src/main/ipc/model-profile-handlers.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Create model-profile-handlers.ts**

```ts
// src/main/ipc/model-profile-handlers.ts
import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import type { ModelProfileCreate, ModelProfileUpdate } from '@shared/types/model-profile'

export function registerModelProfileHandlers(): void {
  ipcMain.handle('model-profile:list', () => {
    return getDatabase().getModelProfiles()
  })

  ipcMain.handle('model-profile:get', (_event, id: string) => {
    return getDatabase().getModelProfile(id)
  })

  ipcMain.handle('model-profile:create', (_event, data: ModelProfileCreate) => {
    return getDatabase().createModelProfile(data)
  })

  ipcMain.handle('model-profile:update', (_event, id: string, data: ModelProfileUpdate) => {
    return getDatabase().updateModelProfile(id, data)
  })

  ipcMain.handle('model-profile:delete', (_event, id: string) => {
    return getDatabase().deleteModelProfile(id)
  })

  ipcMain.handle('model-profile:set-default', (_event, id: string) => {
    getDatabase().setDefaultModelProfile(id)
    return true
  })

  ipcMain.handle(
    'model-profile:resolve',
    (_event, worktreeId?: string, projectId?: string) => {
      return getDatabase().resolveModelProfile(worktreeId, projectId)
    }
  )
}
```

- [ ] **Step 2: Add export to IPC barrel**

In `src/main/ipc/index.ts`, add:

```ts
export { registerModelProfileHandlers } from './model-profile-handlers'
```

- [ ] **Step 3: Register handlers in main process**

In `src/main/index.ts`, add `registerModelProfileHandlers` to the import from `'./ipc'`:

```ts
import {
  // ... existing imports ...
  registerModelProfileHandlers
} from './ipc'
```

Then in the Phase 1 handler registration block (after `registerUsageHandlers()`), add:

```ts
registerModelProfileHandlers()
```

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/model-profile-handlers.ts src/main/ipc/index.ts src/main/index.ts
git commit -m "feat(ipc): add model-profile IPC handlers"
```

---

### Task 5: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

- [ ] **Step 1: Add modelProfileOps namespace to preload/index.ts**

In `src/preload/index.ts`, add the following namespace definition before the `contextBridge` block (near the other ops definitions):

```ts
const modelProfileOps = {
  list: (): Promise<ModelProfile[]> => ipcRenderer.invoke('model-profile:list'),
  get: (id: string): Promise<ModelProfile | null> => ipcRenderer.invoke('model-profile:get', id),
  create: (data: ModelProfileCreate): Promise<ModelProfile> =>
    ipcRenderer.invoke('model-profile:create', data),
  update: (id: string, data: ModelProfileUpdate): Promise<ModelProfile> =>
    ipcRenderer.invoke('model-profile:update', id, data),
  delete: (id: string): Promise<void> => ipcRenderer.invoke('model-profile:delete', id),
  setDefault: (id: string): Promise<void> =>
    ipcRenderer.invoke('model-profile:set-default', id),
  resolve: (worktreeId?: string, projectId?: string): Promise<ModelProfile | null> =>
    ipcRenderer.invoke('model-profile:resolve', worktreeId, projectId)
}
```

Add the necessary type import at the top of the file:

```ts
import type { ModelProfile, ModelProfileCreate, ModelProfileUpdate } from '@shared/types/model-profile'
```

- [ ] **Step 2: Expose modelProfileOps via contextBridge**

In the `contextBridge.exposeInMainWorld` section, add:

```ts
contextBridge.exposeInMainWorld('modelProfileOps', modelProfileOps)
```

In the `else` (non-isolated) fallback section, add:

```ts
// @ts-expect-error (define in dts)
window.modelProfileOps = modelProfileOps
```

- [ ] **Step 3: Add type declarations to preload/index.d.ts**

In `src/preload/index.d.ts`, add to the `declare global` section, inside the `Window` interface:

```ts
    modelProfileOps: {
      list: () => Promise<
        Array<{
          id: string
          name: string
          provider: string
          api_key: string | null
          base_url: string | null
          model_id: string | null
          settings_json: string
          is_default: boolean
          created_at: string
          updated_at: string
        }>
      >
      get: (id: string) => Promise<{
        id: string
        name: string
        provider: string
        api_key: string | null
        base_url: string | null
        model_id: string | null
        settings_json: string
        is_default: boolean
        created_at: string
        updated_at: string
      } | null>
      create: (data: {
        name: string
        provider: string
        api_key?: string | null
        base_url?: string | null
        model_id?: string | null
        settings_json?: string
        is_default?: boolean
      }) => Promise<{
        id: string
        name: string
        provider: string
        api_key: string | null
        base_url: string | null
        model_id: string | null
        settings_json: string
        is_default: boolean
        created_at: string
        updated_at: string
      }>
      update: (
        id: string,
        data: {
          name?: string
          provider?: string
          api_key?: string | null
          base_url?: string | null
          model_id?: string | null
          settings_json?: string
          is_default?: boolean
        }
      ) => Promise<{
        id: string
        name: string
        provider: string
        api_key: string | null
        base_url: string | null
        model_id: string | null
        settings_json: string
        is_default: boolean
        created_at: string
        updated_at: string
      }>
      delete: (id: string) => Promise<void>
      setDefault: (id: string) => Promise<void>
      resolve: (
        worktreeId?: string,
        projectId?: string
      ) => Promise<{
        id: string
        name: string
        provider: string
        api_key: string | null
        base_url: string | null
        model_id: string | null
        settings_json: string
        is_default: boolean
        created_at: string
        updated_at: string
      } | null>
    }
```

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(preload): expose modelProfileOps bridge"
```

---

### Task 6: Zustand Store

**Files:**
- Create: `src/renderer/src/stores/useModelProfileStore.ts`
- Modify: `src/renderer/src/stores/index.ts`

- [ ] **Step 1: Create useModelProfileStore.ts**

```ts
// src/renderer/src/stores/useModelProfileStore.ts
import { create } from 'zustand'
import type { ModelProfile, ModelProfileCreate, ModelProfileUpdate } from '@shared/types/model-profile'

interface ModelProfileState {
  profiles: ModelProfile[]
  loading: boolean

  loadProfiles: () => Promise<void>
  createProfile: (data: ModelProfileCreate) => Promise<ModelProfile>
  updateProfile: (id: string, data: ModelProfileUpdate) => Promise<void>
  deleteProfile: (id: string) => Promise<void>
  setDefaultProfile: (id: string) => Promise<void>
  getDefaultProfile: () => ModelProfile | undefined
}

export const useModelProfileStore = create<ModelProfileState>()((set, get) => ({
  profiles: [],
  loading: false,

  loadProfiles: async () => {
    set({ loading: true })
    try {
      const profiles = await window.modelProfileOps.list()
      set({ profiles })
    } finally {
      set({ loading: false })
    }
  },

  createProfile: async (data) => {
    const profile = await window.modelProfileOps.create(data)
    await get().loadProfiles()
    return profile
  },

  updateProfile: async (id, data) => {
    await window.modelProfileOps.update(id, data)
    await get().loadProfiles()
  },

  deleteProfile: async (id) => {
    await window.modelProfileOps.delete(id)
    await get().loadProfiles()
  },

  setDefaultProfile: async (id) => {
    await window.modelProfileOps.setDefault(id)
    await get().loadProfiles()
  },

  getDefaultProfile: () => {
    return get().profiles.find((p) => p.is_default)
  }
}))
```

- [ ] **Step 2: Export from stores barrel**

In `src/renderer/src/stores/index.ts`, add:

```ts
export { useModelProfileStore } from './useModelProfileStore'
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/stores/useModelProfileStore.ts src/renderer/src/stores/index.ts
git commit -m "feat(store): add useModelProfileStore"
```

---

### Task 7: i18n Keys

**Files:**
- Modify: `src/renderer/src/i18n/messages.ts`

- [ ] **Step 1: Add English i18n keys**

In `src/renderer/src/i18n/messages.ts`, inside the `en.settings.models` object, add a `profiles` key after the existing `useGlobal` entry:

```ts
        profiles: {
          title: 'Model Profiles',
          description:
            'Create named configurations with custom API keys and endpoints. Assign them to projects or worktrees.',
          add: 'Add Profile',
          edit: 'Edit Profile',
          create: 'Create Profile',
          delete: 'Delete',
          deleteConfirm:
            'Delete this profile? Projects and worktrees using it will fall back to the global default.',
          setDefault: 'Set as Default',
          removeDefault: 'Remove Default',
          default: 'Default',
          name: 'Name',
          namePlaceholder: 'e.g. Personal, Company',
          provider: 'Provider',
          apiKey: 'API Key',
          apiKeyPlaceholder: 'sk-ant-...',
          baseUrl: 'Base URL',
          baseUrlPlaceholder: 'https://api.anthropic.com (optional)',
          modelId: 'Default Model',
          modelIdPlaceholder: 'e.g. claude-sonnet-4-20250514 (optional)',
          advancedSettings: 'Advanced Settings (JSON)',
          noProfiles: 'No profiles configured. Add one to get started.',
          useGlobalDefault: 'Use Global Default',
          useProjectDefault: 'Use Project Default',
          none: 'None'
        },
```

- [ ] **Step 2: Add project settings i18n keys**

In `src/renderer/src/i18n/messages.ts`, inside `en.dialogs.projectSettings`, add:

```ts
        modelProfile: 'Model Profile',
        modelProfileDescription: 'Select a model profile for this project',
```

- [ ] **Step 3: Add Chinese i18n keys**

In `src/renderer/src/i18n/messages.ts`, inside the `'zh-CN'.settings.models` object, add a `profiles` key:

```ts
        profiles: {
          title: '模型配置',
          description: '创建带有自定义 API Key 和端点的命名配置，可分配到项目或 Worktree。',
          add: '添加配置',
          edit: '编辑配置',
          create: '创建配置',
          delete: '删除',
          deleteConfirm: '删除此配置？使用它的项目和 Worktree 将回退到全局默认配置。',
          setDefault: '设为默认',
          removeDefault: '取消默认',
          default: '默认',
          name: '名称',
          namePlaceholder: '如：个人、公司',
          provider: '提供商',
          apiKey: 'API Key',
          apiKeyPlaceholder: 'sk-ant-...',
          baseUrl: 'Base URL',
          baseUrlPlaceholder: 'https://api.anthropic.com（可选）',
          modelId: '默认模型',
          modelIdPlaceholder: '如：claude-sonnet-4-20250514（可选）',
          advancedSettings: '高级设置（JSON）',
          noProfiles: '暂无配置，添加一个开始使用。',
          useGlobalDefault: '使用全局默认',
          useProjectDefault: '使用项目默认',
          none: '无'
        },
```

In `'zh-CN'.dialogs.projectSettings`, add:

```ts
        modelProfile: '模型配置',
        modelProfileDescription: '为此项目选择模型配置',
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/i18n/messages.ts
git commit -m "feat(i18n): add model profiles i18n keys (en + zh-CN)"
```

---

### Task 8: ModelProfileDialog Component

**Files:**
- Create: `src/renderer/src/components/settings/ModelProfileDialog.tsx`

- [ ] **Step 1: Create ModelProfileDialog.tsx**

```tsx
// src/renderer/src/components/settings/ModelProfileDialog.tsx
import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Eye, EyeOff } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'
import { useModelProfileStore } from '@/stores'
import { toast } from 'sonner'
import type { ModelProfile, ModelProvider } from '@shared/types/model-profile'

interface ModelProfileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile?: ModelProfile | null
}

export function ModelProfileDialog({ open, onOpenChange, profile }: ModelProfileDialogProps) {
  const { t } = useI18n()
  const { createProfile, updateProfile } = useModelProfileStore()
  const isEditing = !!profile

  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ModelProvider>('claude')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [settingsJson, setSettingsJson] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(profile?.name ?? '')
      setProvider(profile?.provider ?? 'claude')
      setApiKey(profile?.api_key ?? '')
      setBaseUrl(profile?.base_url ?? '')
      setModelId(profile?.model_id ?? '')
      setSettingsJson(
        profile?.settings_json && profile.settings_json !== '{}'
          ? profile.settings_json
          : ''
      )
      setShowApiKey(false)
    }
  }, [open, profile])

  const handleSave = async () => {
    if (!name.trim()) return

    // Validate JSON if provided
    if (settingsJson.trim()) {
      try {
        JSON.parse(settingsJson)
      } catch {
        toast.error('Invalid JSON in advanced settings')
        return
      }
    }

    setSaving(true)
    try {
      if (isEditing && profile) {
        await updateProfile(profile.id, {
          name: name.trim(),
          provider,
          api_key: apiKey.trim() || null,
          base_url: baseUrl.trim() || null,
          model_id: modelId.trim() || null,
          settings_json: settingsJson.trim() || '{}'
        })
      } else {
        await createProfile({
          name: name.trim(),
          provider,
          api_key: apiKey.trim() || null,
          base_url: baseUrl.trim() || null,
          model_id: modelId.trim() || null,
          settings_json: settingsJson.trim() || '{}'
        })
      }
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('settings.models.profiles.edit')
              : t('settings.models.profiles.create')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('settings.models.profiles.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.name')}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.models.profiles.namePlaceholder')}
            />
          </div>

          {/* Provider */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.provider')}
            </label>
            <Select value={provider} onValueChange={(v) => setProvider(v as ModelProvider)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (Anthropic)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.apiKey')}
            </label>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('settings.models.profiles.apiKeyPlaceholder')}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {/* Base URL */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.baseUrl')}
            </label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('settings.models.profiles.baseUrlPlaceholder')}
            />
          </div>

          {/* Model ID */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.modelId')}
            </label>
            <Input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder={t('settings.models.profiles.modelIdPlaceholder')}
            />
          </div>

          {/* Advanced Settings */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.advancedSettings')}
            </label>
            <Textarea
              value={settingsJson}
              onChange={(e) => setSettingsJson(e.target.value)}
              placeholder='{ "max_tokens": 8192 }'
              rows={3}
              className="font-mono text-sm resize-y"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? '...' : isEditing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/settings/ModelProfileDialog.tsx
git commit -m "feat(ui): add ModelProfileDialog component"
```

---

### Task 9: Settings Models Panel — Profiles Section

**Files:**
- Modify: `src/renderer/src/components/settings/SettingsModels.tsx`

- [ ] **Step 1: Add imports**

In `src/renderer/src/components/settings/SettingsModels.tsx`, add these imports at the top:

```tsx
import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, Star } from 'lucide-react'
import { useModelProfileStore } from '@/stores'
import { ModelProfileDialog } from './ModelProfileDialog'
import { toast } from 'sonner'
import type { ModelProfile } from '@shared/types/model-profile'
```

- [ ] **Step 2: Add profile state and handlers to the component**

Inside the `SettingsModels` component function, add at the top (after existing state):

```tsx
  const { profiles, loading, loadProfiles, setDefaultProfile, deleteProfile } =
    useModelProfileStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null)

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  const handleEditProfile = (profile: ModelProfile) => {
    setEditingProfile(profile)
    setDialogOpen(true)
  }

  const handleAddProfile = () => {
    setEditingProfile(null)
    setDialogOpen(true)
  }

  const handleDeleteProfile = async (profile: ModelProfile) => {
    if (!confirm(t('settings.models.profiles.deleteConfirm'))) return
    try {
      await deleteProfile(profile.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete')
    }
  }

  const handleToggleDefault = async (profile: ModelProfile) => {
    try {
      if (profile.is_default) {
        // Remove default — update the profile to is_default: false
        await useModelProfileStore.getState().updateProfile(profile.id, { is_default: false })
      } else {
        await setDefaultProfile(profile.id)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update')
    }
  }

  const maskApiKey = (key: string | null): string => {
    if (!key) return '—'
    if (key.length <= 12) return '••••••••'
    return key.slice(0, 7) + '••••' + key.slice(-4)
  }
```

- [ ] **Step 3: Add profiles section JSX**

In the component return, add the profiles section **above** the existing priority info box. The full section JSX:

```tsx
      {/* Model Profiles */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">
              {t('settings.models.profiles.title')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.models.profiles.description')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleAddProfile}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('settings.models.profiles.add')}
          </Button>
        </div>

        {profiles.length === 0 && !loading ? (
          <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-md">
            {t('settings.models.profiles.noProfiles')}
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center justify-between p-3 rounded-md border bg-card"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{profile.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {profile.provider}
                    </span>
                    {profile.is_default && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                        {t('settings.models.profiles.default')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                    <span>Key: {maskApiKey(profile.api_key)}</span>
                    {profile.base_url && <span>URL: {profile.base_url}</span>}
                    {profile.model_id && <span>Model: {profile.model_id}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => handleToggleDefault(profile)}
                    className={`p-1.5 rounded-md transition-colors ${
                      profile.is_default
                        ? 'text-primary hover:text-primary/80'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={
                      profile.is_default
                        ? t('settings.models.profiles.removeDefault')
                        : t('settings.models.profiles.setDefault')
                    }
                  >
                    <Star
                      className="h-3.5 w-3.5"
                      fill={profile.is_default ? 'currentColor' : 'none'}
                    />
                  </button>
                  <button
                    onClick={() => handleEditProfile(profile)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeleteProfile(profile)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t pt-4" />

      <ModelProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profile={editingProfile}
      />
```

Note: The `<Button>` component should be imported from `@/components/ui/button`. Check if it is already imported; if not, add the import.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/SettingsModels.tsx
git commit -m "feat(ui): add model profiles section to SettingsModels"
```

---

### Task 10: ProjectSettingsDialog — Profile Selector

**Files:**
- Modify: `src/renderer/src/components/projects/ProjectSettingsDialog.tsx`

- [ ] **Step 1: Add imports**

In `ProjectSettingsDialog.tsx`, add these imports:

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useModelProfileStore } from '@/stores'
```

- [ ] **Step 2: Add profile state**

Inside the component, add:

```tsx
  const { profiles, loadProfiles } = useModelProfileStore()
  const [modelProfileId, setModelProfileId] = useState<string | null>(null)
```

In the `useEffect` that initializes state when `open` changes, add:

```tsx
    setModelProfileId(project.model_profile_id ?? null)
    loadProfiles()
```

- [ ] **Step 3: Add profile selector UI**

In the JSX, add after the Auto Port Assignment section (before the script sections):

```tsx
          {/* Model Profile */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('dialogs.projectSettings.modelProfile')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('dialogs.projectSettings.modelProfileDescription')}
            </p>
            <Select
              value={modelProfileId ?? '__none__'}
              onValueChange={(v) => setModelProfileId(v === '__none__' ? null : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  {t('settings.models.profiles.useGlobalDefault')}
                </SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.is_default ? ` (${t('settings.models.profiles.default')})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
```

- [ ] **Step 4: Include model_profile_id in save handler**

In the `handleSave` function, add `model_profile_id: modelProfileId` to the object passed to `updateProject`:

```ts
      await updateProject(project.id, {
        // ... existing fields ...
        model_profile_id: modelProfileId
      })
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/projects/ProjectSettingsDialog.tsx
git commit -m "feat(ui): add model profile selector to ProjectSettingsDialog"
```

---

### Task 11: Lint and Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Run linter**

```bash
pnpm lint
```

Expected: No new errors (fix any introduced issues).

- [ ] **Step 2: Run TypeScript check**

```bash
pnpm exec tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Run build**

```bash
pnpm build
```

Expected: Successful build.

- [ ] **Step 4: Fix any issues and commit**

If there are issues, fix them and commit:

```bash
git add -A
git commit -m "fix: address lint and type issues from model profiles feature"
```
