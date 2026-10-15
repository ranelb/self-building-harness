/**
 * End-to-end data path: a real core process spawning a real agent child, over a
 * real WebSocket, through the real client and reducer.
 *
 * Deliberately no DOM: the render step is covered by the renderer and scaffold
 * tests, and keeping this in the node project means `tsconfig.core.json` keeps
 * its no-DOM guarantee.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { startCore, type Core } from '../core/server.ts'
import { connectStream } from '../src/ui/state/stream.ts'
import { applyEvent, empty, toMessages, withUserMessage, type Transcript } from '../src/ui/state/transcript.ts'

let core: Core | undefined

afterEach(async () => {
  await core?.close()
  core = undefined
})

const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('core -> ws -> transcript', () => {
  it('turns a prompt into a finished agent message', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy' })
    const stream = connectStream(`ws://127.0.0.1:${core.port}/ws`)

    let transcript: Transcript = withUserMessage(empty(), 'hello')
    stream.onEvent((event) => {
      transcript = applyEvent(transcript, event)
    })

    stream.send({ type: 'prompt', text: 'hello' })
    await waitFor(() => toMessages(transcript).some((m) => m.role === 'agent' && m.text.length > 0))

    const agent = toMessages(transcript).find((m) => m.role === 'agent')
    expect(agent?.text).toBe('echo hello (fake)')
    expect(transcript.status).toBe('idle')

    stream.close()
  })

  it('carries usage through to the client, for a context meter', async () => {
    core = await startCore({ port: 0, backend: 'fake:usage', sampleIntervalMs: 0 })
    const stream = connectStream(`ws://127.0.0.1:${core.port}/ws`)
    const events: unknown[] = []
    stream.onEvent((event) => events.push(event))

    stream.send({ type: 'prompt', text: 'hello' })
    await waitFor(() => events.some((event) => (event as { type: string }).type === 'usage'))

    expect(events).toContainEqual({
      type: 'usage',
      used: 12_345,
      size: 100_000,
      cost: { amount: 0.02, currency: 'USD' },
    })
    stream.close()
  })

  it('publishes machine samples on the state channel', async () => {
    core = await startCore({ port: 0, backend: 'fake:happy', sampleIntervalMs: 40 })
    const stream = connectStream(`ws://127.0.0.1:${core.port}/ws`)
    const states: Record<string, unknown> = {}
    stream.onState((key, value) => {
      states[key] = value
    })

    await waitFor(() => 'system' in states)
    const sample = states.system as { cpu?: { cores?: number } }
    expect(sample.cpu?.cores).toBeGreaterThan(0)
    stream.close()
  })

  it('surfaces an agent crash as an error event, not a hang', async () => {
    core = await startCore({ port: 0, backend: 'fake:crash-mid-turn' })
    const stream = connectStream(`ws://127.0.0.1:${core.port}/ws`)

    let transcript = empty()
    stream.onEvent((event) => {
      transcript = applyEvent(transcript, event)
    })

    stream.send({ type: 'prompt', text: 'hello' })
    await waitFor(() => transcript.status === 'error')

    expect(toMessages(transcript)[0]?.text).toBe('partial')
    stream.close()
  })

  it('routes a permission request and resumes the turn after answering', async () => {
    core = await startCore({ port: 0, backend: 'fake:permission' })
    const stream = connectStream(`ws://127.0.0.1:${core.port}/ws`)

    let transcript = empty()
    stream.onEvent((event) => {
      transcript = applyEvent(transcript, event)
      if (event.type === 'permission.requested') {
        stream.send({ type: 'permission', requestId: event.requestId, decision: 'allow' })
      }
    })

    stream.send({ type: 'prompt', text: 'hello' })
    await waitFor(() => transcript.status === 'idle' && toMessages(transcript).length > 0)

    expect(toMessages(transcript).map((m) => m.text).join('')).toContain('after')
    stream.close()
  })
})
