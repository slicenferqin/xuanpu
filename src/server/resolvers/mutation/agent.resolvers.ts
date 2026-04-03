/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Resolvers } from '../../__generated__/resolvers-types'
import { openCodeService } from '../../../main/services/opencode-service'
import {
  withRuntimeDispatch,
  withRuntimeDispatchByHiveSession,
  mapGraphQLRuntimeToInternal
} from '../helpers/runtime-dispatch'

export const agentMutationResolvers: Resolvers = {
  Mutation: {
    agentConnect: async (_parent, { worktreePath, hiveSessionId }, ctx) => {
      try {
        const result = await withRuntimeDispatchByHiveSession(
          ctx,
          hiveSessionId,
          () => openCodeService.connect(worktreePath, hiveSessionId),
          (impl) => impl.connect(worktreePath, hiveSessionId)
        )
        return { success: true, sessionId: result.sessionId }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentReconnect: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, runtimeSessionId, hiveSessionId } = input
        const result = await withRuntimeDispatch(
          ctx,
          runtimeSessionId,
          () => openCodeService.reconnect(worktreePath, runtimeSessionId, hiveSessionId),
          (impl) => impl.reconnect(worktreePath, runtimeSessionId, hiveSessionId)
        )
        return {
          success: result.success ?? true,
          sessionStatus: result.sessionStatus ?? null,
          revertMessageID: result.revertMessageID ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentDisconnect: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        await withRuntimeDispatch(
          ctx,
          sessionId,
          () => openCodeService.disconnect(worktreePath, sessionId),
          (impl) => impl.disconnect(worktreePath, sessionId)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentPrompt: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, runtimeSessionId, message, parts, model } = input
        const messageParts = parts ?? [{ type: 'text', text: message ?? '' }]
        await withRuntimeDispatch(
          ctx,
          runtimeSessionId,
          () => openCodeService.prompt(worktreePath, runtimeSessionId, messageParts, model),
          (impl) => impl.prompt(worktreePath, runtimeSessionId, messageParts, model)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentAbort: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withRuntimeDispatch(
          ctx,
          sessionId,
          () => openCodeService.abort(worktreePath, sessionId),
          (impl) => impl.abort(worktreePath, sessionId)
        )
        return { success: result }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentSetModel: async (_parent, { input }, ctx) => {
      try {
        const { providerID, modelID, variant, runtime } = input
        if (runtime && runtime !== 'opencode' && ctx.runtimeManager) {
          const internalId = mapGraphQLRuntimeToInternal(runtime)
          const impl = ctx.runtimeManager.getImplementer(internalId)
          impl.setSelectedModel({ providerID, modelID, variant: variant ?? undefined })
          return { success: true }
        }
        openCodeService.setSelectedModel({ providerID, modelID, variant: variant ?? undefined })
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentUndo: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withRuntimeDispatch(
          ctx,
          sessionId,
          () => openCodeService.undo(worktreePath, sessionId),
          (impl) => impl.undo(worktreePath, sessionId, '')
        )
        const r = result as Record<string, unknown>
        return {
          success: true,
          revertMessageID: (r.revertMessageID as string) ?? null,
          restoredPrompt: (r.restoredPrompt as string) ?? null,
          revertDiff: (r.revertDiff as string) ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentRedo: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withRuntimeDispatch(
          ctx,
          sessionId,
          () => openCodeService.redo(worktreePath, sessionId),
          (impl) => impl.redo(worktreePath, sessionId, '')
        )
        const r = result as Record<string, unknown>
        return {
          success: true,
          revertMessageID: (r.revertMessageID as string) ?? null
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentCommand: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, runtimeSessionId, command, args, model } = input
        await withRuntimeDispatch(
          ctx,
          runtimeSessionId,
          () => openCodeService.sendCommand(worktreePath, runtimeSessionId, command, args, model),
          (impl) => impl.sendCommand(worktreePath, runtimeSessionId, command, args)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentPermissionReply: async (_parent, { input }, ctx) => {
      try {
        const { requestId, reply, worktreePath, message } = input
        // Check non-OpenCode implementers for the pending permission request
        if (ctx.runtimeManager) {
          for (const runtimeId of ['claude-code', 'codex'] as const) {
            try {
              const impl = ctx.runtimeManager.getImplementer(runtimeId) as any
              if (impl.hasPendingApproval?.(requestId)) {
                await impl.permissionReply(
                  requestId,
                  reply as 'once' | 'always' | 'reject',
                  worktreePath ?? undefined
                )
                return { success: true }
              }
            } catch {
              // Implementer doesn't exist or doesn't have hasPendingApproval — skip
            }
          }
        }
        await openCodeService.permissionReply(
          requestId,
          reply as 'once' | 'always' | 'reject',
          worktreePath ?? undefined,
          message ?? undefined
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentQuestionReply: async (_parent, { input }, ctx) => {
      try {
        const { requestId, answers, worktreePath } = input
        if (ctx.runtimeManager) {
          for (const runtimeId of ['claude-code', 'codex'] as const) {
            try {
              const impl = ctx.runtimeManager.getImplementer(runtimeId) as any
              if (impl.hasPendingQuestion?.(requestId)) {
                await impl.questionReply(requestId, answers, worktreePath ?? undefined)
                return { success: true }
              }
            } catch {
              // Implementer doesn't exist or doesn't have hasPendingQuestion — skip
            }
          }
        }
        await openCodeService.questionReply(requestId, answers, worktreePath ?? undefined)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentQuestionReject: async (_parent, { requestId, worktreePath }, ctx) => {
      try {
        if (ctx.runtimeManager) {
          for (const runtimeId of ['claude-code', 'codex'] as const) {
            try {
              const impl = ctx.runtimeManager.getImplementer(runtimeId) as any
              if (impl.hasPendingQuestion?.(requestId)) {
                await impl.questionReject(requestId, worktreePath ?? undefined)
                return { success: true }
              }
            } catch {
              // Implementer doesn't exist or doesn't have hasPendingQuestion — skip
            }
          }
        }
        await openCodeService.questionReject(requestId, worktreePath ?? undefined)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentPlanApprove: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, hiveSessionId, requestId } = input
        if (ctx.runtimeManager) {
          const claudeImpl = ctx.runtimeManager.getImplementer('claude-code')
          if ('hasPendingPlan' in claudeImpl) {
            const typedImpl = claudeImpl as any
            if (
              (requestId && typedImpl.hasPendingPlan(requestId)) ||
              typedImpl.hasPendingPlanForSession(hiveSessionId)
            ) {
              await typedImpl.planApprove(worktreePath, hiveSessionId, requestId ?? undefined)
              return { success: true }
            }
          }
        }
        return { success: false, error: 'No pending plan found' }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentPlanReject: async (_parent, { input }, ctx) => {
      try {
        const { worktreePath, hiveSessionId, feedback, requestId } = input
        if (ctx.runtimeManager) {
          const claudeImpl = ctx.runtimeManager.getImplementer('claude-code')
          if ('hasPendingPlan' in claudeImpl) {
            const typedImpl = claudeImpl as any
            if (
              (requestId && typedImpl.hasPendingPlan(requestId)) ||
              typedImpl.hasPendingPlanForSession(hiveSessionId)
            ) {
              await typedImpl.planReject(
                worktreePath,
                hiveSessionId,
                feedback,
                requestId ?? undefined
              )
              return { success: true }
            }
          }
        }
        return { success: false, error: 'No pending plan found' }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentFork: async (_parent, { input }) => {
      try {
        const { worktreePath, runtimeSessionId, messageId } = input
        const result = await openCodeService.forkSession(
          worktreePath,
          runtimeSessionId,
          messageId ?? undefined
        )
        return { success: true, sessionId: result.sessionId }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentRenameSession: async (_parent, { input }, ctx) => {
      try {
        const { runtimeSessionId, title, worktreePath } = input
        await withRuntimeDispatch(
          ctx,
          runtimeSessionId,
          () => openCodeService.renameSession(runtimeSessionId, title, worktreePath ?? undefined),
          (impl) => impl.renameSession(worktreePath ?? '', runtimeSessionId, title)
        )
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  }
}
