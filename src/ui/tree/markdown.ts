/**
 * A small markdown renderer that builds DOM nodes directly.
 *
 * Never `innerHTML`: this is the one atom that turns agent-authored prose into
 * structure, so it must not be a markup-injection surface. Everything textual
 * goes through `textContent`/`createTextNode`, which leaves `<script>` and
 * entities inert by construction.
 *
 * Deliberately a subset (headings, lists, fenced code, bold/italic/inline code).
 * Links render as plain text — a clickable agent-chosen URL is an exfiltration
 * affordance this app does not need yet.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g

function appendInline(target: Node, text: string): void {
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) target.appendChild(document.createTextNode(text.slice(last, index)))

    const token = match[0]
    if (token.startsWith('**')) {
      const el = document.createElement('strong')
      el.textContent = token.slice(2, -2)
      target.appendChild(el)
    } else if (token.startsWith('`')) {
      const el = document.createElement('code')
      el.textContent = token.slice(1, -1)
      target.appendChild(el)
    } else {
      const el = document.createElement('em')
      el.textContent = token.slice(1, -1)
      target.appendChild(el)
    }
    last = index + token.length
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)))
}

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const lines = source.split('\n')
  let list: HTMLUListElement | null = null
  let index = 0

  const closeList = () => {
    if (list) {
      fragment.appendChild(list)
      list = null
    }
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trimStart().startsWith('```')) {
      closeList()
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = body.join('\n')
      pre.appendChild(code)
      fragment.appendChild(pre)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = (heading[1] ?? '#').length
      const el = document.createElement(`h${level}`)
      appendInline(el, heading[2] ?? '')
      fragment.appendChild(el)
      index += 1
      continue
    }

    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (item) {
      if (!list) list = document.createElement('ul')
      const li = document.createElement('li')
      appendInline(li, item[1] ?? '')
      list.appendChild(li)
      index += 1
      continue
    }

    if (line.trim() === '') {
      closeList()
      index += 1
      continue
    }

    closeList()
    const paragraph = document.createElement('p')
    appendInline(paragraph, line)
    fragment.appendChild(paragraph)
    index += 1
  }

  closeList()
  return fragment
}
