/**
 * The tree node shape, shared because the default layout is written by the core
 * and consumed by the UI.
 */

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

export interface PendingPermission {
  requestId: string
  title: string
}

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
export interface HostState {
  messages: HostMessage[]
  status: 'idle' | 'streaming' | 'error'
  error?: string
  /** The composer's current text. */
  draft: string
  pendingPermission: PendingPermission[]
  notices: string[]
  harness: { value: string; options: PickOption[] }
  model: { value: string; options: PickOption[] }
}
