/** The received reaction is best-effort: one 👀 on the person's own message, never blocking intake. */
import { describe, expect, it, vi } from 'vitest'
import { reactSeen } from '../src/sources/feishu-channel.ts'

describe('feishu received reaction', () => {
  it('reacts once to the exact message with EYES', async () => {
    const lark = vi.fn(async () => '{"ok":true}')
    await reactSeen({ commands: { lark } } as never, 'om_x100b600b44bdb0a8c45b0da483dc36a')
    expect(lark).toHaveBeenCalledTimes(1)
    expect(lark).toHaveBeenCalledWith(['api', 'POST',
      '/open-apis/im/v1/messages/om_x100b600b44bdb0a8c45b0da483dc36a/reactions',
      '--data', JSON.stringify({ reaction_type: { emoji_type: 'EYES' } })])
  })
  it('does nothing without a message id or with a malformed one', async () => {
    const lark = vi.fn(async () => '')
    await reactSeen({ commands: { lark } } as never, undefined)
    await reactSeen({ commands: { lark } } as never, 'not-a-message')
    expect(lark).not.toHaveBeenCalled()
  })
  it('never throws when the reaction call fails', async () => {
    const lark = vi.fn(async () => { throw new Error('scope missing') })
    await expect(reactSeen({ commands: { lark } } as never, 'om_abc123')).resolves.toBeUndefined()
  })
})
