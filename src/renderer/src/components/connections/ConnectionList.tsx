import { useEffect, useState, useCallback } from 'react'
import { useConnectionStore } from '@/stores'
import { ConnectionItem } from './ConnectionItem'
import { ManageConnectionWorktreesDialog } from './ManageConnectionWorktreesDialog'

export function ConnectionList(): React.JSX.Element | null {
  const connections = useConnectionStore((s) => s.connections)
  const loadConnections = useConnectionStore((s) => s.loadConnections)

  // State for managing worktrees of an existing connection
  const [manageConnectionId, setManageConnectionId] = useState<string | null>(null)

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const handleManageWorktrees = useCallback((connectionId: string) => {
    setManageConnectionId(connectionId)
  }, [])

  const handleCloseManageDialog = useCallback(() => {
    setManageConnectionId(null)
  }, [])

  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)

  if (connections.length === 0 || connectionModeActive) {
    return null
  }

  return (
    <div data-testid="connection-list">
      <div className="space-y-0.5" data-testid="connections-list-items">
        {connections.map((connection) => (
          <ConnectionItem
            key={connection.id}
            connection={connection}
            onManageWorktrees={handleManageWorktrees}
          />
        ))}
      </div>

      {/* Manage connection worktrees dialog */}
      {manageConnectionId && (
        <ManageConnectionWorktreesDialog
          connectionId={manageConnectionId}
          open={!!manageConnectionId}
          onOpenChange={(open) => {
            if (!open) handleCloseManageDialog()
          }}
        />
      )}
    </div>
  )
}
