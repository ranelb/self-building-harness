/**
 * The core: the only process that spawns agents and the only one that answers
 * permissions. It exposes normalized UI events over WebSocket on loopback, so a
 * later phone/PWA client is just another client rather than a second backend.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { connectAcp, type AcpConnection, type AcpSessionInfo } from './acp/client.ts'
import { attachmentBlocks } from './attachments.ts'
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
import { listSessions, readSession, readSessionCost, type SessionSummary } from './sessions.ts'
import {
  canonicalRoots,
  FileAccessError,
  gitDiff,
  listTree,
  readText,
  type FileErrorReason,
  type KnownRoot,
} from './files.ts'
import { ensureThemeFile, readTheme } from './theme.ts'
import { ensureStateFile, readState, validateStateEntry, writeState } from './state.ts'
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
  type Decision,
  type ToolCallLike,
} from './capabilities.ts'
import { isOriginAllowed, resolveAllowedOrigins } from './origin.ts'
import { expandMentions, maxPromptContextBytes } from './mentions.ts'
import { runShell, type ShellHandle } from './shell.ts'
import type { AcpContentBlock } from './attachments.ts'
import type { ContextEntry, PermissionRequest, SessionConfigOption, UiEvent } from '../shared/protocol.ts'

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

/** What the judge is asked: a request (agent or shell) and the capability it is judged as. */
interface JudgeInput {
  requestId: string
  title: string
  kind?: unknown
  rawInput?: unknown
  capability: string
  source: 'manifest' | 'shell'
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
  const attachmentsBase = join(
    process.env.SBH_STATE_DIR ?? join(homedir(), '.local', 'state', 'sbh'),
    'attachments'
  )
  /**
   * A session switch (new / resume / fork) is asynchronous. Prompts queue behind it
   * so a prompt sent right after a switch cannot race the connection it replaced.
   */
  let sessionSwitch: Promise<void> = Promise.resolve()
  /** Last capabilities the agent reported; replayed to clients that connect later. */
  let capabilitiesState: {
    image: boolean
    audio: boolean
    embeddedContext: boolean
    fork: boolean
  } | null = null
  await ensureComponentsDir(componentsDir)
  await ensureThemeFile(configDir)
  await ensureLayoutFile(configDir)
  await ensureRepo(configDir)
  await ensureComponentsDir(profilesDir(configDir))
  await ensureStateFile(configDir)

  const clients = new Set<WebSocket>()
  /** Which surface each socket declared, for scoped hot-reload. */
  const clientProfiles = new Map<WebSocket, string>()
  /** The persisted keyed store. The core is its only writer; components only read. */
  let appState = await readState(configDir)
  /** Serialize writes so two rapid `state.set` messages cannot interleave on disk. */
  let stateWrite: Promise<void> = Promise.resolve()
  let conn: AcpConnection | null = null
  /** Set when the next connection should resume a session rather than create one. */
  let resumeTarget: { sessionId: string; cwd: string } | null = null
  /** The cwd the agent's session was spawned in; mentions and `!` commands resolve against it. */
  let sessionCwd = cwd
  /** Live user commands (`!`/`!!`), so a settle can delete and close can kill them. */
  const shells = new Map<string, ShellHandle>()
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

  /** The whole store rides the state channel under one key, so any component reads it. */
  const publishStore = () => sendToAll({ type: 'state', key: 'store', value: appState })

  const backendSpec = (id: string) => {
    if (id.startsWith('fake:')) {
      return { command: process.execPath, args: [FIXTURE, id.slice('fake:'.length)], cwd }
    }
    return { ...resolveBackend(id), cwd }
  }

