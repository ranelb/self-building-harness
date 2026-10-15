/**
 * The core: the only process that spawns agents and the only one that answers
 * permissions. It exposes normalized UI events over WebSocket on loopback, so a
 * later phone/PWA client is just another client rather than a second backend.
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { connectAcp, type AcpConnection, type AcpSessionInfo } from './acp/client.ts'
import { BACKEND_IDS, resolveBackend } from './backends/registry.ts'
import { ensureComponentsDir } from './components.ts'
import {
  isProfileName,
  listProfileComponents,
  profileComponentsDir,
  profilesDir,
  readProfileComponent,
} from './profile.ts'
import { ensureLayoutFile, readLayout } from './layout.ts'
import { listSessions, readSession, type SessionSummary } from './sessions.ts'
import { ensureThemeFile, readTheme } from './theme.ts'
import { sampleSystem } from './system.ts'
import { ensureRepo, history, revertLast, snapshot } from './versioning.ts'
import { watchPaths } from './watch.ts'
import { DENY_BY_DEFAULT, respondToPermission, type PermissionPolicy } from './acp/permissions.ts'
import {
  appendAudit,
  classifyToolCall,
  evaluate,
  loadManifest,
  ROOT_MANIFEST,
} from './capabilities.ts'
import { isOriginAllowed, resolveAllowedOrigins } from './origin.ts'
import type { PermissionRequest, SessionConfigOption, UiEvent } from '../shared/protocol.ts'

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

/**
 * Whether a backend id can actually run here.
 *
 * A `fake:` backend spawns the scripted fixture; in a packaged core that file is
 * not on disk, and spawning `process.execPath` would just re-exec the core as a
 * nested server. Say no instead, so the failure is legible.
 */
