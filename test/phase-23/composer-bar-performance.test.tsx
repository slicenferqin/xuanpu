import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerBar } from '../../src/renderer/src/components/session-hq/ComposerBar'

const renderCounters = vi.hoisted(() => ({
  attachmentButton: 0
}))

vi.mock('../../src/renderer/src/components/sessions/AttachmentButton', () => ({
  AttachmentButton: ({ disabled }: { disabled?: boolean }) => {
    renderCounters.attachmentButton += 1
    return (
      <button type="button" disabled={disabled} data-testid="mock-attachment-button">
        Attach
      </button>
    )
  }
}))

beforeEach(() => {
  renderCounters.attachmentButton = 0

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

describe('ComposerBar input performance', () => {
  it('does not rerender the attachment toolbar control for every typed character', async () => {
    const user = userEvent.setup()
    const onAction = vi.fn().mockResolvedValue(true)

    render(
      <ComposerBar
        sessionId="sess-1"
        lifecycle="idle"
        pendingCount={0}
        firstInterrupt={null}
        onAction={onAction}
        isConnected={true}
      />
    )

    expect(renderCounters.attachmentButton).toBe(1)

    await user.type(screen.getByRole('textbox'), 'abcdef')

    // The toolbar should update when the draft transitions empty -> non-empty,
    // then stay stable while the controlled textarea receives more characters.
    expect(renderCounters.attachmentButton).toBeLessThanOrEqual(2)

    await user.click(screen.getByTestId('composer-primary-action'))

    expect(onAction).toHaveBeenCalledWith('send', 'abcdef', [])
  })
})
