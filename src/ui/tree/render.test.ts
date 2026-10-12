// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import '../atoms/index.ts'
import { registerAtom, registeredAtoms, renderTree, type RenderContext } from './render.ts'

// Captured before any test registers its own throwaway atom.
const V0_ATOMS = registeredAtoms()

const calls: unknown[] = []
const ctx: RenderContext = {
  dispatch: (action, payload) => calls.push(payload === undefined ? action : { action, payload }),
  tokens: {},
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

  it('renders an atom that throws as an error placeholder, not a crash', () => {
    registerAtom({
      name: 'explodes',
      render: () => {
        throw new Error('boom')
      },
    })
    const el = renderTree({ type: 'explodes' }, ctx) as HTMLElement
    expect(el.getAttribute('data-error')).toBe('explodes')
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

  it('registers exactly the v0 atom set', () => {
    expect(V0_ATOMS).toEqual(['button', 'column', 'input', 'markdown', 'row', 'scroll', 'select', 'text'])
  })
})
