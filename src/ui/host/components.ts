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
  type RenderContext,
  type UiNode,
} from '../tree/render.ts'
import { renderMarkdown } from '../tree/markdown.ts'
import { controlStyle, fieldStyle } from '../atoms/style.ts'
import type { Attachment } from '../../../shared/protocol.ts'
import type { TimelineItem } from '../../../shared/ui.ts'

const stream = (el: HTMLElement, node: UiNode): void => {
  // Note: no `data-atom` here. Each component sets its own; a shared helper that
  // stamped one clobbered the transcript's and made it unaddressable.
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
    // Manifest decisions are visibility: show the recent denials so a blocked
    // action is not silent. Allows are left to the audit log (they are the norm).
    const denials = Array.isArray(ctx.host.data.policy)
      ? (ctx.host.data.policy as { capability?: unknown; decision?: unknown; subject?: unknown }[]).filter(
          (entry) => entry.decision === 'deny'
        )
      : []
    if (notices.length === 0 && denials.length === 0) {
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

    for (const entry of denials.slice(0, 3)) {
      const line = document.createElement('div')
      const subject = entry.subject === undefined ? '' : ` · ${String(entry.subject)}`
      line.textContent = `policy denied · ${String(entry.capability ?? 'other')}${subject}`
      line.style.color = 'var(--sbh-color-danger)'
      line.style.fontSize = 'var(--sbh-font-size-sm)'
      host.appendChild(line)
    }

    if (notices.length === 0) return

    const revert = document.createElement('button')
    revert.textContent = 'Revert last change'
    controlStyle(revert)
    revert.style.alignSelf = 'flex-start'
    revert.addEventListener('click', () => ctx.dispatch('ui.revert'))
    host.appendChild(revert)
  },
})

// --- transcript ------------------------------------------------------------------

/**
 * How the transcript stays bounded. Messages have wildly different heights and
 * markdown gives no measurement before layout, so this is count-windowing rather
 * than position virtualization: only the most recent page is in the DOM, and
 * older ones load a page at a time on demand. 10k messages render initially like
 * 80 — the point is that the DOM size is bounded, not that every row is measured.
 */
const TRANSCRIPT_PAGE = 80

type Windowed = HTMLElement & { __sbhRendered?: number }

/** Within a scroll of the bottom, treat the user as "following" the stream. */
const nearBottom = (host: HTMLElement): boolean =>
  host.scrollHeight - host.scrollTop - host.clientHeight < 40

const attachmentChip = (attachment: Attachment): HTMLElement => {
  const chip = document.createElement('span')
  chip.style.cssText =
    'display:inline-flex;align-items:center;gap:var(--sbh-space-xs);border:1px solid var(--sbh-color-border);' +
    'border-radius:var(--sbh-radius-md);padding:2px 6px;font-size:var(--sbh-font-size-sm);' +
    'color:var(--sbh-color-text-muted);max-width:220px'
  if (attachment.mimeType.startsWith('image/') && attachment.data) {
    const image = document.createElement('img')
    image.src = `data:${attachment.mimeType};base64,${attachment.data}`
    image.alt = attachment.name
    image.style.cssText = 'max-height:80px;max-width:200px;border-radius:var(--sbh-radius-sm);display:block'
    chip.appendChild(image)
  }
  const label = document.createElement('span')
  label.textContent = attachment.name
  label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  chip.appendChild(label)
  return chip
}

