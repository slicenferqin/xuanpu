import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BashCard } from '../../src/renderer/src/components/session-hq/cards/BashCard'

describe('Session HQ BashCard', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'fileOps', {
      writable: true,
      configurable: true,
      value: {
        readArchive: vi.fn().mockResolvedValue({
          success: true,
          content: 'full original output'
        })
      }
    })
  })

  it('shows command and token-saver savings for MCP bash output', async () => {
    render(
      <BashCard
        toolUse={{
          id: 'tool-1',
          name: 'mcp__xuanpu__bash',
          input: {
            command: 'git log --oneline -5',
            description: 'Inspect recent commits'
          },
          status: 'success',
          startTime: 1,
          endTime: 2,
          output:
            'abc123 first commit\n---\n[Token Saver] compressed 1000B → 100B (-90%) · via progress-dedup · original: /Users/slicenfer/.xuanpu/archive/session/raw.txt'
        }}
      />
    )

    expect(screen.getByText('git log --oneline -5')).toBeInTheDocument()
    expect(screen.getByText(/Token Saver -90%/)).toBeInTheDocument()
    expect(screen.getByTestId('token-saver-badge')).toHaveTextContent('90%')
    expect(screen.getByTestId('token-saver-badge')).toHaveTextContent('1000 B')
    expect(screen.getByTestId('token-saver-badge')).toHaveTextContent('100 B')
    expect(screen.getByText('abc123 first commit')).toBeInTheDocument()
    expect(screen.getByTestId('token-saver-show-original')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('token-saver-show-original'))

    await waitFor(() => {
      expect(window.fileOps.readArchive).toHaveBeenCalledWith(
        '/Users/slicenfer/.xuanpu/archive/session/raw.txt'
      )
    })
    expect(await screen.findByText('full original output')).toBeInTheDocument()
  })
})
