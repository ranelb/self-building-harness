// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import '../atoms/index.ts'
import { registerComponent, renderInto, type RenderContext, type UiNode } from './render.ts'

const ctx: RenderContext = {
  tokens: {},
  bind: () => {},
  latest: () => undefined,
  dispatch: () => {},
}

type Log = string[]
const destroyed: Log = []

let host: HTMLDivElement | undefined

afterEach(() => {
  host?.remove()
  host = undefined
  destroyed.length = 0
})

const newHost = (): HTMLDivElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  host = el
  return el
}

/** A component that records its own teardown, optionally with lifecycle tracking. */
const registerTracked = (name: string, options: { throws?: boolean; container?: boolean } = {}) =>
  registerComponent({
    name,
    container: options.container,
    create: () => {
      const el = document.createElement('div')
      el.setAttribute('data-tracked', name)
      return el
    },
    destroy: () => {
      destroyed.push(name)
      if (options.throws) throw new Error('cleanup exploded')
    },
  })

describe('destroy lifecycle', () => {
  it('calls destroy when a node leaves the tree', () => {
    registerTracked('panel')
    const el = newHost()
    const tree = (withPanel: boolean): UiNode => ({
      type: 'column',
      children: withPanel ? [{ type: 'panel' }] : [],
    })

    renderInto(el, tree(true), ctx)
    expect(destroyed).toEqual([])

    renderInto(el, tree(false), ctx)
    expect(destroyed).toEqual(['panel'])
  })

  it('does not destroy a node that was merely updated', () => {
    registerTracked('kept')
    const el = newHost()
    renderInto(el, { type: 'column', children: [{ type: 'kept' }] }, ctx)
    renderInto(el, { type: 'column', children: [{ type: 'kept' }] }, ctx)
    expect(destroyed).toEqual([])
  })

  it('destroys the whole subtree, deepest first, when a container is replaced', () => {
    registerTracked('outer', { container: true })
    registerTracked('inner')
    const el = newHost()

    renderInto(el, { type: 'outer', children: [{ type: 'inner' }] }, ctx)
    renderInto(el, { type: 'text', props: { value: 'replaced' } }, ctx)

    // Inner is a child of outer, so it must be torn down first.
    expect(destroyed).toEqual(['inner', 'outer'])
  })

  it('isolates a component whose cleanup throws', () => {
    registerTracked('angry', { throws: true })
    registerTracked('calm')
    const el = newHost()

    renderInto(el, { type: 'column', children: [{ type: 'angry' }, { type: 'calm' }] }, ctx)
    expect(() => renderInto(el, { type: 'column', children: [] }, ctx)).not.toThrow()
    // Siblings are torn down from the tail; only *nesting* order is guaranteed.
    expect([...destroyed].sort()).toEqual(['angry', 'calm'])
  })
})
