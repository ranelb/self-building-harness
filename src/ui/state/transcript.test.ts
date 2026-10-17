import { describe, it, expect } from 'vitest'
import { applyEvent, empty, markSuperseded, resolvePermission, toMessages, withUserMessage } from './transcript.ts'
import type { UiEvent } from '../../../shared/protocol.ts'

const apply = (events: UiEvent[], start = empty()) => events.reduce(applyEvent, start)

const tool = (over: Partial<Extract<UiEvent, { type: 'tool' }>> = {}): UiEvent => ({
  type: 'tool',
  toolCallId: 't1',
  title: 'edit',
  ...over,
})

describe('timeline', () => {
  describe('compaction divider', () => {
    it('inserts a divider between the prose around a compaction', () => {
      const state = apply([
        { type: 'turn.started', turnId: 1 },
        { type: 'chunk', text: 'before' },
        { type: 'compaction', phase: 'start' },
        { type: 'chunk', text: 'after' },
      ])
      expect(state.items.map((item) => item.kind)).toEqual(['agent', 'divider', 'agent'])
      expect(state.items[1]).toMatchObject({ kind: 'divider', pending: true })
    })

    it('closes the pending divider on the end sentinel', () => {
      const state = apply([
        { type: 'turn.started', turnId: 1 },
        { type: 'chunk', text: 'before' },
        { type: 'compaction', phase: 'start' },
        { type: 'compaction', phase: 'end' },
        { type: 'chunk', text: 'after' },
      ])
      expect(state.items.map((item) => item.kind)).toEqual(['agent', 'divider', 'agent'])
      expect(state.items[1]).toMatchObject({ kind: 'divider', pending: false })
    })

    it('inserts a closed divider for an end with no matching start', () => {
      const state = apply([
        { type: 'turn.started', turnId: 1 },
        { type: 'chunk', text: 'before' },
        { type: 'compaction', phase: 'end' },
      ])
      expect(state.items.map((item) => item.kind)).toEqual(['agent', 'divider'])
      expect(state.items[1]).toMatchObject({ kind: 'divider', pending: false })
    })
  })

  it('coalesces consecutive agent chunks into one item', () => {
    const state = apply([
      { type: 'turn.started', turnId: 1 },
      { type: 'chunk', text: 'he' },
      { type: 'chunk', text: 'llo' },
    ])
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ kind: 'agent', text: 'hello' })
  })

  it('starts a new agent item after a turn finishes', () => {
    const state = apply([
      { type: 'turn.started', turnId: 1 },
      { type: 'chunk', text: 'a' },
      { type: 'turn.finished', turnId: 1, stopReason: 'end_turn' },
      { type: 'turn.started', turnId: 2 },
      { type: 'chunk', text: 'b' },
    ])
    expect(state.items.map((item) => item.kind)).toEqual(['agent', 'agent'])
    expect((state.items[1] as { text: string }).text).toBe('b')
  })

  it('ignores a turn.finished that does not belong to the live turn', () => {
    const state = apply([
      { type: 'turn.started', turnId: 1 },
      { type: 'turn.started', turnId: 2 },
      { type: 'turn.finished', turnId: 1, stopReason: 'cancelled' },
    ])
    expect(state.status).toBe('streaming')
  })

  it('goes idle when the live turn finishes', () => {
    const state = apply([
      { type: 'turn.started', turnId: 1 },
      { type: 'turn.started', turnId: 2 },
      { type: 'turn.finished', turnId: 2, stopReason: 'end_turn' },
    ])
    expect(state.status).toBe('idle')
  })

  it('appends a live user message and keeps its attachments', () => {
    const state = withUserMessage(empty(), 'look', [
      { name: 'p.png', mimeType: 'image/png', data: 'AAA' },
    ])
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'look' })
    expect((state.items[0] as { attachments: unknown[] }).attachments).toHaveLength(1)
  })

  it('interleaves thought, agent text and tool calls in order', () => {
    const state = apply([
      { type: 'turn.started', turnId: 1 },
      { type: 'thought', text: 'why' },
      { type: 'chunk', text: 'answer' },
      tool({ kind: 'edit' }),
    ])
    expect(state.items.map((item) => item.kind)).toEqual(['thought', 'agent', 'tool'])
  })

  it('merges a tool update by id rather than appending', () => {
    const state = apply([
      { type: 'turn.started', turnId: 1 },
      tool({ kind: 'edit', status: 'pending' }),
      tool({ title: 'tool', status: 'completed' }),
    ])
    expect(state.items.filter((item) => item.kind === 'tool')).toHaveLength(1)
    const item = state.items[0] as { status?: string; toolKind?: string; title: string }
    expect(item.status).toBe('completed')
    expect(item.toolKind).toBe('edit')
    expect(item.title).toBe('edit')
  })

  it('records changed files per turn for edit tools only', () => {
    const state = apply([
      { type: 'turn.started', turnId: 1 },
      tool({ toolCallId: 't1', kind: 'edit', locations: [{ path: 'a.ts' }] }),
      tool({ toolCallId: 't2', kind: 'execute', locations: [{ path: 'ignored.ts' }] }),
      { type: 'turn.finished', turnId: 1, stopReason: 'end_turn' },
      { type: 'turn.started', turnId: 2 },
      tool({ toolCallId: 't3', kind: 'edit', locations: [{ path: 'b.ts' }, { path: 'a.ts' }] }),
    ])
    expect(state.changedFiles).toEqual([
      { turn: 1, files: [{ path: 'a.ts' }] },
      { turn: 2, files: [{ path: 'b.ts' }, { path: 'a.ts' }] },
    ])
  })

  it('session.reset clears the timeline but keeps capabilities', () => {
    const started = apply([
      { type: 'capabilities', image: true, audio: false, embeddedContext: false, fork: false },
      { type: 'turn.started', turnId: 1 },
      { type: 'chunk', text: 'hi' },
    ])
    const state = applyEvent(started, { type: 'session.reset', reason: 'new' })
    expect(state.items).toHaveLength(0)
    expect(state.capabilities.image).toBe(true)
  })

  it('attaches a replayed attachment to the preceding user item', () => {
    const state = apply([
      { type: 'user.chunk', text: 'see this' },
      { type: 'attachment', mimeType: 'image/png', data: 'AAA' },
    ])
    expect((state.items[0] as { attachments: unknown[] }).attachments).toHaveLength(1)
  })

  it('updates capabilities from the event', () => {
    const state = applyEvent(empty(), {
      type: 'capabilities',
      image: true,
      audio: false,
      embeddedContext: false,
      fork: true,
    })
    expect(state.capabilities).toEqual({ image: true, audio: false, embeddedContext: false, fork: true })
  })

  it('marks a user item superseded', () => {
    const state = withUserMessage(empty(), 'oops')
    const id = state.items[0]!.id
    expect(markSuperseded(state, id).items[0]).toMatchObject({ superseded: true })
  })
})

