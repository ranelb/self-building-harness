import { registerComponent, getLive, setLive, str, type UiNode } from '../tree/render.ts'
import { controlStyle } from './style.ts'

const OPTIONS = Symbol.for('sbh.select.options')

interface Option {
  value: string
  label: string
}

const optionsOf = (node: UiNode): Option[] => {
  const raw = Array.isArray(node.props?.options) ? node.props.options : []
  return raw.map((option) =>
    option && typeof option === 'object'
      ? {
          value: str((option as Record<string, unknown>).value),
          label: str((option as Record<string, unknown>).label, str((option as Record<string, unknown>).value)),
        }
      : { value: String(option), label: String(option) }
  )
}

const signature = (options: Option[]): string => options.map((o) => `${o.value}\u0000${o.label}`).join('\u0001')

const paintOptions = (el: HTMLSelectElement, node: UiNode): void => {
  const options = optionsOf(node)
  const key = signature(options)
  if ((el as unknown as Record<symbol, unknown>)[OPTIONS] !== key) {
    ;(el as unknown as Record<symbol, unknown>)[OPTIONS] = key
    el.replaceChildren()
    for (const option of options) {
      const item = document.createElement('option')
      item.value = option.value
      item.textContent = option.label
      el.appendChild(item)
    }
  }
  el.value = str(node.props?.value)
}

registerComponent({
  name: 'select',
  create(node, ctx) {
    const el = document.createElement('select')
    el.setAttribute('data-atom', 'select')
    controlStyle(el)
    paintOptions(el, node)
    setLive(el, node, ctx)
    el.addEventListener('change', () => {
      const live = getLive(el)
      if (!live) return
      live.ctx.dispatch(str(live.node.props?.action, 'select.change'), { value: el.value })
    })
    return el
  },
  update(el, node, ctx) {
    setLive(el, node, ctx)
    paintOptions(el as HTMLSelectElement, node)
  },
})
