/**
 * Subtask delegation tools for xuanpu-agent M6.
 *
 * Provides a controlled way for the agent to delegate subtasks that appear
 * in the timeline as visible, trackable units with running/completed/error
 * lifecycle.
 *
 * Tools:
 *   xfp_delegate_subtask — delegate a subtask to a child agent
 *
 * The tool returns structured details that the implementer uses to emit
 * dedicated subtask part events for timeline rendering. The childSessionId
 * allows future routing of child text/tool parts under the subtask.
 */
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'

type JsonSchema<T> = Record<string, unknown> & { static: T }

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

function textResult(
  text: string,
  details?: SubtaskResultDetails
): AgentToolResult<SubtaskResultDetails> {
  return { content: [{ type: 'text', text }], details }
}

function generateChildSessionId(): string {
  return `subtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ───────────────────────────────────────────────────────────────────────────
// Subtask tracking (in-memory for current session)
// ───────────────────────────────────────────────────────────────────────────

export interface SubtaskResultDetails {
  subtask: true
  childSessionId: string
  description: string
  agent: string
  status: 'running' | 'completed' | 'error'
  startedAt: number
  completedAt?: number
  error?: string
}

interface SubtaskState {
  id: string
  childSessionId: string
  sessionID: string
  prompt: string
  description: string
  agent: string
  status: 'running' | 'completed' | 'error'
  startedAt: number
  completedAt?: number
  result?: string
  error?: string
}

const SUBTASK_TTL_MS = 30 * 60 * 1000 // 30 minutes
const SUBTASK_MAX_ENTRIES = 100

const activeSubtasks = new Map<string, SubtaskState>()

function evictStaleSubtasks(): void {
  const now = Date.now()
  for (const [id, subtask] of activeSubtasks) {
    if (subtask.completedAt && now - subtask.completedAt > SUBTASK_TTL_MS) {
      activeSubtasks.delete(id)
    }
  }
  // Hard cap: evict oldest entries if over limit
  if (activeSubtasks.size > SUBTASK_MAX_ENTRIES) {
    const entries = [...activeSubtasks.entries()].sort(
      (a, b) => (a[1].completedAt ?? a[1].startedAt) - (b[1].completedAt ?? b[1].startedAt)
    )
    const toRemove = entries.slice(0, activeSubtasks.size - SUBTASK_MAX_ENTRIES)
    for (const [id] of toRemove) activeSubtasks.delete(id)
  }
}

export function getActiveSubtasks(): SubtaskState[] {
  return Array.from(activeSubtasks.values())
}

export function getSubtask(id: string): SubtaskState | undefined {
  return activeSubtasks.get(id)
}

// ───────────────────────────────────────────────────────────────────────────
// xfp_delegate_subtask
// ───────────────────────────────────────────────────────────────────────────

const xfpDelegateSubtaskParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: {
      type: 'string',
      description: 'Short description of what this subtask does (shown in timeline)'
    },
    prompt: {
      type: 'string',
      description: 'The full prompt/instructions for the subtask agent'
    },
    agent: {
      type: 'string',
      description: 'Agent type to delegate to (default: "general")'
    }
  },
  required: ['description', 'prompt']
} satisfies JsonSchema<{ description: string; prompt: string; agent?: string }>

export const xfpDelegateSubtaskTool: AgentTool<typeof xfpDelegateSubtaskParams> = {
  name: 'xfp_delegate_subtask',
  label: 'Delegate Subtask',
  description:
    'Delegate a subtask to a child agent. The subtask appears in the timeline with running/completed/error lifecycle. ' +
    'Use for independent, well-scoped tasks that can be tracked separately. ' +
    '[EXPERIMENTAL] Real child agent spawning is not yet implemented; the subtask executes a focused extraction pass.',
  parameters: xfpDelegateSubtaskParams,
  intent: 'omit',
  concurrency: 'exclusive',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    evictStaleSubtasks()
    const record = ctx as Record<string, unknown> | undefined
    const sessionId =
      record && typeof record.sessionId === 'string' ? record.sessionId : 'unknown'

    const childSessionId = generateChildSessionId()
    const startedAt = Date.now()

    const subtask: SubtaskState = {
      id: childSessionId,
      childSessionId,
      sessionID: sessionId,
      prompt: params.prompt,
      description: params.description,
      agent: params.agent ?? 'general',
      status: 'running',
      startedAt
    }

    activeSubtasks.set(subtask.id, subtask)

    try {
      const result = executeSubtaskPass(subtask)

      subtask.status = 'completed'
      subtask.completedAt = Date.now()
      subtask.result = result

      const lines: string[] = [
        `## Subtask Delegated: ${subtask.description}`,
        `**ID:** ${subtask.childSessionId}`,
        `**Agent:** ${subtask.agent}`,
        `**Status:** completed`,
        `\n**Result:**\n${result}`
      ]

      return textResult(lines.join('\n'), {
        subtask: true,
        childSessionId: subtask.childSessionId,
        description: subtask.description,
        agent: subtask.agent,
        status: 'completed',
        startedAt: subtask.startedAt,
        completedAt: subtask.completedAt
      })
    } catch (err) {
      subtask.status = 'error'
      subtask.completedAt = Date.now()
      subtask.error = err instanceof Error ? err.message : String(err)

      return textResult(
        `Subtask "${subtask.description}" failed: ${subtask.error}`,
        {
          subtask: true,
          childSessionId: subtask.childSessionId,
          description: subtask.description,
          agent: subtask.agent,
          status: 'error',
          startedAt: subtask.startedAt,
          completedAt: subtask.completedAt,
          error: subtask.error
        }
      )
    }
  }
}

/**
 * Focused extraction pass for the subtask prompt.
 * Analyzes the prompt to extract key entities, file references, and action items.
 * This is a structured placeholder that produces useful output until real
 * child agent spawning is implemented.
 */
function executeSubtaskPass(subtask: SubtaskState): string {
  const prompt = subtask.prompt
  const lines: string[] = []

  // Extract file references from the prompt
  const fileRefs = prompt.match(/[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml)\b/g)
  if (fileRefs && fileRefs.length > 0) {
    const unique = [...new Set(fileRefs)].slice(0, 10)
    lines.push(`Referenced files: ${unique.join(', ')}`)
  }

  // Extract action verbs
  const actionVerbs = prompt.match(
    /\b(?:fix|update|add|remove|refactor|implement|test|check|verify|create|delete|move|rename)\b/gi
  )
  if (actionVerbs && actionVerbs.length > 0) {
    const unique = [...new Set(actionVerbs.map((v) => v.toLowerCase()))].slice(0, 5)
    lines.push(`Actions: ${unique.join(', ')}`)
  }

  // Estimate complexity
  const wordCount = prompt.split(/\s+/).length
  const complexity = wordCount > 100 ? 'high' : wordCount > 30 ? 'medium' : 'low'
  lines.push(`Scope: ${complexity} (${wordCount} words in prompt)`)

  if (lines.length === 0) {
    lines.push('Subtask parsed. No specific entities extracted from prompt.')
  }

  return lines.join('\n')
}

// ───────────────────────────────────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────────────────────────────────

export const SUBTASK_TOOLS: AgentTool[] = [xfpDelegateSubtaskTool]
