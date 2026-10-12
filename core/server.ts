/**
 * The core: the only process that spawns agents and the only one that answers
 * permissions. It exposes normalized UI events over WebSocket on loopback, so a
 * later phone/PWA client is just another client rather than a second backend.
 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { connectAcp, type AcpConnection } from './acp/client.ts'
import { resolveBackend } from './backends/registry.ts'
import { DENY_BY_DEFAULT, respondToPermission, type PermissionPolicy } from './acp/permissions.ts'
import type { UiEvent } from './events.ts'

/**
 * The scripted fixture (test seam), resolved from the repo root.
 *
 * Not derived from `import.meta.url`: under Vitest that URL is not `file:`, so
 * `fileURLToPath` throws before a single test runs.
 */
const FIXTURE = resolve(process.cwd(), 'test/fixtures/fake-acp-agent.ts')

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export interface CoreOptions {
  host?: string
  /** 0 picks a free port. */
  port?: number
  /** Registry id, or `fake:<scenario>` to drive the scripted fixture. */
  backend?: string
  cwd?: string
  policy?: PermissionPolicy
}

export interface Core {
  port: number
  close(): Promise<void>
}

export async function startCore(options: CoreOptions = {}): Promise<Core> {
  const host = options.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host)) {
    throw new Error(`SBH core refuses to bind anything but loopback (got ${host})`)
  }

  const backend = options.backend ?? 'pi'
  const cwd = options.cwd ?? process.cwd()
  const policy = options.policy ?? DENY_BY_DEFAULT

  const clients = new Set<WebSocket>()
  let conn: AcpConnection | null = null

  const broadcast = (event: UiEvent) => {
    const payload = JSON.stringify({ type: 'event', event })
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  const agentSpec = (() => {
    if (backend.startsWith('fake:')) {
      return { command: process.execPath, args: [FIXTURE, backend.slice('fake:'.length)], cwd }
    }
    return { ...resolveBackend(backend), cwd }
  })()

  const ensureConnection = (): AcpConnection => {
    if (conn) return conn
    const created = connectAcp(agentSpec)
    created.onEvent((event) => {
      if (event.type === 'permission.requested' && clients.size === 0) {
        // The gate is still answered — by the policy, not by silence.
        const decided = policy({ requestId: event.requestId, title: event.title })
        void respondToPermission(created, event.requestId, decided === 'allow' ? 'allow' : 'deny')
      }
      broadcast(event)
    })
    conn = created
    return created
  }

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server: http, path: '/ws' })

  wss.on('connection', (socket) => {
    clients.add(socket)

    socket.on('message', (raw) => {
      let msg: any
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }

      if (msg.type === 'prompt' && typeof msg.text === 'string') {
        if (!msg.text.trim()) return
        void ensureConnection().prompt(msg.text)
        return
      }

      if (msg.type === 'permission' && typeof msg.requestId === 'string') {
        const decision = msg.decision === 'allow' ? 'allow' : 'deny'
        void respondToPermission(ensureConnection(), msg.requestId, decision)
      }
    })

    socket.on('close', () => clients.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? 0, host, () => resolve())
  })

  const address = http.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    async close() {
      conn?.close()
      for (const client of clients) client.terminate()
      clients.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
