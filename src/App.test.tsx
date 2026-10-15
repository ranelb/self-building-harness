// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from 'preact'
import { App } from './App'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const waitForSocket = async (): Promise<FakeSocket | undefined> => {
  for (let attempt = 0; attempt < 50 && !FakeSocket.last; attempt += 1) await tick()
  return FakeSocket.last
}

/** Minimal WebSocket stand-in so a test can drive events and read what was sent. */
class FakeSocket {
  static OPEN = 1
  static last: FakeSocket | undefined
  readyState = 1
  sent: unknown[] = []
  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.last = this
    queueMicrotask(() => this.onopen?.())
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}
}

describe('App', () => {
  it('mounts a root element', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    // A dead port keeps the test offline; unmounting closes the stream so the
    // reconnect timer cannot outlive the test.
    render(<App coreUrl="ws://127.0.0.1:9/ws" />, host)
    await tick()
    expect(host.querySelector('[data-sbh-root]')).not.toBeNull()
    render(null, host)
    host.remove()
  })

  // The input's focus/caret across a rebuild is unit-tested in
  // `src/ui/tree/focus.test.ts`: Preact's effect timing under happy-dom does not
  // reproduce the browser bug, so an assertion here would pass either way.

  it('cancels a streaming turn from the composer', async () => {
    const original = globalThis.WebSocket
    ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
    FakeSocket.last = undefined
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      render(<App coreUrl="ws://127.0.0.1:9/ws" />, host)
      await tick()
      const socket = await waitForSocket()
      expect(socket).toBeDefined()
      socket?.onmessage?.({ data: JSON.stringify({ type: 'event', event: { type: 'turn.started' } }) })
      await tick()
      const button = host.querySelector('button[data-send]') as HTMLButtonElement
      expect(button.textContent).toBe('Stop')
      button.click()
      expect(socket?.sent).toContainEqual({ type: 'cancel' })
      render(null, host)
      host.remove()
    } finally {
      ;(globalThis as { WebSocket: unknown }).WebSocket = original
    }
  })

  it('starts a new chat and prefills the draft when editing a prompt', async () => {
    const original = globalThis.WebSocket
    ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
    FakeSocket.last = undefined
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      render(<App coreUrl="ws://127.0.0.1:9/ws" />, host)
      await tick()
      const socket = await waitForSocket()
      expect(socket, 'no socket was created').toBeDefined()
      socket?.onmessage?.({ data: JSON.stringify({ type: 'event', event: { type: 'user.chunk', text: 'hello' } }) })
      await tick()

      const newChat = host.querySelector('button[data-new-chat]') as HTMLButtonElement
      newChat.click()
      expect(socket?.sent, JSON.stringify(socket?.sent)).toContainEqual({ type: 'session.new' })

      const edit = host.querySelector('button[data-edit]') as HTMLButtonElement
      edit.click()
      await tick()
      const input = host.querySelector('input[data-atom="input"]') as HTMLInputElement
      expect(input.value).toBe('hello')

      render(null, host)
      host.remove()
    } finally {
      ;(globalThis as { WebSocket: unknown }).WebSocket = original
    }
  })
})
