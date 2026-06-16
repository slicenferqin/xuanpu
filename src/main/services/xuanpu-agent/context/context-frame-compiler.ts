import { createHash } from 'node:crypto'

import type { FieldEpisodeRawRef } from '../../../field/episode-block-repository'
import type { FieldEpisodeBlockRecord } from '../../../field/episode-block-repository'
import type { XuanpuPiPromptMessage } from '../context-transform'
import {
  packContext,
  type ContextPackerInput,
  type ContextPackerOutput,
  type RetrievedEpisodeEntry
} from './context-packer'
import { stableStringify } from '../turn/provider-request-builder'

export interface ContextFrameCompilerScope {
  taskRunId?: string | null
  userRoundId?: string | null
  contextSegmentId?: string | null
  contextSegmentOrdinal?: number | null
}

export interface ContextFrameCompilerInput extends ContextPackerInput {
  scope?: ContextFrameCompilerScope
  buildReason?: ContextFrameBuildReason
}

export type ContextFrameBuildReason =
  | 'user-round-start'
  | 'segment-boundary'
  | 'gateway-compact'
  | 'checkpoint-resume'
  | 'explicit-refresh'
  | 'compat'

export interface ContextFrameZoneLedger {
  anchorTokens: number
  taskStateTokens: number
  taskStateIncluded: boolean
  currentFieldTokens: number
  currentFieldIncluded: boolean
  frozenEpisodeIds: string[]
  frozenEpisodeDroppedCount: number
  retrievedEpisodeIds: string[]
  retrievedEpisodeDroppedCount: number
  retrievedEpisodeReasons: string[]
  workingSetIncludedMessageIds: string[]
  workingSetDroppedMessageIds: string[]
  workingSetDedupedCount: number
  currentRequestTokens: number
}

export interface ContextFrameRawRefLedger {
  frozenEpisodeRawRefs: FieldEpisodeRawRef[]
  retrievedEpisodeRawRefs: FieldEpisodeRawRef[]
  workingSetRawRefs: FieldEpisodeRawRef[]
}

export interface ContextFrame {
  schemaVersion: 1
  frameId: string
  buildReason: ContextFrameBuildReason
  scope: Required<ContextFrameCompilerScope>
  providerContextMessages: XuanpuPiPromptMessage[]
  providerPromptMessage: XuanpuPiPromptMessage
  includedRetrievedEpisodes: RetrievedEpisodeEntry[]
  decisions: ContextPackerOutput['decisions'] & {
    contextTransform: 'context-frame-compiler'
    frameId: string
    buildReason: ContextFrameBuildReason
    providerMessageCount: number
    rawRefCount: number
    ledger: ContextFrameZoneLedger
  }
  ledger: {
    zones: ContextFrameZoneLedger
    rawRefs: ContextFrameRawRefLedger
  }
}

export class ContextFrameCompiler {
  compile(input: ContextFrameCompilerInput): ContextFrame {
    const packed = packContext(input)
    const scope = normalizeScope(input.scope)
    const buildReason = input.buildReason ?? 'compat'
    const zoneLedger = buildZoneLedger(packed, input)
    const rawRefs = buildRawRefLedger(packed, input)
    const rawRefCount =
      rawRefs.frozenEpisodeRawRefs.length +
      rawRefs.retrievedEpisodeRawRefs.length +
      rawRefs.workingSetRawRefs.length
    const frameId = computeContextFrameId({
      prefixHash: packed.decisions.actualPrefixHash,
      promptMessage: packed.providerPromptMessage,
      scope,
      buildReason
    })
    const decisions: ContextFrame['decisions'] = {
      ...packed.decisions,
      contextTransform: 'context-frame-compiler',
      frameId,
      buildReason,
      providerMessageCount: packed.providerContextMessages.length + 1,
      rawRefCount,
      ledger: zoneLedger
    }

    return {
      schemaVersion: 1,
      frameId,
      buildReason,
      scope,
      providerContextMessages: packed.providerContextMessages,
      providerPromptMessage: packed.providerPromptMessage,
      includedRetrievedEpisodes: packed.includedRetrievedEpisodes,
      decisions,
      ledger: {
        zones: zoneLedger,
        rawRefs
      }
    }
  }
}

function normalizeScope(scope?: ContextFrameCompilerScope): Required<ContextFrameCompilerScope> {
  return {
    taskRunId: scope?.taskRunId ?? null,
    userRoundId: scope?.userRoundId ?? null,
    contextSegmentId: scope?.contextSegmentId ?? null,
    contextSegmentOrdinal: scope?.contextSegmentOrdinal ?? null
  }
}

function buildZoneLedger(
  output: ContextPackerOutput,
  input: ContextFrameCompilerInput
): ContextFrameZoneLedger {
  const zones = output.decisions.zones
  return {
    anchorTokens: zones.anchor.tokens,
    taskStateTokens: zones.taskState.tokens,
    taskStateIncluded: zones.taskState.included,
    currentFieldTokens: zones.currentField.tokens,
    currentFieldIncluded: zones.currentField.included,
    frozenEpisodeIds: sortEpisodesForPacking(input.frozenEpisodes)
      .slice(0, zones.frozenEpisodes.count)
      .map((episode) => episode.id),
    frozenEpisodeDroppedCount: zones.frozenEpisodes.dropped,
    retrievedEpisodeIds: zones.retrievedEpisodes.includedIds,
    retrievedEpisodeDroppedCount: zones.retrievedEpisodes.dropped,
    retrievedEpisodeReasons: zones.retrievedEpisodes.reasons,
    workingSetIncludedMessageIds: zones.workingSet.includedMessageIds,
    workingSetDroppedMessageIds: zones.workingSet.droppedMessageIds,
    workingSetDedupedCount: zones.workingSet.dedupedCount,
    currentRequestTokens: zones.currentRequest.tokens
  }
}

function buildRawRefLedger(
  output: ContextPackerOutput,
  input: ContextFrameCompilerInput
): ContextFrameRawRefLedger {
  const includedWorkingSet = new Set(output.decisions.zones.workingSet.includedMessageIds)
  return {
    frozenEpisodeRawRefs: sortEpisodesForPacking(input.frozenEpisodes)
      .slice(0, output.decisions.zones.frozenEpisodes.count)
      .flatMap((episode) => episode.rawRefs),
    retrievedEpisodeRawRefs: output.includedRetrievedEpisodes.flatMap(
      (entry) => entry.episode.rawRefs
    ),
    workingSetRawRefs: input.workingSet
      .filter((turn) => includedWorkingSet.has(turn.messageId))
      .map((turn) => ({
        type: 'session_message',
        id: turn.messageId,
        role: turn.role,
        at: turn.createdAt
      }))
  }
}

function sortEpisodesForPacking(episodes: FieldEpisodeBlockRecord[]): FieldEpisodeBlockRecord[] {
  return [...episodes].sort((a, b) => b.createdAt - a.createdAt)
}

function computeContextFrameId(input: {
  prefixHash: string
  promptMessage: XuanpuPiPromptMessage
  scope: Required<ContextFrameCompilerScope>
  buildReason: ContextFrameBuildReason
}): string {
  const payload = stableStringify({
    prefixHash: input.prefixHash,
    promptMessage: input.promptMessage,
    scope: input.scope,
    buildReason: input.buildReason
  })
  return createHash('sha256').update(payload).digest('hex')
}
