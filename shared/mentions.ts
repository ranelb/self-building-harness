/**
 * The composer's one grammar: `@path` mentions and `!` / `!!` shell lines. Pure and
 * dependency-free, so the UI (which may not import `core/`) and the core read the same
 * tokens. Nothing here reads the disk; resolution happens in the core.
 */

/** `@` opens a token at the start of the text or after whitespace. A `\` before it is not whitespace, so it stays inert. */
const MENTION =
  /(^|\s)@([A-Za-z0-9._/+-]+)(?::(\d{1,7})(?:-(\d{0,7}))?)?(?!\d)/g

export interface Mention {
  /** The token as written, from the `@` through the range, without the trailing sentence dot. */
  raw: string
  /** Root-relative path, without the `@`. */
  path: string
  /** `:12` is `{start:12,end:12}`; `:12-20` is inclusive; `:12-` is `{start:12}` (to the end). */
  range?: { start: number; end?: number }
  /** Offset of the `@` in the text. */
  index: number
}

/** An odd number of backticks between the start of the line and the token means the token is code prose. */
const insideCode = (text: string, at: number): boolean => {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  let ticks = 0
  for (let i = lineStart; i < at; i++) if (text[i] === '`') ticks++
  return ticks % 2 === 1
}

export function findMentions(text: string): Mention[] {
  const found: Mention[] = []
  for (const m of text.matchAll(MENTION)) {
    const index = (m.index ?? 0) + (m[1]?.length ?? 0)
    if (insideCode(text, index)) continue

    let path = m[2] ?? ''
    let raw = m[0].slice(m[1]?.length ?? 0)
    // One trailing dot is sentence punctuation, not part of the path.
    if (path.endsWith('.')) {
      path = path.slice(0, -1)
      raw = raw.slice(0, -1)
    }
    if (path === '') continue

    const mention: Mention = { raw, path, index }
    if (m[3] !== undefined) {
      const start = Number(m[3])
      const end = m[4] === undefined ? start : m[4] === '' ? undefined : Number(m[4])
      mention.range = end === undefined ? { start } : { start, end }
    }
    found.push(mention)
  }
  return found
}

/**
 * A shell line: the first non-space character is `!` (included in context) or `!!`
 * (run, but kept out of context). The command is the rest, trimmed. `\!` is prose.
 */
export function parseShellCommand(
  text: string
): { command: string; includeInContext: boolean } | null {
  const body = text.trimStart()
  if (!body.startsWith('!')) return null
  const includeInContext = !body.startsWith('!!')
  const command = body.slice(includeInContext ? 1 : 2).trim()
  if (command === '') return null
  return { command, includeInContext }
}
