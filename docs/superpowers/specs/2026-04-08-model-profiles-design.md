# Model Profiles: Custom Model Configuration

## Overview

Add named model configuration profiles to Xuanpu, allowing users to define multiple API connection configurations (API key, base URL, advanced settings) and assign them to projects and worktrees. Start with Claude support; designed for future provider expansion.

## Problem

Currently, Xuanpu's model system handles **which model** to use (model selection) but not **how to connect** (API credentials, custom endpoints). Users with multiple API keys (personal, company) or custom proxy endpoints have no way to configure these per-project or per-worktree.

## Core Concept

**Model Profile** and **Model Selection** are orthogonal:

- **Model Profile** = connection configuration (API key, URL, advanced params)
- **Model Selection** = which specific model to use (claude-sonnet-4, etc.)

A profile tells the system _how to connect_; model selection tells it _what to request_.

## Data Model

### New `model_profiles` table (Migration v13)

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

CREATE INDEX idx_model_profiles_default ON model_profiles(is_default);
```

### Columns added to existing tables (Migration v13)

```sql
ALTER TABLE projects ADD COLUMN model_profile_id TEXT;
ALTER TABLE worktrees ADD COLUMN model_profile_id TEXT;
```

No foreign key constraints (SQLite ALTER TABLE limitation); enforce at application level.

### TypeScript types (`src/shared/types/model-profile.ts`)

```ts
export type ModelProvider = 'claude'  // future: | 'openai' | 'custom'

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

### Profile Resolution Chain

When determining which profile applies to a given context:

1. `worktree.model_profile_id` -- if set, use this profile
2. `project.model_profile_id` -- if set, use this profile
3. Global default -- the profile with `is_default = 1`
4. No profile -- fall back to environment/system defaults (e.g., `ANTHROPIC_API_KEY` env var)

## IPC Layer

### New handler file: `src/main/ipc/model-profile-handlers.ts`

| Channel | Parameters | Returns | Description |
|---------|-----------|---------|-------------|
| `model-profile:list` | -- | `ModelProfile[]` | All profiles |
| `model-profile:get` | `id: string` | `ModelProfile \| null` | Single profile |
| `model-profile:create` | `ModelProfileCreate` | `ModelProfile` | Create profile, auto-generate UUID |
| `model-profile:update` | `id: string, data: ModelProfileUpdate` | `ModelProfile` | Update profile fields |
| `model-profile:delete` | `id: string` | `void` | Delete profile; nullify references in projects/worktrees |
| `model-profile:set-default` | `id: string` | `void` | Unset all `is_default`, set target to 1 |
| `model-profile:resolve` | `worktreeId?: string, projectId?: string` | `ModelProfile \| null` | Walk resolution chain |

### Database methods added to `DatabaseService`

```ts
// model_profiles CRUD
getModelProfiles(): ModelProfile[]
getModelProfile(id: string): ModelProfile | null
createModelProfile(data: ModelProfileCreate): ModelProfile
updateModelProfile(id: string, data: ModelProfileUpdate): ModelProfile
deleteModelProfile(id: string): void
setDefaultModelProfile(id: string): void
getDefaultModelProfile(): ModelProfile | null
resolveModelProfile(worktreeId?: string, projectId?: string): ModelProfile | null
```

### Register in `src/main/index.ts`

Import and call `registerModelProfileHandlers(db)` alongside existing handler registrations.

## Preload Bridge

### New namespace: `window.modelProfileOps`

Added to `src/preload/index.ts` and typed in `src/preload/index.d.ts`:

```ts
modelProfileOps: {
  list(): Promise<ModelProfile[]>
  get(id: string): Promise<ModelProfile | null>
  create(data: ModelProfileCreate): Promise<ModelProfile>
  update(id: string, data: ModelProfileUpdate): Promise<ModelProfile>
  delete(id: string): Promise<void>
  setDefault(id: string): Promise<void>
  resolve(worktreeId?: string, projectId?: string): Promise<ModelProfile | null>
}
```

## Zustand Store

### New file: `src/renderer/src/stores/useModelProfileStore.ts`

