import { registerAtom, str, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'text',
  render(node: UiNode, _ctx: RenderContext): Node {
    const el = document.createElement('span')
    el.setAttribute('data-atom', 'text')
    el.textContent = str(node.props?.value)
    return el
  },
})
