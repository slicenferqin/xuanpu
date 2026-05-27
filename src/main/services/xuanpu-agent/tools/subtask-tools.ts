/**
 * Subtask delegation tools for xuanpu-agent M6.
 *
 * Provides a controlled way for the agent to delegate subtasks that appear
 * in the timeline as visible, trackable units.
 *
 * Tools:
 *   xfp_delegate_subtask — delegate a subtask to a child agent
 */
import type { AgentTool, AgentToolResult } from '@oh-my-pi/pi-agent-core'

type JsonSchema<T> = Record<string, unknown> & { static: T }

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

function textResult(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] }
}

function generateId(): string {
  return `subtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ───────────────────────────────────────────────────────────────────────────
// Subtask tracking (in-memory for current session)
// ───────────────────────────────────────────────────────────────────────────

interface SubtaskState {
  id: string
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

const activeSubtasks = new Map<string, SubtaskState>()

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
    'Delegate a subtask to a child agent. The subtask appears in the timeline and can be tracked independently.',
  parameters: xfpDelegateSubtaskParams,
  intent: 'omit',
  concurrency: 'shared',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const record = ctx as Record<string, unknown> | undefined
    const sessionId =
      record && typeof record.sessionId === 'string' ? record.sessionId : 'unknown'

    const subtask: SubtaskState = {
      id: generateId(),
      sessionID: sessionId,
      prompt: params.prompt,
      description: params.description,
      agent: params.agent ?? 'general',
      status: 'running',
      startedAt: Date.now()
    }

    activeSubtasks.set(subtask.id, subtask)

    // For now, we simulate subtask execution by immediately completing it
    // In a real implementation, this would spawn a child agent process
    const result = simulateSubtaskExecution(subtask)

    subtask.status = 'completed'
    subtask.completedAt = Date.now()
    subtask.result = result

    const lines: string[] = [
      `## Subtask Delegated: ${subtask.description}`,
      `**ID:** ${subtask.id}`,
      `**Agent:** ${subtask.agent}`,
      `**Status:** completed`,
      `\n**Result:**\n${result}`
    ]

    return textResult(lines.join('\n'))
  }
}

function simulateSubtaskExecution(subtask: SubtaskState): string {
  // This is a placeholder implementation
  // In production, this would:
  // 1. Create a child agent session
  // 2. Send the prompt to the child agent
  // 3. Collect the response
  // 4. Return the result

  return `Subtask "${subtask.description}" completed successfully.\n\nThis is a simulated result. In production, this would be the actual output from a child agent processing the prompt:\n\n"${subtask.prompt.slice(0, 200)}${subtask.prompt.length > 200 ? '...' : ''}"`
}

// ───────────────────────────────────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────────────────────────────────

export const SUBTASK_TOOLS: AgentTool[] = [xfpDelegateSubtaskTool]
