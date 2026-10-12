import { describe, it, expect, afterEach } from 'vitest'
import { once } from 'node:events'
import WebSocket from 'ws'
import { startCore, type Core } from './server.ts'

let core: Core | undefined

afterEach(async () => {
  await core?.close()
  core = undefined
})

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('core server', () => {
  it('answers /health', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const res = await fetch(`http://127.0.0.1:${core.port}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('refuses to bind anything but loopback', async () => {
    await expect(startCore({ host: '0.0.0.0' })).rejects.toThrow(/loopback/)
  })

  it('streams normalized events for a prompt', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))

    await waitFor(() => messages.some((m) => m.event?.type === 'chunk'))
    const text = messages
      .filter((m) => m.event?.type === 'chunk')
      .map((m) => m.event.text)
      .join('')
    expect(text).toContain('hi')
    ws.close()
  })

  it('broadcasts to every connected client', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const url = `ws://127.0.0.1:${core.port}/ws`
    const a = new WebSocket(url)
    const b = new WebSocket(url)
    const seenB: any[] = []
    await Promise.all([once(a, 'open'), once(b, 'open')])
    b.on('message', (data) => seenB.push(JSON.parse(String(data))))
    a.send(JSON.stringify({ type: 'prompt', text: 'hi' }))

    await waitFor(() => seenB.some((m) => m.event?.type === 'turn.finished'))
    a.close()
    b.close()
  })

  it('surfaces an agent crash as an error event, not a hang', async () => {
    core = await startCore({ port: 0, backend: 'fake:crash-mid-turn' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))

    await waitFor(() => messages.some((m) => m.event?.type === 'error'))
    ws.close()
  })
})
