/**
 * The ACP client: one child process speaking ACP over stdio.
 *
 * Hand-rolled rather than wrapping the SDK's typed client, for three reasons
 * the tests pin:
 *   - an unknown `sessionUpdate` must be ignored, not fatal (Review Focus 4);
 *   - a mid-turn process exit must surface as an `error` event (Review Focus 2);
 *   - the connection is long-lived and drives many turns, not one `connectWith`.
 *
 * The SDK is still the source of truth for the wire *shapes*; they were read out
 * of its `schema/schema.json`, not invented.
 */
import { spawn } from 'node:child_process'
import { normalizePermissionRequest, normalizeUpdate, type UiEvent } from '../events.ts'
import type { SessionConfigOption } from '../../shared/protocol.ts'

const PROTOCOL_VERSION = 1

export interface AcpSessionInfo {
  sessionId: string
  cwd: string
  title: string
  updatedAt: string
}

export interface AcpConnection {
  /** Send a prompt; resolves when the turn settles (finished or errored). */
  prompt(text: string): Promise<void>
  /** Answer an inbound permission request by its UI-facing id. */
  respondPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>
  /** Subscribe to UI events. Multiple subscribers are allowed. */
  onEvent(cb: (event: UiEvent) => void): void
  /** Ensure the session exists (create, or load a resume target). */
  open(): Promise<void>
  /** List the agent's saved sessions (one page). Does not create a session. */
  list(cursor?: string): Promise<{ sessions: AcpSessionInfo[]; nextCursor: string | null }>
  /** Set a session config option (the model picker uses this). */
  setConfigOption(configId: string, value: string): Promise<void>
  close(): void
}

export interface ConnectOptions {
  command: string
  args: string[]
  cwd: string
  /** Resume an existing session instead of creating a new one. */
  resume?: { sessionId: string; cwd?: string }
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  method: string
}

interface PermissionOption {
  optionId: string
  kind?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Read the options an agent offered, ignoring anything malformed. */
function readPermissionOptions(params: unknown): PermissionOption[] {
  if (!isRecord(params) || !Array.isArray(params.options)) return []
  const options: PermissionOption[] = []
  for (const option of params.options) {
    if (!isRecord(option) || typeof option.optionId !== 'string') continue
    options.push(
      typeof option.kind === 'string'
        ? { optionId: option.optionId, kind: option.kind }
        : { optionId: option.optionId }
    )
  }
  return options
}

const ALLOW_KINDS = ['allow_once', 'allow_always']
const DENY_KINDS = ['reject_once', 'reject_always']

/**
 * Pick the option that matches the user's decision.
 *
 * The response must name an `optionId` the agent actually offered. A literal
 * `'allow'` therefore only works against an agent that happens to name its
 * options that way. Selection is by `kind`, which ACP requires on every option;
 * the literal ids are a fallback for older agents, and `null` fails closed (the
 * caller answers `cancelled`).
 *
 * Note: goose (v1.54) did not emit a permission request in the `approve` mode
 * that was probed, so this path is still only exercised by pi-acp and the fake
 * fixture — the second backend did not widen the gate's coverage.
 */
export function choosePermissionOption(
  options: readonly PermissionOption[],
  decision: 'allow' | 'deny'
): PermissionOption | null {
  const kinds = decision === 'allow' ? ALLOW_KINDS : DENY_KINDS
  return (
    options.find((option) => option.kind !== undefined && kinds.includes(option.kind)) ??
    options.find((option) => option.optionId === decision) ??
    null
  )
}

/** Map ACP `configOptions` to the wire shape, ignoring malformed entries. */
export function readConfigOptions(raw: unknown): SessionConfigOption[] {
  if (!Array.isArray(raw)) return []
  const options: SessionConfigOption[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    const values = Array.isArray(entry.options) ? entry.options : []
    options.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
      currentValue: typeof entry.currentValue === 'string' ? entry.currentValue : '',
      options: values
        .filter((value): value is Record<string, unknown> => isRecord(value) && typeof value.value === 'string')
        .map((value) => ({
          value: value.value as string,
          label: typeof value.name === 'string' ? value.name : (value.value as string),
        })),
    })
  }
  return options
}

