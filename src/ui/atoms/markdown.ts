import { registerComponent, setLive, str, type UiNode } from '../tree/render.ts'
import { renderMarkdown } from '../tree/markdown.ts'

const PAINTED = Symbol.for('sbh.markdown.painted')

const paint = (el: HTMLElement, node: UiNode): void => {
  const source = str(node.props?.value)
  if ((el as unknown as Record<symbol, unknown>)[PAINTED] === source) return
  ;(el as unknown as Record<symbol, unknown>)[PAINTED] = source
  el.replaceChildren()
  el.appendChild(renderMarkdown(source))
}

registerComponent({
  name: 'markdown',
  // The one component that turns model-authored prose into structure. It builds
  // DOM nodes (see tree/markdown.ts), so markup stays inert even though
  // components themselves are trusted code.
  create(node, ctx) {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'markdown')
    el.className = 'sbh-markdown'
    paint(el, node)
    setLive(el, node, ctx)
    return el
  },
  update(el, node, ctx) {
    setLive(el, node, ctx)
    paint(el as HTMLElement, node)
  },
})
