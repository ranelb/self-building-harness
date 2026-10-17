import { describe, it, expect, afterEach } from 'vitest'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startCore, type Core } from './server.ts'
import { makeTempRepo, makeTempTree, type TempRepo, type TempTree } from '../test/fixtures/files-fixture.ts'

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

  it('persists a prompt attachment and completes the turn', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'sbh-state-'))
    const previous = process.env.SBH_STATE_DIR
    process.env.SBH_STATE_DIR = stateDir
    try {
      core = await startCore({ port: 0, backend: 'fake:happy' })
      const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
      const messages: any[] = []
      await once(ws, 'open')
      ws.on('message', (data) => messages.push(JSON.parse(String(data))))
      ws.send(
        JSON.stringify({
          type: 'prompt',
          text: 'hi',
          attachments: [{ name: 'p.png', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') }],
        })
      )
      await waitFor(() => messages.some((m) => m.event?.type === 'turn.finished'))
      const root = join(stateDir, 'attachments')
      const dirs = await readdir(root).catch(() => [] as string[])
      const names: string[] = []
      for (const dir of dirs) {
        names.push(...(await readdir(join(root, dir)).catch(() => [] as string[])))
      }
      expect(names.some((name) => name.endsWith('p.png'))).toBe(true)
      ws.close()
    } finally {
      if (previous === undefined) delete process.env.SBH_STATE_DIR
      else process.env.SBH_STATE_DIR = previous
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('replays cached capabilities to a later client', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const first = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const firstMessages: any[] = []
    first.on('message', (data) => firstMessages.push(JSON.parse(String(data))))
    await once(first, 'open')
    await waitFor(() => firstMessages.some((m) => m.type === 'state' && m.key === 'capabilities'))

    const second = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const secondMessages: any[] = []
    second.on('message', (data) => secondMessages.push(JSON.parse(String(data))))
    await once(second, 'open')
    await waitFor(() => secondMessages.some((m) => m.type === 'state' && m.key === 'capabilities'))
    expect(secondMessages.find((m) => m.key === 'capabilities')?.value).toMatchObject({ image: true, fork: true })
    first.close()
    second.close()
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

  it('a cancel message settles the in-flight turn as cancelled', async () => {
    core = await startCore({ port: 0, backend: 'fake:cancel' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))

    await waitFor(() => messages.some((m) => m.event?.type === 'chunk'))
    ws.send(JSON.stringify({ type: 'cancel' }))
    await waitFor(() => messages.some((m) => m.event?.type === 'turn.finished'))
    const finished = messages.find((m) => m.event?.type === 'turn.finished')
    expect(finished.event.stopReason).toBe('cancelled')
    ws.close()
  })

  it('a steer prompt cancels the in-flight turn and runs next', async () => {
    core = await startCore({ port: 0, backend: 'fake:steer' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'slow' }))
    await waitFor(() => messages.some((m) => m.event?.type === 'chunk'))
    ws.send(JSON.stringify({ type: 'prompt', text: 'redirect', steer: true }))
    await waitFor(() => messages.filter((m) => m.event?.type === 'turn.finished').length === 2)
    const finished = messages.filter((m) => m.event?.type === 'turn.finished')
    expect(finished[0].event.stopReason).toBe('cancelled')
    const text = messages.filter((m) => m.event?.type === 'chunk').map((m) => m.event.text).join('')
    expect(text).toContain('echo redirect')
    ws.close()
  })

  it('publishes the queue depth', async () => {
    core = await startCore({ port: 0, backend: 'fake:queue-turn' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'one' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'two' }))
    await waitFor(() => messages.filter((m) => m.event?.type === 'turn.finished').length === 2)
    const depths = messages.filter((m) => m.event?.type === 'queue').map((m) => m.event.pending)
    expect(depths[0]).toBe(1)
    expect(depths.at(-1)).toBe(0)
    ws.close()
  })

  it('does not spawn an agent to clear an empty queue', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    // A backend switch leaves no connection; a spawn from queue.clear would broadcast state.
    ws.send(JSON.stringify({ type: 'backend', id: 'fake:queue-turn' }))
    await waitFor(() => messages.some((m) => m.key === 'harness'))
    messages.length = 0
    ws.send(JSON.stringify({ type: 'queue.clear' }))
    await new Promise((r) => setTimeout(r, 500))
    expect(messages).toEqual([])
    ws.close()
  })

  it('session.new starts a fresh session and broadcasts session.reset', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'session.new' }))

    await waitFor(() => messages.some((m) => m.event?.type === 'session.reset'))
    expect(messages.find((m) => m.event?.type === 'session.reset').event.reason).toBe('new')

    // The fresh session still streams, i.e. the connection was replaced, not lost.
    ws.send(JSON.stringify({ type: 'prompt', text: 'again' }))
    await waitFor(() =>
      messages.some((m) => m.event?.type === 'chunk' && m.event.text.includes('again'))
    )
    ws.close()
  })

  it('session.new during a streaming turn does not surface an error', async () => {
    core = await startCore({ port: 0, backend: 'fake:cancel' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))

    await waitFor(() => messages.some((m) => m.event?.type === 'chunk'))
    ws.send(JSON.stringify({ type: 'session.new' }))
    await waitFor(() => messages.some((m) => m.event?.type === 'session.reset'))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(messages.some((m) => m.event?.type === 'error')).toBe(false)
    ws.close()
  })

  it('publishes agent capabilities as a state key', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))

    await waitFor(() => messages.some((m) => m.type === 'state' && m.key === 'capabilities'))
    const state = messages.find((m) => m.type === 'state' && m.key === 'capabilities')
    expect(state.value).toMatchObject({ image: true, fork: true })
    ws.close()
  })

  it('session.fork resets onto the forked session', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'session.fork' }))

    await waitFor(() =>
      messages.some((m) => m.event?.type === 'session.reset' && m.event.reason === 'fork')
    )
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

  it('sets an arbitrary config option and publishes the full config state', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const { ws, messages } = await connect()
    await waitFor(
      () =>
        messages.some((m) => m.type === 'state' && m.key === 'config' && m.value?.length > 0)
    )
    ws.send(JSON.stringify({ type: 'config', id: 'thought_level', value: 'high' }))
    await waitFor(() =>
      messages.some(
        (m) =>
          m.type === 'state' &&
          m.key === 'config' &&
          m.value?.some((o: any) => o.id === 'thought_level' && o.currentValue === 'high')
      )
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

describe('capability manifest', () => {
  const manifestFor = async (body: string | null) => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-man-'))
    const user = join(dir, 'capabilities.toml')
    if (body !== null) await writeFile(user, body)
    return { dir, user, root: join(dir, 'absent-root.toml'), audit: join(dir, 'audit.log') }
  }

  const start = async (paths: { root: string; user: string; audit: string }) => {
    core = await startCore({
      port: 0,
      backend: 'fake:permission',
      manifestRoot: paths.root,
      manifestUser: paths.user,
      auditPath: paths.audit,
    })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    return { ws, messages }
  }

  const resolved = (messages: any[]) =>
    messages.find((m) => m.event?.type === 'permission.resolved')?.event

  it('allows a granted tool call without asking the UI', async () => {
    const paths = await manifestFor(
      '[policy]\nenabled = true\n[capabilities.shell]\ndecision = "allow"\ncommands = ["ls *"]\n'
    )
    const { ws, messages } = await start(paths)
    ws.send(JSON.stringify({ type: 'prompt', text: 'go' }))

    await waitFor(() => resolved(messages))
    expect(resolved(messages)).toMatchObject({ capability: 'shell', subject: 'ls -la', decision: 'allow' })
    expect(messages.some((m) => m.event?.type === 'permission.requested')).toBe(false)
    await waitFor(() => messages.some((m) => m.event?.type === 'chunk' && m.event.text === 'after'))
    ws.close()
    await rm(paths.dir, { recursive: true, force: true })
  })

  it('denies a tool call the manifest does not grant, and the turn continues', async () => {
    const paths = await manifestFor(
      '[policy]\nenabled = true\n[capabilities.shell]\ndecision = "allow"\ncommands = ["git *"]\n'
    )
    const { ws, messages } = await start(paths)
    ws.send(JSON.stringify({ type: 'prompt', text: 'go' }))

    await waitFor(() => resolved(messages))
    expect(resolved(messages)).toMatchObject({ capability: 'shell', decision: 'deny' })
    await waitFor(() => messages.some((m) => m.event?.type === 'chunk' && m.event.text === 'denied'))
    ws.close()
    await rm(paths.dir, { recursive: true, force: true })
  })

  it('writes the decision to the audit log', async () => {
    const paths = await manifestFor('[policy]\nenabled = true\n[capabilities.shell]\ndecision = "allow"\n')
    const { ws, messages } = await start(paths)
    ws.send(JSON.stringify({ type: 'prompt', text: 'go' }))
    await waitFor(() => resolved(messages))
    await new Promise((r) => setTimeout(r, 150))
    const line = JSON.parse((await readFile(paths.audit, 'utf8')).trim().split('\n')[0] as string)
    expect(line).toMatchObject({ source: 'manifest', capability: 'shell', decision: 'allow' })
    ws.close()
    await rm(paths.dir, { recursive: true, force: true })
  })

  it('leaves the decision to the UI when the manifest is off', async () => {
    const paths = await manifestFor(null)
    const { ws, messages } = await start(paths)
    ws.send(JSON.stringify({ type: 'prompt', text: 'go' }))

    await waitFor(() => messages.some((m) => m.event?.type === 'permission.requested'))
    const request = messages.find((m) => m.event?.type === 'permission.requested').event
    expect(resolved(messages)).toBeUndefined()
    ws.send(JSON.stringify({ type: 'permission', requestId: request.requestId, decision: 'allow' }))
    await waitFor(() => messages.some((m) => m.event?.type === 'chunk' && m.event.text === 'after'))
    ws.close()
    await rm(paths.dir, { recursive: true, force: true })
  })
})

describe('profiles (surfaces)', () => {
  it('serves a layout, theme and component set per surface', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-surface-'))
    await mkdir(join(dir, 'profiles', 'phone', 'components'), { recursive: true })
    await writeFile(join(dir, 'layout.json'), JSON.stringify({ type: 'row', children: [] }))
    await writeFile(join(dir, 'profiles', 'phone', 'layout.json'), JSON.stringify({ type: 'column', children: [] }))
    await mkdir(join(dir, 'components'), { recursive: true })
    await writeFile(join(dir, 'components', 'panel.js'), 'base panel')
    await writeFile(join(dir, 'profiles', 'phone', 'components', 'panel.js'), 'phone panel')
    await writeFile(join(dir, 'profiles', 'phone', 'components', 'mobile.js'), 'mobile only')

    core = await startCore({ port: 0, backend: 'fake:happy', configDir: dir })

    const base = (await fetch(`http://127.0.0.1:${core.port}/layout`).then((r) => r.json())) as any
    const phone = (await fetch(`http://127.0.0.1:${core.port}/layout?profile=phone`).then((r) => r.json())) as any
    expect(base.type).toBe('row')
    expect(phone.type).toBe('column')

    const list = (await fetch(`http://127.0.0.1:${core.port}/components?profile=phone`).then((r) =>
      r.json()
    )) as any
    expect(list.components).toEqual(['mobile', 'panel'])

    const source = await fetch(`http://127.0.0.1:${core.port}/components/panel.js?profile=phone`).then((r) =>
      r.text()
    )
    expect(source).toBe('phone panel')

    await rm(dir, { recursive: true, force: true })
  })
})

