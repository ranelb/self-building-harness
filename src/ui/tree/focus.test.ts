// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { captureInputFocus, restoreInputFocus } from './focus.ts'

let host: HTMLDivElement | null = null

afterEach(() => {
  host?.remove()
  host = null
})

const build = (value: string) => {
  const el = document.createElement('div')
  const input = document.createElement('input')
  input.setAttribute('data-atom', 'input')
  input.value = value
  el.appendChild(input)
  document.body.appendChild(el)
  host = el
  return { el, input }
}

/** Simulate the renderer replacing children wholesale. */
const rebuild = (el: HTMLElement, value: string) => {
  el.replaceChildren()
  const input = document.createElement('input')
  input.setAttribute('data-atom', 'input')
  input.value = value
  el.appendChild(input)
  return input
}

describe('input focus preservation', () => {
  it('captures nothing when no input atom is focused', () => {
    const { el } = build('hello')
    expect(captureInputFocus(el)).toBeNull()
  })

  it('captures the caret and value when an input atom is focused', () => {
    const { el, input } = build('hello')
    input.focus()
    input.setSelectionRange(3, 3)
    expect(captureInputFocus(el)).toEqual({ caret: 3, value: 'hello' })
  })

  it('restores focus onto the rebuilt input', () => {
    const { el, input } = build('hello')
    input.focus()
    input.setSelectionRange(3, 3)
    const state = captureInputFocus(el)

    const rebuilt = rebuild(el, 'hello')
    restoreInputFocus(el, state)

    expect(document.activeElement).toBe(rebuilt)
    expect(rebuilt.selectionStart).toBe(3)
  })

  it('lets the live value win over a stale render', () => {
    // Typing faster than the re-render: the captured value must survive even
    // though the freshly rendered input carries the previous state.
    const { el, input } = build('ab')
    input.focus()
    input.setSelectionRange(2, 2)
    const state = captureInputFocus(el)

    const rebuilt = rebuild(el, 'a')
    restoreInputFocus(el, state)

    expect(rebuilt.value).toBe('ab')
    expect(rebuilt.selectionStart).toBe(2)
  })

  it('restores the captured value onto the rebuilt input', () => {
    const { el, input } = build('hello')
    input.focus()
    input.setSelectionRange(3, 3)
    const state = captureInputFocus(el)

    const rebuilt = rebuild(el, '')
    restoreInputFocus(el, state)

    expect(rebuilt.value).toBe('hello')
    expect(rebuilt.selectionStart).toBe(3)
  })

  it('clamps a caret that exceeds the value length', () => {
    const { el } = build('')
    restoreInputFocus(el, { caret: 99, value: 'hi' })
    const input = el.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('hi')
    expect(input.selectionStart).toBe(2)
  })

  it('does nothing when there is no state to restore', () => {
    const { el } = build('hello')
    expect(() => restoreInputFocus(el, null)).not.toThrow()
  })
})
