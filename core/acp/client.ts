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

const PROTOCOL_VERSION = 1

export interface AcpConnection {
  /** Send a prompt; resolves when the turn settles (finished or errored). */
  prompt(text: string): Promise<void>
  /** Answer an inbound permission request by its UI-facing id. */
  respondPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>
  /** Subscribe to UI events. Multiple subscribers are allowed. */
  onEvent(cb: (event: UiEvent) => void): void
  close(): void
}

export interface ConnectOptions {
  command: string
  args: string[]
  cwd: string
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  method: string
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

  let nextId = 1
  let closed = false
  let sessionId: string | null = null

  const pending = new Map<number, Pending>()
  /** UI-facing request id -> the JSON-RPC id the agent actually sent. */
  const permissionIds = new Map<string, unknown>()

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
        permissionIds.set(requestId, msg.id)
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
    emit({ type: 'error', message: err.message })
    for (const entry of pending.values()) entry.reject(err)
    pending.clear()
  })

  // The handshake promise is *floating*: if it rejected without a handler, an
  // agent that answers `initialize` with a JSON-RPC error would crash the whole
  // core through an unhandled rejection. Found by running real pi-acp.
  let handshakeError: Error | null = null
  const ready = (async () => {
    await request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    // `mcpServers` is required by NewSessionRequest alongside `cwd`, not optional.
    // Omitting it is rejected with "Invalid params" by a real agent.
    const created = await request('session/new', { cwd: opts.cwd, mcpServers: [] })
    sessionId = created?.result?.sessionId ?? null
  })().catch((err: Error) => {
    handshakeError = err
    emit({ type: 'error', message: err.message })
  })

  return {
    onEvent(cb) {
      listeners.push(cb)
    },

    async prompt(text) {
      await ready
      if (handshakeError) return
      emit({ type: 'turn.started' })
      try {
        const res = await request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        })
        emit({ type: 'turn.finished', stopReason: res?.result?.stopReason ?? 'end_turn' })
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message })
      }
    },

    async respondPermission(requestId, decision) {
      const rawId = permissionIds.get(requestId)
      if (rawId === undefined) return
      permissionIds.delete(requestId)
      send({
        jsonrpc: '2.0',
        id: rawId,
        result: {
          outcome:
            decision === 'allow'
              ? { outcome: 'selected', optionId: 'allow' }
              : { outcome: 'cancelled' },
        },
      })
    },

    close() {
      closed = true
      try {
        child.kill()
      } catch {
        // already gone
      }
    },
  }
}