```ts
interface ModelProfileState {
  profiles: ModelProfile[]
  loading: boolean

  loadProfiles(): Promise<void>
  createProfile(data: ModelProfileCreate): Promise<ModelProfile>
  updateProfile(id: string, data: ModelProfileUpdate): Promise<void>
  deleteProfile(id: string): Promise<void>
  setDefaultProfile(id: string): Promise<void>
  getDefaultProfile(): ModelProfile | undefined
}
```

Export from `stores/index.ts`.

## Settings UI

### SettingsModels.tsx -- New "Model Profiles" section

Placed **above** the existing model selection controls, separated by a divider.

**Profile list:**
- Card grid showing each profile: name, provider badge, masked API key (`sk-ant-...****`), base URL (if custom), default badge
- "Add Profile" button (opens dialog)
- Each card: Edit button, Delete button (with confirmation), "Set as Default" toggle

**Profile edit dialog (new component: `ModelProfileDialog.tsx`):**
- Name: text input (required)
- Provider: select dropdown (initially only "Claude")
- API Key: password input with show/hide toggle
- Base URL: text input with placeholder "https://api.anthropic.com" (optional)
- Model: text input with placeholder "claude-sonnet-4-20250514" (optional)
- Advanced Settings: collapsible section with JSON textarea
- Cancel / Save buttons

### ProjectSettingsDialog.tsx -- Profile selector

Add a "Model Profile" dropdown below existing fields:
- Options: "Use Global Default" + list of all profiles
- Shows resolved profile info when "Use Global Default" is selected
- Saves `model_profile_id` to the project row

### Worktree -- Profile selector

Add profile selector in worktree context menu or detail panel:
- Same dropdown pattern as project settings
- "Use Project Default" option in addition to "Use Global Default"
- Saves `model_profile_id` to the worktree row

## i18n Keys

New keys under `settings.models.profiles.*` and `dialogs.projectSettings.modelProfile.*`:

```
settings.models.profiles.title
settings.models.profiles.description
settings.models.profiles.add
settings.models.profiles.edit
settings.models.profiles.delete
settings.models.profiles.deleteConfirm
settings.models.profiles.setDefault
settings.models.profiles.default
settings.models.profiles.name
settings.models.profiles.provider
settings.models.profiles.apiKey
settings.models.profiles.baseUrl
settings.models.profiles.modelId
settings.models.profiles.advancedSettings
settings.models.profiles.noProfiles
settings.models.profiles.useGlobalDefault
settings.models.profiles.useProjectDefault
```

## Security Considerations

- API keys stored in SQLite as plaintext (user-accepted trade-off for simplicity)
- API keys masked in UI display (`sk-ant-...****`)
- API key field uses password input type by default
- Future: migrate to OS keychain (macOS Keychain, Windows Credential Manager)

## Future Extensibility

- Add more providers by extending `ModelProvider` type (`'openai' | 'custom'`)
- Per-session profile override (add `model_profile_id` to sessions table)
- Profile import/export (JSON format)
- Profile validation (test connection button)

## Files to Create/Modify

### New files:
- `src/shared/types/model-profile.ts` -- shared types
- `src/main/ipc/model-profile-handlers.ts` -- IPC handlers
- `src/renderer/src/stores/useModelProfileStore.ts` -- Zustand store
- `src/renderer/src/components/settings/ModelProfileDialog.tsx` -- edit dialog

### Modified files:
- `src/shared/types/index.ts` -- re-export new types
- `src/main/db/schema.ts` -- migration v13
- `src/main/db/database.ts` -- CRUD methods
- `src/main/db/types.ts` -- DB types update (Project, Worktree add model_profile_id)
- `src/main/index.ts` -- register handlers
- `src/preload/index.ts` -- expose modelProfileOps
- `src/preload/index.d.ts` -- type declarations
- `src/renderer/src/stores/index.ts` -- export new store
- `src/renderer/src/components/settings/SettingsModels.tsx` -- profiles section
- `src/renderer/src/components/projects/ProjectSettingsDialog.tsx` -- profile selector
- `src/shared/types/project.ts` -- add model_profile_id field
- `src/shared/types/worktree.ts` -- add model_profile_id field
- i18n files (en, zh-CN)
