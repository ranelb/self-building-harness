import { applyLayout, registerAtom, renderChildren, str, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'row',
  render(node: UiNode, ctx: RenderContext): Node {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'row')
    el.style.display = 'flex'
    el.style.flexDirection = 'row'
    el.style.gap = str(node.props?.gap, '0.5rem')
    el.style.alignItems = str(node.props?.align, 'center')
    applyLayout(el, node)
    renderChildren(node, ctx, el)
    return el
  },
})
