import { describe, it, expect } from 'vitest'
import { connectAcp } from './client.ts'
import { respondToPermission, DENY_BY_DEFAULT } from './permissions.ts'
import type { UiEvent } from '../events.ts'

const fakePermissionAgent = () => ({
  command: process.execPath,
  args: ['test/fixtures/fake-acp-agent.ts', 'permission'],
  cwd: process.cwd(),
})

const runTurn = async (decision: 'allow' | 'deny') => {
  const conn = connectAcp(fakePermissionAgent())
  const events: UiEvent[] = []
  conn.onEvent((event) => {
    events.push(event)
    if (event.type === 'permission.requested') {
      void respondToPermission(conn, event.requestId, decision)
    }
  })
  await conn.prompt('hello')
  const chunks = events
    .filter((e): e is Extract<UiEvent, { type: 'chunk' }> => e.type === 'chunk')
    .map((e) => e.text)
    .join('')
  conn.close()
  return { events, chunks }
}

describe('permissions', () => {
  it('denies by default', () => {
    expect(DENY_BY_DEFAULT({ requestId: 'r1', title: 'rm -rf /' })).toBe('deny')
  })

  it('surfaces a permission request as a UI event with a title', async () => {
    const { events } = await runTurn('deny')
    const request = events.find((e) => e.type === 'permission.requested')
    expect(request).toMatchObject({ type: 'permission.requested', title: 'Run ls' })
  })

  it('an allowed request lets the turn continue', async () => {
    const { events, chunks } = await runTurn('allow')
    expect(events.some((e) => e.type === 'turn.finished')).toBe(true)
    expect(chunks).toContain('after')
  })

  it('a denied request also lets the turn continue', async () => {
    const { events, chunks } = await runTurn('deny')
    expect(events.some((e) => e.type === 'turn.finished')).toBe(true)
    expect(chunks).toContain('denied')
  })
})
