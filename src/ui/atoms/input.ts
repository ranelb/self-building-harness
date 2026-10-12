import { applyLayout, registerComponent, getLive, setLive, str } from '../tree/render.ts'

registerComponent({
  name: 'input',
  create(node, ctx) {
    const el = document.createElement('input')
    el.setAttribute('data-atom', 'input')
    el.value = str(node.props?.value)
    if (node.props?.placeholder !== undefined) el.placeholder = str(node.props.placeholder)
    applyLayout(el, node)
    setLive(el, node, ctx)
    el.addEventListener('input', () => {
      const live = getLive(el)
      if (!live) return
      live.ctx.dispatch(str(live.node.props?.action, 'input.change'), { value: el.value })
    })
    return el
  },
  update(el, node, ctx) {
    setLive(el, node, ctx)
    const input = el as HTMLInputElement
    if (node.props?.placeholder !== undefined) input.placeholder = str(node.props.placeholder)
    applyLayout(input, node)
    // Never clobber what the user is currently typing. The element survives
    // re-renders, so its live value is the freshest source there is.
    if (document.activeElement !== input) {
      const value = str(node.props?.value)
      if (input.value !== value) input.value = value
    }
  },
})
