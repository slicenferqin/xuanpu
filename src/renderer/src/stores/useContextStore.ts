import { create } from 'zustand'
import { getModelAliases, resolveRuntimeModelId } from '@shared/usage/models'

export interface TokenInfo {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface SessionModelRef {
  providerID: string
  modelID: string
}

export interface ContextUsageCategory {
  name: string
  tokens: number
  color?: string
  isDeferred?: boolean
}

export interface SessionContextSnapshot {
  usedTokens: number
  maxTokens: number
  rawMaxTokens?: number
  percent: number | null
  categories?: ContextUsageCategory[]
  model?: SessionModelRef
  source: 'runtime'
  isRefreshing: boolean
  updatedAt: number
}

export interface SessionContextUsage {
  used: number
  limit?: number
  percent: number | null
  tokens: TokenInfo
  cost: number
  model?: SessionModelRef
  categories?: ContextUsageCategory[]
  rawMaxTokens?: number
  source: 'runtime' | 'snapshot'
  isRefreshing: boolean
}

export function getModelLimitKey(modelID: string, providerID?: string): string {
  return `${providerID ?? '*'}::${modelID}`
}

const EMPTY_TOKENS: TokenInfo = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0
}

function resolveModelLimit(
  modelLimits: Record<string, number>,
  model?: SessionModelRef
): number | undefined {
  if (!model) return undefined

  for (const alias of getModelAliases(model.modelID)) {
    const exact = modelLimits[getModelLimitKey(alias, model.providerID)]
    if (typeof exact === 'number' && exact > 0) return exact

    const wildcard = modelLimits[getModelLimitKey(alias)]
    if (typeof wildcard === 'number' && wildcard > 0) return wildcard
  }

  return undefined
}

function hasRuntimeSnapshot(snapshot?: SessionContextSnapshot): snapshot is SessionContextSnapshot {
  if (!snapshot) return false
  return (
    snapshot.usedTokens > 0 ||
    snapshot.maxTokens > 0 ||
    snapshot.percent !== null ||
    (snapshot.categories?.length ?? 0) > 0
  )
}

interface ContextState {
  // Per-session token snapshot (last assistant message with tokens > 0)
  tokensBySession: Record<string, TokenInfo>
  // Provider/model identity for each session token snapshot
  modelBySession: Record<string, SessionModelRef>
  // Per-session runtime context usage snapshot (exact current usage when available)
  contextSnapshotsBySession: Record<string, SessionContextSnapshot>
  // Per-session cumulative cost
  costBySession: Record<string, number>
  // Dedup keys for cost events already applied to a session
  costEventKeysBySession: Record<string, Record<string, true>>
  // Model context limits (providerID::modelID -> contextLimit)
  modelLimits: Record<string, number>
  // Actions
  setSessionTokens: (sessionId: string, tokens: TokenInfo, model?: SessionModelRef) => void
  setSessionContextSnapshot: (
    sessionId: string,
    snapshot: Omit<SessionContextSnapshot, 'source' | 'isRefreshing' | 'updatedAt'> & {
      source?: SessionContextSnapshot['source']
      isRefreshing?: boolean
    }
  ) => void
  setSessionContextRefreshing: (sessionId: string, refreshing: boolean) => void
  addSessionCost: (sessionId: string, cost: number) => void
  addSessionCostOnce: (sessionId: string, eventKey: string, cost: number) => void
  setSessionCost: (sessionId: string, cost: number) => void
  resetSessionTokens: (sessionId: string) => void
  clearSessionTokenSnapshot: (sessionId: string) => void
  setModelLimit: (modelId: string, limit: number, providerID?: string) => void
  // Derived
  getContextUsage: (
    sessionId: string,
    fallbackModelId: string,
    fallbackProviderId?: string
  ) => SessionContextUsage
}

