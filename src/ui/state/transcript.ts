/**
 * The transcript reducer: pure, no I/O, no timers.
 *
 * One ordered timeline of items (user / agent / thought / tool) rather than a
 * flat list of messages, so reasoning and tool calls interleave where they
 * happened. Also the source for changed files (per turn) and the agent's
 * capabilities. Keeping it pure keeps the awkward cases pinned by ordinary tests.
 */
import type { AgentCapabilities, Attachment, PermissionRequest, UiEvent } from '../../../shared/protocol.ts'
import type { ChangedFilesGroup, HostMessage, TimelineItem, ToolLocation } from '../../../shared/ui.ts'
import type { AvailableCommand } from '../../../shared/protocol.ts'

export type { AgentCapabilities } from '../../../shared/protocol.ts'
export type { ChangedFilesGroup, TimelineItem, ToolLocation } from '../../../shared/ui.ts'

export type PendingPermission = PermissionRequest

export interface Transcript {
  items: TimelineItem[]
  pendingPermission: PendingPermission[]
  status: 'idle' | 'streaming' | 'error'
  error?: string
  /** Files touched by `edit` tools, grouped by the turn that touched them. */
  changedFiles: ChangedFilesGroup[]
  /** The agent's slash commands for the composer's `/` menu. */
  commands: AvailableCommand[]
  capabilities: AgentCapabilities
  /** Monotonic counter; the current turn's group key. */
  turn: number
  /** The turn that produced the currently-open agent item (internal). */
  agentTurn?: number
  /** The core's id for the turn currently streaming (internal). */
  liveTurn?: number
  /** Prompts waiting behind the in-flight turn. */
  queued: number
}

const noCapabilities = (): AgentCapabilities => ({
  image: false,
  audio: false,
  embeddedContext: false,
  fork: false,
})

export const empty = (): Transcript => ({
  items: [],
  pendingPermission: [],
  status: 'idle',
  changedFiles: [],
  commands: [],
  capabilities: noCapabilities(),
  turn: 0,
  queued: 0,
})

let sequence = 0
const nextId = () => `m${(sequence += 1)}`

/** The message view of the timeline, for anything that still wants flat messages. */
export function toMessages(state: Transcript): HostMessage[] {
  return state.items
    .filter((item): item is Extract<TimelineItem, { kind: 'user' | 'agent' }> =>
      item.kind === 'user' || item.kind === 'agent'
    )
    .map((item) => ({ id: item.id, role: item.kind, text: item.text }))
}

export function withUserMessage(state: Transcript, text: string, attachments: Attachment[] = []): Transcript {
  return {
    ...state,
    items: [...state.items, { id: nextId(), kind: 'user', text, attachments }],
  }
}

/** A freshly forked/edited turn: cleared view, same agent capabilities. */
export function reset(state: Transcript): Transcript {
  return { ...empty(), capabilities: state.capabilities }
}

const dedupeLocations = (locations: ToolLocation[]): ToolLocation[] => {
  const byPath = new Map<string, ToolLocation>()
  for (const location of locations) byPath.set(location.path, location)
  return [...byPath.values()]
}

const recordChangedFiles = (
  groups: ChangedFilesGroup[],
  turn: number,
  locations: ToolLocation[]
): ChangedFilesGroup[] => {
  const next = groups.map((group) => ({ turn: group.turn, files: group.files.slice() }))
  let group = next.find((entry) => entry.turn === turn)
  if (!group) {
    group = { turn, files: [] }
    next.push(group)
  }
  group.files = dedupeLocations([...group.files, ...locations])
  return next
}

const makeTool = (event: Extract<UiEvent, { type: 'tool' }>): TimelineItem => ({
  id: nextId(),
  kind: 'tool',
  toolCallId: event.toolCallId,
  title: event.title,
  status: event.status,
  toolKind: event.kind,
  locations: event.locations ?? [],
})

