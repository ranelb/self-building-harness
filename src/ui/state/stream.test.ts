import { describe, it, expect } from 'vitest'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { connectStream } from './stream.ts'
import type { UiEvent } from '../../../shared/protocol.ts'

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('connectStream', () => {
  it('delivers events and sends messages, queuing sends before the socket opens', async () => {
    const wss = new WebSocketServer({ port: 0, path: '/ws' })
    await once(wss, 'listening')
    const address = wss.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    const received: unknown[] = []
    wss.on('connection', (socket) => {
      socket.on('message', (data) => received.push(JSON.parse(String(data))))
      socket.send(JSON.stringify({ type: 'event', event: { type: 'chunk', text: 'hi' } satisfies UiEvent }))
    })

    const stream = connectStream(`ws://127.0.0.1:${port}/ws`)
    const events: UiEvent[] = []
    stream.onEvent((event) => events.push(event))

    // Sent before the socket finishes opening; must not be lost.
    stream.send({ type: 'prompt', text: 'yo' })

    await waitFor(() => events.length > 0 && received.length > 0)

    expect(events[0]).toEqual({ type: 'chunk', text: 'hi' })
    expect(received[0]).toEqual({ type: 'prompt', text: 'yo' })

    stream.close()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  it('ignores malformed frames instead of throwing', async () => {
    const wss = new WebSocketServer({ port: 0, path: '/ws' })
    await once(wss, 'listening')
    const address = wss.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    wss.on('connection', (socket) => {
      socket.send('not json at all')
      socket.send(JSON.stringify({ type: 'event', event: { type: 'turn.finished', stopReason: 'end_turn' } }))
    })

    const stream = connectStream(`ws://127.0.0.1:${port}/ws`)
    const events: UiEvent[] = []
    stream.onEvent((event) => events.push(event))

    await waitFor(() => events.length > 0)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('turn.finished')

    stream.close()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })
})
