import { registerAtom, str, type RenderContext, type UiNode } from '../tree/render.ts'

registerAtom({
  name: 'select',
  render(node: UiNode, ctx: RenderContext): Node {
    const action = str(node.props?.action, 'select.change')
    const el = document.createElement('select')
    el.setAttribute('data-atom', 'select')
    el.value = str(node.props?.value)

    const options = Array.isArray(node.props?.options) ? node.props.options : []
    for (const option of options) {
      const item = document.createElement('option')
      if (option && typeof option === 'object') {
        const record = option as Record<string, unknown>
        item.value = str(record.value)
        item.textContent = str(record.label, item.value)
      } else {
        item.value = String(option)
        item.textContent = String(option)
      }
      el.appendChild(item)
    }

    el.addEventListener('change', () => ctx.dispatch(action, { value: el.value }))
    return el
  },
})
