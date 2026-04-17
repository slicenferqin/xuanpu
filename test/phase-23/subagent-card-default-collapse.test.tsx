import { fireEvent, render, screen } from '@testing-library/react'
import { SubAgentCard } from '../../src/renderer/src/components/session-hq/cards/SubAgentCard'
import type { StreamingPart } from '../../src/shared/lib/timeline-types'

function makeSubtask(
  overrides: Partial<NonNullable<StreamingPart['subtask']>> = {}
): NonNullable<StreamingPart['subtask']> {
  return {
    id: 'subtask-1',
    sessionID: 'child-session-1',
    prompt: 'Inspect auth flow',
    description: 'Searching authentication patterns in codebase',
    agent: 'Explore',
    parts: [],
    status: 'running',
    ...overrides
  }
}

function makeToolPart(): StreamingPart {
  return {
    type: 'tool_use',
    toolUse: {
      id: 'tool-1',
      name: 'bash',
      input: { command: 'echo hello' },
      status: 'running',
      startTime: Date.now()
    }
  }
}

describe('SubAgentCard default collapse', () => {
  it('starts collapsed and keeps child actions collapsed until explicitly opened', () => {
    render(<SubAgentCard subtask={makeSubtask()} childParts={[makeToolPart()]} />)

    expect(screen.getByText('Delegated to Explore')).toBeInTheDocument()
    expect(screen.queryByText('Searching authentication patterns in codebase')).not.toBeInTheDocument()
    expect(screen.queryByText('Show 1 action')).not.toBeInTheDocument()
    expect(screen.queryByText('echo hello')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Delegated to Explore'))

    expect(screen.getByText('Searching authentication patterns in codebase')).toBeInTheDocument()
    expect(screen.getByText('Show 1 action')).toBeInTheDocument()
    expect(screen.queryByText('echo hello')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Show 1 action'))

    expect(screen.getByText('echo hello')).toBeInTheDocument()
  })
})
