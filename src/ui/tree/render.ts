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
import type { HostState, UiNode } from '../../../shared/ui.ts'

export type { HostState, SessionSummary, UiNode } from '../../../shared/ui.ts'
export interface RenderContext {
  /** Emit a named action for the host to handle. */
  dispatch(action: string, payload?: unknown): void
  /** Theme tokens available to components. */
  tokens: Record<string, string>
  /** Live session state — how a static layout becomes dynamic. */
  host: HostState
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
  /**
   * Tear down before the element leaves the tree.
   *
   * Required for anything holding a timer, a `requestAnimationFrame` loop, or a
   * listener on `window`/`document`: reconciliation replaces elements routinely
   * (hot reload, an agent editing its own layout), and without this the loop keeps
   * running against a detached node forever. Measured: one edit left two rAF loops
   * both ticking at full rate.
   */
  destroy?(el: Node, node: UiNode, ctx: RenderContext): void
  /** The renderer owns this element's children and reconciles them. */
  container?: boolean
  /**
   * Every UiEvent kind (`host.schema.kinds`) must be accounted for by exactly
   * one of two lists, and anything in neither is "new to the schema":
   *
   * - `handledEvents` — kinds the component renders.
   * - `unhandledEvents` — kinds it DELIBERATELY does not render (usage, config, ...).
   * - anything else — missing: the core added it and the component has not decided.
   *
   * Declare both as named exports of the component module, alongside `name`:
   * `export const component = { name, handledEvents: [...], unhandledEvents: [...], create }`.
   * When kinds are missing the runtime shows a notice inside the component, so an
   * override that predates a new kind does not drop it silently. Declare both lists
   * and the notice fires only for kinds in neither. Declare neither and an
   * *override* of a built-in gets a softer notice; a new component gets none.
   */
  handledEvents?: string[]
  /** Kinds the component deliberately ignores; see `handledEvents`. */
  unhandledEvents?: string[]
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
  overridden.delete(name)
}

/** Names of loaded components that replace a built-in of the same name. */
const overridden = new Set<string>()

/** Record that a loaded component overrides a built-in (see `handledEvents`). */
export function markOverride(name: string): void {
  overridden.add(name)
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
  setLive(el, node, ctx)

  // Mount is create *plus* update, so a component needs only one painting path.
  // Without this, anything that fills its element in `update` renders blank until
  // something else happens to trigger an update — an easy trap to fall into.
  try {
    component.update?.(el, node, ctx)
  } catch (err) {
    return placeholder('data-error', node.type, `component failed: ${node.type}: ${(err as Error).message}`)
  }

  if (component.container) reconcileChildren(el, node, ctx)
  staleNotice(el, component, ctx)
  return el
}

const STALE = 'data-component-stale'

/**
 * Show whether `component` is behind the core's event schema.
 *
 * Unknown schema (version 0 or no kinds, i.e. before the core's first publish)
 * shows nothing: flagging on first paint would be a false alarm every launch.
 * Idempotent: any previous notice is removed before the current one is added,
 * and nothing here throws, so a notice can never break the component it sits in.
 */
function staleNotice(el: Node, component: Component, ctx: RenderContext): void {
  try {
    if (!(el instanceof Element)) return
    for (const child of Array.from(el.children)) {
      if (child.hasAttribute(STALE)) child.remove()
    }

    const schema = ctx.host?.schema
    if (!schema || schema.version === 0 || schema.kinds.length === 0) return

    let marker: string
    let text: string
    if (component.handledEvents || component.unhandledEvents) {
      // Declared kinds, rendered or deliberately ignored, are accounted for; the rest are new.
      const declared = new Set([...(component.handledEvents ?? []), ...(component.unhandledEvents ?? [])])
      const missing = schema.kinds.filter((kind) => !declared.has(kind))
      if (missing.length === 0) return
      marker = 'true'
      text = `component is out of date — missing: ${missing.join(', ')}`
    } else if (overridden.has(component.name)) {
      marker = 'undeclared'
      text = 'does not declare handledEvents or unhandledEvents; new event kinds may be dropped silently'
    } else {
      return
    }

    const notice = document.createElement('div')
    notice.setAttribute(STALE, marker)
    notice.textContent = text
    notice.style.color = ctx.tokens['--sbh-color-textMuted'] ?? 'currentColor'
    notice.style.fontSize = 'var(--sbh-font-size-sm)'
    el.appendChild(notice)
  } catch {
    // A notice is advisory; failing to draw it must not fail the render.
  }
}

/**
 * Tear down an element and everything under it, deepest first.
 *
 * A cleanup that throws must not break the render that is already in flight, so
 * each one is isolated.
 */
function destroyTree(el: Node, ctx: RenderContext): void {
  for (const child of Array.from(el.childNodes)) destroyTree(child, ctx)

  const component = (el as Tagged)[COMPONENT]
  if (!component?.destroy) return

  const live = getLive(el)
  try {
    component.destroy(el, live?.node ?? ({} as UiNode), live?.ctx ?? ctx)
  } catch {
    // A component that cannot clean up is not a reason to fail the render.
  }
  delete (el as Tagged)[COMPONENT]
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

  setLive(el, node, ctx)
  if (component.container) reconcileChildren(el, node, ctx)
  staleNotice(el, component, ctx)
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
    if (next !== existing) {
      destroyTree(existing, ctx)
      parent.replaceChild(next, existing)
    }
  }

  while (parent.childNodes.length > desired.length) {
    const extra = parent.lastChild as Node
    destroyTree(extra, ctx)
    parent.removeChild(extra)
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
  if (next !== existing) {
    destroyTree(existing, ctx)
    parent.replaceChild(next, existing)
  }

  while (parent.childNodes.length > 1) {
    const extra = parent.lastChild as Node
    destroyTree(extra, ctx)
    parent.removeChild(extra)
  }
}

/** One-shot mount, for tests and isolated rendering. */
export function renderTree(node: UiNode, ctx: RenderContext): Node {
  return mount(node, ctx)
}

/**
 * Apply the layout props a node carries.
 *
 * Shared layout props, so a template can lay itself out without injecting CSS.
 * Deliberately a small fixed vocabulary rather than a style passthrough.
 *
 * A growing flex item needs `min-width:0` *and* `min-height:0`: without them its
 * automatic minimum size is its content, so a tall child (the session list)
 * stretches the container past its parent instead of scrolling. Chromium
 * happened to absorb that; WebKitGTK did not, and pushed the composer below the
 * window.
 */
export function applyLayout(el: HTMLElement, node: UiNode): void {
  if (node.props?.grow) {
    el.style.flexGrow = '1'
    el.style.minWidth = '0'
    el.style.minHeight = '0'
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
