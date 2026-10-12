import { registerAtom, str, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'markdown',
  render(node: UiNode, _ctx: RenderContext): Node {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'markdown')
    // M1 renders plain text with preserved whitespace. This atom is the one
    // place a real markdown renderer will live; until then `textContent` is the
    // safe choice — agent-authored prose never becomes markup.
    el.textContent = str(node.props?.value)
    el.style.whiteSpace = 'pre-wrap'
    return el
  },
})
