/**
 * Model-based episode summarizer for xuanpu-agent M7.
 *
 * Replaces rule-based regex extraction with a lightweight model call
 * that produces structured episode data (summary, key facts, constraints,
 * files, commands, failures). Falls back to rule-based on any failure.
 */
import type {
  FieldEpisodeBlockCreate,
  FieldEpisodeBlockConfidence,
  FieldEpisodeTurnInput
} from '../../../field/episode-block-repository'
import {
  buildRuleBasedEpisodeFromTurns
} from '../../../field/episode-block-repository'
import type { CompactionModelResolution } from './compaction-model'
import { loadPiAiModule } from '../pi-agent-core-loader'

let _completeSimple:
  | ((
      model: unknown,
      context: unknown,
      options?: unknown
    ) => Promise<{ content: { type: string; text?: string }[] }>)
  | null = null

async function ensurePiAi(): Promise<void> {
  if (_completeSimple) return
  const piAi = await loadPiAiModule()
  const fn = piAi.completeSimple as typeof _completeSimple | undefined
  if (!fn) {
    throw new Error('@oh-my-pi/pi-ai completeSimple is not available')
  }
  _completeSimple = fn
}

// ─────────────────────────────────────────────────────────────────────────────
// Zod-like validation (lightweight, no zod dependency at runtime)
// ─────────────────────────────────────────────────────────────────────────────

interface EpisodeModelOutput {
  summary: string
  keyFacts: string[]
  constraints: string[]
  files: string[]
  commands: string[]
  failures: string[]
}

function parseEpisodeModelOutput(raw: string): EpisodeModelOutput | null {
  // Extract JSON from possible markdown code fence
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, raw]
  const jsonStr = jsonMatch[1]?.trim()
  if (!jsonStr) return null

  try {
    const parsed = JSON.parse(jsonStr)
    if (typeof parsed !== 'object' || parsed === null) return null
    if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) return null

    return {
      summary: parsed.summary.trim(),
      keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.filter(isNonEmptyString) : [],
      constraints: Array.isArray(parsed.constraints)
        ? parsed.constraints.filter(isNonEmptyString)
        : [],
      files: Array.isArray(parsed.files) ? parsed.files.filter(isNonEmptyString) : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands.filter(isNonEmptyString) : [],
      failures: Array.isArray(parsed.failures) ? parsed.failures.filter(isNonEmptyString) : []
    }
  } catch {
    return null
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

function buildSummarizePrompt(turns: FieldEpisodeTurnInput[]): string {
  const conversation = turns
    .map((t) => `[${t.role}]\n${t.content}`)
    .join('\n\n---\n\n')

  return [
    'You are a conversation summarizer. Analyze the following conversation turns',
    'and produce a structured JSON summary. Focus on:',
    '- What was discussed and decided',
    '- Key facts, constraints, and technical details mentioned',
    '- Files referenced or modified',
    '- Commands run or suggested',
    '- Failures, errors, or blockers encountered',
    '',
    'Respond with ONLY a JSON object (no markdown fence, no explanation):',
    '{',
    '  "summary": "2-3 sentence overview of what happened",',
    '  "keyFacts": ["fact 1", "fact 2"],',
    '  "constraints": ["constraint 1"],',
    '  "files": ["path/to/file.ts"],',
    '  "commands": ["git status", "pnpm test"],',
    '  "failures": ["error description"]',
    '}',
    '',
    '--- CONVERSATION ---',
    conversation
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export interface SummarizeEpisodeInput {
  worktreeId: string
  sessionId?: string | null
  title?: string
  turns: FieldEpisodeTurnInput[]
  resolution: CompactionModelResolution
}

export async function summarizeEpisode(
  input: SummarizeEpisodeInput
): Promise<FieldEpisodeBlockCreate> {
  const { turns, resolution, ...rest } = input

  // Rule-based fallback: no model available
  if (resolution.kind === 'rule-based' || !resolution.model) {
    return {
      ...buildRuleBasedEpisodeFromTurns({ ...rest, turns }),
      metadata: {
        compactorKind: 'rule-based',
        fallbackReason: resolution.kind === 'rule-based'
          ? 'no-model-configured'
          : 'model-unavailable',
        degradedReason: resolution.degradedReason ?? null
      }
    }
  }

  try {
    await ensurePiAi()

    const prompt = buildSummarizePrompt(turns)
    const now = Date.now()

    const result = await _completeSimple!(
      resolution.model,
      {
        messages: [
          {
            role: 'user',
            content: prompt,
            timestamp: now
          }
        ]
      },
      resolution.resolvedApiKey ? { apiKey: resolution.resolvedApiKey } : undefined
    )

    const textParts = result.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('')

    const parsed = parseEpisodeModelOutput(textParts)
    if (!parsed) {
      // Model returned unparseable output — fall back to rule-based
      return {
        ...buildRuleBasedEpisodeFromTurns({ ...rest, turns }),
        metadata: {
          compactorKind: 'rule-based',
          providerId: resolution.modelRef?.providerID ?? null,
          modelId: resolution.modelRef?.modelID ?? null,
          fallbackReason: 'model-output-unparseable',
          degradedReason: resolution.degradedReason ?? null
        }
      }
    }

    const rawRefs = turns.map((t) => ({
      type: 'session_message' as const,
      id: t.messageId,
      role: t.role,
      at: t.createdAt ?? null
    }))

    const summaryMarkdown = [
      `## ${rest.title || 'Conversation Episode'}`,
      '',
      parsed.summary,
      parsed.constraints.length
        ? ['', '### Constraints', ...parsed.constraints.map((c) => `- ${c}`)]
        : '',
      parsed.failures.length
        ? ['', '### Failures', ...parsed.failures.map((f) => `- ${f}`)]
        : ''
    ]
      .flat()
      .filter((line) => line !== '')
      .join('\n')

    return {
      worktreeId: rest.worktreeId,
      sessionId: rest.sessionId ?? null,
      sourceMessageIdStart: turns.at(0)?.messageId ?? null,
      sourceMessageIdEnd: turns.at(-1)?.messageId ?? null,
      kind: 'turns',
      title: rest.title ?? 'Conversation Episode',
      summaryMarkdown,
      keyFacts: parsed.keyFacts,
      constraints: parsed.constraints,
      files: parsed.files,
      commands: parsed.commands,
      failures: parsed.failures,
      rawRefs,
      confidence: 'high' as FieldEpisodeBlockConfidence,
      metadata: {
        compactorKind: 'model',
        providerId: resolution.modelRef?.providerID ?? null,
        modelId: resolution.modelRef?.modelID ?? null,
        promptVersion: 'v1',
        degradedReason: resolution.degradedReason ?? null
      }
    }
  } catch {
    // Any model error — fall back to rule-based
    return {
      ...buildRuleBasedEpisodeFromTurns({ ...rest, turns }),
      metadata: {
        compactorKind: 'rule-based',
        providerId: resolution.modelRef?.providerID ?? null,
        modelId: resolution.modelRef?.modelID ?? null,
        fallbackReason: 'model-call-error',
        degradedReason: resolution.degradedReason ?? null
      }
    }
  }
}