/** One timeline entry. Model text goes through renderMarkdown, never innerHTML. */
const renderItem = (item: TimelineItem): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.dataset.item = item.kind

  if (item.kind === 'user') {
    wrap.style.alignSelf = 'flex-end'
    wrap.style.maxWidth = '80%'
    const line = document.createElement('div')
    line.className = 'sbh-markdown'
    line.appendChild(renderMarkdown(`**you:** ${item.text}`))
    wrap.appendChild(line)
    if (item.attachments.length > 0) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--sbh-space-xs);margin-top:var(--sbh-space-xs)'
      for (const attachment of item.attachments) row.appendChild(attachmentChip(attachment))
      wrap.appendChild(row)
    }
    if (item.superseded) {
      const mark = document.createElement('div')
      mark.textContent = 'superseded'
      mark.style.cssText =
        'font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted);opacity:.7;' +
        'font-style:italic;margin-top:var(--sbh-space-xs)'
      wrap.appendChild(mark)
    }
    return wrap
  }

  if (item.kind === 'agent') {
    wrap.className = 'sbh-markdown'
    wrap.appendChild(renderMarkdown(item.text))
    return wrap
  }

  if (item.kind === 'thought') {
    wrap.style.cssText =
      'border-left:2px solid var(--sbh-color-border);padding-left:var(--sbh-space-sm);' +
      'color:var(--sbh-color-text-muted);font-size:var(--sbh-font-size-sm);white-space:pre-wrap'
    wrap.textContent = item.text
    return wrap
  }

  // tool
  wrap.style.cssText =
    'border:1px solid var(--sbh-color-border);border-radius:var(--sbh-radius-md);' +
    'background:var(--sbh-color-surface);padding:var(--sbh-space-xs) var(--sbh-space-sm);' +
    'display:flex;gap:var(--sbh-space-xs);align-items:center'
  const dot = document.createElement('span')
  const color =
    item.status === 'completed'
      ? 'var(--sbh-color-success)'
      : item.status === 'failed'
        ? 'var(--sbh-color-danger)'
        : 'var(--sbh-color-accent)'
  dot.style.cssText = `width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:${color}`
  const title = document.createElement('span')
  title.textContent = item.title
  title.style.cssText =
    'font-family:var(--sbh-font-mono);font-size:var(--sbh-font-size-sm);overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap'
  wrap.append(dot, title)
  return wrap
}

function paintTranscript(host: Windowed, ctx: RenderContext): void {
  const items = ctx.host.items
  const rendered = Math.min(items.length, Math.max(TRANSCRIPT_PAGE, host.__sbhRendered ?? 0))
  host.__sbhRendered = rendered
  const start = items.length - rendered

  host.replaceChildren()

  if (start > 0) {
    const earlier = document.createElement('button')
    earlier.type = 'button'
    earlier.textContent = `Load earlier messages (${start} hidden)`
    earlier.style.cssText =
      'align-self:center;border:1px solid var(--sbh-color-border);background:var(--sbh-color-surface);' +
      'color:var(--sbh-color-text-muted);border-radius:var(--sbh-radius-full);padding:var(--sbh-space-xs) var(--sbh-space-md);' +
      'font-family:var(--sbh-font-sans);font-size:var(--sbh-font-size-sm);cursor:pointer'
    earlier.addEventListener('click', () => {
      // Anchor the viewport across the prepend: the newly loaded rows go above the
      // button, so the content under the cursor must not jump.
      const previousHeight = host.scrollHeight
      const previousTop = host.scrollTop
      host.__sbhRendered = (host.__sbhRendered ?? TRANSCRIPT_PAGE) + TRANSCRIPT_PAGE
      const live = getLive(host)
      if (live) paintTranscript(host, live.ctx)
      host.scrollTop = previousTop + (host.scrollHeight - previousHeight)
    })
    host.appendChild(earlier)
  }

  for (let index = start; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue
    host.appendChild(renderItem(item))
  }

  if (ctx.host.status === 'error' && ctx.host.error) {
    const line = document.createElement('div')
    line.textContent = `error: ${ctx.host.error}`
    line.style.color = 'var(--sbh-color-danger)'
    host.appendChild(line)
  }
}

registerComponent({
  name: 'transcript',
  create(node, ctx) {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'transcript')
    el.style.overflowY = 'auto'
    el.style.minHeight = '0'
    stream(el, node)
    setLive(el, node, ctx)
    return el
  },
  update(el, node, ctx) {
    const host = el as Windowed
    setLive(host, node, ctx)
    stream(host, node)
    // Follow the stream only if the user was already at the bottom; scrolling back
    // through history must not be yanked away by an incoming chunk.
    const following = nearBottom(host)
    paintTranscript(host, ctx)
    if (following) host.scrollTop = host.scrollHeight
  },
})

// --- changed files ---------------------------------------------------------------

/**
 * The files an `edit` tool touched, grouped by turn. A running record of what the
 * agent changed, at the end of the conversation.
 */
