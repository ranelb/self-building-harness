// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import './components.ts'
import { renderTree, type RenderContext } from '../tree/render.ts'

const withMessages = (count: number): RenderContext => ({
  tokens: {},
  host: {
    messages: Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'agent',
      text: `message ${index}`,
    })),
    status: 'idle',
    draft: '',
    pendingPermission: [],
    notices: [],
    harness: { value: 'pi', options: [] },
    model: { value: '', options: [] },
    sessions: [],
    data: {},
  },
  bind: () => {},
  latest: () => undefined,
  dispatch: () => {},
})

const countMarkdown = (el: HTMLElement) => el.querySelectorAll('.sbh-markdown').length

describe('transcript windowing', () => {
  it('renders only a page of a 10k transcript', () => {
    const el = renderTree({ type: 'transcript' }, withMessages(10_000)) as HTMLElement
    expect(countMarkdown(el)).toBe(80)
    expect(el.textContent).toContain('Load earlier messages')
    // The newest message is present; the originals are not in the DOM at all.
    expect(el.textContent).toContain('message 9999')
    expect(el.textContent).not.toContain('message 0')
  })

  it('loads another page on demand and keeps the count bounded', () => {
    const el = renderTree({ type: 'transcript' }, withMessages(300)) as HTMLElement
    expect(countMarkdown(el)).toBe(80)
    ;(el.querySelector('button') as HTMLButtonElement).click()
    expect(countMarkdown(el)).toBe(160)
    ;(el.querySelector('button') as HTMLButtonElement).click()
    expect(countMarkdown(el)).toBe(240)
  })

  it('drops the load-earlier control once everything is shown', () => {
    const el = renderTree({ type: 'transcript' }, withMessages(50)) as HTMLElement
    expect(countMarkdown(el)).toBe(50)
    expect(el.textContent).not.toContain('Load earlier')
  })
})