describe('toMessages', () => {
  it('maps user and agent items, dropping thoughts and tools', () => {
    const state = apply([
      { type: 'user.chunk', text: 'q' },
      { type: 'turn.started', turnId: 1 },
      { type: 'thought', text: 'x' },
      { type: 'chunk', text: 'a' },
      tool({}),
    ])
    expect(toMessages(state)).toEqual([
      { id: expect.any(String), role: 'user', text: 'q' },
      { id: expect.any(String), role: 'agent', text: 'a' },
    ])
  })
})

describe('resolvePermission', () => {
  it('drops only the answered request', () => {
    const state = apply([
      {
        type: 'permission.requested',
        requestId: 'r1',
        title: 'Run ls',
      },
      {
        type: 'permission.requested',
        requestId: 'r2',
        title: 'Write file',
      },
    ])
    const resolved = resolvePermission(state, 'r1')
    expect(resolved.pendingPermission.map((p) => p.requestId)).toEqual(['r2'])
  })
})

describe('queue depth', () => {
  it('counts the queue depth', () => {
    const state = applyEvent(empty(), { type: 'queue', pending: 2 })
    expect(state.queued).toBe(2)
    expect(applyEvent(state, { type: 'session.reset', reason: 'new' }).queued).toBe(0)
  })
})
