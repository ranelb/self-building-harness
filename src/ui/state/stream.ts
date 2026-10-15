/**
 * The client end of the core's WebSocket.
 *
 * Uses the global `WebSocket`, which exists in both the Tauri webview and Node,
 * so the same code is exercised by the tests and shipped in the app.
 */
import type { ClientToCore, UiEvent } from '../../../shared/protocol.ts'

export interface Stream {
  send(message: ClientToCore): void
  onEvent(cb: (event: UiEvent) => void): void
  /** Values the host publishes — `system`, and anything else the core can reach. */
  onState(cb: (key: string, value: unknown) => void): void
  /** Fired when the core reports a watched file changed (hot reload). */
  onInvalidate(cb: (what: 'components' | 'theme' | 'layout') => void): void
  close(): void
}

const MAX_BACKOFF_MS = 10_000

export function connectStream(url: string, profile = 'desktop'): Stream {
  const listeners: ((event: UiEvent) => void)[] = []
  const invalidators: ((what: 'components' | 'theme' | 'layout') => void)[] = []
  const stateListeners: ((key: string, value: unknown) => void)[] = []
  const queue: string[] = []
  let socket: WebSocket | null = null
  let closed = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const open = () => {
    if (closed) return
    const ws = new WebSocket(url)
    socket = ws

    ws.onopen = () => {
      attempt = 0
      // Declare the surface before anything else, so hot-reload scoping is right
      // from the first change, and re-declared on every reconnect.
      ws.send(JSON.stringify({ type: 'client.hello', profile }))
      while (queue.length > 0) {
        const data = queue.shift()
        if (data !== undefined) ws.send(data)
      }
    }

    ws.onmessage = (message) => {
      let parsed: any
      try {
        parsed = JSON.parse(String(message.data))
      } catch {
        return
      }
      if (parsed?.type === 'event' && parsed.event) {
        for (const listener of listeners) listener(parsed.event as UiEvent)
      } else if (parsed?.type === 'invalidate' && typeof parsed.what === 'string') {
        for (const listener of invalidators) listener(parsed.what as 'components' | 'theme' | 'layout')
      } else if (parsed?.type === 'state' && typeof parsed.key === 'string') {
        for (const listener of stateListeners) listener(parsed.key, parsed.value)
      }
    }

    ws.onclose = () => {
      if (closed) return
      attempt += 1
      const delay = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS)
      timer = setTimeout(open, delay)
    }

    ws.onerror = () => {
      // `onclose` always follows; reconnection is handled there.
    }
  }

  open()

  return {
    send(message) {
      const data = JSON.stringify(message)
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(data)
      else queue.push(data)
    },

    onEvent(cb) {
      listeners.push(cb)
    },

    onInvalidate(cb) {
      invalidators.push(cb)
    },

    onState(cb) {
      stateListeners.push(cb)
    },

    close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      socket?.close()
    },
  }
}
