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
import type { Attachment, AvailableCommand } from '../../../shared/protocol.ts'
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
    const edit = document.createElement('button')
    edit.setAttribute('data-edit', item.id)
    edit.textContent = 'Edit'
    edit.title = 'Edit this prompt'
    edit.style.cssText =
      'align-self:flex-end;border:none;background:transparent;color:var(--sbh-color-text-muted);' +
      'font-family:var(--sbh-font-sans);font-size:var(--sbh-font-size-sm);cursor:pointer;' +
      'opacity:0;transition:opacity .12s;padding:0;margin-top:var(--sbh-space-xs)'
    wrap.addEventListener('mouseenter', () => {
      edit.style.opacity = '1'
    })
    wrap.addEventListener('mouseleave', () => {
      edit.style.opacity = '0'
    })
    edit.addEventListener('click', () => {
      const host = wrap.closest('[data-atom="transcript"]')
      const live = host ? getLive(host) : undefined
      if (live) live.ctx.dispatch('message.edit', { id: item.id })
    })
    wrap.appendChild(edit)
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

  if (item.kind === 'divider') {
    // Two hairlines with a host-owned label: the label is ours, never model text.
    wrap.style.cssText =
      'display:flex;align-items:center;gap:var(--sbh-space-sm);margin:var(--sbh-space-xs) 0;' +
      'color:var(--sbh-color-text-muted);font-size:var(--sbh-font-size-sm)'
    const rule = (): HTMLElement => {
      const line = document.createElement('div')
      line.style.cssText = 'flex:1;height:1px;background:var(--sbh-color-border)'
      return line
    }
    const label = document.createElement('span')
    label.textContent = item.pending ? 'compacting context' : 'context compacted'
    wrap.append(rule(), label, rule())
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

// --- usage (context %, cost, tokens) ---------------------------------------------

const readUsagePref = (key: string, fallback: boolean): boolean => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}
const writeUsagePref = (key: string, value: boolean): void => {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // storage unavailable; the toggle just does not persist
  }
}

/** Cost arrives as a number or an ACP `{ amount, currency }`; show the amount. */
const formatCost = (cost: unknown): string => {
  if (typeof cost === 'number') return cost.toFixed(2)
  if (cost && typeof cost === 'object' && 'amount' in cost) {
    const amount = (cost as { amount?: unknown }).amount
    if (typeof amount === 'number') return amount.toFixed(2)
  }
  return '0.00'
}

