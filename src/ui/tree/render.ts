/**
 * The tree renderer and the component registry.
 *
 * A component is a function over a node: `create` mounts it, `update` reconciles
 * it in place. That contract is deliberately the same one the built-in atoms use,
 * because agent-authored components are loaded through the very same registry —
 * there is no second plugin system.
 *
 * Two rules hold regardless of how much we trust component code:
 *   - a component that throws, or an unknown type, renders as a labelled
 *     placeholder rather than taking the window down;
 *   - prose that arrives from a model goes through node-building (see
 *     `markdown.ts`), never `innerHTML`.
 */

export interface UiNode {
  type: string
  props?: Record<string, unknown>
  children?: UiNode[]
}
export interface RenderContext {
  /** Emit a named action for the host to handle. */
  dispatch(action: string, payload?: unknown): void
  /** Theme tokens available to components. */
  tokens: Record<string, string>
  /**
   * Record the node this element currently represents.
   *
   * An event listener is installed once, at `create` time, so it must read the
   * *latest* node rather than closing over the one from mount. This is the
   * documented way an agent-authored component does that, since a loaded module
   * cannot import the registry's internals.
   */
  bind(el: Node, node: UiNode): void
  /** Recall what `bind` recorded — how a listener reads the current node. */
  latest(el: Node): LiveNode | undefined
}

export interface Component {
  name: string
  /** Create the element. Must NOT append children when `container` is set. */
  create(node: UiNode, ctx: RenderContext): Node
  /**
   * Reconcile the element in place. Omitting it means the element is replaced on
   * every update, which discards its state — declare one if the component holds
   * focus, scroll, canvas buffers or animation.
   */
  update?(el: Node, node: UiNode, ctx: RenderContext): void
  /** The renderer owns this element's children and reconciles them. */
  container?: boolean
}

const components = new Map<string, Component>()

/** Marks the node type an element was built for, so patching can detect a swap. */
const TYPE = Symbol.for('sbh.nodeType')

/**
 * Marks the component *implementation* that built an element.
 *
 * Type alone is not enough: a loaded component can override a built-in of the
 * same name (that is the point), and patching the old element with the new
 * implementation's `update` produced a hybrid — the new label on an element the
 * built-in had created. Comparing implementation identity forces a clean remount.
 */
const COMPONENT = Symbol.for('sbh.component')

type Tagged = Node & { [TYPE]?: string; [COMPONENT]?: Component }

export function registerComponent(component: Component): void {
  components.set(component.name, component)
}

export function registeredComponents(): string[] {
  return [...components.keys()].sort()
}

/** Needed by hot reload: a component whose file was deleted must stop resolving. */
export function unregisterComponent(name: string): void {
  components.delete(name)
}

export function resolveComponent(type: string): Component | undefined {
  return components.get(type)
}

const placeholder = (attr: string, value: string, text: string): HTMLElement => {
  const el = document.createElement('div')
  el.setAttribute(attr, value)
  el.textContent = text
  return el
}

function mount(node: UiNode, ctx: RenderContext): Node {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    return placeholder('data-invalid', 'true', 'invalid node')
  }

  const component = components.get(node.type)
  if (!component) {
    return placeholder('data-unknown', node.type, `unknown component: ${node.type}`)
  }

  let el: Node
  try {
    el = component.create(node, ctx)
  } catch (err) {
    return placeholder('data-error', node.type, `component failed: ${node.type}: ${(err as Error).message}`)
  }

  ;(el as Tagged)[TYPE] = node.type
  ;(el as Tagged)[COMPONENT] = component
  if (component.container) reconcileChildren(el, node, ctx)
  return el
}

/**
 * Reconcile `el` to match `node`, returning the element to use — the same one
 * when the type matches, a replacement otherwise.
 */
export function patchTree(el: Node, node: UiNode, ctx: RenderContext): Node {
  const tagged = el as Tagged

  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    return tagged[TYPE] === undefined
      ? el
      : placeholder('data-invalid', 'true', 'invalid node')
  }

  const component = components.get(node.type)
  if (!component || tagged[TYPE] !== node.type || tagged[COMPONENT] !== component) {
    return mount(node, ctx)
  }

  try {
    component.update?.(el, node, ctx)
  } catch (err) {
    return placeholder('data-error', node.type, `component failed: ${node.type}: ${(err as Error).message}`)
  }

  if (component.container) reconcileChildren(el, node, ctx)
  return el
}

/**
 * Reconcile children positionally.
 *
 * Positional is sufficient while lists only append (the transcript does). A list
 * that reorders needs keys, which is not built yet.
 */
function reconcileChildren(parent: Node, node: UiNode, ctx: RenderContext): void {
  const desired = node.children ?? []

  for (let index = 0; index < desired.length; index += 1) {
    const child = desired[index] as UiNode
    const existing = parent.childNodes[index]

    if (!existing) {
      parent.appendChild(mount(child, ctx))
      continue
    }

    const next = patchTree(existing, child, ctx)
    if (next !== existing) parent.replaceChild(next, existing)
  }

  while (parent.childNodes.length > desired.length) {
    parent.removeChild(parent.lastChild as Node)
  }
}

/** Mount or reconcile a single root node inside `parent`. */
export function renderInto(parent: Node, node: UiNode, ctx: RenderContext): void {
  const existing = parent.firstChild
  if (!existing) {
    parent.appendChild(mount(node, ctx))
    return
  }

  const next = patchTree(existing, node, ctx)
  if (next !== existing) parent.replaceChild(next, existing)

  while (parent.childNodes.length > 1) {
    parent.removeChild(parent.lastChild as Node)
  }
}

/** One-shot mount, for tests and isolated rendering. */
export function renderTree(node: UiNode, ctx: RenderContext): Node {
  return mount(node, ctx)
}

/**
 * Shared layout props, so a template can lay itself out without injecting CSS.
 * Deliberately a small fixed vocabulary rather than a style passthrough.
 */
export function applyLayout(el: HTMLElement, node: UiNode): void {
  if (node.props?.grow) {
    el.style.flexGrow = '1'
    el.style.minWidth = '0'
  }
}

/** Read a prop as a string, with a fallback. */
export const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)

const LIVE = Symbol.for('sbh.live')

export interface LiveNode {
  node: UiNode
  ctx: RenderContext
}

/**
 * Record the node and context an element currently represents.
 *
 * Event listeners are installed once at `create` time but must dispatch against
 * the *latest* node and context — closing over the ones from mount is how an
 * earlier bug sent a stale draft.
 */
export function setLive(el: Node, node: UiNode, ctx: RenderContext): void {
  ;(el as Tagged & { [LIVE]?: LiveNode })[LIVE] = { node, ctx }
}

export function getLive(el: Node): LiveNode | undefined {
  return (el as Tagged & { [LIVE]?: LiveNode })[LIVE]
}

/** The `bind` helper handed to every component, including loaded ones. */
export const bindTo = (ctx: RenderContext) => (el: Node, node: UiNode) => setLive(el, node, ctx)
