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

  it('captures the caret when an input atom is focused', () => {
    const { el, input } = build('hello')
    input.focus()
    input.setSelectionRange(3, 3)
    expect(captureInputFocus(el)).toEqual({ caret: 3 })
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

  it('clamps the caret when the rebuilt input is shorter', () => {
    const { el, input } = build('hello')
    input.focus()
    input.setSelectionRange(5, 5)
    const state = captureInputFocus(el)

    const rebuilt = rebuild(el, 'he')
    restoreInputFocus(el, state)

    expect(rebuilt.selectionStart).toBe(2)
  })

  it('does nothing when there is no state to restore', () => {
    const { el } = build('hello')
    expect(() => restoreInputFocus(el, null)).not.toThrow()
  })
})
