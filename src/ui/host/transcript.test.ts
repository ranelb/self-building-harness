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
    items: [],
    changedFiles: [],
    capabilities: { image: false, audio: false, embeddedContext: false, fork: false },
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

describe('permission card', () => {
  it('shows the tool kind and the raw input, not just a title', () => {
    const base = withMessages(0)
    const ctx: RenderContext = {
      ...base,
      host: {
        ...base.host,
        pendingPermission: [
          {
            type: 'permission.requested',
            requestId: 'r1',
            title: 'Run ls',
            kind: 'execute',
            name: 'shell',
            rawInput: { command: 'ls -la' },
          },
        ],
      },
    }
    const el = renderTree({ type: 'permission' }, ctx) as HTMLElement
    expect(el.textContent).toContain('execute')
    expect(el.textContent).toContain('Run ls')
    expect(el.textContent).toContain('ls -la')
    expect(el.querySelectorAll('button')).toHaveLength(2)
  })
})

describe('sessions sidebar', () => {
  it('renders a row per session and filters by title without rebuilding on input', () => {
    const base = withMessages(0)
    const ctx: RenderContext = {
      ...base,
      host: {
        ...base.host,
        sessions: [
          { id: 'a', title: 'Refactor parser', cwd: '/x', startedAt: '', updatedAt: '' },
          { id: 'b', title: 'Fix the launcher', cwd: '/y', startedAt: '', updatedAt: '' },
          { id: 'c', title: 'Ship it', cwd: '/z', startedAt: '', updatedAt: '' },
        ],
      },
    }
    const el = renderTree({ type: 'sessions' }, ctx) as HTMLElement
    expect(el.querySelectorAll('button[data-session]')).toHaveLength(3)

    const filter = el.querySelector('input[data-session-filter]') as HTMLInputElement
    filter.value = 'launcher'
    filter.dispatchEvent(new Event('input'))
    const rows = el.querySelectorAll('button[data-session]')
    expect(rows).toHaveLength(1)
    expect((rows[0] as HTMLElement).dataset.session).toBe('b')
  })
})
