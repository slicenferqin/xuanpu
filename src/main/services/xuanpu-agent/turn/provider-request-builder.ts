/**
 * Provider Request Builder (INV-TURN-3, INV-TURN-5).
 *
 * Builds a deterministic provider request snapshot from turn-scoped inputs.
 * The providerRequestHash is stable: identical inputs produce identical
 * hashes (volatile fields like createdAt are excluded).
 */
import { createHash } from 'node:crypto'
import type { XuanpuPiPromptMessage } from '../context-transform'
import type { XuanpuAgentModelRef } from '../model-config'
import type {
  ProviderSessionPolicy,
  XuanpuProviderRequestSnapshot,
  XuanpuToolDefinition,
  XuanpuTurnBudget
} from './turn-snapshot'

export interface BuildProviderRequestInput {
  turnId: string
  sessionId: string
  taskRunId?: string | null
  userRoundId?: string | null
  contextSegmentId?: string | null
  contextSegmentOrdinal?: number | null
  providerCallSeq?: number | null
  modelRef: XuanpuAgentModelRef
  systemPrompt: string[]
  contextMessages: XuanpuPiPromptMessage[]
  promptMessage: XuanpuPiPromptMessage
  tools: XuanpuToolDefinition[]
  providerSessionPolicy: ProviderSessionPolicy
  budget: XuanpuTurnBudget
  prefixHash?: string
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortKeys)
}

function sortKeys(_key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    )
  }
  return value
}

function imageDataSha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Strip volatile fields (timestamp) from prompt messages before hashing.
 * Ensures the hash is stable across runs with identical content.
 */
export function stripVolatileFields(messages: XuanpuPiPromptMessage[]): unknown[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content.map((part) => {
      if (part.type === 'text') {
        return {
          type: part.type,
          text: part.text
        }
      }
      return {
        type: part.type,
        mimeType: part.mimeType,
        dataSha256: imageDataSha256(part.data),
        byteLength: Buffer.byteLength(part.data, 'base64')
      }
    })
    // timestamp intentionally excluded
  }))
}

export function computeProviderRequestHash(input: BuildProviderRequestInput): string {
  const canonical = {
    systemPrompt: input.systemPrompt,
    contextMessages: stripVolatileFields(input.contextMessages),
    promptMessage: stripVolatileFields([input.promptMessage])[0],
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })),
    modelRef: {
      providerID: input.modelRef.providerID,
      modelID: input.modelRef.modelID,
      variant: input.modelRef.variant ?? null,
      reasoningEffort: input.modelRef.reasoningEffort ?? null,
      verbosity: input.modelRef.verbosity ?? null,
      providerOptions: input.modelRef.providerOptions ?? null
    },
    providerSessionPolicy: {
      mode: input.providerSessionPolicy.mode,
      providerSessionId: input.providerSessionPolicy.providerSessionId ?? null
    }
  }

  const payload = stableStringify(canonical)
  return createHash('sha256').update(payload).digest('hex')
}

export function buildProviderRequest(
  input: BuildProviderRequestInput
): XuanpuProviderRequestSnapshot {
  const providerRequestHash = computeProviderRequestHash(input)

  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    taskRunId: input.taskRunId ?? null,
    userRoundId: input.userRoundId ?? null,
    contextSegmentId: input.contextSegmentId ?? null,
    contextSegmentOrdinal: input.contextSegmentOrdinal ?? null,
    providerCallSeq: input.providerCallSeq ?? 0,
    providerRequestHash,
    prefixHash: input.prefixHash,
    systemPrompt: input.systemPrompt,
    contextMessages: input.contextMessages,
    promptMessage: input.promptMessage,
    toolsJson: stableStringify(input.tools),
    modelRef: input.modelRef,
    providerSessionPolicy: input.providerSessionPolicy,
    budget: input.budget
  }
}