export function connectAcp(opts: ConnectOptions): AcpConnection {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const listeners: ((event: UiEvent) => void)[] = []
  const emit = (event: UiEvent) => {
    for (const listener of listeners) listener(event)
  }
  const emitConfig = (raw: unknown) => {
    const options = readConfigOptions(raw)
    if (options.length > 0) emit({ type: 'config', options })
  }

  let nextId = 1
  let closed = false
  /** Set when *we* close the connection: an expected ending is not an error. */
  let closing = false
  let sessionId: string | null = null

  const pending = new Map<number, Pending>()
  /** UI-facing request id -> the JSON-RPC id and the options the agent offered. */
  const permissionRequests = new Map<string, { id: unknown; options: PermissionOption[] }>()

  const send = (obj: unknown) => {
    if (closed) return
    child.stdin.write(JSON.stringify(obj) + '\n')
  }

  const request = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject, method })
      send({ jsonrpc: '2.0', id, method, params })
    })

  const handle = (msg: any) => {
    // An inbound request from the agent: the permission gate lives here.
    if (msg.method === 'session/request_permission') {
      const requestId = String(msg.id)
      const event = normalizePermissionRequest(msg.params, requestId)
      if (event && event.type === 'permission.requested') {
        permissionRequests.set(requestId, { id: msg.id, options: readPermissionOptions(msg.params) })
        emit(event)
      } else {
        // Never leave the agent hanging on an unparseable request.
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
      }
      return
    }

    // A response to something we sent.
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      if (!entry) return
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message ?? 'acp error'}`))
      else entry.resolve(msg)
      return
    }

    if (msg.method === 'session/update') {
      for (const event of normalizeUpdate(msg.params?.update)) emit(event)
    }
  }

  // Byte-safe framing: decode only whole lines, so a chunk arriving mid-character
  // is reassembled rather than mangled.
  let buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    let index: number
    while ((index = buffer.indexOf(0x0a)) >= 0) {
      const line = buffer.subarray(0, index).toString('utf8').replace(/\r$/, '')
      buffer = buffer.subarray(index + 1)
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      handle(msg)
    }
  })

  // Keep the pipe drained; an unread stderr can block a chatty agent.
  child.stderr.on('data', () => {})

  child.on('exit', (code) => {
    closed = true
    for (const entry of pending.values()) {
      entry.reject(new Error(`agent exited with code ${code}`))
    }
    pending.clear()
  })

  child.on('error', (err) => {
    closed = true
    if (!closing) emit({ type: 'error', message: err.message })
    for (const entry of pending.values()) entry.reject(err)
    pending.clear()
  })

  // The handshake promise is *floating*: if it rejected without a handler, an
  // agent that answers `initialize` with a JSON-RPC error would crash the whole
  // core through an unhandled rejection. Found by running real pi-acp.
  let handshakeError: Error | null = null
  const fail = (error: Error) => {
    handshakeError = error
    // A close we asked for (a backend switch, shutdown) tears down an in-flight
    // handshake on purpose. Surfacing that as "agent exited" made selecting a
    // harness look like a crash.
    if (!closing) emit({ type: 'error', message: error.message })
  }
  const ready = request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }).catch(
    fail
  )

  // A session is created lazily — on the first prompt, or when a resume asks for
  // one. `session/list` must not create one, or merely opening the app would
  // litter the agent's store with empty sessions.
  let sessionReady: Promise<void> | null = null
  const ensureSession = (): Promise<void> => {
    if (sessionReady) return sessionReady
    sessionReady = (async () => {
      await ready
      if (handshakeError) return
      if (opts.resume) {
        const loaded = await request('session/load', {
          sessionId: opts.resume.sessionId,
          cwd: opts.resume.cwd ?? opts.cwd,
          mcpServers: [],
        })
        sessionId = opts.resume.sessionId
        emitConfig(loaded?.result?.configOptions)
        return
      }
      // `mcpServers` is required by NewSessionRequest alongside `cwd`, not optional.
      // Omitting it is rejected with "Invalid params" by a real agent.
      const created = await request('session/new', { cwd: opts.cwd, mcpServers: [] })
      sessionId = created?.result?.sessionId ?? null
      emitConfig(created?.result?.configOptions)
    })().catch(fail)
    return sessionReady
  }

  return {
    onEvent(cb) {
      listeners.push(cb)
    },

    async prompt(text) {
      await ensureSession()
      if (handshakeError) return
      emit({ type: 'turn.started' })
      try {
        const res = await request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        })
        emit({ type: 'turn.finished', stopReason: res?.result?.stopReason ?? 'end_turn' })
      } catch (err) {
        if (!closing) emit({ type: 'error', message: (err as Error).message })
      }
    },

    async list(cursor) {
      await ready
      if (handshakeError) throw handshakeError
      const res = await request('session/list', cursor ? { cursor } : {})
      const sessions: AcpSessionInfo[] = (res?.result?.sessions ?? []).map((entry: any) => ({
        sessionId: String(entry?.sessionId ?? ''),
        cwd: String(entry?.cwd ?? ''),
        title: typeof entry?.title === 'string' ? entry.title : '',
        updatedAt: String(entry?.updatedAt ?? ''),
      }))
      return { sessions, nextCursor: res?.result?.nextCursor ?? null }
    },

    async open() {
      await ensureSession()
    },

    async setConfigOption(configId, value) {
      await ensureSession()
      if (handshakeError) return
      const res = await request('session/set_config_option', { sessionId, configId, value })
      emitConfig(res?.result?.configOptions)
    },

    async respondPermission(requestId, decision) {
      const entry = permissionRequests.get(requestId)
      if (!entry) return
      permissionRequests.delete(requestId)
      const option = choosePermissionOption(entry.options, decision)
      send({
        jsonrpc: '2.0',
        id: entry.id,
        result: option
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } },
      })
    },

    close() {
      closing = true
      closed = true
      try {
        child.kill()
      } catch {
        // already gone
      }
    },
  }
}
