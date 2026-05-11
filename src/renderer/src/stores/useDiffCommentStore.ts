import { create } from 'zustand'
import type { DiffComment, DiffCommentCreate, DiffCommentUpdate } from '@shared/types/git'

export interface DiffCommentScope {
  compareBranch?: string | null
  staged?: boolean
}

function normalizeScope(scope?: DiffCommentScope): {
  compareBranch: string | null
  staged: boolean
} {
  return {
    compareBranch: scope?.compareBranch ?? null,
    staged: scope?.staged ?? false
  }
}

export function diffCommentFileKey(
  worktreeId: string,
  filePath: string,
  scope?: DiffCommentScope
): string {
  const normalized = normalizeScope(scope)
  return `${worktreeId}\u0000${filePath}\u0000${normalized.staged ? 'staged' : 'unstaged'}\u0000${normalized.compareBranch ?? ''}`
}

function diffCommentKeyForComment(comment: DiffComment): string {
  return diffCommentFileKey(comment.worktreeId, comment.filePath, {
    staged: comment.staged,
    compareBranch: comment.compareBranch
  })
}

function sortComments(comments: DiffComment[]): DiffComment[] {
  return [...comments].sort((a, b) => {
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath)
    if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber
    return a.createdAt - b.createdAt
  })
}

interface DiffCommentStoreState {
  commentsByFile: Map<string, DiffComment[]>
  worktreeComments: Map<string, DiffComment[]>
  loadingKeys: Set<string>
  errorByKey: Map<string, string | null>
  attachedComments: DiffComment[]

  loadComments: (worktreeId: string, filePath: string, scope?: DiffCommentScope) => Promise<void>
  loadWorktreeComments: (worktreeId: string) => Promise<void>
  createComment: (data: DiffCommentCreate) => Promise<DiffComment>
  updateComment: (id: string, data: DiffCommentUpdate) => Promise<DiffComment | null>
  deleteComment: (id: string) => Promise<boolean>
  attachComment: (comment: DiffComment) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  getFileComments: (worktreeId: string, filePath: string, scope?: DiffCommentScope) => DiffComment[]
}

function upsertCommentInArray(comments: DiffComment[], comment: DiffComment): DiffComment[] {
  const filtered = comments.filter((item) => item.id !== comment.id)
  return sortComments([...filtered, comment])
}

function removeCommentFromArray(comments: DiffComment[], id: string): DiffComment[] {
  return comments.filter((item) => item.id !== id)
}