registerComponent({
  name: 'usage',
  create() {
    const el = document.createElement('div')
    el.setAttribute('data-atom', 'usage')
    el.style.cssText =
      'display:none;align-items:center;gap:var(--sbh-space-sm);flex-wrap:wrap;' +
      'font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted);padding:var(--sbh-space-xs) 0'
    return el
  },
  update(el, _node, ctx) {
    const host = el as HTMLElement
    const usage = ctx.host.data.usage as { used?: unknown; size?: unknown; cost?: unknown } | undefined
    if (!usage || typeof usage.used !== 'number' || typeof usage.size !== 'number' || usage.size <= 0) {
      host.style.display = 'none'
      host.replaceChildren()
      return
    }
    host.style.display = 'flex'
    host.replaceChildren()
    const percent = Math.max(0, Math.min(100, Math.round((usage.used / usage.size) * 100)))

    const bar = document.createElement('span')
    bar.style.cssText =
      'display:inline-block;width:90px;height:6px;border-radius:var(--sbh-radius-full);' +
      'background:var(--sbh-color-surface-alt);border:1px solid var(--sbh-color-border);overflow:hidden'
    const fill = document.createElement('span')
    fill.style.cssText = `display:block;height:100%;width:${percent}%;background:var(--sbh-color-accent)`
    bar.appendChild(fill)

    const context = document.createElement('span')
    context.textContent = `context ${percent}%`
    context.style.color = percent >= 90 ? 'var(--sbh-color-danger)' : 'var(--sbh-color-text-muted)'

    const cost = document.createElement('span')
    cost.textContent = `$${formatCost(usage.cost)}`

    const expanded = readUsagePref('sbh.usage.expanded', false)
    const tokens = document.createElement('span')
    tokens.textContent = `${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens`
    tokens.style.display = expanded ? '' : 'none'

    const toggle = document.createElement('button')
    toggle.textContent = 'Tokens \u25be'
    toggle.style.cssText =
      'border:none;background:transparent;color:var(--sbh-color-text-muted);cursor:pointer;' +
      'font:inherit;font-size:var(--sbh-font-size-sm);padding:0'
    toggle.addEventListener('click', () => {
      const next = tokens.style.display === 'none'
      tokens.style.display = next ? '' : 'none'
      writeUsagePref('sbh.usage.expanded', next)
    })

    host.append(bar, context, cost, toggle, tokens)
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

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

type ComposerHost = HTMLElement & { __error?: string; __menuIndex?: number }

/** Paint the composer's inline error immediately; a host update is not coming. */
const paintComposerError = (el: ComposerHost): void => {
  const node = el.querySelector('[data-composer-error]') as HTMLElement | null
  if (!node) return
  node.style.display = el.__error ? 'block' : 'none'
  node.textContent = el.__error ?? ''
}

/** Read dropped/picked/pasted files into base64 attachments, with a size guard. */
const addFiles = (el: ComposerHost, files: File[]): void => {
  el.__error = undefined
  for (const file of files) {
    if (file.size > ATTACHMENT_MAX_BYTES) {
      el.__error = `${file.name} is too large (max 25 MB)`
      continue
    }
    const reader = new FileReader()
    reader.onerror = () => {
      el.__error = `${file.name} could not be read`
      paintComposerError(el)
    }
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      const live = getLive(el)
      if (!live) return
      live.ctx.dispatch('attachment.add', {
        attachment: {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          data: comma >= 0 ? result.slice(comma + 1) : '',
        },
      })
    }
    reader.readAsDataURL(file)
  }
  paintComposerError(el)
}

const paintAttachments = (tray: HTMLElement, attachments: Attachment[], el: ComposerHost): void => {  if (attachments.length === 0) {
    tray.style.display = 'none'
    tray.replaceChildren()
    return
  }
  tray.style.display = 'flex'
  tray.replaceChildren()
  attachments.forEach((attachment, index) => {
    const chip = attachmentChip(attachment)
    const remove = document.createElement('button')
    remove.textContent = '\u00d7'
    remove.title = 'Remove'
    remove.style.cssText =
      'border:none;background:transparent;color:var(--sbh-color-text-muted);cursor:pointer;font-size:14px;line-height:1'
    remove.addEventListener('click', () => {
      const live = getLive(el)
      if (live) live.ctx.dispatch('attachment.remove', { index })
    })
    chip.appendChild(remove)
    tray.appendChild(chip)
  })
}

/** Insert a chosen command into the input and let the user add arguments. */
const chooseCommand = (el: ComposerHost, input: HTMLInputElement, command: AvailableCommand): void => {
  input.value = `/${command.name} `
  const live = getLive(el)
  if (live) live.ctx.dispatch('prompt.draft', { value: input.value })
  input.focus()
  const menu = el.querySelector('[data-commands]') as HTMLElement | null
  if (menu) {
    menu.style.display = 'none'
    menu.replaceChildren()
  }
}

/**
 * The `/` menu: filter the agent's commands (skills, builtins) by what is typed
 * after the slash, until a space ends the command token.
 */
const paintCommands = (el: ComposerHost, input: HTMLInputElement, commands: AvailableCommand[]): void => {
  const menu = el.querySelector('[data-commands]') as HTMLElement | null
  if (!menu) return
  const query =
    input.value.startsWith('/') && !input.value.includes(' ')
      ? input.value.slice(1).toLowerCase()
      : null
  const matches =
    query === null
      ? []
      : commands.filter((command) => command.name.toLowerCase().includes(query))
  if (matches.length === 0) {
    menu.style.display = 'none'
    menu.replaceChildren()
    return
  }
  const index = Math.min(Math.max(el.__menuIndex ?? 0, 0), matches.length - 1)
  el.__menuIndex = index
  menu.style.display = 'flex'
  menu.replaceChildren()
  matches.forEach((command, at) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.setAttribute('data-command', command.name)
    item.style.cssText =
      'display:flex;flex-direction:column;gap:2px;text-align:left;border:none;' +
      'border-radius:var(--sbh-radius-sm);padding:var(--sbh-space-xs) var(--sbh-space-sm);' +
      'cursor:pointer;font:inherit;color:var(--sbh-color-text);background:' +
      (at === index ? 'var(--sbh-color-surface-alt)' : 'transparent')
    const name = document.createElement('span')
    name.textContent = `/${command.name}`
    name.style.cssText =
      'font-family:var(--sbh-font-mono);font-size:var(--sbh-font-size-sm);color:var(--sbh-color-accent)'
    item.appendChild(name)
    if (command.description) {
      const description = document.createElement('span')
      description.textContent = command.description
      description.style.cssText =
        'font-size:var(--sbh-font-size-sm);color:var(--sbh-color-text-muted);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%'
      item.appendChild(description)
    }
    // mousedown, not click: the input's blur would otherwise close the menu first.
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      chooseCommand(el, input, command)
    })
    menu.appendChild(item)
  })
}

