// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import '../atoms/index.ts'
import { renderInto, type RenderContext, type UiNode } from './render.ts'

const calls: unknown[] = []
const ctx: RenderContext = {
  tokens: {},
  dispatch: (action, payload) => calls.push(payload === undefined ? action : { action, payload }),
}

let host: HTMLDivElement | undefined

afterEach(() => {
  host?.remove()
  host = undefined
})

const newHost = (): HTMLDivElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  host = el
  return el
}

describe('reconciliation', () => {
  it('reuses the element when the type matches, updating in place', () => {
    const el = newHost()
    const tree = (value: string): UiNode => ({
      type: 'column',
      children: [{ type: 'text', props: { value } }, { type: 'button', props: { label: 'Send', action: 'send' } }],
    })

    renderInto(el, tree('one'), ctx)
    const button = el.querySelector('button')
    renderInto(el, tree('two'), ctx)

    expect(el.querySelector('button')).toBe(button)
    expect(el.querySelector('span')?.textContent).toBe('two')
  })

  it('keeps a focused input — same element, focus intact, typing not clobbered', () => {
    const el = newHost()
    const tree = (value: string): UiNode => ({
      type: 'row',
      children: [{ type: 'input', props: { value, action: 'draft' } }],
    })

    renderInto(el, tree(''), ctx)
    const input = el.querySelector('input') as HTMLInputElement
    input.focus()
    input.value = 'half typed'

    // A re-render whose state still says '' must not eat what was typed.
    renderInto(el, tree(''), ctx)
    expect(el.querySelector('input')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('half typed')

    input.blur()
    renderInto(el, tree('from state'), ctx)
    expect(input.value).toBe('from state')
  })

  it('keeps the scroll pane element, so scroll position survives a new chunk', () => {
    const el = newHost()
    const list = (count: number): UiNode => ({
      type: 'scroll',
      children: Array.from({ length: count }, (_, i) => ({ type: 'text', props: { value: String(i) } })),
    })

    renderInto(el, list(2), ctx)
    const scroll = el.querySelector('[data-atom="scroll"]') as HTMLElement
    scroll.scrollTop = 120

    renderInto(el, list(3), ctx)
    expect(el.querySelector('[data-atom="scroll"]')).toBe(scroll)
    expect(scroll.scrollTop).toBe(120)
    expect(scroll.querySelectorAll('span')).toHaveLength(3)
  })

  it('removes trailing children that are no longer in the tree', () => {
    const el = newHost()
    const list = (count: number): UiNode => ({
      type: 'scroll',
      children: Array.from({ length: count }, (_, i) => ({ type: 'text', props: { value: String(i) } })),
    })

    renderInto(el, list(3), ctx)
    renderInto(el, list(1), ctx)
    expect(el.querySelectorAll('span')).toHaveLength(1)
  })

  it('replaces the element when the type changes', () => {
    const el = newHost()
    renderInto(el, { type: 'text', props: { value: 'a' } }, ctx)
    const text = el.querySelector('span')

    renderInto(el, { type: 'button', props: { label: 'b', action: 'x' } }, ctx)
    expect(el.querySelector('span')).toBeNull()
    expect(el.querySelector('button')).not.toBe(text)
  })

  it('falls back to a placeholder when a component stops resolving', () => {
    const el = newHost()
    renderInto(el, { type: 'text', props: { value: 'a' } }, ctx)
    renderInto(el, { type: 'not-registered' }, ctx)
    expect(el.querySelector('[data-unknown="not-registered"]')).not.toBeNull()
  })
})
