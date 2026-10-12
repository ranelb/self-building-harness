/**
 * Host components: the dynamic pieces a static layout refers to.
 *
 * These are ordinary components — registered in the same registry, overridable by
 * an agent like anything else. They exist so the *layout* can stay plain static
 * JSON while the transcript, the composer and the permission card stay live.
 */
import {
  applyLayout,
  getLive,
  registerComponent,
  setLive,
  str,
  type UiNode,
} from '../tree/render.ts'
import { renderMarkdown } from '../tree/markdown.ts'
import { controlStyle, fieldStyle } from '../atoms/style.ts'

const stream = (el: HTMLElement, node: UiNode): void => {
  el.setAttribute('data-atom', 'stream')
  el.style.display = 'flex'
  el.style.flexDirection = 'column'
  el.style.gap = str(node.props?.gap, 'var(--sbh-space-sm)')
  applyLayout(el, node)
}

// --- notices: component failures, plus the undo ---------------------------------

registerComponent({
  name: 'notices',
  create() {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'notices')
    el.style.display = 'none'
    el.style.flexDirection = 'column'
    el.style.gap = 'var(--sbh-space-xs)'
    return el
  },
  update(el, _node, ctx) {
    const host = el as HTMLElement
    const notices = ctx.host.notices
    if (notices.length === 0) {
      host.style.display = 'none'
      host.replaceChildren()
      return
    }

    host.style.display = 'flex'
    host.replaceChildren()
    for (const notice of notices) {
      const line = document.createElement('div')
      line.textContent = `component unavailable — ${notice}`
      line.style.color = 'var(--sbh-color-danger)'
      line.style.fontSize = 'var(--sbh-font-size-sm)'
      host.appendChild(line)
    }

    const revert = document.createElement('button')
    revert.textContent = 'Revert last change'
    controlStyle(revert)
    revert.style.alignSelf = 'flex-start'
    revert.addEventListener('click', () => ctx.dispatch('ui.revert'))
    host.appendChild(revert)
  },
})

// --- transcript ------------------------------------------------------------------

registerComponent({
  name: 'transcript',
  create(node) {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'transcript')
    el.style.overflowY = 'auto'
    el.style.minHeight = '0'
    stream(el, node)
    return el
  },
  update(el, node, ctx) {
    const host = el as HTMLElement
    stream(host, node)

    // Rebuilt wholesale: messages are stateless leaves, and this keeps the
    // component honest about whose job the list is.
    host.replaceChildren()
    for (const message of ctx.host.messages) {
      const line = document.createElement('div')
      line.className = 'sbh-markdown'
      line.appendChild(renderMarkdown(message.role === 'user' ? `**you:** ${message.text}` : message.text))
      host.appendChild(line)
    }
    if (ctx.host.status === 'error' && ctx.host.error) {
      const line = document.createElement('div')
      line.textContent = `error: ${ctx.host.error}`
      line.style.color = 'var(--sbh-color-danger)'
      host.appendChild(line)
    }
    host.scrollTop = host.scrollHeight
  },
})

// --- permission ------------------------------------------------------------------

registerComponent({
  name: 'permission',
  create() {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'permission')
    el.style.display = 'none'
    el.style.flexDirection = 'column'
    el.style.gap = 'var(--sbh-space-xs)'
    return el
  },
  update(el, _node, ctx) {
    const host = el as HTMLElement
    const pending = ctx.host.pendingPermission
    if (pending.length === 0) {
      host.style.display = 'none'
      host.replaceChildren()
      return
    }

    host.style.display = 'flex'
    host.replaceChildren()
    for (const request of pending) {
      const label = document.createElement('div')
      label.textContent = `Permission requested: ${request.title}`
      host.appendChild(label)

      const row = document.createElement('div')
      row.style.display = 'flex'
      row.style.gap = 'var(--sbh-space-sm)'
      for (const [text, decision] of [
        ['Allow', 'permission.allow'],
        ['Deny', 'permission.deny'],
      ] as const) {
        const button = document.createElement('button')
        button.textContent = text
        controlStyle(button)
        button.addEventListener('click', () => ctx.dispatch(decision, { requestId: request.requestId }))
        row.appendChild(button)
      }
      host.appendChild(row)
    }
  },
})

// --- composer --------------------------------------------------------------------

registerComponent({
  name: 'composer',
  create() {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'composer')
    el.style.display = 'flex'
    el.style.gap = 'var(--sbh-space-sm)'

    const input = document.createElement('input')
    input.setAttribute('data-atom', 'input')
    fieldStyle(input)
    input.placeholder = 'Message'
    input.style.flexGrow = '1'
    input.style.minWidth = '0'
    input.addEventListener('input', () => {
      const live = getLive(el)
      if (live) live.ctx.dispatch('prompt.draft', { value: input.value })
    })
    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        const live = getLive(el)
        if (live) live.ctx.dispatch('prompt.send')
      }
    })

    const send = document.createElement('button')
    send.textContent = 'Send'
    controlStyle(send)
    send.addEventListener('click', () => {
      const live = getLive(el)
      if (live) live.ctx.dispatch('prompt.send')
    })

    el.append(input, send)
    return el
  },
  update(el, _node, ctx) {
    setLive(el, { type: 'composer' }, ctx)
    const element = el as HTMLElement
    const input = element.querySelector('input') as HTMLInputElement | null
    // Same rule as the input atom: never overwrite what is being typed.
    if (input && document.activeElement !== input && input.value !== ctx.host.draft) {
      input.value = ctx.host.draft
    }
  },
})

// --- pickers ---------------------------------------------------------------------

const makePicker = (name: string, key: 'harness' | 'model', action: string): void => {
  registerComponent({
    name,
    create() {
      const el = document.createElement('select')
      el.setAttribute('data-atom', name)
      controlStyle(el)
      return el
    },
    update(el, _node, ctx) {
      const select = el as HTMLSelectElement
      const state = ctx.host[key]
      select.replaceChildren()
      for (const option of state.options) {
        const item = document.createElement('option')
        item.value = option.value
        item.textContent = option.label
        select.appendChild(item)
      }
      select.value = state.value
      select.onchange = () => ctx.dispatch(action, { value: select.value })
    },
  })
}

makePicker('harnessPicker', 'harness', 'harness.change')
makePicker('modelPicker', 'model', 'model.change')
