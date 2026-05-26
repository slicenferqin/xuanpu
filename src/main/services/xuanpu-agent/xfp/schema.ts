/**
 * XFP v1 — Zod runtime schema mirroring `./types.ts`.
 *
 * The TypeScript interfaces are the design surface; the Zod schemas are the
 * runtime contract. Use these at every trust boundary:
 *   - when reading a packet from disk / SQLite
 *   - when receiving a packet over IPC
 *   - when ingesting a packet from a CLI process
 *
 * Inferred types (e.g. `z.infer<typeof XfpFieldPacketSchema>`) MUST stay
 * structurally compatible with the interfaces in `./types.ts` — keep them in
 * lock-step. If you add a field to the interface, add it to the schema.
 */

import { z } from 'zod'

import type { MinimalFieldPacket, XfpFieldPacket, XfpRawRefKind } from './types'

// ---------------------------------------------------------------------------
// Raw refs
// ---------------------------------------------------------------------------

const xfpRawRefKindSchema = z.enum([
  'file',
  'command-trace',
  'terminal-output',
  'git-object',
  'message',
  'episode',
  'memory-page',
  'checkpoint'
]) satisfies z.ZodType<XfpRawRefKind>

export const XfpRawRefSchema = z.object({
  kind: xfpRawRefKindSchema,
  id: z.string().min(1),
  excerpt: z.string().optional(),
  byteRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
})

const rawRefsArraySchema = z.array(XfpRawRefSchema)

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const XfpIdentitySectionSchema = z.object({
  packetId: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  sessionId: z.string().min(1).nullable()
})

// ---------------------------------------------------------------------------
// Git state — re-validates GitFileStatus shape inline (the shared type lives
// in src/shared/types/git.ts; we mirror it here instead of importing zod
// from there, since the shared module is .ts-types-only by convention).
// ---------------------------------------------------------------------------

const gitStatusCodeSchema = z.enum(['M', 'A', 'D', '?', 'C', ''])

const gitFileStatusSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  status: gitStatusCodeSchema,
  staged: z.boolean()
})

export const XfpGitStateSchema = z.object({
  branchName: z.string().min(1),
  headShort: z.string().min(1).max(40),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirty: z.boolean(),
  dirtyFiles: z.array(gitFileStatusSchema).max(20),
  dirtyTruncated: z.boolean(),
  rawRefs: rawRefsArraySchema
})

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

export const XfpFocusFileSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1)
})

export const XfpFocusSelectionSchema = z.object({
  path: z.string().min(1),
  fromLine: z.number().int().positive(),
  toLine: z.number().int().positive(),
  length: z.number().int().nonnegative()
})

export const XfpFocusSectionSchema = z.object({
  file: XfpFocusFileSchema.nullable(),
  selection: XfpFocusSelectionSchema.nullable(),
  rawRefs: rawRefsArraySchema
})

// ---------------------------------------------------------------------------
// Terminal summary
// ---------------------------------------------------------------------------

export const XfpTerminalSummarySchema = z.object({
  command: z.string(),
  commandAt: z.number().int().nonnegative(),
  shell: z.string().nullable(),
  cwd: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  outputHead: z.string(),
  outputTail: z.string(),
  truncated: z.boolean(),
  totalBytes: z.number().int().nonnegative(),
  rawRefs: rawRefsArraySchema
})

// ---------------------------------------------------------------------------
// Test summary
// ---------------------------------------------------------------------------

const xfpTestStatusSchema = z.enum(['pass', 'fail', 'mixed', 'unknown'])

export const XfpTestSummarySchema = z.object({
  status: xfpTestStatusSchema,
  runner: z.string().nullable(),
  passed: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
  skipped: z.number().int().nonnegative().nullable(),
  failureExcerpts: z.array(z.string()).max(10),
  rawRefs: rawRefsArraySchema
})

// ---------------------------------------------------------------------------
// Command trace
// ---------------------------------------------------------------------------

export const XfpCommandTraceEntrySchema = z.object({
  traceId: z.string().min(1),
  command: z.string(),
  capturedAt: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  compressionRatio: z.number().min(0).max(1).nullable(),
  summary: z.string(),
  rawRefs: rawRefsArraySchema
})