describe('state store', () => {
  it('persists a state.set, broadcasts it, and serves it over HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-store-'))
    core = await startCore({ port: 0, backend: 'fake:happy', configDir: dir })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    // Attach before open: the connect snapshot is sent immediately.
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    await once(ws, 'open')

    // The whole store is sent on connect, so a component never starts blind.
    await waitFor(() => messages.some((m) => m.type === 'state' && m.key === 'store'))
    ws.send(JSON.stringify({ type: 'state.set', key: 'density', value: 'compact' }))

    await waitFor(() =>
      messages.some((m) => m.type === 'state' && m.key === 'store' && m.value?.density === 'compact')
    )
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual({ density: 'compact' })

    const http = (await fetch(`http://127.0.0.1:${core.port}/state`).then((r) => r.json())) as any
    expect(http.state).toEqual({ density: 'compact' })
    ws.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an invalid key without touching the store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-store-'))
    core = await startCore({ port: 0, backend: 'fake:happy', configDir: dir })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'state.set', key: 'bad key', value: 1 }))
    await new Promise((r) => setTimeout(r, 50))
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toEqual({})
    ws.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('backend validation', () => {
  it('refuses an unknown backend at startup', async () => {
    await expect(startCore({ port: 0, backend: 'nope' })).rejects.toThrow(/not runnable/)
  })
})

