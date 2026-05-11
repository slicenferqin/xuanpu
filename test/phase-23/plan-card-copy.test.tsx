import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { PlanCard } from '@/components/session-hq/cards/PlanCard'
import { toast } from '@/lib/toast'

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const writeTextMock = vi.fn().mockResolvedValue(undefined)

Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  writable: true,
  value: {
    writeText: writeTextMock
  }
})

describe('PlanCard copy markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeTextMock.mockResolvedValue(undefined)
  })

  test('copies the raw plan markdown without collapsing the card', async () => {
    const markdown = ['# Ship PR6', '', '- Show PR title', '- Copy plan markdown'].join('\n')

    render(<PlanCard content={markdown} isPending />)

    fireEvent.click(screen.getByTestId('plan-card-copy-button'))

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(markdown)
      expect(toast.success).toHaveBeenCalledWith('Plan markdown copied to clipboard')
    })

    expect(screen.getByText('Copy plan markdown')).toBeInTheDocument()
  })

  test('does not render a copy button for empty plan content', () => {
    render(<PlanCard content="  " isPending />)

    expect(screen.queryByTestId('plan-card-copy-button')).not.toBeInTheDocument()
  })
})
