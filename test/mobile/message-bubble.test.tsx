import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { MessageBubble } from '../../mobile/src/components/MessageBubble'
import type { HubMessage } from '../../mobile/src/types/hub'

describe('mobile MessageBubble', () => {
  test('renders assistant text content with readable styling', () => {
    const message: HubMessage = {
      id: 'm-1',
      role: 'assistant',
      ts: Date.now(),
      seq: 1,
      parts: [{ type: 'text', text: '这里应该能看到历史消息正文' }]
    }

    const { container } = render(<MessageBubble message={message} />)

    expect(screen.getByText('这里应该能看到历史消息正文')).toBeInTheDocument()
    expect(container.firstChild).toHaveClass('text-zinc-100')
  })
})