  /** Client-sent context as text blocks, bounded; a malformed entry is dropped, not trusted. */
  const contextBlocks = (entries: unknown): AcpContentBlock[] => {
    if (!Array.isArray(entries)) return []
    const blocks: AcpContentBlock[] = []
    let bytes = 0
    for (const entry of entries as Partial<ContextEntry>[]) {
      if (typeof entry?.label !== 'string' || typeof entry?.text !== 'string') continue
      const text = `${entry.label}\n${entry.text}`
      bytes += Buffer.byteLength(text)
      if (bytes > maxPromptContextBytes) break
      blocks.push({ type: 'text', text })
    }
    return blocks
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
  /** The full ACP config option set, so a component can reach any of them. */
  const configState = () => configOptions

  const audit = (entry: Parameters<typeof appendAudit>[1]) => {
    if (auditEnabled) void appendAudit(auditPath, entry)
  }

  /**
   * The one judging path: the manifest, the audit line, and the `permission.resolved`
   * broadcast. Returns `undefined` when the manifest is off, so each caller keeps its
   * own no-manifest behaviour (the UI for agent requests, spawn for shell commands).
   * Callers answer the agent or spawn the process; nothing here does either.
   */
  const judge = async (input: JudgeInput): Promise<Decision | undefined> => {
    const { manifest } = await loadManifest({ rootPath: manifestRoot, userPath: manifestUser })
    auditEnabled = manifest.enabled ? manifest.audit : true
    if (!manifest.enabled) return undefined

    const classification = {
      ...classifyToolCall({ kind: input.kind, title: input.title, rawInput: input.rawInput }),
      capability: input.capability,
    }
    const verdict = evaluate(manifest, classification)
    audit({
      at: new Date().toISOString(),
      source: input.source,
      capability: classification.capability,
      ...(classification.subject ? { subject: classification.subject } : {}),
      decision: verdict.decision,
      reason: verdict.reason,
      title: input.title,
    })
    broadcast({
      type: 'permission.resolved',
      requestId: input.requestId,
      title: input.title,
      capability: classification.capability,
      ...(classification.subject ? { subject: classification.subject } : {}),
      decision: verdict.decision,
      reason: verdict.reason,
    })
    return verdict.decision
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
    const call = event as ToolCallLike
    const decision = await judge({
      requestId: event.requestId,
      title: event.title,
      kind: call.kind,
      rawInput: call.rawInput,
      capability: classifyToolCall(call).capability,
      source: 'manifest',
    })
    if (decision !== undefined) {
      await respondToPermission(connection, event.requestId, decision)
      awaitingUi.delete(event.requestId)
      return
    }

    if (clients.size === 0) {
      // Nobody to ask. The gate is still answered — by the policy, not by silence.
      const decided = policy({ requestId: event.requestId, title: event.title })
      const decision = decided === 'allow' ? 'allow' : 'deny'
      await respondToPermission(connection, event.requestId, decision)
      const classification = classifyToolCall(call)
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
      capability: classifyToolCall(call).capability,
    })
    broadcast(event)
  }

  /**
   * pi-acp's `usage_update` carries context occupancy but not price, and pi keeps
   * the price in its own store. Read it (read-only) and fold it into the event so a
   * client sees one usage value with both. Neutral on the wire; pi only in source.
   */
  const enrichUsage = async (
    connection: AcpConnection,
    event: { type: 'usage'; used: number; size: number; cost?: unknown }
  ): Promise<void> => {
    try {
      const id = connection.currentSessionId()
      if (id) {
        const cost = await readSessionCost(sessionsRoot, id)
        if (cost !== null) {
          broadcast({ ...event, cost })
          return
        }
      }
    } catch {
      // fall through to the un-enriched event
    }
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
        sendToAll({ type: 'state', key: 'config', value: configState() })
      }
      if (event.type === 'capabilities') {
        // Not a transcript event: publish it on the state channel so the composer
        // can gate the attacher honestly, and cache it for later clients.
        capabilitiesState = {
          image: event.image,
          audio: event.audio,
          embeddedContext: event.embeddedContext,
          fork: event.fork,
        }
        sendToAll({ type: 'state', key: 'capabilities', value: capabilitiesState })
        return
      }
      if (event.type === 'usage' && event.cost === undefined && backendId === 'pi') {
        void enrichUsage(created, event)
        return
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
    sendToAll({ type: 'state', key: 'config', value: configState() })
  }

  /**
   * Attach the agent to an existing session. A fresh connection loads it, and the
   * agent's replayed `session/update`s rebuild the transcript for every client.
   */
  const resumeSession = (id: string, resumeCwd: string) => {
    sessionSwitch = (async () => {
      conn?.close()
      conn = null
      resumeTarget = { sessionId: id, cwd: resumeCwd || cwd }
      sessionCwd = resumeTarget.cwd
      await ensureConnection().open()
    })()
  }