const isRunnableBackend = (id: string): boolean => {
  if (id.startsWith('fake:')) return existsSync(FIXTURE)
  try {
    resolveBackend(id)
    return true
  } catch {
    return false
  }
}

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
  /** How often to publish a machine sample. 0 disables it. */
  sampleIntervalMs?: number
  /** Where the harness keeps its sessions. Read-only, always. */
  sessionsRoot?: string
  /** Browser origins allowed to reach this core. Overrides the default set. */
  allowedOrigins?: readonly string[]
  /** Root-owned capability manifest. Defaults to `/etc/sbh/capabilities.toml`. */
  manifestRoot?: string
  /** User manifest, consulted only when the root one is absent (development). */
  manifestUser?: string
  /** Where the permission audit log is appended. */
  auditPath?: string
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

  let backendId = options.backend ?? 'pi'
  if (!isRunnableBackend(backendId)) {
    throw new Error(
      `backend ${backendId} is not runnable here` +
        (backendId.startsWith('fake:') ? ' (fake backends need the repo test fixture)' : '')
    )
  }
  const cwd = options.cwd ?? process.cwd()
  const policy = options.policy ?? DENY_BY_DEFAULT
  const configDir = options.configDir ?? process.env.SBH_CONFIG_DIR ?? join(homedir(), '.config', 'sbh')
  const componentsDir = options.componentsDir ?? join(configDir, 'components')
  const sessionsRoot =
    options.sessionsRoot ?? process.env.SBH_SESSIONS_DIR ?? join(homedir(), '.pi', 'agent', 'sessions')
  const allowedOrigins = resolveAllowedOrigins(options.allowedOrigins)
  const manifestRoot = options.manifestRoot ?? ROOT_MANIFEST
  const manifestUser = options.manifestUser ?? join(configDir, 'capabilities.toml')
  const auditPath =
    options.auditPath ??
    join(process.env.SBH_STATE_DIR ?? join(homedir(), '.local', 'state', 'sbh'), 'audit.log')
  await ensureComponentsDir(componentsDir)
  await ensureThemeFile(configDir)
  await ensureLayoutFile(configDir)
  await ensureRepo(configDir)
  await ensureComponentsDir(profilesDir(configDir))

  const clients = new Set<WebSocket>()
  /** Which surface each socket declared, for scoped hot-reload. */
  const clientProfiles = new Map<WebSocket, string>()
  let conn: AcpConnection | null = null
  /** Set when the next connection should resume a session rather than create one. */
  let resumeTarget: { sessionId: string; cwd: string } | null = null
  /** The latest session config options, so a new client can be told the model. */
  let configOptions: SessionConfigOption[] = []
  /** Unresolved UI-owned decisions, so their answers can be audited with context. */
  const awaitingUi = new Map<string, { title: string; capability: string }>()
  /** The manifest's audit flag, refreshed on every load; true when disabled. */
  let auditEnabled = true

  const broadcast = (event: UiEvent) => sendToAll({ type: 'event', event })

  const sendToAll = (message: unknown) => {
    const payload = JSON.stringify(message)
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  /**
   * Scope a hot-reload. A base change affects every surface, so it goes to all; a
   * profile change goes only to clients that declared it, so editing the phone
   * layout does not churn the desktop window.
   */
  const invalidate = (what: 'components' | 'theme' | 'layout', profile?: string) => {
    const payload = JSON.stringify({ type: 'invalidate', what, ...(profile ? { profile } : {}) })
    for (const client of clients) {
      if (profile && clientProfiles.get(client) !== profile) continue
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  const backendSpec = (id: string) => {
    if (id.startsWith('fake:')) {
      return { command: process.execPath, args: [FIXTURE, id.slice('fake:'.length)], cwd }
    }
    return { ...resolveBackend(id), cwd }
  }

  const label = (id: string) => id.charAt(0).toUpperCase() + id.slice(1)
  const harnessState = () => ({
    value: backendId,
    options: BACKEND_IDS.map((id) => ({ value: id, label: label(id) })),
  })
  const modelState = () => {
    const model = configOptions.find((option) => option.category === 'model')
    return model ? { value: model.currentValue, options: model.options } : { value: '', options: [] }
  }

  const audit = (entry: Parameters<typeof appendAudit>[1]) => {
    if (auditEnabled) void appendAudit(auditPath, entry)
  }

  /**
   * Judge a permission request. With the manifest on, the core answers and the UI
   * is only told the outcome; with it off, the UI decides (or the policy does when
   * nobody is connected). Never leaves the agent hanging.
   */
  const handlePermission = async (
    connection: AcpConnection,
    event: PermissionRequest
  ): Promise<void> => {
    const { manifest } = await loadManifest({ rootPath: manifestRoot, userPath: manifestUser })
    auditEnabled = manifest.enabled ? manifest.audit : true

    if (manifest.enabled) {
      const classification = classifyToolCall(event)
      const verdict = evaluate(manifest, classification)
      await respondToPermission(connection, event.requestId, verdict.decision)
      awaitingUi.delete(event.requestId)
      audit({
        at: new Date().toISOString(),
        source: 'manifest',
        capability: classification.capability,
        ...(classification.subject ? { subject: classification.subject } : {}),
        decision: verdict.decision,
        reason: verdict.reason,
        title: event.title,
      })
      broadcast({
        type: 'permission.resolved',
        requestId: event.requestId,
        title: event.title,
        capability: classification.capability,
        ...(classification.subject ? { subject: classification.subject } : {}),
        decision: verdict.decision,
        reason: verdict.reason,
      })
      return
    }

    if (clients.size === 0) {
      // Nobody to ask. The gate is still answered — by the policy, not by silence.
      const decided = policy({ requestId: event.requestId, title: event.title })
      const decision = decided === 'allow' ? 'allow' : 'deny'
      await respondToPermission(connection, event.requestId, decision)
      const classification = classifyToolCall(event)
      audit({
        at: new Date().toISOString(),
        source: 'unattended',
        capability: classification.capability,
        ...(classification.subject ? { subject: classification.subject } : {}),
        decision,
        reason: 'no client connected',
        title: event.title,
      })
      return
    }

    awaitingUi.set(event.requestId, {
      title: event.title,
      capability: classifyToolCall(event).capability,
    })
    broadcast(event)
  }

  const ensureConnection = (): AcpConnection => {
    if (conn) return conn
    const created = connectAcp({
      ...backendSpec(backendId),
      ...(resumeTarget ? { resume: resumeTarget } : {}),
    })
    resumeTarget = null
    created.onEvent((event) => {
      if (event.type === 'permission.requested') {
        void handlePermission(created, event)
        return
      }
      if (event.type === 'config') {
        configOptions = event.options
        sendToAll({ type: 'state', key: 'model', value: modelState() })
      }
      broadcast(event)
    })
    conn = created
    return created
  }

  /** Switch backends by reconnecting; nothing is spawned until it is needed. */
  const switchBackend = (id: string) => {
    // Validate before tearing anything down: an unknown id must not kill the app.
    if (!isRunnableBackend(id)) return
    if (id === backendId && conn) return
    conn?.close()
    conn = null
    resumeTarget = null
    configOptions = []
    backendId = id
    sendToAll({ type: 'state', key: 'harness', value: harnessState() })
    sendToAll({ type: 'state', key: 'model', value: modelState() })
  }

  /**
   * Attach the agent to an existing session. A fresh connection loads it, and the
   * agent's replayed `session/update`s rebuild the transcript for every client.
   */
  const resumeSession = (id: string, sessionCwd: string) => {
    conn?.close()
    conn = null
    resumeTarget = { sessionId: id, cwd: sessionCwd || cwd }
    void ensureConnection().open()
  }

  const startNewSession = () => {
    // Settle the in-flight turn before tearing the connection down, so a cancelled
    // turn is never attributed to the session the client has stopped showing.
    void conn?.cancel().catch(() => {})
    conn?.close()
    conn = null
    resumeTarget = null
    configOptions = []
    void ensureConnection().open()
    broadcast({ type: 'session.reset', reason: 'new' })
  }

  const toUiSession = (session: SessionSummary) => ({
    id: session.id,
    cwd: session.cwd,
    title: session.title || '(untitled)',
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
  })

  /**
   * The agent's own view of its session store. Returns null when it cannot list
   * (an older agent), so the caller can fall back to reading pi's files.
   */
  const acpSessions = async (): Promise<SessionSummary[] | null> => {
    try {
      const connection = ensureConnection()
      const all: AcpSessionInfo[] = []
      let cursor: string | undefined
      for (let page = 0; page < 5; page += 1) {
        const result = await connection.list(cursor)
        all.push(...result.sessions)
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      return all.map((session) => ({
        id: session.sessionId,
        path: '',
        cwd: session.cwd,
        startedAt: session.updatedAt,
        updatedAt: session.updatedAt,
        title: session.title,
      }))
    } catch {
      return null
    }
  }

  const http = createServer((req, res) => {
    // The client appends a cache-buster to module URLs, so parse the query rather
    // than splitting it off. `profile` selects the surface (see core/profile.ts).
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const url = requestUrl.pathname
    const requested = requestUrl.searchParams.get('profile')
    const profile = isProfileName(requested) ? requested : undefined
    const profileDir = profile ? profileComponentsDir(configDir, profile) : null

    // The origin guard runs before routing: a browser that sends an Origin we do
    // not trust is refused everything, reads included. A request with no Origin
    // is a non-browser client (tests, curl) and is allowed.
    const origin = req.headers.origin
    if (!isOriginAllowed(origin, allowedOrigins)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'origin not allowed' }))
      return
    }
    // Echo the caller's origin rather than `*`, so only an allowed page can read
    // a response even if the allowlist is later loosened.
    if (origin) res.setHeader('access-control-allow-origin', origin)

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'GET' && url === '/theme') {
      void readTheme(configDir, profile).then((theme) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(theme))
      })
      return
    }

    // Agent-authored components. CORS is open because the webview may be served
    // from a different origin (Vite in dev, tauri:// in the app); the listener is
    // loopback-only.
    if (req.method === 'GET' && url === '/components') {
      void listProfileComponents(componentsDir, profileDir).then((components) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ components }))
      })
      return
    }

    const match = /^\/components\/([A-Za-z0-9_-]+)\.js$/.exec(url)
    if (req.method === 'GET' && match) {
      void readProfileComponent(componentsDir, match[1] as string, profileDir).then((source) => {
        if (source === null) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'text/javascript',
          'cache-control': 'no-store',
        })
        res.end(source)
      })
      return
    }

    if (req.method === 'GET' && url === '/layout') {
      void readLayout(configDir, profile).then((layout) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(layout))
      })
      return
    }

    if (req.method === 'GET' && url === '/backends') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          backends: BACKEND_IDS.map((id) => ({ id, label: label(id) })),
          value: backendId,
        })
      )
      return
    }

    if (req.method === 'GET' && url === '/sessions') {
      void (async () => {
        // The agent's own store first (also the only one goose has); pi's files are
        // the fallback for an agent that cannot list.
        const sessions = (await acpSessions()) ?? (await listSessions(sessionsRoot))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sessions: sessions.map(toUiSession) }))
      })()
      return
    }

    const sessionMatch = /^\/sessions\/([A-Za-z0-9_-]+)$/.exec(url)
    if (req.method === 'GET' && sessionMatch) {
      void readSession(sessionsRoot, sessionMatch[1] as string).then((detail) => {
        if (!detail) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(detail))
      })
      return
    }

    if (req.method === 'GET' && url === '/history') {
      void history(configDir).then((commits) => {
        res.writeHead(200, { 'content-type': 'application/json' })
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
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ reverted }))
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    // Same guard on the upgrade: a web page can open a WebSocket cross-origin,
    // and this socket drives the agent. Node's `ws` client sends no Origin, so
    // the test suite and CLI clients are unaffected.
    verifyClient: (info, cb) => {
      if (isOriginAllowed(info.origin, allowedOrigins)) cb(true)
      else cb(false, 403, 'origin not allowed')
    },
  })

  wss.on('connection', (socket) => {
    clients.add(socket)
    // A fresh client needs the current pickers before it asks anything.
    socket.send(JSON.stringify({ type: 'state', key: 'harness', value: harnessState() }))
    socket.send(JSON.stringify({ type: 'state', key: 'model', value: modelState() }))
    // The model list only arrives with a session (`session/new` carries
    // `configOptions`), so open one now. pi does not write a session file until
    // the first message; goose does create an empty row.
    void ensureConnection().open()

    socket.on('message', (raw) => {
      let msg: any
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }

      if (msg.type === 'client.hello' && isProfileName(msg.profile)) {
        clientProfiles.set(socket, msg.profile)
        return
      }

      if (msg.type === 'prompt' && typeof msg.text === 'string') {
        if (!msg.text.trim()) return
        void ensureConnection().prompt(msg.text)
        return
      }

      if (msg.type === 'cancel') {
        void ensureConnection().cancel()
        return
      }

      if (msg.type === 'session.new') {
        startNewSession()
        return
      }

      if (msg.type === 'permission' && typeof msg.requestId === 'string') {
        const decision = msg.decision === 'allow' ? 'allow' : 'deny'
        void respondToPermission(ensureConnection(), msg.requestId, decision)
        const meta = awaitingUi.get(msg.requestId)
        awaitingUi.delete(msg.requestId)
        audit({
          at: new Date().toISOString(),
          source: 'ui',
          capability: meta?.capability ?? 'other',
          decision,
          reason: 'answered in the UI',
          title: meta?.title ?? '',
        })
        return
      }

      if (msg.type === 'backend' && typeof msg.id === 'string') {
        switchBackend(msg.id)
        return
      }

      if (msg.type === 'model' && typeof msg.id === 'string') {
        void ensureConnection().setConfigOption('model', msg.id)
        return
      }

      if (msg.type === 'session.resume' && typeof msg.id === 'string') {
        resumeSession(msg.id, typeof msg.cwd === 'string' ? msg.cwd : '')
      }
    })

    socket.on('close', () => {
      clients.delete(socket)
      clientProfiles.delete(socket)
    })
  })

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? 0, host, () => resolve())
  })

  // Hot reload: tell clients to re-fetch rather than pushing the content, so the
  // client keeps ownership of import/validation/registration. Each settled change
  // is committed first, so "revert what the agent just did" has a target.
  const componentWatcher = watchPaths([componentsDir], (changed) => {
    void snapshot(configDir, `sbh: component ${changed}`).then(() => invalidate('components'))
  })

  /** Which surface (and what kind) a changed config path belongs to. */
  const classifyChange = (
    changed: string
  ): { what: 'components' | 'theme' | 'layout'; profile?: string } | null => {
    const parts = changed.split(/[\\/]/)
    if (parts[0] === 'profiles' && parts[1] && isProfileName(parts[1])) {
      const rest = parts.slice(2).join('/')
      const profile = parts[1]
      if (rest.endsWith('layout.json')) return { what: 'layout', profile }
      if (rest.endsWith('theme.json')) return { what: 'theme', profile }
      return { what: 'components', profile }
    }
    // Base components are the component watcher's job; anything else here is layout
    // or theme. A profile directory may not exist yet when the watcher starts.
    if (parts[0] === 'components') return null
    if (changed.endsWith('layout.json')) return { what: 'layout' }
    if (changed.endsWith('theme.json')) return { what: 'theme' }
    return null
  }

  // Recursive: profiles live in subdirectories, and a layout edit inside one must
  // reload only that surface.
  const configWatcher = watchPaths(
    [configDir],
    (changed) => {
      // `.git` lives inside the watched directory, and committing writes there:
      // without this filter the watcher retriggers on its own snapshots.
      if (changed.startsWith('.git')) return
      const change = classifyChange(changed)
      if (!change) return
      void snapshot(configDir, `sbh: ${change.what} changed`).then(() =>
        invalidate(change.what, change.profile)
      )
    },
    150,
    true
  )

  // Machine samples ride the same state channel as everything else, so a component
  // can render the CPU without any protocol or core change per widget. Skipped when
  // nobody is connected, and unref'd so it never holds a test process open.
  const sampleIntervalMs = options.sampleIntervalMs ?? 2000
  const sampleTimer =
    sampleIntervalMs > 0
      ? setInterval(() => {
          if (clients.size === 0) return
          sendToAll({ type: 'state', key: 'system', value: sampleSystem() })
        }, sampleIntervalMs)
      : null
  sampleTimer?.unref?.()

  const address = http.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    async close() {
      if (sampleTimer) clearInterval(sampleTimer)
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
