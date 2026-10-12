// An agent-authored override of the built-in button, to prove the pipeline.
export const component = {
  name: 'button',
  create(node, ctx) {
    const el = document.createElement('button')
    el.setAttribute('data-atom', 'button')
    el.dataset.agentAuthored = 'true'
    el.style.borderRadius = '999px'
    el.style.padding = '0.35rem 1.1rem'
    el.style.background = 'linear-gradient(135deg,#4b7bec,#8e44ad)'
    el.style.color = 'white'
    el.style.border = 'none'
    el.style.cursor = 'pointer'
    el.style.fontWeight = '600'
    ctx.bind(el, node)
    el.addEventListener('click', () => {
      const live = ctx.latest(el)
      if (live) live.ctx.dispatch(String(live.node.props.action ?? ''), live.node.props.payload)
    })
    paint(el, node)
    return el
  },
  update(el, node, ctx) {
    ctx.bind(el, node)
    paint(el, node)
  },
}

function paint(el, node) {
  const label = String(node.props.label ?? 'button')
  const text = '\u2605 ' + label
  if (el.textContent !== text) el.textContent = text
}
