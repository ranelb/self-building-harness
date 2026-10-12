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
import { applyEvent, empty, withUserMessage, type Transcript } from '../src/ui/state/transcript.ts'

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
    await waitFor(() => transcript.messages.some((m) => m.role === 'agent' && m.text.length > 0))

    const agent = transcript.messages.find((m) => m.role === 'agent')
    expect(agent?.text).toBe('echo hello (fake)')
    expect(transcript.status).toBe('idle')

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

    expect(transcript.messages[0]?.text).toBe('partial')
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
    await waitFor(() => transcript.status === 'idle' && transcript.messages.length > 0)

    expect(transcript.messages.map((m) => m.text).join('')).toContain('after')
    stream.close()
  })
})
