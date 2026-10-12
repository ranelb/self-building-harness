import { registerAtom, str, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'button',
  render(node: UiNode, ctx: RenderContext): Node {
    const action = str(node.props?.action)
    const el = document.createElement('button')
    el.setAttribute('data-atom', 'button')
    el.textContent = str(node.props?.label, action || 'button')
    el.addEventListener('click', () => ctx.dispatch(action, node.props?.payload))
    return el
  },
})
