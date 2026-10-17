import { describe, it, expect } from 'vitest'
import { EVENT_SCHEMA_VERSION, UI_EVENT_KINDS, type UiEvent } from './protocol.ts'

// The union, as a list of its discriminants, written out by hand. If a kind is
// added to UiEvent this list fails to compile (see the type guard in protocol.ts)
// and the runtime assertion below pins the spelling.
const EXPECTED: UiEvent['type'][] = [
  'chunk', 'user.chunk', 'thought', 'tool', 'attachment', 'context',
  'permission.requested', 'usage', 'compaction', 'config', 'permission.resolved',
  'turn.started', 'turn.finished', 'queue', 'session.reset', 'commands',
  'capabilities', 'error',
]

describe('UI_EVENT_KINDS', () => {
  it('lists every UiEvent kind exactly once', () => {
    expect([...UI_EVENT_KINDS].sort()).toEqual([...EXPECTED].sort())
    expect(new Set(UI_EVENT_KINDS).size).toBe(UI_EVENT_KINDS.length)
  })

  it('names the kinds an override is most likely to miss', () => {
    expect(UI_EVENT_KINDS).toEqual(expect.arrayContaining(['context', 'compaction', 'queue']))
  })

  it('starts the schema version at a positive integer', () => {
    expect(Number.isInteger(EVENT_SCHEMA_VERSION)).toBe(true)
    expect(EVENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })
})
