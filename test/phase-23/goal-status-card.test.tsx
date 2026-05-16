import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GoalStatusCard } from '../../src/renderer/src/components/session-hq/cards/GoalStatusCard'

describe('GoalStatusCard', () => {
  it('shows success criteria separately from the goal title', () => {
    render(
      <GoalStatusCard
        goal={{
          threadId: 'thread-1',
          objective: 'Review and fix the bug',
          successCriteria: 'Focused tests pass',
          status: 'active',
          tokensUsed: 1200,
          tokenBudget: 50000,
          timeUsedSeconds: 90
        }}
      />
    )

    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('Review and fix the bug')
    expect(screen.getByTestId('goal-success-criteria')).toHaveTextContent('Focused tests pass')
    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('1.2K / 50K tokens')
    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('1m 30s')
  })

  it('shows a dismiss affordance only for completed goals and calls it', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()

    render(
      <GoalStatusCard
        goal={{
          threadId: 'thread-2',
          objective: 'Ship the fix',
          successCriteria: 'UI state is correct',
          status: 'completed'
        }}
        onDismiss={onDismiss}
      />
    )

    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('Completed')
    expect(screen.getByTestId('goal-dismiss-button')).toBeInTheDocument()

    await user.click(screen.getByTestId('goal-dismiss-button'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
