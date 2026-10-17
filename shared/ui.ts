/**
 * The tree node shape, shared because the default layout is written by the core
 * and consumed by the UI.
 */

import type {
  AgentCapabilities,
  Attachment,
  AvailableCommand,
  ContextEntry,
  PermissionRequest,
} from './protocol.ts'

export interface UiNode {
  type: string
  props?: Record<string, unknown>
  children?: UiNode[]
}

/**
 * Shallow validation of an agent-authored layout.
 *
 * Deliberately lenient: a node with a type the app does not know renders as a
 * labelled placeholder, so the useful check is that this is a tree at all. A
 * layout that is not one falls back to the default rather than blanking the app.
 */
export function isValidLayout(value: unknown): value is UiNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const node = value as UiNode
  if (typeof node.type !== 'string' || node.type === '') return false
  if (node.props !== undefined && (typeof node.props !== 'object' || node.props === null)) return false
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) return false
    return node.children.every(isValidLayout)
  }
  return true
}

// --- host state -----------------------------------------------------------------

export interface HostMessage {
  id: string
  role: 'user' | 'agent'
  text: string
}

export interface ToolLocation {
  path: string
  line?: number
}

/**
 * One entry in the conversation timeline. Ordering is the point: reasoning and
 * tool calls sit where they happened, not flattened into messages.
 */
export type TimelineItem =
  | { id: string; kind: 'user'; text: string; attachments: Attachment[]; superseded?: boolean }
  | { id: string; kind: 'agent'; text: string }
  | { id: string; kind: 'thought'; text: string }
  /** A compaction marker. `pending` while the agent is still compacting. */
  | { id: string; kind: 'divider'; pending?: boolean }
  /** An `@path:lines` mention the core resolved, or refused (`reason`). */
  | { id: string; kind: 'context'; mention: string; status: 'included' | 'skipped'; lines?: { start: number; end: number }; reason?: string }
  | {
      id: string
      kind: 'tool'
      toolCallId: string
      title: string
      status?: string
      /** ACP ToolKind (`edit`, `execute`, …); `kind` is taken by the discriminant. */
      toolKind?: string
      locations: ToolLocation[]
      /** Accumulated terminal output (`outputDelta`), shown in a `<pre>`. */
      output?: string
      exitCode?: number
      /** `shell`: a user command the core ran, not the agent. */
      origin?: 'shell'
      /** `shell`: false for `!!`, which is shown locally and never sent to the model. */
      includeInContext?: boolean
    }

/** Files touched by `edit` tools, grouped by the turn that touched them. */
export interface ChangedFilesGroup {
  turn: number
  files: ToolLocation[]
}

export type PendingPermission = PermissionRequest

export interface PickOption {
  value: string
  label: string
}

/**
 * The live state a host component reads.
 *
 * This is the whole binding model: the layout is static structure, and anything
 * dynamic is a component reading this. There is no expression language and no
 * bind syntax to learn.
 */
export interface SessionSummary {
  id: string
  title: string
  cwd: string
  startedAt: string
  updatedAt: string
}

export interface HostState {
  messages: HostMessage[]
  /** The ordered conversation timeline; reasoning and tools included. */
  items: TimelineItem[]
  /** Files edited, grouped per turn. */
  changedFiles: ChangedFilesGroup[]
  /** The agent's slash commands for the composer's `/` menu. */
  commands: AvailableCommand[]
  /** Attachments staged in the composer, not yet sent. */
  draftAttachments: Attachment[]
  /** `!` results that will ride the next prompt; shown as removable chips. */
  pendingContext: ContextEntry[]
  /** What the agent reported it can do (image, fork, …). */
  capabilities: AgentCapabilities
  status: 'idle' | 'streaming' | 'error'
  /** Prompts waiting behind the in-flight turn. */
  queued: number
  error?: string
  /** The composer's current text. */
  draft: string
  pendingPermission: PendingPermission[]
  notices: string[]
  harness: { value: string; options: PickOption[] }
  model: { value: string; options: PickOption[] }
  /** Past conversations, newest first. Read-only — the app never writes them. */
  sessions: SessionSummary[]
  /**
   * Keyed values published by the core — `usage` from the agent, `system` from the
   * machine. Components read this; new keys need no protocol change.
   */
  data: Record<string, unknown>
}
