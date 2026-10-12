import { registerAtom, str, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'input',
  render(node: UiNode, ctx: RenderContext): Node {
    const action = str(node.props?.action, 'input.change')
    const el = document.createElement('input')
    el.setAttribute('data-atom', 'input')
    el.value = str(node.props?.value)
    if (node.props?.placeholder !== undefined) {
      el.placeholder = str(node.props.placeholder)
    }
    el.addEventListener('input', () => ctx.dispatch(action, { value: el.value }))
    return el
  },
})
