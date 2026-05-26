import { describe, expect, it } from 'vitest'
import type {
  StreamingPart,
  TimelineMessage,
  ToolUseInfo
} from '../../src/shared/lib/timeline-types'
import { getTimelineCardTypeFromToolName } from '../../src/renderer/src/lib/session-timeline/card-type'
import { buildTimelineViewModel } from '../../src/renderer/src/lib/session-timeline/view-model'

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseInfo {
  return {
    id,
    name,
    input,
    status: 'running',
    startTime: 1
  }
}

function toolPart(id: string, name: string, input: Record<string, unknown> = {}): StreamingPart {
  return {
    type: 'tool_use',
    toolUse: toolUse(id, name, input)
  }
}

function message(
  id: string,
  role: TimelineMessage['role'],
  content: string,
  parts?: StreamingPart[],
  timestamp = '2026-05-26T00:00:00.000Z'
): TimelineMessage {
  return {
    id,
    role,
    content,
    timestamp,
    ...(parts ? { parts } : {})
  }
}

describe('session timeline view model', () => {
  it('maps durable and streaming tool names to the same card types', () => {
    const cases = [
      ['Bash', 'bash'],
      ['read_file', 'file-read'],
      ['edit', 'file-write'],
      ['grep', 'search'],
      ['dispatch_agent', 'sub-agent'],
      ['ExitPlanMode', 'plan'],
      ['AskUserQuestion', 'ask-user'],
      ['update_plan', 'todo'],
      ['task_create', 'todo'],
      ['unknown_tool', 'tool-call']
    ] as const

    for (const [toolName, expectedType] of cases) {
      expect(getTimelineCardTypeFromToolName(toolName)).toBe(expectedType)
    }

    const durableParts = cases.map(([toolName], index) => toolPart(`durable-${index}`, toolName))
    const streamingParts = cases.map(([toolName], index) =>
      toolPart(`streaming-${index}`, toolName)
    )

    const viewModel = buildTimelineViewModel({
      timelineMessages: [message('assistant-tools', 'assistant', '', durableParts)],
      streamingParts,
      isStreaming: true
    })

    expect(viewModel.nodes.map((node) => node.cardType)).toEqual(cases.map(([, type]) => type))
    expect(viewModel.streamingNodes.map((node) => node.cardType)).toEqual(
      cases.map(([, type]) => type)
    )
  })

  it('dedupes streaming tool copies already committed to durable messages', () => {
    const viewModel = buildTimelineViewModel({
      timelineMessages: [message('assistant-1', 'assistant', '', [toolPart('tool-1', 'bash')])],
      streamingParts: [toolPart('tool-1', 'bash'), toolPart('tool-2', 'read')],
      isStreaming: true
    })

    expect(viewModel.streamingNodes.map((node) => node.toolUse?.id)).toEqual(['tool-2'])
  })

  it('filters active-run durable text while preserving structured durable parts', () => {
    const viewModel = buildTimelineViewModel({
      timelineMessages: [
        message('user-1', 'user', 'Please inspect this', undefined, '2026-05-26T00:00:00.000Z'),
        message('assistant-old', 'assistant', 'old answer', undefined, '2026-05-26T00:00:00.500Z'),
        message(
          'assistant-live-text',
          'assistant',
          'live duplicate',
          undefined,
          '2026-05-26T00:00:02.000Z'
        ),
        message(
          'assistant-live-tool',
          'assistant',
          '',
          [toolPart('tool-live', 'bash')],
          '2026-05-26T00:00:02.000Z'
        )
      ],
      streamingParts: [],
      isStreaming: true,
      activeRunStartedAt: '2026-05-26T00:00:01.000Z'
    })

    expect(viewModel.nodes.map((node) => node.message.id)).toEqual([
      'user-1',
      'assistant-old',
      'assistant-live-tool'
    ])
    expect(viewModel.nodes.map((node) => node.cardType)).toEqual(['user-message', 'text', 'bash'])
  })

  it('drops stale streaming text and reasoning after streaming ends but keeps structured nodes', () => {
    const viewModel = buildTimelineViewModel({
      timelineMessages: [],
      streamingParts: [
        { type: 'text', text: 'already durable' },
        { type: 'reasoning', reasoning: 'already durable reasoning' },
        toolPart('tool-1', 'read')
      ],
      isStreaming: false
    })

    expect(viewModel.streamingNodes.map((node) => node.cardType)).toEqual(['file-read'])
  })

  it('groups nodes into rounds using user messages as boundaries', () => {
    const viewModel = buildTimelineViewModel({
      timelineMessages: [
        message('user-1', 'user', 'First prompt'),
        message('assistant-1', 'assistant', 'First answer'),
        message('user-2', 'user', 'Second prompt'),
        message('assistant-2', 'assistant', '', [toolPart('tool-1', 'bash')])
      ],
      streamingParts: [],
      isStreaming: false
    })

    expect(viewModel.preludeNodes).toHaveLength(0)
    expect(viewModel.rounds.map((round) => round.id)).toEqual(['user-1', 'user-2'])
    expect(viewModel.rounds[0].nodes.map((node) => node.cardType)).toEqual(['user-message', 'text'])
    expect(viewModel.rounds[1].nodes.map((node) => node.cardType)).toEqual(['user-message', 'bash'])
  })

  it('suppresses todo cards in both durable and streaming nodes when requested', () => {
    const viewModel = buildTimelineViewModel({
      timelineMessages: [
        message('assistant-1', 'assistant', '', [toolPart('durable-todo', 'update_plan')])
      ],
      streamingParts: [
        toolPart('streaming-todo', 'todo_write'),
        toolPart('streaming-bash', 'bash')
      ],
      isStreaming: true,
      suppressTodoCards: true
    })

    expect(viewModel.nodes).toHaveLength(0)
    expect(viewModel.streamingNodes.map((node) => node.cardType)).toEqual(['bash'])
  })
})
