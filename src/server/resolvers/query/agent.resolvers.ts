/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Resolvers } from '../../__generated__/resolvers-types'
import { openCodeService } from '../../../main/services/opencode-service'
import { withRuntimeDispatch, mapGraphQLRuntimeToInternal } from '../helpers/runtime-dispatch'

export const agentQueryResolvers: Resolvers = {
  Query: {
    agentMessages: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const messages = await withRuntimeDispatch(
          ctx,
          sessionId,
          () => openCodeService.getMessages(worktreePath, sessionId),
          (impl) => impl.getMessages(worktreePath, sessionId)
        )
        return { success: true, messages }
      } catch (error) {
        return {
          success: false,
          messages: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentSessionInfo: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        const result = await withRuntimeDispatch(
          ctx,
          sessionId,
          () => openCodeService.getSessionInfo(worktreePath, sessionId),
          (impl) => impl.getSessionInfo(worktreePath, sessionId)
        )
        return {
          success: true,
          revertMessageID: result.revertMessageID,
          revertDiff: result.revertDiff
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentModels: async (_parent, { runtime }, ctx) => {
      try {
        if (runtime && runtime !== 'opencode' && ctx.runtimeManager) {
          const internalId = mapGraphQLRuntimeToInternal(runtime)
          const impl = ctx.runtimeManager.getImplementer(internalId)
          const providers = await impl.getAvailableModels()
          return { success: true, providers }
        }
        const providers = await openCodeService.getAvailableModels()
        return { success: true, providers }
      } catch (error) {
        return {
          success: false,
          providers: {},
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentModelInfo: async (_parent, { worktreePath, modelId, runtime }, ctx) => {
      try {
        if (runtime && runtime !== 'opencode' && ctx.runtimeManager) {
          const internalId = mapGraphQLRuntimeToInternal(runtime)
          const impl = ctx.runtimeManager.getImplementer(internalId)
          const model = await impl.getModelInfo(worktreePath, modelId)
          if (!model) return { success: false, error: 'Model not found' }
          return { success: true, model }
        }
        const model = await openCodeService.getModelInfo(worktreePath, modelId)
        if (!model) return { success: false, error: 'Model not found' }
        return { success: true, model }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentCommands: async (_parent, { worktreePath, sessionId }, ctx) => {
      try {
        if (ctx.runtimeManager && ctx.db && sessionId) {
          const runtimeId = ctx.db.getRuntimeIdForSession(sessionId)
          if (runtimeId && runtimeId !== 'opencode' && runtimeId !== 'terminal') {
            const impl = ctx.runtimeManager.getImplementer(runtimeId)
            const commands = await impl.listCommands(worktreePath)
            return { success: true, commands: commands as any[] }
          }
        }
        const commands = await openCodeService.listCommands(worktreePath)
        return { success: true, commands: commands as any[] }
      } catch (error) {
        return {
          success: false,
          commands: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentCapabilities: async (_parent, { sessionId }, ctx) => {
      try {
        if (ctx.runtimeManager && ctx.db && sessionId) {
          const runtimeId = ctx.db.getRuntimeIdForSession(sessionId)
          if (runtimeId) {
            return { success: true, capabilities: ctx.runtimeManager.getCapabilities(runtimeId) }
          }
        }
        const defaultCaps = ctx.runtimeManager?.getCapabilities('opencode') ?? null
        return { success: true, capabilities: defaultCaps }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    },

    agentPermissionList: async (_parent, { worktreePath }, ctx) => {
      try {
        const permissions = await openCodeService.permissionList(worktreePath)
        const allPermissions = [...(permissions as any[])]

        // Also collect permissions from non-OpenCode implementers
        if (ctx.runtimeManager) {
          for (const runtimeId of ['claude-code', 'codex'] as const) {
            try {
              const impl = ctx.runtimeManager.getImplementer(runtimeId)
              const sdkPerms = await impl.permissionList(worktreePath)
              allPermissions.push(...(sdkPerms as any[]))
            } catch {
              // Implementer may not exist or may throw — skip
            }
          }
        }

        return { success: true, permissions: allPermissions }
      } catch (error) {
        return {
          success: false,
          permissions: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  }
}
