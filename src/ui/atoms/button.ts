import { registerComponent, getLive, setLive, str } from '../tree/render.ts'
import { controlStyle } from './style.ts'

registerComponent({
  name: 'button',
  create(node, ctx) {
    const el = document.createElement('button')
    el.setAttribute('data-atom', 'button')
    controlStyle(el)
    el.textContent = str(node.props?.label, 'button')
    setLive(el, node, ctx)
    // Installed once; reads the latest node so an action never dispatches with
    // stale payloads.
    el.addEventListener('click', () => {
      const live = getLive(el)
      if (!live) return
      live.ctx.dispatch(str(live.node.props?.action), live.node.props?.payload)
    })
    return el
  },
  update(el, node, ctx) {
    setLive(el, node, ctx)
    const label = str(node.props?.label, str(node.props?.action) || 'button')
    if (el.textContent !== label) el.textContent = label
  },
})
