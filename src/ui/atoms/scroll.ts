import { applyLayout, registerComponent, setLive } from '../tree/render.ts'

/**
 * A scroll pane. `container` + `update` without replacement is what keeps its
 * own scroll position across a re-render — appending a streamed chunk no longer
 * jumps the transcript back to the top.
 */
registerComponent({
  name: 'scroll',
  container: true,
  create(node, ctx) {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'scroll')
    el.style.overflowY = 'auto'
    el.style.minHeight = '0'
    applyLayout(el, node)
    setLive(el, node, ctx)
    return el
  },
  update(el, node, ctx) {
    setLive(el, node, ctx)
    applyLayout(el as HTMLElement, node)
  },
})
