import { render, screen } from '@testing-library/react'
import { ThreadStatusRow } from '../../src/renderer/src/components/session-hq/ThreadStatusRow'

describe('ThreadStatusRow', () => {
  it('renders compacting status in the thread', () => {
    render(
      <ThreadStatusRow
        status={{
          id: 'compaction-1',
          kind: 'compacting',
          timestamp: Date.now(),
          ephemeral: true
        }}
      />
    )

    expect(screen.getByTestId('thread-status-compacting')).toBeInTheDocument()
  })

  it('renders running status with Agent Running label', () => {
    render(
      <ThreadStatusRow
        status={{
          id: 'running-1',
          kind: 'running',
          timestamp: Date.now(),
          startedAt: Date.now() - 2400,
          ephemeral: true
        }}
      />
    )

    expect(screen.getByTestId('thread-status-running')).toBeInTheDocument()
    expect(screen.getByText(/Agent Running/)).toBeInTheDocument()
  })
})
