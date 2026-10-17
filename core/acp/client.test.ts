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
      expect.objectContaining({ id: 'thought_level', category: 'thought_level' }),
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

  it('finishes a resumed session so the client is not left streaming', async () => {
    const conn = connectAcp({ ...fake('happy'), resume: { sessionId: 'saved-1' } })
    const events = collect(conn)
    await conn.open()
    const finished = events.filter(
      (e): e is Extract<UiEvent, { type: 'turn.finished' }> => e.type === 'turn.finished'
    )
    expect(finished.length).toBeGreaterThan(0)
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
    // Wait for the turn to actually start, so `cancel` cannot race the session.
    const started = Date.now()
    while (!events.some((e) => e.type === 'chunk')) {
      if (Date.now() - started > 5000) throw new Error('turn never started')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
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
  it('emits a compaction event and no sentinel prose', async () => {
    const conn = connectAcp(fake('compaction'))
    const events = collect(conn)
    await conn.prompt('go', [])
    const chunks = events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text)
    const phases = events.filter((e) => e.type === 'compaction').map((e) => (e as { phase: string }).phase)
    expect(chunks.join('')).toBe('before after')
    expect(phases).toEqual(['start', 'end'])
  })

})

describe('turn control', () => {
  const waitUntil = async (predicate: () => boolean) => {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > 5000) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  it('steers: cancels the in-flight turn and jumps the queue', async () => {
    const conn = connectAcp(fake('steer'))
    const events = collect(conn)
    const slow = conn.prompt('slow')
    await waitUntil(() => events.some((e) => e.type === 'chunk'))
    const started = Date.now()
    await conn.prompt('redirect', [], { steer: true })
    // The fixture holds the first turn for 3s; a steer that waited would take that long.
    expect(Date.now() - started).toBeLessThan(2000)
    await slow
    const finished = events.filter((e) => e.type === 'turn.finished') as { stopReason: string }[]
    expect(finished[0]?.stopReason).toBe('cancelled')
    const text = events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text).join('')
    expect(text).toContain('echo redirect')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    conn.close()
  })

  it('keeps a steer ahead of an earlier follow-up', async () => {
    const conn = connectAcp(fake('steer'))
    const events = collect(conn)
    const slow = conn.prompt('slow')
    await waitUntil(() => events.some((e) => e.type === 'chunk'))
    const later = conn.prompt('later')
    const now = conn.prompt('now', [], { steer: true })
    await Promise.all([slow, later, now])
    const text = events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text).join('')
    expect(text.indexOf('echo now')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('echo now')).toBeLessThan(text.indexOf('echo later'))
    conn.close()
  })

  it('runs a second prompt after the first finishes, not concurrently', async () => {
    const conn = connectAcp(fake('queue-turn'))
    const events = collect(conn)
    await Promise.all([conn.prompt('one'), conn.prompt('two')])
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(2)
    const text = events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text).join('')
    expect(text.indexOf('end one')).toBeLessThan(text.indexOf('start two'))
    conn.close()
  })

  it('pairs every turn.finished with its turn.started, in increasing order', async () => {
    const conn = connectAcp(fake('happy'))
    const events = collect(conn)
    await conn.prompt('one')
    await conn.prompt('two')
    const started = events.filter((e): e is Extract<UiEvent, { type: 'turn.started' }> => e.type === 'turn.started')
    const finished = events.filter((e): e is Extract<UiEvent, { type: 'turn.finished' }> => e.type === 'turn.finished')
    expect(started).toHaveLength(2)
    expect(finished.map((e) => e.turnId)).toEqual(started.map((e) => e.turnId))
    expect(started[1]!.turnId).toBeGreaterThan(started[0]!.turnId)
    conn.close()
  })
})

describe('queue depth', () => {
  const waitUntil = async (predicate: () => boolean) => {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > 5000) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const pendings = (events: UiEvent[]) =>
    events.filter((e): e is Extract<UiEvent, { type: 'queue' }> => e.type === 'queue').map((e) => e.pending)

  it('clearQueue drops only the waiting prompts', async () => {
    const conn = connectAcp(fake('queue-turn'))
    const events = collect(conn)
    const a = conn.prompt('one')
    const b = conn.prompt('two')
    const c = conn.prompt('three')
    await waitUntil(() => pendings(events).includes(2))
    expect(conn.clearQueue()).toBe(2)
    await Promise.all([a, b, c])
    const text = events.filter((e) => e.type === 'chunk').map((e) => (e as { text: string }).text).join('')
    expect(text).toContain('end one')
    expect(text).not.toContain('two')
    expect(text).not.toContain('three')
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
    expect(pendings(events).at(-1)).toBe(0)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    conn.close()
  })

  it('drops the queue when the connection closes', async () => {
    const conn = connectAcp(fake('queue-turn'))
    const events = collect(conn)
    const a = conn.prompt('one')
    const b = conn.prompt('two')
    const c = conn.prompt('three')
    await waitUntil(() => pendings(events).includes(2))
    conn.close()
    await Promise.all([a, b, c])
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
    expect(pendings(events).at(-1)).toBe(0)
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
