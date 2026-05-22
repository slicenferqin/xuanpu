import { describe, expect, it, vi } from 'vitest'
import type { HubMessage, ServerMsg } from '../../src/main/services/hub/hub-protocol'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { replayFramesAfterSnapshot } from '../../src/main/services/hub/hub-server'

describe('hub-server replayFramesAfterSnapshot', () => {
  it('dedupes already-snapshotted message appends but keeps live interaction frames', () => {
    const history: HubMessage[] = [
      {
        id: 'persisted-message',
        role: 'assistant',
        ts: 1,
        seq: 0,
        parts: [{ type: 'text', text: 'persisted' }]
      }
    ]
    const frames: ServerMsg[] = [
      {
        type: 'message/append',
        seq: 1,
        message: history[0]
      },
      {
        type: 'permission/request',
        seq: 2,
        requestId: 'perm-1',
        toolName: 'Bash'
      },
      {
        type: 'message/update',
        seq: 3,
        messageId: 'persisted-message',
        patch: { op: 'appendText', partIdx: 0, value: ' live tail' }
      }
    ]

    expect(replayFramesAfterSnapshot(history, frames)).toEqual([frames[1], frames[2]])
  })
})
