import { render } from '@testing-library/react'
import { ReadableMessage } from '../../src/renderer/src/components/session-hq/readable/ReadableMessage'

describe('ReadableMessage layout', () => {
  it('fills the available timeline width by default', () => {
    const { container } = render(<ReadableMessage content="final assistant reply" />)
    const message = container.firstElementChild

    expect(message).toHaveClass('xp-readable-message')
    expect(message).toHaveClass('w-full')
    expect(message).toHaveClass('max-w-full')
    expect(message).not.toHaveClass('max-w-[var(--xp-reader-measure)]')
  })
})
