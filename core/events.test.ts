import { describe, it, expect } from 'vitest'
import { normalizeUpdate } from './events.ts'

describe('normalizeUpdate', () => {
  it('maps an agent message chunk to a chunk event', () => {
    expect(
      normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    ).toEqual([{ type: 'chunk', text: 'hi' }])
  })

  it('maps an agent thought chunk to a thought event', () => {
    expect(
      normalizeUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'why' } })
    ).toEqual([{ type: 'thought', text: 'why' }])
  })

  it('maps a tool call to a tool event, NOT a permission request', () => {
    // Permission arrives on its own channel (an inbound session/request_permission
    // request); conflating the two was a bug in the original plan.
    expect(normalizeUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Run ls' })).toEqual([
      { type: 'tool', toolCallId: 'tc1', title: 'Run ls' },
    ])
  })

  it('ignores an unknown update kind instead of throwing', () => {
    expect(normalizeUpdate({ sessionUpdate: 'invented_future_kind', payload: 1 })).toEqual([])
  })

  it('survives malformed input without throwing', () => {
    expect(normalizeUpdate(null)).toEqual([])
    expect(normalizeUpdate(undefined)).toEqual([])
    expect(normalizeUpdate({})).toEqual([])
    expect(normalizeUpdate('nonsense')).toEqual([])
    expect(normalizeUpdate({ sessionUpdate: 'agent_message_chunk' })).toEqual([])
  })
})
