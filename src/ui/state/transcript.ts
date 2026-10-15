/**
 * The transcript reducer: pure, no I/O, no timers.
 *
 * Keeps the render-testable core of the UI independent of the socket, so the
 * awkward cases (chunks arriving after an error, a second turn, an answered
 * permission) are pinned by ordinary unit tests.
 */
import type { PermissionRequest, UiEvent } from '../../../shared/protocol.ts'

export interface TranscriptMessage {
  id: string
  role: 'user' | 'agent'
  text: string
}

export type PendingPermission = PermissionRequest

export interface Transcript {
  messages: TranscriptMessage[]
  pendingPermission: PendingPermission[]
  status: 'idle' | 'streaming' | 'error'
  error?: string
}

export const empty = (): Transcript => ({ messages: [], pendingPermission: [], status: 'idle' })

let sequence = 0
const nextId = () => `m${(sequence += 1)}`

export function withUserMessage(state: Transcript, text: string): Transcript {
  return { ...state, messages: [...state.messages, { id: nextId(), role: 'user', text }] }
}

/**
 * Build a transcript from stored turns, to view a past conversation.
 *
 * Viewing is not resuming: this replaces what is on screen, and the agent is still
 * attached to its own current session.
 */
export function fromTurns(turns: { role: 'user' | 'assistant'; text: string }[]): Transcript {
  return {
    messages: turns.map((turn) => ({
      id: nextId(),
      role: turn.role === 'user' ? 'user' : 'agent',
      text: turn.text,
    })),
    pendingPermission: [],
    status: 'idle',
  }
}

export function applyEvent(state: Transcript, event: UiEvent): Transcript {
  switch (event.type) {
    case 'turn.started':
      return { ...state, status: 'streaming', error: undefined }

    case 'chunk': {
      const last = state.messages[state.messages.length - 1]
      // Consecutive chunks of one turn are one message; a chunk arriving after
      // the turn closed starts a new one.
      if (state.status === 'streaming' && last && last.role === 'agent') {
        const messages = state.messages.slice()
        messages[messages.length - 1] = { ...last, text: last.text + event.text }
        return { ...state, messages }
      }
      return {
        ...state,
        status: 'streaming',
        messages: [...state.messages, { id: nextId(), role: 'agent', text: event.text }],
      }
    }

    case 'user.chunk': {
      // Only replayed history carries these; a live turn's user message was added
      // by the composer, so this cannot duplicate it.
      const previous = state.messages[state.messages.length - 1]
      if (previous && previous.role === 'user') {
        const messages = state.messages.slice()
        messages[messages.length - 1] = { ...previous, text: previous.text + event.text }
        return { ...state, messages }
      }
      return {
        ...state,
        status: 'idle',
        messages: [...state.messages, { id: nextId(), role: 'user', text: event.text }],
      }
    }

    case 'turn.finished':
      return { ...state, status: 'idle' }

    case 'error':
      return { ...state, status: 'error', error: event.message }

    case 'permission.requested':
      return {
        ...state,
        pendingPermission: [...state.pendingPermission, event],
      }

    default:
      // `thought` and `tool` carry nothing the M1 box renders.
      return state
  }
}

export function resolvePermission(state: Transcript, requestId: string): Transcript {
  return {
    ...state,
    pendingPermission: state.pendingPermission.filter((p) => p.requestId !== requestId),
  }
}
