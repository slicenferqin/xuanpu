import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerBar } from '../../src/renderer/src/components/session-hq/ComposerBar'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: {
      session: {
        getDraft: vi.fn().mockResolvedValue(null),
        updateDraft: vi.fn().mockResolvedValue(undefined)
      }
    }
  })

  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: {
      commands: vi.fn().mockResolvedValue({ success: true, commands: [] })
    }
  })
})

describe('ComposerBar', () => {
  it('uses queue as the primary action while busy when draft content exists', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()

    render(
      <ComposerBar
        sessionId="sess-1"
        lifecycle="busy"
        pendingCount={0}
        firstInterrupt={null}
        onAction={onAction}
        isConnected={true}
      />
    )

    await user.type(screen.getByRole('textbox'), 'Follow up after this run')
    await user.click(screen.getByTestId('composer-primary-action'))

    expect(onAction).toHaveBeenCalledWith('queue', 'Follow up after this run', expect.any(Array))
  })

  it('shows steer and stop actions in the busy-state action menu', async () => {
    const user = userEvent.setup()

    render(
      <ComposerBar
        sessionId="sess-1"
        lifecycle="busy"
        pendingCount={0}
        firstInterrupt={null}
        onAction={vi.fn()}
        isConnected={true}
        supportsSteer={true}
      />
    )

    await user.type(screen.getByRole('textbox'), 'Need to redirect now')
    await act(async () => {
      await user.click(screen.getByTestId('composer-action-menu-trigger'))
    })

    expect(await screen.findByTestId('composer-action-steer')).toBeInTheDocument()
    expect(screen.getByTestId('composer-action-stop_and_send')).toBeInTheDocument()
  })

  it('dispatches steer from the busy-state action menu', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn()

    render(
      <ComposerBar
        sessionId="sess-1"
        lifecycle="busy"
        pendingCount={0}
        firstInterrupt={null}
        onAction={onAction}
        isConnected={true}
        supportsSteer={true}
      />
    )

    await user.type(screen.getByRole('textbox'), 'Switch to investigating the failing test')
    await act(async () => {
      await user.click(screen.getByTestId('composer-action-menu-trigger'))
    })
    await act(async () => {
      await user.click(await screen.findByTestId('composer-action-steer'))
    })

    expect(onAction).toHaveBeenCalledWith(
      'steer',
      'Switch to investigating the failing test',
      expect.any(Array)
    )
  })

  it('renders and toggles the Codex goal control', async () => {
    const user = userEvent.setup()
    const onToggleGoalMode = vi.fn()

    render(
      <ComposerBar
        sessionId="sess-1"
        lifecycle="idle"
        pendingCount={0}
        firstInterrupt={null}
        onAction={vi.fn()}
        isConnected={true}
        supportsGoalMode={true}
        goalMode={false}
        onToggleGoalMode={onToggleGoalMode}
      />
    )

    const goalToggle = screen.getByTestId('composer-goal-toggle')
    expect(goalToggle).toHaveTextContent('Goal')
    expect(goalToggle).toHaveAttribute('aria-pressed', 'false')

    await user.click(goalToggle)

    expect(onToggleGoalMode).toHaveBeenCalledTimes(1)
  })

  it('shows success criteria input only while goal mode is enabled', async () => {
    const user = userEvent.setup()

    function GoalComposer(): React.JSX.Element {
      const [goalMode, setGoalMode] = React.useState(false)
      const [successCriteria, setSuccessCriteria] = React.useState('')

      return (
        <ComposerBar
          sessionId="sess-1"
          lifecycle="idle"
          pendingCount={0}
          firstInterrupt={null}
          onAction={vi.fn()}
          isConnected={true}
          supportsGoalMode={true}
          goalMode={goalMode}
          onToggleGoalMode={() => setGoalMode((current) => !current)}
          successCriteria={successCriteria}
          onSuccessCriteriaChange={setSuccessCriteria}
        />
      )
    }

    render(<GoalComposer />)

    expect(screen.queryByTestId('composer-success-criteria')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('composer-goal-toggle'))
    const criteriaInput = screen.getByTestId('composer-success-criteria')
    expect(criteriaInput).toBeInTheDocument()
    expect(criteriaInput).toHaveAttribute('placeholder', 'Success criteria...')

    await user.type(criteriaInput, 'All tests pass and the UI is stable')

    expect(criteriaInput).toHaveValue('All tests pass and the UI is stable')
  })

  it('does not render goal controls when goal mode is unsupported', () => {
    render(
      <ComposerBar
        sessionId="sess-1"
        lifecycle="idle"
        pendingCount={0}
        firstInterrupt={null}
        onAction={vi.fn()}
        isConnected={true}
        supportsGoalMode={false}
        goalMode={true}
        onToggleGoalMode={vi.fn()}
      />
    )

    expect(screen.queryByTestId('composer-goal-toggle')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-success-criteria')).not.toBeInTheDocument()
  })
})
