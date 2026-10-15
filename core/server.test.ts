import { describe, it, expect, afterEach } from 'vitest'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startCore, type Core } from './server.ts'

let core: Core | undefined

afterEach(async () => {
  await core?.close()
  core = undefined
})

const waitFor = async (predicate: () => boolean, timeoutMs = 8000) => {
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

  it('serves the component directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-server-components-'))
    await writeFile(join(dir, 'badge.js'), 'export const component = { name: "badge" }')
    core = await startCore({ port: 0, backend: 'fake:happy', componentsDir: dir })

    const list = await fetch(`http://127.0.0.1:${core.port}/components`).then((r) => r.json())
    expect(list).toEqual({ components: ['badge'] })

    const source = await fetch(`http://127.0.0.1:${core.port}/components/badge.js`)
    expect(source.status).toBe(200)
    expect(await source.text()).toContain('badge')

    const traversal = await fetch(`http://127.0.0.1:${core.port}/components/..%2f..%2fetc%2fpasswd.js`)
    expect(traversal.status).toBe(404)

    await rm(dir, { recursive: true, force: true })
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

describe('origin guard', () => {
  const STRANGER = 'https://evil.example'
  const DEV = 'http://127.0.0.1:5199'

  it('refuses an untrusted browser origin on every route, reads included', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const health = await fetch(`http://127.0.0.1:${core.port}/health`, { headers: { origin: STRANGER } })
    expect(health.status).toBe(403)

    const history = await fetch(`http://127.0.0.1:${core.port}/history`, { headers: { origin: STRANGER } })
    expect(history.status).toBe(403)
  })

  it('refuses an untrusted origin on the WebSocket upgrade', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`, { origin: STRANGER })
    const error = await new Promise<Error>((resolve) => ws.on('error', resolve))
    expect(String(error)).toMatch(/403|Unexpected/)
  })

  it('admits the dev origin and echoes it instead of a wildcard', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const res = await fetch(`http://127.0.0.1:${core.port}/health`, { headers: { origin: DEV } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV)
  })

  it('admits the dev origin on the WebSocket upgrade', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`, { origin: DEV })
    await once(ws, 'open')
    ws.close()
  })
})

describe('pickers and resume', () => {
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${core!.port}/ws`)
    const messages: any[] = []
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    await once(ws, 'open')
    return { ws, messages }
  }

  it('lists the backends and the active one', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const body = (await fetch(`http://127.0.0.1:${core.port}/backends`).then((r) => r.json())) as any
    expect(body.backends.map((b: any) => b.id)).toEqual(['pi', 'goose'])
    expect(body.value).toBe('fake:happy')
  })

  it('lists sessions from the agent, not the files', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const body = (await fetch(`http://127.0.0.1:${core.port}/sessions`).then((r) => r.json())) as any
    expect(body.sessions.map((s: any) => s.id)).toEqual(['saved-1', 'saved-2'])
    expect(body.sessions[0].title).toBe('First chat')
  })

  it('reports the model and changes it', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const { ws, messages } = await connect()
    ws.send(JSON.stringify({ type: 'model', id: 'model-b' }))
    await waitFor(() =>
      messages.some((m) => m.type === 'state' && m.key === 'model' && m.value?.value === 'model-b')
    )
    ws.close()
  })

  it('switches backend and streams from the new one', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const { ws, messages } = await connect()
    ws.send(JSON.stringify({ type: 'backend', id: 'fake:unknown-update' }))
    await waitFor(() =>
      messages.some((m) => m.type === 'state' && m.key === 'harness' && m.value?.value === 'fake:unknown-update')
    )
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))
    await waitFor(() =>
      messages.some((m) => m.type === 'event' && m.event?.type === 'chunk' && m.event.text === 'known')
    )
    ws.close()
  })

  it('rejects an unknown backend without tearing down the app', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const { ws, messages } = await connect()
    ws.send(JSON.stringify({ type: 'backend', id: 'nope' }))
    // No harness state change; the previous backend still answers.
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))
    await waitFor(() => messages.some((m) => m.event?.type === 'turn.finished'))
    ws.close()
  })

  it('resumes a session and replays it as events', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const { ws, messages } = await connect()
    ws.send(JSON.stringify({ type: 'session.resume', id: 'saved-1', cwd: process.cwd() }))
    await waitFor(() =>
      messages.some((m) => m.type === 'event' && m.event?.type === 'user.chunk' && m.event.text === 'earlier question')
    )
    await waitFor(() =>
      messages.some((m) => m.type === 'event' && m.event?.type === 'chunk' && m.event.text === 'earlier answer')
    )
    ws.close()
  })
})