export const useDiffCommentStore = create<DiffCommentStoreState>((set, get) => ({
  commentsByFile: new Map(),
  worktreeComments: new Map(),
  loadingKeys: new Set(),
  errorByKey: new Map(),
  attachedComments: [],

  loadComments: async (worktreeId, filePath, scope) => {
    const normalized = normalizeScope(scope)
    const key = diffCommentFileKey(worktreeId, filePath, normalized)
    set((state) => {
      const loadingKeys = new Set(state.loadingKeys)
      loadingKeys.add(key)
      const errorByKey = new Map(state.errorByKey)
      errorByKey.set(key, null)
      return { loadingKeys, errorByKey }
    })

    try {
      const comments = await window.db.diffComment.list(worktreeId, {
        filePath,
        staged: normalized.staged,
        compareBranch: normalized.compareBranch
      })
      set((state) => {
        const commentsByFile = new Map(state.commentsByFile)
        commentsByFile.set(key, sortComments(comments))
        const loadingKeys = new Set(state.loadingKeys)
        loadingKeys.delete(key)
        return { commentsByFile, loadingKeys }
      })
    } catch (error) {
      set((state) => {
        const loadingKeys = new Set(state.loadingKeys)
        loadingKeys.delete(key)
        const errorByKey = new Map(state.errorByKey)
        errorByKey.set(key, error instanceof Error ? error.message : String(error))
        return { loadingKeys, errorByKey }
      })
    }
  },

  loadWorktreeComments: async (worktreeId) => {
    const key = `${worktreeId}\u0000*`
    set((state) => {
      const loadingKeys = new Set(state.loadingKeys)
      loadingKeys.add(key)
      const errorByKey = new Map(state.errorByKey)
      errorByKey.set(key, null)
      return { loadingKeys, errorByKey }
    })

    try {
      const comments = await window.db.diffComment.list(worktreeId)
      set((state) => {
        const worktreeComments = new Map(state.worktreeComments)
        worktreeComments.set(worktreeId, sortComments(comments))
        const commentsByFile = new Map(state.commentsByFile)
        const byFile = new Map<string, DiffComment[]>()
        for (const comment of comments) {
          const key = diffCommentKeyForComment(comment)
          const next = byFile.get(key) ?? []
          next.push(comment)
          byFile.set(key, next)
        }
        for (const [key, fileComments] of byFile) {
          commentsByFile.set(key, sortComments(fileComments))
        }
        const loadingKeys = new Set(state.loadingKeys)
        loadingKeys.delete(key)
        return { worktreeComments, commentsByFile, loadingKeys }
      })
    } catch (error) {
      set((state) => {
        const loadingKeys = new Set(state.loadingKeys)
        loadingKeys.delete(key)
        const errorByKey = new Map(state.errorByKey)
        errorByKey.set(key, error instanceof Error ? error.message : String(error))
        return { loadingKeys, errorByKey }
      })
    }
  },

  createComment: async (data) => {
    const comment = await window.db.diffComment.create(data)
    set((state) => {
      const commentsByFile = new Map(state.commentsByFile)
      const key = diffCommentKeyForComment(comment)
      commentsByFile.set(key, upsertCommentInArray(commentsByFile.get(key) ?? [], comment))

      const worktreeComments = new Map(state.worktreeComments)
      worktreeComments.set(
        comment.worktreeId,
        upsertCommentInArray(worktreeComments.get(comment.worktreeId) ?? [], comment)
      )
      return { commentsByFile, worktreeComments }
    })
    return comment
  },

  updateComment: async (id, data) => {
    const updated = await window.db.diffComment.update(id, data)
    if (!updated) return null

    set((state) => {
      const commentsByFile = new Map(state.commentsByFile)
      const key = diffCommentKeyForComment(updated)
      commentsByFile.set(key, upsertCommentInArray(commentsByFile.get(key) ?? [], updated))

      const worktreeComments = new Map(state.worktreeComments)
      worktreeComments.set(
        updated.worktreeId,
        upsertCommentInArray(worktreeComments.get(updated.worktreeId) ?? [], updated)
      )

      const attachedComments = state.attachedComments.map((comment) =>
        comment.id === updated.id ? updated : comment
      )

      return { commentsByFile, worktreeComments, attachedComments }
    })
    return updated
  },

  deleteComment: async (id) => {
    const deleted = await window.db.diffComment.delete(id)
    if (!deleted) return false

    set((state) => {
      const commentsByFile = new Map(state.commentsByFile)
      const worktreeComments = new Map(state.worktreeComments)

      for (const [key, comments] of commentsByFile) {
        if (comments.some((comment) => comment.id === id)) {
          commentsByFile.set(key, removeCommentFromArray(comments, id))
        }
      }
      for (const [worktreeId, comments] of worktreeComments) {
        if (comments.some((comment) => comment.id === id)) {
          worktreeComments.set(worktreeId, removeCommentFromArray(comments, id))
        }
      }

      return {
        commentsByFile,
        worktreeComments,
        attachedComments: state.attachedComments.filter((comment) => comment.id !== id)
      }
    })
    return true
  },

  attachComment: (comment) => {
    set((state) => {
      if (state.attachedComments.some((item) => item.id === comment.id)) return state
      return { attachedComments: [...state.attachedComments, comment] }
    })
  },

  removeAttachment: (id) => {
    set((state) => ({
      attachedComments: state.attachedComments.filter((comment) => comment.id !== id)
    }))
  },

  clearAttachments: () => {
    set({ attachedComments: [] })
  },

  getFileComments: (worktreeId, filePath, scope) => {
    return get().commentsByFile.get(diffCommentFileKey(worktreeId, filePath, scope)) ?? []
  }
}))

export type { DiffComment, DiffCommentStoreState }
