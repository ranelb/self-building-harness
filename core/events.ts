/**
 * Normalizing ACP into the UI's vocabulary.
 *
 * The event type itself lives in `shared/protocol.ts` — the UI speaks it too, and
 * UI code must not import from `core/`.
 */
import type { UiEvent } from '../shared/protocol.ts'

export type { UiEvent } from '../shared/protocol.ts'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Extract text from an ACP ContentBlock, or null if it is not a text block. */
const textOf = (content: unknown): string | null => {
  if (!isRecord(content)) return null
  return content.type === 'text' && typeof content.text === 'string' ? content.text : null
}

/**
 * Map one ACP `session/update` payload to zero or more UI events.
 *
 * Unknown and malformed updates return `[]` on purpose: a future ACP version
 * adding an update kind must not be able to stall or crash a turn.
 */
export function normalizeUpdate(update: unknown): UiEvent[] {
  if (!isRecord(update)) return []

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textOf(update.content)
      return text === null ? [] : [{ type: 'chunk', text }]
    }

    case 'user_message_chunk': {
      // Only replay (`session/load`) sends this; a live turn does not, so it never
      // duplicates the message the composer already added.
      const text = textOf(update.content)
      return text === null ? [] : [{ type: 'user.chunk', text }]
    }

    case 'agent_thought_chunk': {
      const text = textOf(update.content)
      return text === null ? [] : [{ type: 'thought', text }]
    }

    case 'usage_update': {
      // The context meter's whole data source. ACP carries it; dropping it here is
      // what made a context indicator look impossible to build.
      if (typeof update.used !== 'number' || typeof update.size !== 'number') return []
      const event: UiEvent = { type: 'usage', used: update.used, size: update.size }
      return update.cost === undefined ? [event] : [{ ...event, cost: update.cost }]
    }

    case 'tool_call': {
      if (typeof update.toolCallId !== 'string') return []
      const title =
        typeof update.title === 'string'
          ? update.title
          : typeof update.name === 'string'
            ? update.name
            : 'tool'
      const event: UiEvent = { type: 'tool', toolCallId: update.toolCallId, title }
      return typeof update.status === 'string' ? [{ ...event, status: update.status }] : [event]
    }

    default:
      return []
  }
}

/**
 * Map an inbound `session/request_permission` *request* to a UI event.
 *
 * This is a separate channel from `session/update` — the permission gate is the
 * trust boundary, so it does not ride the update stream.
 */
export function normalizePermissionRequest(params: unknown, requestId: string): UiEvent | null {
  if (!isRecord(params)) return null
  const toolCall = params.toolCall
  const title = isRecord(toolCall)
    ? typeof toolCall.title === 'string'
      ? toolCall.title
      : typeof toolCall.name === 'string'
        ? toolCall.name
        : 'permission'
    : 'permission'
  return { type: 'permission.requested', requestId, title }
}