export function applyEvent(state: Transcript, event: UiEvent): Transcript {
  switch (event.type) {
    case 'turn.started':
      return {
        ...state,
        status: 'streaming',
        error: undefined,
        turn: state.turn + 1,
        liveTurn: event.turnId,
      }

    case 'chunk': {
      const last = state.items[state.items.length - 1]
      // Coalesce within one turn only: a chunk after a finished turn is a new
      // message, even though it is still an agent chunk.
      if (state.status === 'streaming' && last && last.kind === 'agent' && state.agentTurn === state.turn) {
        const items = state.items.slice()
        items[items.length - 1] = { ...last, text: last.text + event.text }
        return { ...state, items }
      }
      return {
        ...state,
        status: 'streaming',
        agentTurn: state.turn,
        items: [...state.items, { id: nextId(), kind: 'agent', text: event.text }],
      }
    }

    case 'user.chunk': {
      // Only replay carries these; a live turn's user message is added by the composer.
      const last = state.items[state.items.length - 1]
      if (last && last.kind === 'user') {
        const items = state.items.slice()
        items[items.length - 1] = { ...last, text: last.text + event.text }
        return { ...state, status: 'idle', items }
      }
      return {
        ...state,
        status: 'idle',
        items: [...state.items, { id: nextId(), kind: 'user', text: event.text, attachments: [] }],
      }
    }

    case 'thought': {
      const last = state.items[state.items.length - 1]
      if (last && last.kind === 'thought') {
        const items = state.items.slice()
        items[items.length - 1] = { ...last, text: last.text + event.text }
        return { ...state, items }
      }
      return { ...state, items: [...state.items, { id: nextId(), kind: 'thought', text: event.text }] }
    }

    case 'tool': {
      const index = state.items.findIndex(
        (item) => item.kind === 'tool' && item.toolCallId === event.toolCallId
      )
      const items = state.items.slice()
      if (index >= 0) {
        const existing = items[index] as Extract<TimelineItem, { kind: 'tool' }>
        items[index] = {
          ...existing,
          // An update often has no real title; keep the one the call arrived with.
          title: event.title && event.title !== 'tool' ? event.title : existing.title,
          status: event.status ?? existing.status,
          toolKind: event.kind ?? existing.toolKind,
          locations: event.locations
            ? dedupeLocations([...existing.locations, ...event.locations])
            : existing.locations,
        }
      } else {
        items.push(makeTool(event))
      }
      const tool = items.find(
        (item): item is Extract<TimelineItem, { kind: 'tool' }> =>
          item.kind === 'tool' && item.toolCallId === event.toolCallId
      )
      const changedFiles =
        tool && tool.toolKind === 'edit' && tool.locations.length > 0
          ? recordChangedFiles(state.changedFiles, state.turn, tool.locations)
          : state.changedFiles
      return { ...state, items, changedFiles }
    }

    case 'attachment': {
      // A replayed attachment belongs to the user message it streamed with.
      const last = state.items[state.items.length - 1]
      if (last && last.kind === 'user') {
        const items = state.items.slice()
        items[items.length - 1] = {
          ...last,
          attachments: [
            ...last.attachments,
            { name: event.name ?? 'attachment', mimeType: event.mimeType, data: event.data ?? '' },
          ],
        }
        return { ...state, items }
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            id: nextId(),
            kind: 'user',
            text: '',
            attachments: [{ name: event.name ?? 'attachment', mimeType: event.mimeType, data: event.data ?? '' }],
          },
        ],
      }
    }

    case 'capabilities':
      return {
        ...state,
        capabilities: {
          image: event.image,
          audio: event.audio,
          embeddedContext: event.embeddedContext,
          fork: event.fork,
        },
      }

    case 'commands':
      return { ...state, commands: event.commands }

    case 'turn.finished':
      // A settlement from a turn that is no longer the live one must not flip the
      // composer back to idle while a newer turn streams.
      if (event.turnId !== state.liveTurn) return state
      return { ...state, status: 'idle' }

    case 'error':
      return { ...state, status: 'error', error: event.message }

    case 'permission.requested':
      return { ...state, pendingPermission: [...state.pendingPermission, event] }

    case 'queue':
      return { ...state, queued: event.pending }

    case 'session.reset':
      return reset(state)

    case 'compaction': {
      // Clearing agentTurn is what makes the divider land between the prose: the next
      // chunk must open a new agent item rather than extend the one before the marker.
      const last = state.items[state.items.length - 1]
      if (event.phase === 'start') {
        return {
          ...state,
          agentTurn: undefined,
          items: [...state.items, { id: nextId(), kind: 'divider', pending: true }],
        }
      }
      if (last && last.kind === 'divider' && last.pending) {
        const items = state.items.slice()
        items[items.length - 1] = { ...last, pending: false }
        return { ...state, agentTurn: undefined, items }
      }
      // An end with no start (or after a closed divider): still show the marker.
      return {
        ...state,
        agentTurn: undefined,
        items: [...state.items, { id: nextId(), kind: 'divider', pending: false }],
      }
    }

    default:
      return state
  }
}

export function resolvePermission(state: Transcript, requestId: string): Transcript {
  return {
    ...state,
    pendingPermission: state.pendingPermission.filter((p) => p.requestId !== requestId),
  }
}

/** Mark a user item as superseded (an edited prompt's original turn). */
export function markSuperseded(state: Transcript, id: string): Transcript {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'user' && item.id === id ? { ...item, superseded: true } : item
    ),
  }
}
