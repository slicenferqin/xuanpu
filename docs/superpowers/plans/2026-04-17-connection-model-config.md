# Connection Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable model profile configuration on connections (linked projects) with two-level control: connection-wide default + per-member worktree overrides.

**Architecture:** Add `model_profile_id` column to `connections` table via migration v16. Extend `resolveModelProfile()` to include a connection layer (worktree > connection > project > global). Create a `ConnectionSettingsDialog` component accessible from the ConnectionItem context menu, mounted globally in AppLayout.

**Tech Stack:** SQLite (better-sqlite3), Electron IPC, React 19, Zustand, shadcn/ui (Dialog, Select), Tailwind CSS 4

---

### Task 1: Schema Migration + DB Types

**Files:**
- Modify: `src/main/db/schema.ts` (add migration v16, bump version)
- Modify: `src/main/db/database.ts` (add `safeAddColumn` call in `ensureConnectionTables`)
- Modify: `src/main/db/types.ts` (add `model_profile_id` to Connection and ConnectionUpdate)

- [ ] **Step 1: Add migration v16 to schema.ts**

In `src/main/db/schema.ts`, change `CURRENT_SCHEMA_VERSION` from 15 to 16, and append to the `MIGRATIONS` array:

```ts
  {
    version: 16,
    name: 'add_connection_model_profile',
    up: `-- NOTE: ALTER TABLE for model_profile_id is handled idempotently by
         -- ensureConnectionTables() in database.ts to avoid "duplicate column" errors.`,
    down: `-- SQLite cannot drop columns; this is a no-op for safety`
  }
```

- [ ] **Step 2: Add safeAddColumn in ensureConnectionTables**

In `src/main/db/database.ts`, inside `ensureConnectionTables()`, after the existing `this.safeAddColumn('connections', 'pinned', ...)` line (line 204), add:

```ts
    this.safeAddColumn('connections', 'model_profile_id', 'TEXT DEFAULT NULL')
```

- [ ] **Step 3: Add model_profile_id to DB types**

In `src/main/db/types.ts`, add `model_profile_id` to three interfaces:

In `Connection` (line 329-339), add after `pinned`:
```ts
  model_profile_id: string | null
```

In `ConnectionCreate` (line 341-346), add:
```ts
  model_profile_id?: string | null
```

In `ConnectionUpdate` (line 348-355), add:
```ts
  model_profile_id?: string | null
```

- [ ] **Step 4: Verify the app starts without errors**

Run: `pnpm dev`
Expected: App launches, no migration errors in logs. The connections table now has a `model_profile_id` column (default NULL).

- [ ] **Step 5: Commit**

```bash
git add src/main/db/schema.ts src/main/db/database.ts src/main/db/types.ts
git commit -m "feat: add model_profile_id column to connections table (migration v16)"
```

---

### Task 2: Database updateConnection + resolveModelProfile

**Files:**
- Modify: `src/main/db/database.ts` (update `updateConnection` method, update `resolveModelProfile`)

- [ ] **Step 1: Add model_profile_id handling to updateConnection**

In `src/main/db/database.ts`, inside the `updateConnection` method (around line 1875, after the `pinned` block), add:

```ts
    if (data.model_profile_id !== undefined) {
      updates.push('model_profile_id = ?')
      values.push(data.model_profile_id ?? null)
    }
```

- [ ] **Step 2: Update resolveModelProfile to accept connectionId**

In `src/main/db/database.ts`, change the `resolveModelProfile` method signature and add the connection layer between worktree and project:

