import { describe, it, expect } from 'vitest'
import { applyEvent, empty, resolvePermission, withUserMessage } from './transcript.ts'

describe('applyEvent', () => {
  it('coalesces consecutive chunks into one agent message', () => {
    let state = applyEvent(empty(), { type: 'chunk', text: 'Hel' })
    state = applyEvent(state, { type: 'chunk', text: 'lo' })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.text).toBe('Hello')
  })

  it('starts a new message after a turn finishes', () => {
    let state = applyEvent(empty(), { type: 'chunk', text: 'a' })
    state = applyEvent(state, { type: 'turn.finished', stopReason: 'end_turn' })
    state = applyEvent(state, { type: 'chunk', text: 'b' })
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]?.text).toBe('b')
  })

  it('records an error without dropping the transcript', () => {
    let state = applyEvent(empty(), { type: 'chunk', text: 'a' })
    state = applyEvent(state, { type: 'error', message: 'boom' })
    expect(state.status).toBe('error')
    expect(state.error).toBe('boom')
    expect(state.messages[0]?.text).toBe('a')
  })

  it('queues a permission request', () => {
    const state = applyEvent(empty(), {
      type: 'permission.requested',
      requestId: 'r1',
      title: 'Run ls',
    })
    expect(state.pendingPermission).toEqual([{ requestId: 'r1', title: 'Run ls' }])
  })

  it('is streaming between turn.started and turn.finished', () => {
    let state = applyEvent(empty(), { type: 'turn.started' })
    expect(state.status).toBe('streaming')
    state = applyEvent(state, { type: 'turn.finished', stopReason: 'end_turn' })
    expect(state.status).toBe('idle')
  })
})

describe('withUserMessage', () => {
  it('appends a user message and leaves the agent message separate', () => {
    const state = withUserMessage(empty(), 'hi there')
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ role: 'user', text: 'hi there' })
  })
})

describe('resolvePermission', () => {
  it('drops only the answered request', () => {
    let state = applyEvent(empty(), { type: 'permission.requested', requestId: 'r1', title: 'one' })
    state = applyEvent(state, { type: 'permission.requested', requestId: 'r2', title: 'two' })
    state = resolvePermission(state, 'r1')
    expect(state.pendingPermission).toEqual([{ requestId: 'r2', title: 'two' }])
  })
})

describe('replay (user.chunk)', () => {
  it('rebuilds a replayed conversation as alternating messages', () => {
    let s = empty()
    s = applyEvent(s, { type: 'user.chunk', text: 'question' })
    s = applyEvent(s, { type: 'chunk', text: 'ans' })
    s = applyEvent(s, { type: 'chunk', text: 'wer' })
    s = applyEvent(s, { type: 'user.chunk', text: 'follow up' })
    s = applyEvent(s, { type: 'chunk', text: 'reply' })
    expect(s.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:question',
      'agent:answer',
      'user:follow up',
      'agent:reply',
    ])
  })

  it('coalesces consecutive user chunks of one message', () => {
    let s = applyEvent(empty(), { type: 'user.chunk', text: 'a' })
    s = applyEvent(s, { type: 'user.chunk', text: 'b' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ role: 'user', text: 'ab' })
  })
})
