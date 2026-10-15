import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { injectGlobals, startPhoneServer, type PhoneServer } from './phone-server.ts'

let phone: PhoneServer | undefined
let core: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await phone?.close()
  phone = undefined
  if (core) {
    core.closeAllConnections?.()
    await new Promise<void>((resolve) => core?.close(() => resolve()))
    core = undefined
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

async function fakeCore(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (path === '/layout') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"type":"column","marker":"core"}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return { server, port: typeof address === 'object' && address !== null ? address.port : 0 }
}

async function builtClient(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sbh-phone-dist-'))
  await writeFile(join(d, 'index.html'), '<!doctype html><html><head><title>SBH</title></head><body>app</body></html>')
  await mkdir(join(d, 'assets'))
  await writeFile(join(d, 'assets', 'app.js'), 'console.log("app")')
  return d
}

describe('injectGlobals', () => {
  it('declares the surface and a same-origin core URL, before the app runs', () => {
    const html = injectGlobals('<html><head></head><body></body></html>', 'phone')
    expect(html).toContain('__SBH_PROFILE__="phone"')
    expect(html).toContain('location.host+"/ws"')
    expect(html.indexOf('__SBH_PROFILE__')).toBeLessThan(html.indexOf('</head>'))
  })
})

describe('phone server', () => {
  it('serves the client, proxies the core, and bridges the socket', async () => {
    const fake = await fakeCore()
    core = fake.server
    dir = await builtClient()
    phone = await startPhoneServer({ coreUrl: `ws://127.0.0.1:${fake.port}/ws`, distDir: dir, port: 0 })
    const base = `http://127.0.0.1:${phone.port}`

    // Core routes are proxied.
    expect(await fetch(`${base}/health`).then((r) => r.json())).toEqual({ ok: true })
    expect(await fetch(`${base}/layout?profile=phone`).then((r) => r.json())).toMatchObject({ marker: 'core' })

    // The client is served with its surface declared.
    const index = await fetch(`${base}/`).then((r) => r.text())
    expect(index).toContain('__SBH_PROFILE__="phone"')
    expect(index).toContain('window.__SBH_CORE_URL__')

    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toContain('console.log')

    // An extensionless route falls back to the app entry.
    const route = await fetch(`${base}/settings`, { headers: { accept: 'text/html' } })
    expect(await route.text()).toContain('__SBH_PROFILE__')

    // Nothing escapes the dist root.
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).toBe(404)

    // The socket is bridged to the core.
    const ws = new WebSocket(`ws://127.0.0.1:${phone.port}/ws`)
    await once(ws, 'open')
    const echoed = new Promise<string>((resolve) => ws.on('message', (data) => resolve(String(data))))
    ws.send('ping')
    expect(await echoed).toBe('ping')
    ws.close()
  })
})
