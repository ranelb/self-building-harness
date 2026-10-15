import { describe, it, expect } from 'vitest'
import { choosePermissionOption, connectAcp } from './client.ts'
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

  it('resolves the goose backend to its native ACP server', () => {
    expect(resolveBackend('goose')).toEqual({ command: 'goose', args: ['acp'] })
  })

  it('rejects an unknown backend with a named error', () => {
    expect(() => resolveBackend('nope')).toThrow(/UnknownBackend/)
  })
})

describe('choosePermissionOption', () => {
  const byKind = [
    { optionId: 'opt-yes', kind: 'allow_once' },
    { optionId: 'opt-always', kind: 'allow_always' },
    { optionId: 'opt-no', kind: 'reject_once' },
  ]

  it('selects the allow option by kind, not by a literal id', () => {
    expect(choosePermissionOption(byKind, 'allow')?.optionId).toBe('opt-yes')
  })

  it('selects the reject option by kind', () => {
    expect(choosePermissionOption(byKind, 'deny')?.optionId).toBe('opt-no')
  })

  it('prefers a one-shot allow over an always-allow', () => {
    const options = [
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
    ]
    expect(choosePermissionOption(options, 'allow')?.optionId).toBe('once')
  })

  it('falls back to a literal id for an older agent', () => {
    expect(choosePermissionOption([{ optionId: 'allow' }], 'allow')?.optionId).toBe('allow')
  })

  it('fails closed (null) when no option matches', () => {
    expect(choosePermissionOption([{ optionId: 'weird', kind: 'reject_once' }], 'allow')).toBeNull()
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

  it('lists the agent sessions without creating one', async () => {
    const conn = connectAcp(fake('happy'))
    const { sessions, nextCursor } = await conn.list()
    expect(sessions.map((s) => s.sessionId)).toEqual(['saved-1', 'saved-2'])
    expect(sessions[0]).toMatchObject({ title: 'First chat', cwd: process.cwd() })
    expect(nextCursor).toBeNull()
    conn.close()
  })

  it('reports session config options and updates them', async () => {
    const conn = connectAcp(fake('happy'))
    const events = collect(conn)
    await conn.setConfigOption('model', 'model-b')
    const configs = events.filter((e): e is Extract<UiEvent, { type: 'config' }> => e.type === 'config')
    const latest = configs[configs.length - 1]
    expect(latest?.options).toEqual([
      expect.objectContaining({ id: 'model', category: 'model', currentValue: 'model-b' }),
    ])
    conn.close()
  })

  it('resumes an existing session and replays its history as events', async () => {
    const conn = connectAcp({ ...fake('happy'), resume: { sessionId: 'saved-1' } })
    const events = collect(conn)
    await conn.prompt('again')
    const text = events
      .filter((e) => e.type === 'chunk' || e.type === 'user.chunk')
      .map((e) => (e as { text: string }).text)
      .join('|')
    expect(text).toContain('earlier question')
    expect(text).toContain('earlier answer')
    conn.close()
  })

  it('reassembles a chunk split across a multibyte boundary', async () => {
    const conn = connectAcp(fake('split-multibyte'))
    const events = collect(conn)
    await conn.prompt('hello')
    expect(events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text).join('')).toBe('a🎉b')
    conn.close()
  })

  it('cancel stops the turn (session/cancel)', async () => {
    const conn = connectAcp(fake('cancel'))
    const events = collect(conn)
    const turn = conn.prompt('hello')
    await new Promise((resolve) => setTimeout(resolve, 80))
    await conn.cancel()
    await turn
    const finished = events.find(
      (e): e is Extract<UiEvent, { type: 'turn.finished' }> => e.type === 'turn.finished'
    )
    expect(finished?.stopReason).toBe('cancelled')
    conn.close()
  })

  it('reads agent capabilities from initialize', async () => {
    const conn = connectAcp(fake('happy'))
    await conn.open()
    expect(conn.capabilities()).toEqual({
      image: true,
      audio: false,
      embeddedContext: false,
      fork: true,
    })
    conn.close()
  })

  it('fork returns the new session id', async () => {
    const conn = connectAcp(fake('happy'))
    await conn.open()
    expect(await conn.fork()).toBe('forked-session')
    conn.close()
  })
})

describe('closing', () => {
  it('does not emit an error when the core closes an in-flight handshake', async () => {
    // A process that never answers ACP, so `open()` has a request in flight.
    const conn = connectAcp({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      cwd: process.cwd(),
    })
    const events = collect(conn)
    void conn.open()
    await new Promise((resolve) => setTimeout(resolve, 50))
    conn.close()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })
})
