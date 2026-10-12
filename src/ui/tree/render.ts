/**
 * The tree renderer.
 *
 * Walks a declarative JSON tree and instantiates host atoms. There is no HTML
 * in the vocabulary: an agent's node names an atom, and only registered atoms
 * can render anything. Unknown or broken nodes become visible placeholders
 * rather than exceptions, so a bad agent-authored panel fails loudly instead of
 * taking the window down.
 *
 * Atoms are dumb by contract: they read `node.props`, `ctx.tokens` and
 * `ctx.dispatch`, and never import from `core/`.
 */

export interface UiNode {
  type: string
  props?: Record<string, unknown>
  children?: UiNode[]
}

export interface RenderContext {
  /** Emit a named action for the host to handle. */
  dispatch(action: string, payload?: unknown): void
  /** Theme tokens (CSS custom properties) available to atoms. */
  tokens: Record<string, string>
}

export interface AtomDefinition {
  name: string
  render(node: UiNode, ctx: RenderContext): Node
}

const atoms = new Map<string, AtomDefinition>()

export function registerAtom(definition: AtomDefinition): void {
  atoms.set(definition.name, definition)
}

export function registeredAtoms(): string[] {
  return [...atoms.keys()].sort()
}

const placeholder = (attr: string, value: string, text: string): HTMLElement => {
  const el = document.createElement('div')
  el.setAttribute(attr, value)
  el.textContent = text
  return el
}

export function renderTree(node: UiNode, ctx: RenderContext): Node {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    return placeholder('data-invalid', 'true', 'invalid node')
  }

  const atom = atoms.get(node.type)
  if (!atom) {
    return placeholder('data-unknown', node.type, `unknown atom: ${node.type}`)
  }

  try {
    return atom.render(node, ctx)
  } catch (err) {
    return placeholder('data-error', node.type, `atom failed: ${node.type}: ${(err as Error).message}`)
  }
}

/** Render every child of a node into `parent`. Atoms use this for containers. */
export function renderChildren(node: UiNode, ctx: RenderContext, parent: Node): void {
  for (const child of node.children ?? []) {
    parent.appendChild(renderTree(child, ctx))
  }
}

/** Read a prop as a string, with a fallback. */
export const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
