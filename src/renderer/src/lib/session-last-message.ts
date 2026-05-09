import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

function refreshConnectionMembers(connectionId: string, timestamp: number): boolean {
  const connection = useConnectionStore
    .getState()
    .connections.find((item) => item.id === connectionId)
  if (!connection) return false

  const statusStore = useWorktreeStatusStore.getState()
  for (const member of connection.members) {
    statusStore.setLastMessageTime(member.worktree_id, timestamp)
  }
  return true
}

function refreshFromStores(sessionId: string, timestamp: number): boolean {
  const sessionState = useSessionStore.getState()
  const statusStore = useWorktreeStatusStore.getState()

  for (const [worktreeId, sessions] of sessionState.sessionsByWorktree) {
    if (sessions.some((session) => session.id === sessionId)) {
      statusStore.setLastMessageTime(worktreeId, timestamp)
      return true
    }
  }

  for (const [connectionId, sessions] of sessionState.sessionsByConnection) {
    if (!sessions.some((session) => session.id === sessionId)) continue

    return refreshConnectionMembers(connectionId, timestamp)
  }

  return false
}

async function refreshFromDatabase(sessionId: string, timestamp: number): Promise<void> {
  if (typeof window === 'undefined' || !window.db?.session?.get) return

  try {
    const session = await window.db.session.get(sessionId)
    if (!session) return

    if (session.worktree_id) {
      useWorktreeStatusStore.getState().setLastMessageTime(session.worktree_id, timestamp)
      return
    }

    if (!session.connection_id) return

    if (refreshConnectionMembers(session.connection_id, timestamp)) return

    const result = await window.connectionOps?.get?.(session.connection_id)
    if (!result?.success || !result.connection) return

    const statusStore = useWorktreeStatusStore.getState()
    for (const member of result.connection.members) {
      statusStore.setLastMessageTime(member.worktree_id, timestamp)
    }
  } catch {
    // Best-effort UI freshness helper; persistence failures should not break send paths.
  }
}

export async function refreshSessionLastMessageAt(
  sessionId: string,
  timestamp = Date.now()
): Promise<void> {
  if (refreshFromStores(sessionId, timestamp)) return
  await refreshFromDatabase(sessionId, timestamp)
}
