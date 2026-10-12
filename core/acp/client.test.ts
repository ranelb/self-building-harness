import { describe, it, expect } from 'vitest'
import { connectAcp } from './client.ts'
import { resolveBackend } from '../backends/registry.ts'
import type { UiEvent } from '../events.ts'

const fake = (scenario: string) => ({
  command: process.execPath,
  args: ['test/fixtures/fake-acp-agent.ts', scenario],
  cwd: process.cwd(),
})

const collect = (conn: { onEvent: (cb: (e: UiEvent) => void) => void }) => {
  const events: UiEvent[] = []
  conn.onEvent((e) => events.push(e))
  return events
}

describe('resolveBackend', () => {
  it('resolves the pi backend to pi-acp', () => {
    expect(resolveBackend('pi')).toEqual({ command: 'npx', args: ['pi-acp@latest'] })
  })

  it('rejects an unknown backend with a named error', () => {
    expect(() => resolveBackend('nope')).toThrow(/UnknownBackend/)
  })
})

describe('connectAcp', () => {
  it('streams chunks from the happy scenario', async () => {
    const conn = connectAcp(fake('happy'))
    const events = collect(conn)
    await conn.prompt('hello')
    expect(events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text).join('')).toContain(
      'hello'
    )
    conn.close()
  })

  it('ignores an unknown update kind and still finishes the turn', async () => {
    const conn = connectAcp(fake('unknown-update'))
    const events = collect(conn)
    await conn.prompt('hello')
    expect(events.some((e) => e.type === 'turn.finished')).toBe(true)
    conn.close()
  })

  it('emits an error event when the agent dies mid-turn', async () => {
    const conn = connectAcp(fake('crash-mid-turn'))
    const events = collect(conn)
    await conn.prompt('hello')
    expect(events.some((e) => e.type === 'error')).toBe(true)
    conn.close()
  })

  it('reassembles a chunk split across a multibyte boundary', async () => {
    const conn = connectAcp(fake('split-multibyte'))
    const events = collect(conn)
    await conn.prompt('hello')
    expect(events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text).join('')).toBe('a🎉b')
    conn.close()
  })
})
