// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import '../atoms/index.ts'
import {
  markOverride,
  registerComponent,
  registeredComponents,
  renderInto,
  renderTree,
  str,
  type RenderContext,
} from './render.ts'

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
    schema: { version: 1, kinds: [] },
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

  describe('stale notice', () => {
    const withSchema = (version: number, kinds: string[]): RenderContext => ({
      ...ctx,
      host: { ...ctx.host, schema: { version, kinds } },
    })
    const KINDS = ['token', 'tool', 'queue']
    const notices = (el: Node) => (el as Element).querySelectorAll('[data-component-stale]')

    it('shows nothing before the schema arrives, even for a partial declaration', () => {
      registerComponent({
        name: 'stale-unknown',
        handledEvents: ['token'],
        create: () => document.createElement('div'),
      })
      for (const c of [withSchema(0, KINDS), withSchema(1, [])]) {
        const el = renderTree({ type: 'stale-unknown' }, c)
        expect(notices(el).length).toBe(0)
      }
    })

    it('flags exactly one notice naming the missing kinds', () => {
      registerComponent({
        name: 'stale-partial',
        handledEvents: ['token'],
        create: () => document.createElement('div'),
      })
      const el = renderTree({ type: 'stale-partial' }, withSchema(2, KINDS)) as HTMLElement
      const found = notices(el)
      expect(found.length).toBe(1)
      expect(found[0]!.getAttribute('data-component-stale')).toBe('true')
      expect(found[0]!.textContent).toBe('component is out of date — missing: tool, queue')
    })

    it('shows no notice for a component with full coverage', () => {
      registerComponent({
        name: 'stale-full',
        handledEvents: [...KINDS],
        create: () => document.createElement('div'),
      })
      const el = renderTree({ type: 'stale-full' }, withSchema(2, KINDS))
      expect(notices(el).length).toBe(0)
    })

    it('gives an undeclared override the softer notice', () => {
      registerComponent({ name: 'stale-override', create: () => document.createElement('div') })
      markOverride('stale-override')
      const el = renderTree({ type: 'stale-override' }, withSchema(2, KINDS)) as HTMLElement
      const found = notices(el)
      expect(found.length).toBe(1)
      expect(found[0]!.getAttribute('data-component-stale')).toBe('undeclared')
      expect(found[0]!.textContent).toContain('does not declare handledEvents')
    })

    it('stays at one notice across re-renders and keeps the component output', () => {
      registerComponent({
        name: 'stale-rerender',
        handledEvents: ['token'],
        create: () => document.createElement('div'),
        update: (el, node) => {
          el.textContent = str(node.props?.value)
        },
      })
      const parent = document.createElement('div')
      const c = withSchema(2, KINDS)
      renderInto(parent, { type: 'stale-rerender', props: { value: 'one' } }, c)
      renderInto(parent, { type: 'stale-rerender', props: { value: 'two' } }, c)
      expect(notices(parent).length).toBe(1)
      expect(parent.firstElementChild?.firstChild?.textContent).toBe('two')
    })
  })
})
