// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import '../atoms/index.ts'
import { registerComponent, registeredComponents, renderTree, str, type RenderContext } from './render.ts'

// Captured before any test registers its own throwaway component.
const BUILT_INS = registeredComponents()

const calls: unknown[] = []
const ctx: RenderContext = {
  tokens: {},
  host: {
    messages: [],
    items: [],
    changedFiles: [],
    commands: [],
    draftAttachments: [],
    capabilities: { image: false, audio: false, embeddedContext: false, fork: false },
    status: 'idle',
    queued: 0,
    draft: '',
    pendingPermission: [],
    pendingContext: [],
    notices: [],
    harness: { value: 'pi', options: [] },
    model: { value: 'default', options: [] },
    sessions: [],
    data: {},
  },
  bind: () => {},
  latest: () => undefined,
  dispatch: (action, payload) => calls.push(payload === undefined ? action : { action, payload }),
}

describe('renderTree', () => {
  it('renders text into a text node', () => {
    const el = renderTree({ type: 'text', props: { value: 'hello' } }, ctx)
    expect(el.textContent).toBe('hello')
  })

  it('renders children in order inside a column', () => {
    const el = renderTree(
      {
        type: 'column',
        children: [
          { type: 'text', props: { value: 'a' } },
          { type: 'text', props: { value: 'b' } },
        ],
      },
      ctx
    )
    expect(el.textContent).toBe('ab')
  })

  it('renders an unknown type as a placeholder without throwing', () => {
    const el = renderTree({ type: 'invented' }, ctx) as HTMLElement
    expect(el.getAttribute('data-unknown')).toBe('invented')
  })

  it('renders a component that throws as an error placeholder, not a crash', () => {
    registerComponent({
      name: 'explodes',
      create: () => {
        throw new Error('boom')
      },
    })
    const el = renderTree({ type: 'explodes' }, ctx) as HTMLElement
    expect(el.getAttribute('data-error')).toBe('explodes')
    expect(el.textContent).toContain('boom')
  })

  it('survives a malformed node without throwing', () => {
    expect((renderTree({} as never, ctx) as HTMLElement).getAttribute('data-invalid')).toBe('true')
    expect((renderTree(null as never, ctx) as HTMLElement).getAttribute('data-invalid')).toBe('true')
  })

  it('dispatches a named action when a button is clicked', () => {
    calls.length = 0
    const el = renderTree({ type: 'button', props: { label: 'Send', action: 'prompt.send' } }, ctx)
    ;(el as HTMLElement).click()
    expect(calls).toEqual(['prompt.send'])
  })

  it('renders a select with options and dispatches the chosen value', () => {
    calls.length = 0
    const el = renderTree(
      {
        type: 'select',
        props: {
          value: 'pi',
          action: 'harness.change',
          options: [
            { value: 'pi', label: 'Pi' },
            { value: 'goose', label: 'Goose' },
          ],
        },
      },
      ctx
    ) as HTMLSelectElement
    expect(el.querySelectorAll('option')).toHaveLength(2)
    el.value = 'goose'
    el.dispatchEvent(new Event('change'))
    expect(calls).toEqual([{ action: 'harness.change', payload: { value: 'goose' } }])
  })

  it('registers exactly the built-in component set', () => {
    expect(BUILT_INS).toEqual([
      'button',
      'column',
      'input',
      'markdown',
      'row',
      'scroll',
      'select',
      'text',
    ])
  })

  it('runs update after create, so one painting path is enough', () => {
    // Mount is create + update. A component that fills its element only in
    // `update` must not render blank on first mount.
    registerComponent({
      name: 'paints-in-update',
      create: () => document.createElement('div'),
      update: (el, node) => {
        el.textContent = str(node.props?.value)
      },
    })
    const el = renderTree({ type: 'paints-in-update', props: { value: 'painted' } }, ctx)
    expect(el.textContent).toBe('painted')
  })
})
