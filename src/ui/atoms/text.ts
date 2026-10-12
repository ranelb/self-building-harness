import { registerComponent, setLive, str } from '../tree/render.ts'

registerComponent({
  name: 'text',
  create(node, ctx) {
    const el = document.createElement('span')
    el.setAttribute('data-atom', 'text')
    el.textContent = str(node.props?.value)
    setLive(el, node, ctx)
    return el
  },
  update(el, node, ctx) {
    setLive(el, node, ctx)
    const value = str(node.props?.value)
    if (el.textContent !== value) el.textContent = value
  },
})
