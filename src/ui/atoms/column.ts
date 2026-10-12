import { applyLayout, registerAtom, renderChildren, str, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'column',
  render(node: UiNode, ctx: RenderContext): Node {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'column')
    el.style.display = 'flex'
    el.style.flexDirection = 'column'
    el.style.gap = str(node.props?.gap, '0.5rem')
    applyLayout(el, node)
    renderChildren(node, ctx, el)
    return el
  },
})
