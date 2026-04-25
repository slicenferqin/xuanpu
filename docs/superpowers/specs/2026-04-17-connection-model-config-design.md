# Connection Model Configuration

## Problem

Connections (linked projects) have no way to configure model profiles. The ConnectionItem context menu lacks a settings entry, the `connections` DB table has no `model_profile_id` column, and no `ConnectionSettingsDialog` exists. Users must navigate to individual project/worktree settings to configure models, which defeats the purpose of the unified connection workspace.

## Solution

Add a `ConnectionSettingsDialog` accessible from the ConnectionItem context menu. The dialog supports two-level model configuration: a connection-level model profile, and per-member worktree overrides.

## Model Resolution Priority

```
worktree.model_profile_id
  → connection.model_profile_id
    → project.model_profile_id
      → mode default
        → global default
```

## Changes

### 1. Schema Migration (v16)

File: `src/main/db/schema.ts`

- Bump `CURRENT_SCHEMA_VERSION` to 16
- Add migration v16:

```sql
ALTER TABLE connections ADD COLUMN model_profile_id TEXT;
```

### 2. Shared Types

File: `src/shared/types/connection.ts`

Add to `Connection` interface:

```ts
model_profile_id: string | null
custom_name: string | null  // already used in ConnectionItem but missing from shared type
```

### 3. IPC Layer

Ensure the existing connection IPC handlers:

- Include `model_profile_id` in query results (`getConnection`, `getConnections`)
- Accept `model_profile_id` in update operations (`updateConnection`)

If no generic `updateConnection` IPC channel exists, add one following the pattern in `src/main/ipc/` with corresponding preload exposure under `window.connectionOps`.

### 4. useConnectionStore

File: `src/renderer/src/stores/useConnectionStore.ts`

Add state and methods:

```ts
settingsConnectionId: string | null

openConnectionSettings: (connectionId: string) => void   // set({ settingsConnectionId })
closeConnectionSettings: () => void                       // set({ settingsConnectionId: null })
updateConnectionModelProfile: (id: string, modelProfileId: string | null) => Promise<boolean>
```

`updateConnectionModelProfile` calls `window.connectionOps.updateConnection(id, { model_profile_id })`, then refreshes the connection in the store.

### 5. ConnectionSettingsDialog (new component)

File: `src/renderer/src/components/connections/ConnectionSettingsDialog.tsx`

Structure:

```
┌─ Connection Settings ──────────────────────┐
│                                            │
│  Connection Model Profile                  │
│  [Select model profile...          ▼]      │
│                                            │
│  ── Member Worktrees ──────────────────    │
│                                            │
│  📁 frontend (main)                        │
│     Project: my-app                        │
│     [Inherit from connection        ▼]     │
│                                            │
│  📁 backend (develop)                      │
│     Project: api-server                    │
│     [gpt-4o profile                ▼]     │
│                                            │
│              [Cancel]  [Save]              │
└────────────────────────────────────────────┘
```

Behavior:

- Reads `settingsConnectionId` from `useConnectionStore` to find the target connection and its members
- Reads all model profiles from `useModelProfileStore`
- Connection-level dropdown: options are `None` + all profiles
- Per-worktree dropdown: options are `Inherit` (null, meaning fall through to connection/project level) + all profiles
- On save: calls `updateConnectionModelProfile` for the connection, and calls the existing worktree update IPC for each modified worktree's `model_profile_id`
- Uses shadcn/ui `Dialog` and `Select` components, consistent with `ProjectSettingsDialog` styling

### 6. ConnectionItem Menu

File: `src/renderer/src/components/connections/ConnectionItem.tsx`

Add a "Connection Settings" menu item in both the context menu and dropdown menu, placed after "Manage Worktrees":

```tsx
<ContextMenuItem onClick={() => useConnectionStore.getState().openConnectionSettings(connection.id)}>
  <Settings className="h-4 w-4 mr-2" />
  Connection Settings
</ContextMenuItem>
```

### 7. AppLayout Global Mount

File: `src/renderer/src/components/layout/AppLayout.tsx`

Add a `GlobalConnectionSettings` component following the `GlobalProjectSettings` pattern:

```tsx
function GlobalConnectionSettings() {
  const settingsConnectionId = useConnectionStore(s => s.settingsConnectionId)
  const connections = useConnectionStore(s => s.connections)
  const close = useConnectionStore(s => s.closeConnectionSettings)
  const connection = connections.find(c => c.id === settingsConnectionId)
  if (!connection) return null
  return <ConnectionSettingsDialog connection={connection} open onClose={close} />
}
```

Mount alongside `GlobalProjectSettings` in the AppLayout render tree.

### 8. Model Resolution Logic

Find the location where session model profile is resolved (likely in session creation or the ModelSelector component) and insert the connection layer:

```ts
// pseudocode
function resolveModelProfile(session) {
  if (session.worktree?.model_profile_id) return session.worktree.model_profile_id
  if (session.connection?.model_profile_id) return session.connection.model_profile_id
  if (session.project?.model_profile_id) return session.project.model_profile_id
  return getModeDefault() ?? getGlobalDefault()
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/main/db/schema.ts` | Migration v16, bump schema version |
| `src/shared/types/connection.ts` | Add `model_profile_id`, `custom_name` to `Connection` |
| `src/main/ipc/` (connection handler) | Ensure update supports `model_profile_id` |
| `src/preload/index.ts` + `index.d.ts` | Expose updated connection ops if needed |
| `src/renderer/src/stores/useConnectionStore.ts` | Add settings state + update method |
| `src/renderer/src/components/connections/ConnectionSettingsDialog.tsx` | New component |
| `src/renderer/src/components/connections/ConnectionItem.tsx` | Add settings menu item |
| `src/renderer/src/components/layout/AppLayout.tsx` | Mount GlobalConnectionSettings |
| Model resolution logic (location TBD) | Insert connection layer in priority chain |

## Out of Scope

- Setup/Run/Archive script configuration for connections
- Connection rename/color editing in the dialog (stays in context menu)
- BottomPanel tab changes for connection mode