registerComponent({
  name: 'changedFiles',
  create() {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'changedFiles')
    el.style.display = 'none'
    el.style.flexDirection = 'column'
    el.style.gap = 'var(--sbh-space-sm)'
    return el
  },
  update(el, _node, ctx) {
    const host = el as HTMLElement
    const groups = ctx.host.changedFiles.filter((group) => group.files.length > 0)
    if (groups.length === 0) {
      host.style.display = 'none'
      host.replaceChildren()
      return
    }
    host.style.display = 'flex'
    host.replaceChildren()
    for (const group of groups) {
      const section = document.createElement('div')
      section.style.cssText = 'display:flex;flex-direction:column;gap:var(--sbh-space-xs)'
      const heading = document.createElement('div')
      heading.textContent =
        groups.length > 1
          ? `Files changed \u00b7 turn ${group.turn}`
          : `Files changed \u00b7 ${group.files.length}`
      heading.style.cssText =
        'font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted);' +
        'text-transform:uppercase;letter-spacing:.04em'
      section.appendChild(heading)
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--sbh-space-xs)'
      for (const file of group.files) {
        const box = document.createElement('div')
        box.textContent = file.line === undefined ? file.path : `${file.path}:${file.line}`
        box.title = file.path
        box.style.cssText =
          'border:1px solid var(--sbh-color-border);background:var(--sbh-color-surface);' +
          'border-radius:var(--sbh-radius-md);padding:var(--sbh-space-xs) var(--sbh-space-sm);' +
          'font-family:var(--sbh-font-mono);font-size:var(--sbh-font-size-sm);max-width:100%;' +
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        row.appendChild(box)
      }
      section.appendChild(row)
      host.appendChild(section)
    }
  },
})

// --- permission ------------------------------------------------------------------

/** Pretty-print a tool call's raw input for display. A reference, not a rule. */
const formatRawInput = (raw: unknown): string | null => {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return String(raw)
  }
}

/**
 * The default permission card. Agent-authored components override it like any
 * other; this one is the reference, and it uses the whole tool call (`kind`,
 * `name`, `rawInput`) rather than just the title.
 */