```ts
  resolveModelProfile(worktreeId?: string, projectId?: string, connectionId?: string): ModelProfile | null {
    const db = this.getDb()
    // 1. Check worktree's profile
    if (worktreeId) {
      const row = db
        .prepare('SELECT model_profile_id FROM worktrees WHERE id = ?')
        .get(worktreeId) as { model_profile_id: string | null } | undefined
      if (row?.model_profile_id) {
        const profile = this.getModelProfile(row.model_profile_id)
        if (profile) return profile
      }
    }
    // 2. Check connection's profile
    if (connectionId) {
      const row = db
        .prepare('SELECT model_profile_id FROM connections WHERE id = ?')
        .get(connectionId) as { model_profile_id: string | null } | undefined
      if (row?.model_profile_id) {
        const profile = this.getModelProfile(row.model_profile_id)
        if (profile) return profile
      }
    }
    // 3. Check project's profile
    if (projectId) {
      const row = db
        .prepare('SELECT model_profile_id FROM projects WHERE id = ?')
        .get(projectId) as { model_profile_id: string | null } | undefined
      if (row?.model_profile_id) {
        const profile = this.getModelProfile(row.model_profile_id)
        if (profile) return profile
      }
    }
    // 4. Fall back to global default
    return this.getDefaultModelProfile()
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/main/db/database.ts
git commit -m "feat: support model_profile_id in updateConnection and resolveModelProfile"
```

---

### Task 3: Shared Types

**Files:**
- Modify: `src/shared/types/connection.ts`

- [ ] **Step 1: Add model_profile_id and custom_name to shared Connection type**

In `src/shared/types/connection.ts`, update the `Connection` interface to include the missing fields:

```ts
export interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null
  model_profile_id: string | null
  created_at: string
  updated_at: string
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types/connection.ts
git commit -m "feat: add model_profile_id and custom_name to shared Connection type"
```

---

### Task 4: IPC Layer — Connection Update Handler + Model Resolution

**Files:**
- Modify: `src/main/ipc/connection-handlers.ts` (add `connection:updateModelProfile` handler)
- Modify: `src/main/ipc/model-profile-handlers.ts` (add `connectionId` param to resolve)
- Modify: `src/preload/index.ts` (expose new IPC method)
- Modify: `src/preload/index.d.ts` (add type declaration)

- [ ] **Step 1: Add connection:updateModelProfile IPC handler**

In `src/main/ipc/connection-handlers.ts`, add the following imports at the top (alongside existing imports):

```ts
import { syncProfileToClaudeSettings } from '../services/model-profile-sync'
import { BrowserWindow } from 'electron'
```

Then, inside `registerConnectionHandlers()`, before the closing `}`, add:

```ts
  // Update model profile for a connection
  ipcMain.handle(
    'connection:updateModelProfile',
    async (
      _event,
      {
        connectionId,
        modelProfileId
      }: { connectionId: string; modelProfileId: string | null }
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const db = getDatabase()
        db.updateConnection(connectionId, { model_profile_id: modelProfileId })

        // Re-sync all member worktrees that inherit from connection
        const connection = db.getConnection(connectionId)
        if (connection) {
          const worktreeIds: string[] = []
          for (const member of connection.members) {
            const profile = db.resolveModelProfile(
              member.worktree_id,
              member.project_id,
              connectionId
            )
            syncProfileToClaudeSettings(member.worktree_path, profile)
            worktreeIds.push(member.worktree_id)
          }
          if (worktreeIds.length > 0) {
            const windows = BrowserWindow.getAllWindows()
            if (windows.length > 0) {
              windows[0].webContents.send('model-profile:changed', { worktreeIds })
            }
          }
        }

        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('Update connection model profile failed', error instanceof Error ? error : new Error(message))
        return { success: false, error: message }
      }
    }
  )
```

Note: `BrowserWindow` needs to be added to the existing `import { ipcMain } from 'electron'` line:

```ts
import { ipcMain, BrowserWindow } from 'electron'
```

- [ ] **Step 2: Update model-profile:resolve to accept connectionId**

In `src/main/ipc/model-profile-handlers.ts`, update the resolve handler (lines 86-91):

```ts
  ipcMain.handle(
    'model-profile:resolve',
    (_event, worktreeId?: string, projectId?: string, connectionId?: string) => {
      return getDatabase().resolveModelProfile(worktreeId, projectId, connectionId)
    }
  )
```

- [ ] **Step 3: Expose in preload**

In `src/preload/index.ts`, add to the `connectionOps` object (after `getPinned` at line 1750):

```ts
  updateModelProfile: (connectionId: string, modelProfileId: string | null) =>
    ipcRenderer.invoke('connection:updateModelProfile', { connectionId, modelProfileId }),
```

