/**
 * Normalizing ACP into the UI's vocabulary.
 *
 * The event type itself lives in `shared/protocol.ts` — the UI speaks it too, and
 * UI code must not import from `core/`.
 */
import type { AvailableCommand, UiEvent } from '../shared/protocol.ts'

export type { UiEvent } from '../shared/protocol.ts'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Extract text from an ACP ContentBlock, or null if it is not a text block. */
const textOf = (content: unknown): string | null => {
  if (!isRecord(content)) return null
  return content.type === 'text' && typeof content.text === 'string' ? content.text : null
}

/** Read ACP `ToolCallLocation[]`, dropping anything malformed. */
const readLocations = (raw: unknown): { path: string; line?: number }[] => {
  if (!Array.isArray(raw)) return []
  const out: { path: string; line?: number }[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue
    out.push(
      typeof entry.line === 'number' ? { path: entry.path, line: entry.line } : { path: entry.path }
    )
  }
  return out
}

/**
 * Read an image/audio content block from a replayed user message, or null.
 * A live turn's attachments are added by the composer; only replay sends these.
 */
const attachmentOf = (content: unknown): UiEvent[] => {
  if (!isRecord(content)) return []
  if (content.type !== 'image' && content.type !== 'audio') return []
  if (typeof content.data !== 'string' || typeof content.mimeType !== 'string') return []
  return [
    {
      type: 'attachment',
      mimeType: content.mimeType,
      data: content.data,
      ...(typeof content.uri === 'string' ? { uri: content.uri } : {}),
    },
  ]
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
      if (text !== null) return [{ type: 'user.chunk', text }]
      return attachmentOf(update.content)
    }

    case 'agent_thought_chunk': {
      const text = textOf(update.content)
      return text === null ? [] : [{ type: 'thought', text }]
    }

    case 'available_commands_update': {
      // The composer's `/` menu. pi advertises its builtins and its skills here, so
      // a skill is reachable without the agent knowing pi's command syntax.
      const raw = update.availableCommands
      if (!Array.isArray(raw)) return []
      const commands: AvailableCommand[] = []
      for (const entry of raw) {
        if (!isRecord(entry) || typeof entry.name !== 'string') continue
        commands.push({
          name: entry.name,
          description: typeof entry.description === 'string' ? entry.description : '',
          ...(entry.input !== undefined ? { input: entry.input } : {}),
        })
      }
      return [{ type: 'commands', commands }]
    }

    case 'usage_update': {
      // The context meter's whole data source. ACP carries it; dropping it here is
      // what made a context indicator look impossible to build.
      if (typeof update.used !== 'number' || typeof update.size !== 'number') return []
      const event: UiEvent = { type: 'usage', used: update.used, size: update.size }
      return update.cost === undefined ? [event] : [{ ...event, cost: update.cost }]
    }

    case 'tool_call':
    case 'tool_call_update': {
      // `tool_call_update` carries the completion (status, locations, content) and
      // often no title; dropping it left every tool card stuck on `pending`.
      if (typeof update.toolCallId !== 'string') return []
      const title =
        typeof update.title === 'string'
          ? update.title
          : typeof update.name === 'string'
            ? update.name
            : 'tool'
      const event: Extract<UiEvent, { type: 'tool' }> = {
        type: 'tool',
        toolCallId: update.toolCallId,
        title,
      }
      if (typeof update.status === 'string') event.status = update.status
      if (typeof update.kind === 'string') event.kind = update.kind
      const locations = readLocations(update.locations)
      if (locations.length > 0) event.locations = locations
      if (update.content !== undefined) event.content = update.content
      if (update.rawInput !== undefined) event.rawInput = update.rawInput
      // Terminal tools (bash) report their output through `_meta`, not `content`:
      // pi-acp streams `terminal_output.data` deltas and a final `terminal_exit`.
      // Dropping `_meta` is why a bash card could never show what it returned.
      const meta = isRecord(update._meta) ? update._meta : null
      if (meta) {
        const terminal = isRecord(meta.terminal_output) ? meta.terminal_output : null
        if (terminal && typeof terminal.data === 'string') event.outputDelta = terminal.data
        const exit = isRecord(meta.terminal_exit) ? meta.terminal_exit : null
        if (exit && typeof exit.exit_code === 'number') event.exitCode = exit.exit_code
      }
      return [event]
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
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
  const title =
    typeof toolCall.title === 'string'
      ? toolCall.title
      : typeof toolCall.name === 'string'
        ? toolCall.name
        : 'permission'
  // The whole tool call goes to the UI: `kind`, `name` and `rawInput` are what an
  // agent-authored card needs to show a command, a path or a diff. Whether it
  // shows them is the agent's decision, not the core's.
  return {
    type: 'permission.requested',
    requestId,
    title,
    ...(typeof toolCall.toolCallId === 'string' ? { toolCallId: toolCall.toolCallId } : {}),
    ...(typeof toolCall.kind === 'string' ? { kind: toolCall.kind } : {}),
    ...(typeof toolCall.name === 'string' ? { name: toolCall.name } : {}),
    ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
  }
}