export const XfpCommandTraceSectionSchema = z.object({
  entries: z.array(XfpCommandTraceEntrySchema),
  totalAvailable: z.number().int().nonnegative()
})

// ---------------------------------------------------------------------------
// Retrieved memory
// ---------------------------------------------------------------------------

export const XfpRetrievedMemoryEntrySchema = z.object({
  memoryPageId: z.string().min(1),
  scope: z.enum(['user', 'project', 'worktree', 'session', 'episode', 'command']),
  scopeId: z.string().min(1),
  kind: z.enum(['fact', 'decision', 'assumption', 'constraint']),
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  retrievalReason: z.string().min(1),
  rawRefs: rawRefsArraySchema.min(1)
})

export const XfpRetrievedMemorySectionSchema = z.object({
  entries: z.array(XfpRetrievedMemoryEntrySchema),
  totalAvailable: z.number().int().nonnegative()
})

// ---------------------------------------------------------------------------
// Task goal
// ---------------------------------------------------------------------------

export const XfpTaskGoalSchema = z.object({
  objective: z.string().min(1),
  source: z.enum(['user-message', 'checkpoint', 'heuristic']),
  successCriteria: z.string().nullable(),
  rawRefs: rawRefsArraySchema
})

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

const xfpBudgetProfileSchema = z.enum(['focused', 'balanced', 'extended'])

export const XfpBudgetSectionSchema = z.object({
  profile: xfpBudgetProfileSchema,
  budgetTokens: z.number().int().positive(),
  estimatedTokens: z.number().int().nonnegative(),
  omittedSectionNames: z.array(z.string()),
  compressionRatio: z.number().min(0).max(1).nullable()
})

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

export const XfpAnchorSectionSchema = z.object({
  pinnedFactsMarkdown: z.string().nullable(),
  worktreeNotesMarkdown: z.string().nullable(),
  updatedAt: z.number().int().nonnegative().nullable(),
  rawRefs: rawRefsArraySchema
})

// ---------------------------------------------------------------------------
// Top-level packets
// ---------------------------------------------------------------------------

export const XfpFieldPacketSchema = z.object({
  version: z.literal(1),
  identity: XfpIdentitySectionSchema,
  anchor: XfpAnchorSectionSchema.nullable(),
  gitState: XfpGitStateSchema,
  focus: XfpFocusSectionSchema,
  terminal: XfpTerminalSummarySchema.nullable(),
  tests: XfpTestSummarySchema.nullable(),
  commandTrace: XfpCommandTraceSectionSchema.nullable(),
  retrievedMemory: XfpRetrievedMemorySectionSchema.nullable(),
  currentGoal: XfpTaskGoalSchema,
  budget: XfpBudgetSectionSchema
}) satisfies z.ZodType<XfpFieldPacket>

export const MinimalFieldPacketSchema = z.object({
  version: z.literal(1),
  identity: z.object({
    packetId: z.string().min(1),
    capturedAt: z.number().int().nonnegative()
  }),
  cwd: z.string().min(1),
  stdin: z
    .object({
      path: z.string().nullable(),
      excerpt: z.string(),
      rawRefs: rawRefsArraySchema
    })
    .nullable(),
  gitState: XfpGitStateSchema.nullable(),
  currentGoal: XfpTaskGoalSchema
}) satisfies z.ZodType<MinimalFieldPacket>

// ---------------------------------------------------------------------------
// Narrowing helper — XfpFieldPacket -> MinimalFieldPacket
// ---------------------------------------------------------------------------

/**
 * Convert a full XFP packet to its CLI-mode subset.
 *
 * The caller MUST supply `cwd` because the full packet identifies the
 * worktree by id, not by absolute path. `stdin` is optional.
 *
 * @invariant the returned packet validates against MinimalFieldPacketSchema.
 */
export function narrowToMinimal(
  packet: XfpFieldPacket,
  options: {
    cwd: string
    stdin?: {
      path: string | null
      excerpt: string
      rawRefs: XfpFieldPacket['focus']['rawRefs']
    } | null
  }
): MinimalFieldPacket {
  return {
    version: 1,
    identity: {
      packetId: packet.identity.packetId,
      capturedAt: packet.identity.capturedAt
    },
    cwd: options.cwd,
    stdin: options.stdin ?? null,
    gitState: packet.gitState,
    currentGoal: packet.currentGoal
  }
}