describe('file routes', () => {
  let tree: TempTree | undefined
  let repo: TempRepo | undefined

  afterEach(async () => {
    await tree?.cleanup()
    await repo?.cleanup()
    tree = undefined
    repo = undefined
  })

  // No prompt is ever sent: the file routes must answer without an agent.
  const up = async (cwd: string) => {
    core = await startCore({ port: 0, backend: 'fake:happy', cwd })
  }
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${core!.port}${path}`, { headers })
  const query = (root: string, path = '') =>
    `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`

  it('lists a directory, one level, never cached', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files/tree?${query(tree.root)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as any
    const names = body.entries.map((e: any) => e.name)
    expect(names).toEqual(expect.arrayContaining(['a.txt', 'sub', '.hidden']))
    expect(names).not.toContain('b.ts')
  })

  it('reads a file', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files?${query(tree.root, 'a.txt')}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as any).text).toBe('hello\nworld\n')
  })

  it('reports the diff of one path in a repository', async () => {
    repo = await makeTempRepo()
    await up(repo.root)
    const res = await get(`/files/diff?${query(repo.root, 'a.txt')}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).patch).toContain('+two')
  })

  it('refuses a root the session does not know', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files/tree?${query(tmpdir())}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'root-not-known' })
  })

  it('refuses a name-prefix sibling of a known root', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files/tree?${query(tree.sibling)}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'root-not-known' })
  })

  it('refuses .. traversal out of the root', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files?${query(tree.root, '../outside/secret.txt')}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'escapes-root' })
  })

  it('refuses an absolute path even when it points inside the root', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files?${query(tree.root, join(tree.root, 'a.txt'))}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'absolute-path' })
  })

  it('refuses a symlink that points outside the root', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files?${query(tree.root, 'link-out')}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'escapes-root' })
  })

  it('answers 404 for a missing file', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files?${query(tree.root, 'nope.txt')}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'missing' })
  })

  it('answers 409 for a diff outside a repository', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files/diff?${query(tree.root, 'a.txt')}`)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'no-git' })
  })

  it('refuses a foreign origin on the file routes, under the origin guard', async () => {
    tree = await makeTempTree()
    await up(tree.root)
    const res = await get(`/files/tree?${query(tree.root)}`, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })
})

describe('core server: @path:lines mentions', () => {
  let tree: TempTree

  afterEach(async () => {
    await tree?.cleanup()
  })

  it("'@a.txt:1-2' is resolved in the core: a context event, and the text reaches the agent unchanged", async () => {
    tree = await makeTempTree()
    core = await startCore({ port: 0, backend: 'fake:happy', cwd: tree.root })
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const messages: any[] = []
    await once(ws, 'open')
    ws.on('message', (data) => messages.push(JSON.parse(String(data))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'read @a.txt:1-2 please' }))

    await waitFor(() => messages.some((m) => m.event?.type === 'turn.finished'))
    const context = messages.filter((m) => m.event?.type === 'context').map((m) => m.event)
    expect(context).toEqual([
      { type: 'context', mention: '@a.txt:1-2', status: 'included', lines: { start: 1, end: 2 } },
    ])
    const text = messages.filter((m) => m.event?.type === 'chunk').map((m) => m.event.text).join('')
    expect(text).toContain('read @a.txt:1-2 please')
    ws.close()
  })
})
