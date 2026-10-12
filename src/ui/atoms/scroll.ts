import { registerAtom, renderChildren, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'scroll',
  render(node: UiNode, ctx: RenderContext): Node {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'scroll')
    el.style.overflowY = 'auto'
    el.style.minHeight = '0'
    renderChildren(node, ctx, el)
    return el
  },
})
