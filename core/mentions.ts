/**
 * `@path:lines` mentions, resolved in the core. The prompt text is never rewritten: the
 * model gets the reference (the text, as typed) plus the excerpt as extra content blocks.
 *
 * Every path goes through `confine()` inside `readLines`; a refusal becomes a `skipped`
 * event carrying the gate's own reason, never a block.
 */
import { findMentions, type Mention } from '../shared/mentions.ts'
import type { UiEvent } from '../shared/protocol.ts'
import type { AcpContentBlock } from './attachments.ts'
import { confine, FileAccessError, readLines, type KnownRoot } from './files.ts'

export const maxMentionsPerPrompt = 8
export const maxMentionLines = 400
export const maxPromptContextBytes = 256 * 1024

type ContextEvent = Extract<UiEvent, { type: 'context' }>

interface Entry {
  event: ContextEvent
  block?: AcpContentBlock
  bytes: number
}

const skipped = (mention: string, reason: string): Entry => ({
  event: { type: 'context', mention, status: 'skipped', reason },
  bytes: 0,
})

/** Resolve one mention. Only `FileAccessError` is a refusal; anything else is a bug and propagates. */
async function resolveMention(
  m: Mention,
  root: string,
  roots: readonly KnownRoot[],
  embeddedContext: boolean
): Promise<Entry> {
  const start = m.range?.start ?? 1
  const end = m.range?.end
  if (start < 1 || (end !== undefined && end < start)) return skipped(m.raw, 'empty-range')

  // Ask for at most one window; a request for more is truncated, and says so.
  const windowEnd = start + maxMentionLines - 1
  try {
    const { abs } = await confine(roots, root, m.path)
    const res = await readLines(roots, root, m.path, { start, end: Math.min(end ?? windowEnd, windowEnd) })
    if (res.binary) return skipped(m.raw, 'binary')
    if (res.lines.length === 0) return skipped(m.raw, 'empty-range')

    const more = res.totalLines === null ? res.endLine === windowEnd : res.totalLines > windowEnd
    const truncated = (end === undefined || end > windowEnd) && more

    const first = start
    const last = res.endLine
    const header =
      `@${m.path}:${first}-${last}` + (res.totalLines === null ? '' : ` of ${res.totalLines} lines`)
    const numbered = res.lines.map((line, i) => `${first + i}| ${line}`)
    const body = `${header}\n\`\`\`\n${numbered.join('\n')}\n\`\`\``

    const block: AcpContentBlock = embeddedContext
      ? { type: 'resource', resource: { uri: `file://${abs}`, mimeType: 'text/plain', text: body } }
      : { type: 'text', text: body }
    const event: ContextEvent = { type: 'context', mention: m.raw, status: 'included', lines: { start: first, end: last } }
    if (truncated) event.reason = `truncated to ${maxMentionLines} lines`
    return { event, block, bytes: Buffer.byteLength(body) }
  } catch (err) {
    if (err instanceof FileAccessError) return skipped(m.raw, err.reason)
    throw err
  }
}

/**
 * Turn the mentions in `text` into content blocks and one `context` event per mention,
 * in text order. Caps: the first `maxMentionsPerPrompt` mentions are resolved; the rest
 * are skipped. When the blocks exceed `maxPromptContextBytes`, the last block is dropped
 * (its event becomes `skipped`) until the total fits.
 */
export async function expandMentions(params: {
  text: string
  root: string
  roots: readonly KnownRoot[]
  caps: { embeddedContext: boolean }
}): Promise<{ blocks: AcpContentBlock[]; events: UiEvent[] }> {
  const mentions = findMentions(params.text)
  const entries: Entry[] = []
  for (const [i, m] of mentions.entries()) {
    entries.push(
      i >= maxMentionsPerPrompt
        ? skipped(m.raw, 'too-many-mentions')
        : await resolveMention(m, params.root, params.roots, params.caps.embeddedContext)
    )
  }

  let total = entries.reduce((sum, e) => sum + e.bytes, 0)
  for (let i = entries.length - 1; i >= 0 && total > maxPromptContextBytes; i--) {
    const e = entries[i]
    if (!e || e.block === undefined) continue
    total -= e.bytes
    entries[i] = skipped(e.event.mention, 'over-budget')
  }

  return {
    blocks: entries.flatMap((e) => (e.block ? [e.block] : [])),
    events: entries.map((e) => e.event),
  }
}
