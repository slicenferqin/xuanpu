/**
 * Zod schemas for all agent:* IPC channels.
 *
 * Each schema validates the args tuple as delivered by ipcMain.handle
 * (so `z.tuple([...])` even for single-payload handlers).
 *
 * Centralizing these here keeps handler bodies focused on dispatch and makes
 * it obvious what shape each channel expects. Renderer types (in preload
 * index.d.ts) remain the source of truth for the caller; these schemas are
 * the guard on the main side.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const runtimeIdSchema = z.enum(['opencode', 'claude-code', 'codex', 'terminal'])

const modelRefSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().optional()
})

// ---------------------------------------------------------------------------
// Channel schemas (tuple of positional args)
// ---------------------------------------------------------------------------

export const connectSchema = z.tuple([z.string(), z.string()])
// [worktreePath, hiveSessionId]

export const reconnectSchema = z.tuple([z.string(), z.string(), z.string()])
// [worktreePath, runtimeSessionId, hiveSessionId]

export const disconnectSchema = z.tuple([z.string(), z.string()])
// [worktreePath, runtimeSessionId]

export const abortSchema = z.tuple([z.string(), z.string()])
// [worktreePath, runtimeSessionId]

export const messagesSchema = z.tuple([z.string(), z.string()])
// [worktreePath, runtimeSessionId]

// Prompt supports both positional and object-style call with varied shapes.
// Schema is intentionally permissive — the handler body unpacks args manually.
export const promptSchema = z.array(z.unknown())

export const modelsSchema = z.tuple([
  z.object({ runtimeId: runtimeIdSchema.optional() }).optional()
])

export const setModelSchema = z.tuple([
  z
    .object({
      providerID: z.string(),
      modelID: z.string(),
      variant: z.string().optional(),
      runtimeId: runtimeIdSchema.optional()
    })
    .nullable()
])

export const modelInfoSchema = z.tuple([
  z.object({
    worktreePath: z.string(),
    modelId: z.string(),
    runtimeId: runtimeIdSchema.optional()
  })
])

export const sessionInfoSchema = z.tuple([
  z.object({ worktreePath: z.string(), sessionId: z.string() })
])

export const commandsSchema = z.tuple([
  z.object({ worktreePath: z.string(), sessionId: z.string().optional() })
])

export const commandSchema = z.tuple([
  z.object({
    worktreePath: z.string(),
    sessionId: z.string(),
    command: z.string(),
    args: z.string(),
    model: modelRefSchema.optional()
  })
])

export const undoSchema = z.tuple([
  z.object({ worktreePath: z.string(), sessionId: z.string() })
])

export const redoSchema = undoSchema

export const questionReplySchema = z.tuple([
  z.object({
    requestId: z.string(),
    answers: z.array(z.array(z.string())),
    worktreePath: z.string().optional()
  })
])

export const questionRejectSchema = z.tuple([
  z.object({ requestId: z.string(), worktreePath: z.string().optional() })
])

export const permissionReplySchema = z.tuple([
  z.object({
    requestId: z.string(),
    reply: z.enum(['once', 'always', 'reject']),
    worktreePath: z.string().optional(),
    message: z.string().optional()
  })
])

export const permissionListSchema = z.tuple([
  z.object({ worktreePath: z.string().optional() })
])

export const renameSessionSchema = z.tuple([
  z.object({
    runtimeSessionId: z.string(),
    title: z.string(),
    worktreePath: z.string().optional()
  })
])

export const forkSchema = z.tuple([
  z.object({
    worktreePath: z.string(),
    sessionId: z.string(),
    messageId: z.string().optional()
  })
])

export const capabilitiesSchema = z.tuple([
  z.object({ sessionId: z.string().optional() })
])

export const planApproveSchema = z.tuple([
  z.object({
    worktreePath: z.string(),
    hiveSessionId: z.string(),
    requestId: z.string().optional()
  })
])

export const planRejectSchema = z.tuple([
  z.object({
    worktreePath: z.string(),
    hiveSessionId: z.string(),
    feedback: z.string(),
    requestId: z.string().optional()
  })
])

export const commandApprovalReplySchema = z.tuple([
  z.object({
    requestId: z.string(),
    approved: z.boolean(),
    remember: z.enum(['allow', 'block']).optional(),
    pattern: z.string().optional(),
    worktreePath: z.string().optional(),
    patterns: z.array(z.string()).optional()
  })
])