registerComponent({
  name: 'permission',
  create() {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'permission')
    el.style.display = 'none'
    el.style.flexDirection = 'column'
    el.style.gap = 'var(--sbh-space-sm)'
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
      const card = document.createElement('div')
      card.style.cssText =
        'display:flex;flex-direction:column;gap:var(--sbh-space-sm);padding:var(--sbh-space-md);' +
        'border:1px solid var(--sbh-color-border);border-left:3px solid var(--sbh-color-accent);' +
        'border-radius:var(--sbh-radius-md);background:var(--sbh-color-surface);box-shadow:var(--sbh-shadow-sm)'

      const header = document.createElement('div')
      header.style.cssText = 'display:flex;align-items:center;gap:var(--sbh-space-sm);flex-wrap:wrap'
      if (request.kind) {
        const badge = document.createElement('span')
        badge.textContent = request.kind
        badge.style.cssText =
          'text-transform:uppercase;letter-spacing:0.06em;font-size:var(--sbh-font-size-sm);' +
          'font-weight:var(--sbh-font-weight-bold);color:var(--sbh-color-accent-text);' +
          'background:var(--sbh-color-accent);border-radius:var(--sbh-radius-full);padding:2px 8px'
        header.appendChild(badge)
      }
      const label = document.createElement('div')
      label.textContent = `Permission requested: ${request.title}`
      label.style.fontWeight = 'var(--sbh-font-weight-bold)'
      header.appendChild(label)
      card.appendChild(header)

      const input = formatRawInput(request.rawInput)
      if (input) {
        const pre = document.createElement('pre')
        pre.textContent = input
        pre.style.cssText =
          'margin:0;padding:var(--sbh-space-sm);background:var(--sbh-color-surface-alt);' +
          'border:1px solid var(--sbh-color-border);border-radius:var(--sbh-radius-sm);' +
          'font-family:var(--sbh-font-mono);font-size:var(--sbh-font-size-sm);' +
          'overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:220px'
        card.appendChild(pre)
      }

      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:var(--sbh-space-sm)'
      for (const [text, decision, accent] of [
        ['Allow', 'permission.allow', true],
        ['Deny', 'permission.deny', false],
      ] as const) {
        const button = document.createElement('button')
        button.textContent = text
        controlStyle(button)
        if (accent) button.style.background = 'var(--sbh-color-accent)'
        button.addEventListener('click', () => ctx.dispatch(decision, { requestId: request.requestId }))
        actions.appendChild(button)
      }
      card.appendChild(actions)
      host.appendChild(card)
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

// --- sessions sidebar ------------------------------------------------------------

/** Query lives on the element so a host re-render cannot wipe what you typed. */
type SessionsHost = HTMLElement & { __query?: string }

function paintSessions(list: HTMLElement, ctx: RenderContext, query: string): void {
  list.replaceChildren()
  const needle = query.trim().toLowerCase()
  const sessions = needle
    ? ctx.host.sessions.filter(
        (session) =>
          (session.title || '').toLowerCase().includes(needle) ||
          session.cwd.toLowerCase().includes(needle)
      )
    : ctx.host.sessions

  if (sessions.length === 0) {
    const empty = document.createElement('div')
    empty.textContent = needle ? 'no matches' : 'none yet'
    empty.style.cssText = 'font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted)'
    list.appendChild(empty)
    return
  }

  for (const session of sessions) {
    const button = document.createElement('button')
    button.dataset.session = session.id
    button.textContent = session.title || '(untitled)'
    button.title = `${session.cwd}\n${session.updatedAt}`
    button.style.cssText = [
      'display:block',
      'width:100%',
      // The fix: a flex column shrinks its children to fit, so 50 sessions became
      // 50 hairlines instead of a scrolling list. Keep each row at its own height.
      'flex-shrink:0',
      'text-align:left',
      'cursor:pointer',
      'border:1px solid var(--sbh-color-border)',
      'background:var(--sbh-color-surface)',
      'color:var(--sbh-color-text)',
      'border-radius:var(--sbh-radius-md)',
      'padding:var(--sbh-space-xs) var(--sbh-space-sm)',
      'font-family:var(--sbh-font-sans)',
      'font-size:var(--sbh-font-size-sm)',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';')
    button.addEventListener('click', () => ctx.dispatch('session.open', { id: session.id }))
    list.appendChild(button)
  }
}

registerComponent({
  name: 'sessions',
  create(node, ctx) {
    const el = document.createElement('div') as SessionsHost
    el.setAttribute('data-atom', 'sessions')
    el.style.display = 'flex'
    el.style.flexDirection = 'column'
    el.style.gap = 'var(--sbh-space-xs)'
    el.style.minHeight = '0'
    // `overflow: hidden`, not `auto`: the *list* scrolls, the sidebar does not, so a
    // long list cannot drag the heading and the filter box off the top.
    el.style.overflow = 'hidden'
    // `flex: 0 0 <width>`, not `width`: a flex child with a growing sibling is free
    // to shrink, which once squeezed the sidebar to ~60px.
    const width = str(node.props?.width, '240px')
    el.style.flex = `0 0 ${width}`
    el.setAttribute('data-width', width)
    applyLayout(el, node)

    const heading = document.createElement('div')
    heading.setAttribute('data-session-heading', '')
    heading.style.cssText =
      'flex-shrink:0;font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted);padding:var(--sbh-space-xs) 0'
    el.appendChild(heading)

    const search = document.createElement('input')
    search.setAttribute('data-session-filter', '')
    search.type = 'search'
    search.placeholder = 'Filter chats\u2026'
    fieldStyle(search)
    search.style.flexShrink = '0'
    search.style.borderRadius = 'var(--sbh-radius-full)'
    search.style.fontSize = 'var(--sbh-font-size-sm)'
    search.addEventListener('input', () => {
      el.__query = search.value
      const live = getLive(el)
      const list = el.querySelector<HTMLElement>('[data-session-list]')
      if (list && live) paintSessions(list, live.ctx, el.__query ?? '')
    })
    el.appendChild(search)

    const list = document.createElement('div')
    list.setAttribute('data-session-list', '')
    list.style.cssText =
      'flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:var(--sbh-space-xs)'
    el.appendChild(list)

    el.__query = ''
    setLive(el, node, ctx)
    return el
  },
  update(el, node, ctx) {
    const host = el as SessionsHost
    setLive(host, node, ctx)
    const width = str(node.props?.width, '240px')
    if (host.dataset.width !== width) {
      host.style.flex = `0 0 ${width}`
      host.dataset.width = width
    }
    applyLayout(host, node)

    // Rebuild only the list: replacing the whole host would take focus (and the
    // query) out of the filter box on every streamed chunk.
    const total = ctx.host.sessions.length
    const heading = host.querySelector<HTMLElement>('[data-session-heading]')
    if (heading) heading.textContent = total ? `Past chats \u00b7 ${total}` : 'Past chats'
    const list = host.querySelector<HTMLElement>('[data-session-list]')
    if (list) paintSessions(list, ctx, host.__query ?? '')
  },
})
