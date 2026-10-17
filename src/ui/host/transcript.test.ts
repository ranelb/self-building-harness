// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import './components.ts'
import { renderTree, type RenderContext } from '../tree/render.ts'
import type { TimelineItem } from '../../../shared/ui.ts'

const withMessages = (count: number): RenderContext => {
  const messages = Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('agent' as const),
    text: `message ${index}`,
  }))
  const items: TimelineItem[] = messages.map((message) =>
    message.role === 'user'
      ? { id: message.id, kind: 'user', text: message.text, attachments: [] }
      : { id: message.id, kind: 'agent', text: message.text }
  )
  return {
    tokens: {},
    host: {
      messages,
      items,
      changedFiles: [],
      commands: [],
      draftAttachments: [],
      capabilities: { image: false, audio: false, embeddedContext: false, fork: false },
      status: 'idle',
      queued: 0,
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
  }
}

const countMarkdown = (el: HTMLElement) => el.querySelectorAll('.sbh-markdown').length

describe('transcript windowing', () => {  it('renders only a page of a 10k transcript', () => {
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

describe('compaction divider', () => {
  it('renders a divider item', () => {
    const items: TimelineItem[] = [
      { id: 'd1', kind: 'divider', pending: false },
    ]
    const ctx = withMessages(0)
    ctx.host.items = items
    const root = renderTree({ type: 'transcript' }, ctx) as HTMLElement
    const divider = root.querySelector('[data-item="divider"]')
    expect(divider).not.toBeNull()
    expect(divider?.textContent).toBe('context compacted')
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

  it('offers a New Chat button', () => {
    const base = withMessages(0)
    const actions: string[] = []
    const ctx: RenderContext = { ...base, dispatch: (action: string) => actions.push(action) }
    const el = renderTree({ type: 'sessions' }, ctx) as HTMLElement
    const button = el.querySelector('button[data-new-chat]') as HTMLButtonElement
    expect(button).not.toBeNull()
    button.click()
    expect(actions).toEqual(['session.new'])
  })
})

describe('usage', () => {
  it('shows context percent and cost by default, tokens collapsed', () => {
    const base = withMessages(0)
    const ctx: RenderContext = {
      ...base,
      host: {
        ...base.host,
        data: { usage: { used: 2500, size: 10000, cost: { amount: 0.12, currency: 'USD' } } },
      },
    }
    const el = renderTree({ type: 'usage' }, ctx) as HTMLElement
    expect(el.style.display).toBe('flex')
    expect(el.textContent).toContain('context 25%')
    expect(el.textContent).toContain('$0.12')
    const tokens = [...el.querySelectorAll('span')].find((s) => s.textContent.includes('tokens'))
    expect(tokens?.style.display).toBe('none')
  })

  it('hides when there is no usage', () => {
    const el = renderTree({ type: 'usage' }, withMessages(0)) as HTMLElement
    expect(el.style.display).toBe('none')
  })
})

describe('timeline items', () => {
  it('renders reasoning and a tool card from items', () => {
    const base = withMessages(0)
    const ctx: RenderContext = {
      ...base,
      host: {
        ...base.host,
        items: [
          { id: '1', kind: 'thought', text: 'weighing options' },
          { id: '2', kind: 'agent', text: 'done' },
          {
            id: '3',
            kind: 'tool',
            toolCallId: 't1',
            title: 'edit src/app.ts',
            status: 'completed',
            toolKind: 'edit',
            locations: [],
          },
        ],
      },
    }
    const el = renderTree({ type: 'transcript' }, ctx) as HTMLElement
    expect(el.textContent).toContain('weighing options')
    expect(el.textContent).toContain('edit src/app.ts')
    expect(el.querySelectorAll('[data-item="tool"]')).toHaveLength(1)
  })

  it('dispatches message.edit with the user item id', () => {
    const base = withMessages(0)
    const actions: { action: string; id?: unknown }[] = []
    const ctx: RenderContext = {
      ...base,
      host: { ...base.host, items: [{ id: 'u1', kind: 'user', text: 'hi', attachments: [] }] },
      dispatch: (action: string, payload?: unknown) =>
        actions.push({ action, id: (payload as { id?: unknown } | undefined)?.id }),
    }
    const el = renderTree({ type: 'transcript' }, ctx) as HTMLElement
    const edit = el.querySelector('button[data-edit="u1"]') as HTMLButtonElement
    expect(edit).not.toBeNull()
    edit.click()
    expect(actions).toEqual([{ action: 'message.edit', id: 'u1' }])
  })
})

describe('changed files', () => {  it('hides when nothing changed and groups files per turn', () => {
    const base = withMessages(0)
    const hidden = renderTree({ type: 'changedFiles' }, base) as HTMLElement
    expect(hidden.style.display).toBe('none')

    const ctx: RenderContext = {
      ...base,
      host: {
        ...base.host,
        changedFiles: [
          { turn: 1, files: [{ path: 'a.ts' }] },
          { turn: 2, files: [{ path: 'b.ts', line: 3 }] },
        ],
      },
    }
    const el = renderTree({ type: 'changedFiles' }, ctx) as HTMLElement
    expect(el.style.display).toBe('flex')
    expect(el.textContent).toContain('a.ts')
    expect(el.textContent).toContain('b.ts:3')
    expect(el.textContent).toContain('turn 1')
  })
})

describe('composer', () => {
  const withStatus = (status: 'idle' | 'streaming', extra: Partial<RenderContext['host']> = {}) => {
    const base = withMessages(0)
    const actions: string[] = []
    const ctx: RenderContext = {
      ...base,
      host: { ...base.host, status, ...extra },
      dispatch: (action: string) => actions.push(action),
    }
    return { el: renderTree({ type: 'composer' }, ctx) as HTMLElement, actions }
  }

  it('shows Stop and cancels while streaming', () => {
    const { el, actions } = withStatus('streaming')
    const button = el.querySelector('button[data-send]') as HTMLButtonElement
    expect(button.textContent).toBe('Stop')
    button.click()
    expect(actions).toEqual(['turn.cancel'])
  })

  it('shows the depth badge and clears the queue', () => {
    const { el, actions } = withStatus('streaming', { queued: 2 })
    const badge = el.querySelector('span[data-queued]') as HTMLElement
    expect(badge.textContent).toBe('2 queued')
    expect(badge.style.display).not.toBe('none')
    const clear = el.querySelector('button[data-queue-clear]') as HTMLButtonElement
    expect(clear.textContent).toBe('Clear')
    clear.click()
    expect(actions).toEqual(['queue.clear'])
  })

  it('hides the depth badge at zero', () => {
    const { el } = withStatus('streaming')
    expect((el.querySelector('span[data-queued]') as HTMLElement).style.display).toBe('none')
  })

  it('shows Send and renders staged attachments', () => {
    const { el, actions } = withStatus('idle', {
      draftAttachments: [{ name: 'p.png', mimeType: 'image/png', data: 'AAA' }],
    })
    expect((el.querySelector('button[data-send]') as HTMLButtonElement).textContent).toBe('Send')
    expect(el.querySelector('[data-attachments]')?.textContent).toContain('p.png')
    ;(el.querySelector('button[data-send]') as HTMLButtonElement).click()
    expect(actions).toEqual(['prompt.send'])
  })

  it('offers a / menu filtered by the typed query, and inserts the choice', () => {
    const base = withMessages(0)
    const ctx: RenderContext = {
      ...base,
      host: {
        ...base.host,
        commands: [
          { name: 'skill:grilling', description: 'grill' },
          { name: 'model', description: 'pick' },
        ],
      },
    }
    const el = renderTree({ type: 'composer' }, ctx) as HTMLElement
    const input = el.querySelector('input[data-atom="input"]') as HTMLInputElement
    input.value = '/gr'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const items = el.querySelectorAll('button[data-command]')
    expect(items).toHaveLength(1)
    expect(items[0]?.getAttribute('data-command')).toBe('skill:grilling')
    ;(items[0] as HTMLButtonElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(input.value).toBe('/skill:grilling ')
  })

  it('lists agent builtins that come after the skills', () => {
    const base = withMessages(0)
    const skills = Array.from({ length: 12 }, (_, index) => ({
      name: `skill:${index}`,
      description: 'a skill',
    }))
    const ctx: RenderContext = {
      ...base,
      host: { ...base.host, commands: [...skills, { name: 'compact', description: 'compact' }] },
    }
    const el = renderTree({ type: 'composer' }, ctx) as HTMLElement
    const input = el.querySelector('input[data-atom="input"]') as HTMLInputElement
    input.value = '/'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(el.querySelectorAll('button[data-command]')).toHaveLength(13)
    expect(el.querySelector('button[data-command="compact"]')).not.toBeNull()
  })
})
