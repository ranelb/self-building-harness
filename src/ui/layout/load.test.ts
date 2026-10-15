import { describe, it, expect } from 'vitest'
import { loadLayout } from './load.ts'
import { DEFAULT_LAYOUT } from '../../../shared/layout.ts'

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

describe('loadLayout', () => {
  it('loads a valid layout', async () => {
    const layout = await loadLayout('http://core', undefined, async () =>
      jsonResponse({ type: 'column', children: [{ type: 'text', props: { value: 'hi' } }] })
    )
    expect(layout).toEqual({ type: 'column', children: [{ type: 'text', props: { value: 'hi' } }] })
  })

  it('falls back to the default when the layout is not a tree', async () => {
    expect(await loadLayout('http://core', undefined, async () => jsonResponse(['not', 'a', 'node']))).toEqual(DEFAULT_LAYOUT)
    expect(await loadLayout('http://core', undefined, async () => jsonResponse({}))).toEqual(DEFAULT_LAYOUT)
    expect(await loadLayout('http://core', undefined, async () => jsonResponse({ type: 'column', children: [{}] }))).toEqual(
      DEFAULT_LAYOUT
    )
  })

  it('falls back when the core is unreachable or errors', async () => {
    expect(
      await loadLayout('http://core', undefined, async () => {
        throw new Error('connection refused')
      })
    ).toEqual(DEFAULT_LAYOUT)
    expect(await loadLayout('http://core', undefined, async () => jsonResponse({}, 500))).toEqual(DEFAULT_LAYOUT)
  })

  it('accepts the default layout itself', async () => {
    expect(await loadLayout('http://core', undefined, async () => jsonResponse(DEFAULT_LAYOUT))).toEqual(DEFAULT_LAYOUT)
  })
})

describe('loadLayout profile', () => {
  it('passes the surface through to the core', async () => {
    let seen = ''
    await loadLayout('http://core', 'phone', async (input) => {
      seen = String(input)
      return jsonResponse(DEFAULT_LAYOUT)
    })
    expect(seen).toContain('profile=phone')
  })
})
