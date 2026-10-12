import { registerAtom, str, type RenderContext, type UiNode } from '../tree/render.ts'
import { renderMarkdown } from '../tree/markdown.ts'

registerAtom({
  name: 'markdown',
  // The one atom that turns agent-authored prose into structure. It builds DOM
  // nodes directly (see tree/markdown.ts) so markup is inert.
  render(node: UiNode, _ctx: RenderContext): Node {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'markdown')
    el.className = 'sbh-markdown'
    el.appendChild(renderMarkdown(str(node.props?.value)))
    return el
  },
})