Update the `modelProfileOps.resolve` call (line 1805-1806) to pass `connectionId`:

```ts
  resolve: (worktreeId?: string, projectId?: string, connectionId?: string) =>
    ipcRenderer.invoke('model-profile:resolve', worktreeId, projectId, connectionId)
```

- [ ] **Step 4: Add type declarations in preload**

In `src/preload/index.d.ts`, add to the `connectionOps` interface (after `getPinned` around line 1263):

```ts
      updateModelProfile: (
        connectionId: string,
        modelProfileId: string | null
      ) => Promise<{ success: boolean; error?: string }>
```

Update the `modelProfileOps.resolve` type declaration to include `connectionId`:

```ts
      resolve: (
        worktreeId?: string,
        projectId?: string,
        connectionId?: string
      ) => Promise<ModelProfile | null>
```

Find the existing `resolve` declaration in `modelProfileOps` and update it.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/connection-handlers.ts src/main/ipc/model-profile-handlers.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat: add connection:updateModelProfile IPC + connectionId in model resolution"
```

---

### Task 5: Connection Store — Settings State + Update Method

**Files:**
- Modify: `src/renderer/src/stores/useConnectionStore.ts`

- [ ] **Step 1: Add settings state and methods to the store interface**

In `src/renderer/src/stores/useConnectionStore.ts`, add to the `ConnectionState` interface (after `connectionModeSubmitting: boolean`):

```ts
  // Settings dialog
  settingsConnectionId: string | null
```

Add to the actions section (after `finalizeConnection`):

```ts
  // Settings
  openConnectionSettings: (connectionId: string) => void
  closeConnectionSettings: () => void
  updateConnectionModelProfile: (
    connectionId: string,
    modelProfileId: string | null
  ) => Promise<boolean>
```

- [ ] **Step 2: Add model_profile_id to the local Connection interface**

In the local `Connection` interface inside the store file, add after `updated_at`:

```ts
  model_profile_id: string | null
```

- [ ] **Step 3: Implement the state and methods**

In the `create` call, add initial state (after `connectionModeSubmitting: false,`):

```ts
      settingsConnectionId: null,
```

Add the method implementations (after the `selectConnection` method, before the closing of the `create` block):

```ts
      openConnectionSettings: (connectionId: string) => {
        set({ settingsConnectionId: connectionId })
      },

      closeConnectionSettings: () => {
        set({ settingsConnectionId: null })
      },

      updateConnectionModelProfile: async (
        connectionId: string,
        modelProfileId: string | null
      ) => {
        try {
          const result = await window.connectionOps.updateModelProfile(
            connectionId,
            modelProfileId
          )
          if (!result.success) {
            toast.error(result.error || t('connectionStore.toasts.unknownError'))
            return false
          }
          // Update local state
          set((state) => ({
            connections: state.connections.map((c) =>
              c.id === connectionId ? { ...c, model_profile_id: modelProfileId } : c
            )
          }))
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          toast.error(message)
          return false
        }
      },
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/stores/useConnectionStore.ts
git commit -m "feat: add connection settings state and updateConnectionModelProfile to store"
```

---

### Task 6: ConnectionSettingsDialog Component

**Files:**
- Create: `src/renderer/src/components/connections/ConnectionSettingsDialog.tsx`
- Modify: `src/renderer/src/components/connections/index.ts` (add export)

- [ ] **Step 1: Create ConnectionSettingsDialog**

Create `src/renderer/src/components/connections/ConnectionSettingsDialog.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { useModelProfileStore } from '@/stores'
import { useConnectionStore } from '@/stores'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

interface ConnectionMemberEnriched {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
  worktree_name: string
  worktree_branch: string
  worktree_path: string
  project_name: string
}

interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null
  model_profile_id: string | null
  created_at: string
  updated_at: string
  members: ConnectionMemberEnriched[]
}