  const startNewSession = () => {
    sessionSwitch = (async () => {
      // Ask the agent to stop, then drop the connection. The old turn is
      // abandoned, not settled — `close()` does not wait for the cancel to flush.
      await conn?.cancel().catch(() => {})
      conn?.close()
      conn = null
      resumeTarget = null
      sessionCwd = cwd
      configOptions = []
      sendToAll({ type: 'state', key: 'config', value: configState() })
      await ensureConnection().open()
      broadcast({ type: 'session.reset', reason: 'new' })
    })()
  }

  /**
   * Run a `!`/`!!` command in the session cwd and stream it as one tool card. The card
   * is the only record: nothing is buffered here for a later prompt. `includeInContext`
   * is stamped on every event, so no client branch can mistake a `!!` for a `!`.
   */
  const runUserShell = async (command: string, includeInContext: boolean) => {
    const shellId = 'shell-' + randomUUID()
    const title = (includeInContext ? '!' : '!!') + command
    const tool = (over: Partial<Extract<UiEvent, { type: 'tool' }>>) =>
      broadcast({
        type: 'tool',
        toolCallId: shellId,
        title,
        kind: 'execute',
        origin: 'shell',
        includeInContext,
        ...over,
      })
    // A typed command faces the same manifest as the agent's: judged before anything spawns.
    // `ask` is a deny here, as everywhere (there is no click-to-allow for a typed command).
    const verdict = await judge({
      requestId: shellId,
      title: command,
      kind: 'execute',
      rawInput: { command },
      capability: 'shell',
      source: 'shell',
    })
    if (verdict === 'deny') {
      tool({ status: 'failed' })
      return
    }
    tool({ status: 'in_progress' })
    const handle = runShell({
      command,
      cwd: sessionCwd,
      onChunk: ({ text }) => tool({ status: 'in_progress', outputDelta: text }),
    })
    shells.set(shellId, handle)
    void handle.result.then((result) => {
      shells.delete(shellId)
      tool({
        status: result.exitCode === 0 ? 'completed' : 'failed',
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      })
    })
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

  /**
   * Directories the file routes may read: the active cwd plus every session's cwd.
   * Refreshed at most every 5 s. The agent's listing is consulted only when a
   * connection already exists, so a file read never spawns a backend. The set only
   * grows; a failed refresh keeps what was known.
   */
  const knownGivens = new Set<string>()
  let knownSet: KnownRoot[] = []
  let knownAt = -Infinity
  const knownRoots = async (): Promise<KnownRoot[]> => {
    if (Date.now() - knownAt < 5000) return knownSet
    knownAt = Date.now()
    knownGivens.add(sessionCwd)
    try {
      const sessions =
        (conn !== null ? await acpSessions() : null) ?? (await listSessions(sessionsRoot))
      for (const session of sessions) knownGivens.add(session.cwd)
    } catch {
      // keep the roots already known
    }
    knownSet = await canonicalRoots([...knownGivens])
    return knownSet
  }
  const fileErrorStatus: Record<FileErrorReason, number> = {
    'root-not-known': 403,
    'escapes-root': 403,
    'absolute-path': 400,
    'not-a-file': 400,
    'not-a-dir': 400,
    missing: 404,
    'no-git': 409,
    'beyond-cap': 416,
  }
  const fileHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' }

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

    if (req.method === 'GET' && url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ state: appState }))
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

    if (req.method === 'GET' && (url === '/files' || url === '/files/tree' || url === '/files/diff')) {
      const root = requestUrl.searchParams.get('root') ?? ''
      const path = requestUrl.searchParams.get('path') ?? ''
      void (async () => {
        try {
          const roots = await knownRoots()
          const body =
            url === '/files'
              ? await readText(roots, root, path)
              : url === '/files/tree'
                ? await listTree(roots, root, path)
                : await gitDiff(roots, root, path)
          res.writeHead(200, fileHeaders)
          res.end(JSON.stringify(body))
        } catch (error) {
          if (error instanceof FileAccessError) {
            res.writeHead(fileErrorStatus[error.reason], fileHeaders)
            res.end(JSON.stringify({ error: error.reason }))
            return
          }
          res.writeHead(500, fileHeaders)
          res.end(JSON.stringify({ error: 'internal' }))
        }
      })()
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
    socket.send(JSON.stringify({ type: 'state', key: 'config', value: configState() }))
    if (capabilitiesState) {
      socket.send(JSON.stringify({ type: 'state', key: 'capabilities', value: capabilitiesState }))
    }
    socket.send(JSON.stringify({ type: 'state', key: 'store', value: appState }))
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
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : []
        if (!msg.text.trim() && attachments.length === 0) return
        void (async () => {
          try {
            await sessionSwitch
            // A switch may have replaced the connection while we queued.
            const live = ensureConnection()
            // Capabilities arrive with `initialize`; wait for it so an image is not
            // downgraded to a file link just because the handshake had not resolved.
            await live.ready()
            // Mentions resolve against the session cwd, after capabilities are known and
            // before the prompt leaves; the text itself is shipped untouched.
            const mentions = await expandMentions({
              text: msg.text,
              root: sessionCwd,
              roots: await knownRoots(),
              caps: { embeddedContext: live.capabilities().embeddedContext },
            })
            for (const event of mentions.events) broadcast(event)
            const blocks = await attachmentBlocks(join(attachmentsBase, randomUUID()), attachments, {
              image: live.capabilities().image,
            })
            // Client-chosen context (a `!` result the user sent) rides ahead of the prompt.
            // The core holds no shell output of its own: this is the only way it reaches the model.
            await live.prompt(
              msg.text,
              [...contextBlocks(msg.context), ...mentions.blocks, ...blocks],
              { steer: msg.steer === true }
            )
          } catch (error) {
            broadcast({ type: 'error', message: (error as Error).message })
          }
        })()
        return
      }

      if (msg.type === 'shell' && typeof msg.command === 'string') {
        if (!msg.command.trim()) return
        void runUserShell(msg.command, msg.includeInContext === true)
        return
      }

      if (msg.type === 'shell.cancel' && typeof msg.shellId === 'string') {
        shells.get(msg.shellId)?.cancel()
        return
      }

      if (msg.type === 'cancel') {
        void ensureConnection().cancel()
        return
      }

      if (msg.type === 'queue.clear') {
        // Never ensureConnection(): clearing an empty queue must not start an agent.
        conn?.clearQueue()
        return
      }

      if (msg.type === 'session.new') {
        startNewSession()
        return
      }

      if (msg.type === 'session.fork') {
        sessionSwitch = (async () => {
          try {
            const id = await ensureConnection().fork()
            conn?.close()
            conn = null
            resumeTarget = { sessionId: id, cwd }
            sessionCwd = cwd
            configOptions = []
            sendToAll({ type: 'state', key: 'config', value: configState() })
            await ensureConnection().open()
            broadcast({ type: 'session.reset', reason: 'fork' })
          } catch (error) {
            broadcast({ type: 'error', message: (error as Error).message })
          }
        })()
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

      if (msg.type === 'config' && typeof msg.id === 'string' && typeof msg.value === 'string') {
        void ensureConnection().setConfigOption(msg.id, msg.value)
        return
      }

      if (msg.type === 'session.resume' && typeof msg.id === 'string') {
        resumeSession(msg.id, typeof msg.cwd === 'string' ? msg.cwd : '')
      }

      if (msg.type === 'state.set' && typeof msg.key === 'string') {
        // The core only validates and persists; a key's meaning is the component's.
        if (validateStateEntry(msg.key, msg.value) !== null) return
        const next = { ...appState }
        if (msg.value === null) delete next[msg.key]
        else next[msg.key] = msg.value
        appState = next
        stateWrite = stateWrite
          .then(() => writeState(configDir, next))
          .then(() => {
            void snapshot(configDir, `sbh: store ${msg.key}`)
          })
          .catch(() => {})
        publishStore()
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
      if (changed.endsWith('state.json')) {
        // The agent can edit the store directly (it owns the config dir); the
        // core's own writes land here too. Reload and re-broadcast so every
        // surface converges, then snapshot so an edit is revertable.
        void readState(configDir).then((next) => {
          appState = next
          publishStore()
          return snapshot(configDir, 'sbh: store changed')
        })
        return
      }
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
      for (const handle of shells.values()) handle.cancel()
      shells.clear()
      for (const client of clients) client.terminate()
      clients.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
