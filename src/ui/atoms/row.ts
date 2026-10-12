import { applyLayout, registerComponent, setLive, str } from '../tree/render.ts'

registerComponent({
  name: 'row',
  container: true,
  create(node, ctx) {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'row')
    el.style.display = 'flex'
    el.style.flexDirection = 'row'
    el.style.gap = str(node.props?.gap, 'var(--sbh-space-sm)')
    el.style.alignItems = str(node.props?.align, 'center')
    applyLayout(el, node)
    setLive(el, node, ctx)
    return el
  },
  update(el, node, ctx) {
    setLive(el, node, ctx)
    const element = el as HTMLElement
    element.style.gap = str(node.props?.gap, 'var(--sbh-space-sm)')
    element.style.alignItems = str(node.props?.align, 'center')
    applyLayout(element, node)
  },
})