interface ConnectionSettingsDialogProps {
  connection: Connection
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConnectionSettingsDialog({
  connection,
  open,
  onOpenChange
}: ConnectionSettingsDialogProps): React.JSX.Element {
  const { t } = useI18n()
  const profiles = useModelProfileStore((s) => s.profiles)
  const loadProfiles = useModelProfileStore((s) => s.loadProfiles)
  const updateConnectionModelProfile = useConnectionStore(
    (s) => s.updateConnectionModelProfile
  )

  // Local state
  const [connectionProfileId, setConnectionProfileId] = useState<string | null>(null)
  const [worktreeProfiles, setWorktreeProfiles] = useState<Map<string, string | null>>(new Map())
  const [saving, setSaving] = useState(false)

  // Load profiles when dialog opens
  useEffect(() => {
    if (open) {
      loadProfiles()
      setConnectionProfileId(connection.model_profile_id)

      // Initialize worktree profile overrides — we need to fetch current values
      const fetchWorktreeProfiles = async (): Promise<void> => {
        const map = new Map<string, string | null>()
        for (const member of connection.members) {
          try {
            const result = await window.db.worktree.get(member.worktree_id)
            map.set(member.worktree_id, result?.model_profile_id ?? null)
          } catch {
            map.set(member.worktree_id, null)
          }
        }
        setWorktreeProfiles(map)
      }
      fetchWorktreeProfiles()
    }
  }, [open, connection, loadProfiles])

  const handleWorktreeProfileChange = useCallback(
    (worktreeId: string, profileId: string | null) => {
      setWorktreeProfiles((prev) => {
        const next = new Map(prev)
        next.set(worktreeId, profileId)
        return next
      })
    },
    []
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // 1. Update connection model profile
      const success = await updateConnectionModelProfile(
        connection.id,
        connectionProfileId
      )
      if (!success) {
        setSaving(false)
        return
      }

      // 2. Update each worktree's model profile if changed
      for (const member of connection.members) {
        const newProfileId = worktreeProfiles.get(member.worktree_id)
        // We fetched the initial values on open, so any difference is a change
        try {
          await window.db.worktree.update(member.worktree_id, {
            model_profile_id: newProfileId ?? null
          })
        } catch {
          toast.error(
            t('connectionSettings.worktreeUpdateError', {
              name: member.worktree_name
            })
          )
        }
      }

      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [
    connection,
    connectionProfileId,
    worktreeProfiles,
    updateConnectionModelProfile,
    onOpenChange,
    t
  ])

  const displayName = connection.custom_name || connection.name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t('connectionSettings.title', { name: displayName })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Connection-level model profile */}
          <div className="space-y-2">
            <Label>{t('connectionSettings.connectionProfile')}</Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              value={connectionProfileId ?? '__none__'}
              onChange={(e) =>
                setConnectionProfileId(
                  e.target.value === '__none__' ? null : e.target.value
                )
              }
            >
              <option value="__none__">
                {t('connectionSettings.useGlobalDefault')}
              </option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.provider})
                </option>
              ))}
            </select>
          </div>

          {/* Member worktree overrides */}
          {connection.members.length > 0 && (
            <>
              <Separator />
              <div className="space-y-3">
                <Label className="text-muted-foreground text-xs uppercase tracking-wider">
                  {t('connectionSettings.memberWorktrees')}
                </Label>
                {connection.members.map((member) => (
                  <div key={member.id} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {member.worktree_name}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        {member.project_name}
                      </span>
                    </div>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                      value={
                        worktreeProfiles.get(member.worktree_id) ?? '__inherit__'
                      }
                      onChange={(e) =>
                        handleWorktreeProfileChange(
                          member.worktree_id,
                          e.target.value === '__inherit__' ? null : e.target.value
                        )
                      }
                    >
                      <option value="__inherit__">
                        {t('connectionSettings.inherit')}
                      </option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.provider})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('connectionSettings.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? t('connectionSettings.saving')
              : t('connectionSettings.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Export from connections index**

In `src/renderer/src/components/connections/index.ts`, add:

```ts
export { ConnectionSettingsDialog } from './ConnectionSettingsDialog'
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/connections/ConnectionSettingsDialog.tsx src/renderer/src/components/connections/index.ts
git commit -m "feat: create ConnectionSettingsDialog component"
```

---

### Task 7: ConnectionItem Menu + AppLayout Mount

**Files:**
- Modify: `src/renderer/src/components/connections/ConnectionItem.tsx`
- Modify: `src/renderer/src/components/layout/AppLayout.tsx`

- [ ] **Step 1: Add settings menu item to ConnectionItem**

In `src/renderer/src/components/connections/ConnectionItem.tsx`, add a `handleOpenSettings` callback (alongside the other `useCallback` handlers):

```tsx
  const handleOpenSettings = useCallback((): void => {
    useConnectionStore.getState().openConnectionSettings(connection.id)
  }, [connection.id])
```

Then in the `menuItems` JSX (the `<>` fragment that defines context menu items), add after the "Manage Worktrees" item and before the "Rename" item:

```tsx
      <ContextMenuItem onClick={handleOpenSettings}>
        <Settings2 className="h-4 w-4 mr-2" />
        {t('pinned.menu.connectionSettings')}
      </ContextMenuItem>
```

Note: `Settings2` is already imported in the file.

Also add the same item to the DropdownMenuContent (the hover menu). After the "Manage Worktrees" `DropdownMenuItem` and before "Rename", add:

```tsx
          <DropdownMenuItem onClick={handleOpenSettings}>
            <Settings2 className="h-4 w-4 mr-2" />
            {t('pinned.menu.connectionSettings')}
          </DropdownMenuItem>
```

- [ ] **Step 2: Mount ConnectionSettingsDialog globally in AppLayout**

In `src/renderer/src/components/layout/AppLayout.tsx`, add the import at the top:

```tsx
import { ConnectionSettingsDialog } from '@/components/connections/ConnectionSettingsDialog'
import { useConnectionStore } from '@/stores/useConnectionStore'
```

Add a `GlobalConnectionSettings` component after the existing `GlobalProjectSettings` function:

```tsx
function GlobalConnectionSettings(): React.JSX.Element | null {
  const settingsConnectionId = useConnectionStore((s) => s.settingsConnectionId)
  const closeConnectionSettings = useConnectionStore((s) => s.closeConnectionSettings)
  const connection = useConnectionStore((s) =>
    s.connections.find((c) => c.id === s.settingsConnectionId)
  )

  if (!connection) return null

  return (
    <ConnectionSettingsDialog
      connection={connection}
      open={!!settingsConnectionId}
      onOpenChange={(open) => {
        if (!open) closeConnectionSettings()
      }}
    />
  )
}
```

In the JSX render tree, add `<GlobalConnectionSettings />` right after `<GlobalProjectSettings />` (inside the `<Suspense>` block):

```tsx
        <GlobalProjectSettings />
        <GlobalConnectionSettings />
```

- [ ] **Step 3: Verify the dialog opens**

Run: `pnpm dev`
Expected: Right-click a connection → "Connection Settings" menu item appears → clicking it opens the dialog with model profile dropdowns.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/connections/ConnectionItem.tsx src/renderer/src/components/layout/AppLayout.tsx
git commit -m "feat: add Connection Settings menu item and global dialog mount"
```

---

### Task 8: Session Model Resolution — Connection Layer

**Files:**
- Modify: `src/renderer/src/stores/useSessionStore.ts` (update `createConnectionSession`)

- [ ] **Step 1: Add model profile resolution to createConnectionSession**

In `src/renderer/src/stores/useSessionStore.ts`, in the `createConnectionSession` method (around line 1290, after looking up the connection and determining `projectId`), add model profile resolution before the existing model fallback logic:

Find this section:

```ts
          const projectId = result.connection.members[0].project_id

          // Determine default model and agent SDK from global settings
          let defaultModel: { providerID: string; modelID: string; variant?: string } | null = null
          let defaultAgentSdk: 'opencode' | 'claude-code' | 'codex' | 'terminal' = 'opencode'
```

Replace with:

```ts
          const projectId = result.connection.members[0].project_id

          // Determine default model and agent SDK
          let defaultModel: { providerID: string; modelID: string; variant?: string } | null = null
          let defaultAgentSdk: 'opencode' | 'claude-code' | 'codex' | 'terminal' = 'opencode'
          try {
            const { useSettingsStore } = await import('./useSettingsStore')
            defaultAgentSdk =
              agentSdkOverride ?? useSettingsStore.getState().defaultAgentSdk ?? 'opencode'

            if (defaultAgentSdk !== 'terminal') {
              // Priority 0: resolved model profile (worktree > connection > project > default)
              const resolvedProfile = await window.modelProfileOps.resolve(
                undefined,
                projectId,
                connectionId
              )
              if (resolvedProfile?.model_id) {
                // Determine SDK from profile provider
                const profileSdk =
                  resolvedProfile.provider === 'codex' ? 'codex' : 'claude-code'
                if (!agentSdkOverride) {
                  defaultAgentSdk = profileSdk
                }
                defaultModel = {
                  providerID: resolvedProfile.provider,
                  modelID: resolvedProfile.model_id,
                  variant: undefined
                }
              }

              if (!defaultModel) {
                const configuredDefaultSdk =
                  useSettingsStore.getState().defaultAgentSdk ?? 'opencode'

                // Priority 1: mode-specific default
                if (defaultAgentSdk === configuredDefaultSdk) {
                  const modeModel = useSettingsStore
                    .getState()
                    .getModelForMode(initialMode ?? 'build')
                  if (modeModel) {
                    defaultModel = modeModel
                  }
                }

                // Priority 2: per-provider default -> (legacy) global default
                if (!defaultModel) {
                  const { resolveModelForSdk } = await import('./useSettingsStore')
                  defaultModel = resolveModelForSdk(defaultAgentSdk)
                }
              }
            }
          } catch {
            /* non-critical */
          }
```

And remove the old `try { ... } catch { /* non-critical */ }` block that followed the original `let defaultAgentSdk` line, since we replaced it entirely.

- [ ] **Step 2: Verify connection sessions use the resolved model**

Run: `pnpm dev`
Expected: Set a model profile on a connection via the new dialog → create a new session in that connection → the session uses the configured model profile.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/stores/useSessionStore.ts
git commit -m "feat: resolve model profile with connection layer in createConnectionSession"
```

---

### Task 9: i18n Keys

**Files:**
- Modify: The i18n message files (find via grep for existing `connectionStore` or `pinned.menu` keys)

- [ ] **Step 1: Find and read the i18n file**

Grep for `pinned.menu.connectionWorktrees` to find the i18n source file. Add the following keys alongside the existing connection-related keys:

```ts
// Under pinned.menu:
'pinned.menu.connectionSettings': 'Connection Settings'

// New section for ConnectionSettingsDialog:
'connectionSettings.title': '{name} Settings'
'connectionSettings.connectionProfile': 'Model Profile'
'connectionSettings.useGlobalDefault': 'Use global default'
'connectionSettings.memberWorktrees': 'Member Worktrees'
'connectionSettings.inherit': 'Inherit from connection'
'connectionSettings.cancel': 'Cancel'
'connectionSettings.save': 'Save'
'connectionSettings.saving': 'Saving...'
'connectionSettings.worktreeUpdateError': 'Failed to update {name}'
```

- [ ] **Step 2: Commit**

```bash
git add <i18n-file-path>
git commit -m "feat: add i18n keys for connection settings dialog"
```

---

### Task 10: Lint + Type Check + Smoke Test

- [ ] **Step 1: Run lint**

Run: `pnpm lint`
Expected: No new errors. Fix any that appear.

- [ ] **Step 2: Run type check**

Run: `pnpm exec tsc --noEmit`
Expected: No type errors. Fix any that appear.

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All existing tests pass.

- [ ] **Step 4: Manual smoke test**

1. Create a connection with 2+ worktrees
2. Right-click → Connection Settings → set a model profile → Save
3. Create a new session in the connection → verify it uses the configured model
4. Set a different model profile on a member worktree → create session → verify worktree override takes precedence
5. Remove the worktree override (set to "Inherit") → create session → verify connection profile is used

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address lint and type errors from connection model config feature"
```
