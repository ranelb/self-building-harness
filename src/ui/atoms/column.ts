import { applyLayout, registerComponent, setLive, str, type RenderContext, type UiNode } from '../tree/render.ts'

export function createColumn(node: UiNode, _ctx: RenderContext): Node {
  const el = document.createElement('div')
  el.setAttribute('data-atom', 'column')
  el.style.display = 'flex'
  el.style.flexDirection = 'column'
  el.style.gap = str(node.props?.gap, '0.5rem')
  applyLayout(el, node)
  return el
}

registerComponent({
  name: 'column',
  container: true,
  create: createColumn,
  update(el, node, ctx) {
    setLive(el, node, ctx)
    const element = el as HTMLElement
    element.style.gap = str(node.props?.gap, '0.5rem')
    applyLayout(element, node)
  },
})