export const useContextStore = create<ContextState>()((set, get) => ({
  tokensBySession: {},
  modelBySession: {},
  contextSnapshotsBySession: {},
  costBySession: {},
  costEventKeysBySession: {},
  modelLimits: {},

  setSessionTokens: (sessionId: string, tokens: TokenInfo, model?: SessionModelRef) => {
    set((state) => ({
      tokensBySession: {
        ...state.tokensBySession,
        [sessionId]: { ...tokens }
      },
      modelBySession: model
        ? {
            ...state.modelBySession,
            [sessionId]: model
          }
        : state.modelBySession
    }))
  },

  setSessionContextSnapshot: (sessionId, snapshot) => {
    set((state) => ({
      contextSnapshotsBySession: {
        ...state.contextSnapshotsBySession,
        [sessionId]: {
          usedTokens: snapshot.usedTokens,
          maxTokens: snapshot.maxTokens,
          ...(typeof snapshot.rawMaxTokens === 'number'
            ? { rawMaxTokens: snapshot.rawMaxTokens }
            : {}),
          percent: snapshot.percent,
          ...(snapshot.categories ? { categories: snapshot.categories } : {}),
          ...(snapshot.model ? { model: snapshot.model } : {}),
          source: snapshot.source ?? 'runtime',
          isRefreshing: snapshot.isRefreshing ?? false,
          updatedAt: Date.now()
        }
      }
    }))
  },

  setSessionContextRefreshing: (sessionId, refreshing) => {
    set((state) => {
      const existing = state.contextSnapshotsBySession[sessionId]
      if (!existing && !refreshing) return state

      return {
        contextSnapshotsBySession: {
          ...state.contextSnapshotsBySession,
          [sessionId]: existing
            ? {
                ...existing,
                isRefreshing: refreshing
              }
            : {
                usedTokens: 0,
                maxTokens: 0,
                percent: null,
                source: 'runtime',
                isRefreshing: true,
                updatedAt: Date.now()
              }
        }
      }
    })
  },

  addSessionCost: (sessionId: string, cost: number) => {
    set((state) => ({
      costBySession: {
        ...state.costBySession,
        [sessionId]: (state.costBySession[sessionId] ?? 0) + cost
      }
    }))
  },

  addSessionCostOnce: (sessionId: string, eventKey: string, cost: number) => {
    set((state) => {
      const existingKeys = state.costEventKeysBySession[sessionId] ?? {}
      if (existingKeys[eventKey]) {
        return state
      }

      return {
        costBySession: {
          ...state.costBySession,
          [sessionId]: (state.costBySession[sessionId] ?? 0) + cost
        },
        costEventKeysBySession: {
          ...state.costEventKeysBySession,
          [sessionId]: {
            ...existingKeys,
            [eventKey]: true
          }
        }
      }
    })
  },

  setSessionCost: (sessionId: string, cost: number) => {
    set((state) => ({
      costBySession: {
        ...state.costBySession,
        [sessionId]: cost
      }
    }))
  },

  resetSessionTokens: (sessionId: string) => {
    set((state) => {
      const { [sessionId]: _removedTokens, ...restTokens } = state.tokensBySession
      const { [sessionId]: _removedModel, ...restModel } = state.modelBySession
      const { [sessionId]: _removedContext, ...restContext } = state.contextSnapshotsBySession
      const { [sessionId]: _removedCost, ...restCost } = state.costBySession
      const { [sessionId]: _removedCostKeys, ...restCostKeys } = state.costEventKeysBySession
      void _removedTokens
      void _removedModel
      void _removedContext
      void _removedCost
      void _removedCostKeys
      return {
        tokensBySession: restTokens,
        modelBySession: restModel,
        contextSnapshotsBySession: restContext,
        costBySession: restCost,
        costEventKeysBySession: restCostKeys
      }
    })
  },

  clearSessionTokenSnapshot: (sessionId: string) => {
    set((state) => {
      const { [sessionId]: _removed, ...rest } = state.tokensBySession
      void _removed
      return { tokensBySession: rest }
    })
  },

  setModelLimit: (modelId: string, limit: number, providerID?: string) => {
    set((state) => ({
      modelLimits: {
        ...state.modelLimits,
        ...Object.fromEntries(
          getModelAliases(modelId).map((alias) => [getModelLimitKey(alias, providerID), limit])
        )
      }
    }))
  },

  getContextUsage: (sessionId: string, fallbackModelId: string, fallbackProviderId?: string) => {
    const state = get()
    const tokens = state.tokensBySession[sessionId] ?? { ...EMPTY_TOKENS }
    const fallbackRuntimeModelId = resolveRuntimeModelId(fallbackModelId, fallbackProviderId)
    const fallbackModel =
      fallbackRuntimeModelId && fallbackProviderId
        ? {
            providerID: fallbackProviderId,
            modelID: fallbackRuntimeModelId
          }
        : fallbackRuntimeModelId
          ? {
              providerID: fallbackProviderId ?? '*',
              modelID: fallbackRuntimeModelId
            }
          : undefined
    const tokenModel = state.modelBySession[sessionId] ?? fallbackModel
    const runtimeSnapshot = state.contextSnapshotsBySession[sessionId]
    const model = runtimeSnapshot?.model ?? tokenModel
    const derivedLimit = resolveModelLimit(state.modelLimits, model)
    const cost = state.costBySession[sessionId] ?? 0
    const derivedUsed = tokens.input + tokens.cacheRead + tokens.cacheWrite
    const derivedPercent =
      typeof derivedLimit === 'number' && derivedLimit > 0
        ? Math.round((derivedUsed / derivedLimit) * 100)
        : null

    if (hasRuntimeSnapshot(runtimeSnapshot)) {
      return {
        used: runtimeSnapshot.usedTokens,
        limit: runtimeSnapshot.maxTokens > 0 ? runtimeSnapshot.maxTokens : derivedLimit,
        percent: runtimeSnapshot.percent,
        tokens,
        cost,
        model,
        categories: runtimeSnapshot.categories,
        rawMaxTokens: runtimeSnapshot.rawMaxTokens,
        source: runtimeSnapshot.source,
        isRefreshing: runtimeSnapshot.isRefreshing
      }
    }

    return {
      used: derivedUsed,
      limit: derivedLimit,
      percent: derivedPercent,
      tokens,
      cost,
      model,
      source: 'snapshot',
      isRefreshing: runtimeSnapshot?.isRefreshing ?? false
    }
  }
}))