registerComponent({
  name: 'composer',
  create() {
    const el = document.createElement('div') as ComposerHost
    el.setAttribute('data-atom', 'composer')
    el.style.display = 'flex'
    el.style.flexDirection = 'column'
    el.style.gap = 'var(--sbh-space-xs)'

    const tray = document.createElement('div')
    tray.setAttribute('data-attachments', '')
    tray.style.cssText = 'display:none;flex-wrap:wrap;gap:var(--sbh-space-xs)'

    const error = document.createElement('div')
    error.setAttribute('data-composer-error', '')
    error.style.cssText = 'display:none;color:var(--sbh-color-danger);font-size:var(--sbh-font-size-sm)'

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:var(--sbh-space-sm);align-items:center'

    const picker = document.createElement('input')
    picker.type = 'file'
    picker.multiple = true
    picker.style.display = 'none'
    picker.addEventListener('change', () => {
      addFiles(el, Array.from(picker.files ?? []))
      picker.value = ''
    })

    const attach = document.createElement('button')
    attach.setAttribute('data-attach', '')
    attach.textContent = '\u{1F4CE}'
    attach.title = 'Attach files'
    controlStyle(attach)
    attach.addEventListener('click', () => picker.click())

    const input = document.createElement('input')
    input.setAttribute('data-atom', 'input')
    fieldStyle(input)
    input.placeholder = 'Message'
    input.style.flexGrow = '1'
    input.style.minWidth = '0'
    input.addEventListener('input', () => {
      const live = getLive(el)
      if (live) live.ctx.dispatch('prompt.draft', { value: input.value })
      el.__menuIndex = 0
      if (live) paintCommands(el, input, live.ctx.host.commands)
    })
    input.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      const live = getLive(el)
      if (!live) return
      const menu = el.querySelector('[data-commands]') as HTMLElement | null
      const open = !!menu && menu.style.display !== 'none' && menu.children.length > 0
      if (open && (key === 'ArrowDown' || key === 'ArrowUp')) {
        event.preventDefault()
        const count = menu!.children.length
        el.__menuIndex = ((el.__menuIndex ?? 0) + (key === 'ArrowDown' ? 1 : -1) + count) % count
        paintCommands(el, input, live.ctx.host.commands)
        return
      }
      if (open && key === 'Enter') {
        event.preventDefault()
        const chosen = menu!.querySelectorAll('button[data-command]')[el.__menuIndex ?? 0]
        const command = live.ctx.host.commands.find(
          (entry) => entry.name === (chosen as HTMLElement | undefined)?.dataset.command
        )
        if (command) chooseCommand(el, input, command)
        return
      }
      if (open && key === 'Escape') {
        event.preventDefault()
        menu!.style.display = 'none'
        menu!.replaceChildren()
        return
      }
      if (key === 'Enter') live.ctx.dispatch('prompt.send')
      else if (key === 'Escape' && live.ctx.host.status === 'streaming') live.ctx.dispatch('turn.cancel')
    })
    input.addEventListener('paste', (event) => {
      const items = (event as ClipboardEvent).clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
      if (files.length > 0) {
        event.preventDefault()
        addFiles(el, files)
      }
    })

    el.addEventListener('dragover', (event) => event.preventDefault())
    el.addEventListener('drop', (event) => {
      event.preventDefault()
      const files = Array.from((event as DragEvent).dataTransfer?.files ?? [])
      if (files.length > 0) addFiles(el, files)
    })

    const send = document.createElement('button')
    send.setAttribute('data-send', '')
    send.textContent = 'Send'
    controlStyle(send)
    send.addEventListener('click', () => {
      const live = getLive(el)
      if (!live) return
      live.ctx.dispatch(live.ctx.host.status === 'streaming' ? 'turn.cancel' : 'prompt.send')
    })

    // Prompts waiting behind the in-flight turn; hidden at zero.
    const queued = document.createElement('span')
    queued.setAttribute('data-queued', '')
    queued.style.cssText =
      'display:none;color:var(--sbh-color-text-muted);font-size:var(--sbh-font-size-sm);white-space:nowrap'

    const clear = document.createElement('button')
    clear.setAttribute('data-queue-clear', '')
    clear.textContent = 'Clear'
    clear.title = 'Drop the queued messages (the running turn keeps going)'
    controlStyle(clear)
    clear.style.display = 'none'
    clear.addEventListener('click', () => getLive(el)?.ctx.dispatch('queue.clear'))

    const menu = document.createElement('div')
    menu.setAttribute('data-commands', '')
    menu.style.cssText =
      'display:none;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;' +
      'border:1px solid var(--sbh-color-border);border-radius:var(--sbh-radius-md);' +
      'background:var(--sbh-color-surface);padding:var(--sbh-space-xs)'

    row.append(attach, input, queued, clear, send)
    el.append(menu, tray, error, row, picker)
    return el
  },
  update(el, _node, ctx) {
    setLive(el, { type: 'composer' }, ctx)
    const element = el as ComposerHost
    const input = element.querySelector('input[data-atom="input"]') as HTMLInputElement | null
    // Same rule as the input atom: never overwrite what is being typed.
    if (input && document.activeElement !== input && input.value !== ctx.host.draft) {
      input.value = ctx.host.draft
    }
    if (input) paintCommands(element, input, ctx.host.commands)

    const send = element.querySelector('button[data-send]') as HTMLButtonElement | null
    if (send) send.textContent = ctx.host.status === 'streaming' ? 'Stop' : 'Send'

    const waiting = ctx.host.queued > 0 ? 'inline' : 'none'
    const badge = element.querySelector('span[data-queued]') as HTMLElement | null
    if (badge) {
      badge.style.display = waiting
      badge.textContent = `${ctx.host.queued} queued`
    }
    const clear = element.querySelector('button[data-queue-clear]') as HTMLElement | null
    if (clear) clear.style.display = waiting

    const tray = element.querySelector('[data-attachments]') as HTMLElement | null
    if (tray) paintAttachments(tray, ctx.host.draftAttachments, element)

    const error = element.querySelector('[data-composer-error]') as HTMLElement | null
    if (error) {
      error.style.display = element.__error ? 'block' : 'none'
      error.textContent = element.__error ?? ''
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

    const newChat = document.createElement('button')
    newChat.setAttribute('data-new-chat', '')
    newChat.textContent = '+ New chat'
    controlStyle(newChat)
    newChat.style.flexShrink = '0'
    newChat.addEventListener('click', () => {
      const live = getLive(el)
      if (live) live.ctx.dispatch('session.new')
    })
    el.appendChild(newChat)

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
