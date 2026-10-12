/**
 * The core: the only process that spawns agents and the only one that answers
 * permissions. It exposes normalized UI events over WebSocket on loopback, so a
 * later phone/PWA client is just another client rather than a second backend.
 */
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { connectAcp, type AcpConnection } from './acp/client.ts'
import { resolveBackend } from './backends/registry.ts'
import { ensureComponentsDir, listComponents, readComponent } from './components.ts'
import { ensureThemeFile, readTheme } from './theme.ts'
import { ensureRepo, history, revertLast, snapshot } from './versioning.ts'
import { watchPaths } from './watch.ts'
import { DENY_BY_DEFAULT, respondToPermission, type PermissionPolicy } from './acp/permissions.ts'
import type { UiEvent } from './events.ts'

/**
 * The scripted fixture (test seam).
 *
 * Resolved from the package root, not `process.cwd()`: the core is expected to
 * run from anywhere, and a wrong cwd silently turned into "agent exited with
 * code 1" during the browser smoke test. `import.meta.dirname` is unavailable
 * under Vitest, where cwd is already the package root.
 */
const HERE = (import.meta as ImportMeta & { dirname?: string }).dirname
const FIXTURE = resolve(HERE ? resolve(HERE, '..') : process.cwd(), 'test/fixtures/fake-acp-agent.ts')

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export interface CoreOptions {
  host?: string
  /** 0 picks a free port. */
  port?: number
  /** Registry id, or `fake:<scenario>` to drive the scripted fixture. */
  backend?: string
  cwd?: string
  policy?: PermissionPolicy
  /** Where agent-authored component modules live. */
  componentsDir?: string
  /** Config root; theme.json and components/ live under it. */
  configDir?: string
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
  const configDir = options.configDir ?? process.env.SBH_CONFIG_DIR ?? join(homedir(), '.config', 'sbh')
  const componentsDir = options.componentsDir ?? join(configDir, 'components')
  await ensureComponentsDir(componentsDir)
  await ensureThemeFile(configDir)
  await ensureRepo(configDir)

  const clients = new Set<WebSocket>()
  let conn: AcpConnection | null = null

  const broadcast = (event: UiEvent) => sendToAll({ type: 'event', event })

  const sendToAll = (message: unknown) => {
    const payload = JSON.stringify(message)
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
    const url = req.url ?? ''

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'GET' && url === '/theme') {
      void readTheme(configDir).then((theme) => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify(theme))
      })
      return
    }

    // Agent-authored components. CORS is open because the webview may be served
    // from a different origin (Vite in dev, tauri:// in the app); the listener is
    // loopback-only.
    if (req.method === 'GET' && url === '/components') {
      void listComponents(componentsDir).then((components) => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify({ components }))
      })
      return
    }

    const match = /^\/components\/([A-Za-z0-9_-]+)\.js$/.exec(url)
    if (req.method === 'GET' && match) {
      void readComponent(componentsDir, match[1] as string).then((source) => {
        if (source === null) {
          res.writeHead(404, { 'access-control-allow-origin': '*' })
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'text/javascript',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        res.end(source)
      })
      return
    }

    if (req.method === 'GET' && url === '/history') {
      void history(configDir).then((commits) => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify({ commits }))
      })
      return
    }

    if (req.method === 'POST' && url === '/revert') {
      void revertLast(configDir).then((reverted) => {
        if (reverted) {
          sendToAll({ type: 'invalidate', what: 'components' })
          sendToAll({ type: 'invalidate', what: 'theme' })
        }
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify({ reverted }))
      })
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

  // Hot reload: tell clients to re-fetch rather than pushing the content, so the
  // client keeps ownership of import/validation/registration. Each settled change
  // is committed first, so "revert what the agent just did" has a target.
  const componentWatcher = watchPaths([componentsDir], (changed) => {
    void snapshot(configDir, `sbh: component ${changed}`).then(() =>
      sendToAll({ type: 'invalidate', what: 'components' })
    )
  })
  const configWatcher = watchPaths([configDir], (changed) => {
    // `.git` lives inside the watched directory, and committing writes there:
    // without this filter the watcher retriggers on its own snapshots.
    if (changed.startsWith('.git')) return
    if (changed === 'theme.json' || changed === configDir) {
      void snapshot(configDir, 'sbh: theme changed').then(() =>
        sendToAll({ type: 'invalidate', what: 'theme' })
      )
    }
  })

  const address = http.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    async close() {
      componentWatcher.close()
      configWatcher.close()
      conn?.close()
      for (const client of clients) client.terminate()
      clients.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
