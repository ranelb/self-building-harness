/**
 * Reading the harness's own session store.
 *
 * **Read-only, permanently.** The design's rule is that the app is not the writer
 * of a harness's session files: `pi` and `pi-web` must keep working on the same
 * files, and a second writer is how a store gets corrupted. This module opens files
 * for reading and never writes, renames or deletes one.
 *
 * Format (pi `session-format.md`): a `session` header line, then tree entries linked
 * by `id`/`parentId`. Only `message` entries with a user or assistant role carry
 * anything a transcript shows.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionSummary {
  id: string
  path: string
  cwd: string
  startedAt: string
  updatedAt: string
  title: string
}

export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface SessionDetail {
  summary: SessionSummary
  turns: SessionTurn[]
}

/** Enough to tell two conversations apart, and not a line more. */
const TITLE_LIMIT = 90

/**
 * Injected scaffolding, not conversation.
 *
 * A harness pastes a skill's whole body into the first user message, so the raw
 * text makes a useless title (`<skill name="grilling"…>`). Strip it and title the
 * session with what the person actually typed.
 */
const SCAFFOLDING = /<skill\b[^>]*>[\s\S]*?<\/skill>/g

const stripScaffolding = (text: string): string =>
  text.replace(SCAFFOLDING, ' ').replace(/\s+/g, ' ').trim()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Text of a message's content blocks; `thinking` and tool blocks are skipped. */
function textOfMessage(entry: unknown): string | null {
  if (!isRecord(entry) || entry.type !== 'message') return null
  const message = entry.message
  if (!isRecord(message)) return null
  const role = message.role
  if (role !== 'user' && role !== 'assistant') return null

  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

const titleFrom = (text: string): string => {
  const flat = stripScaffolding(text)
  if (!flat) return ''
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat
}

function parseHeader(line: string): { id: string; cwd: string; startedAt: string } | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (!isRecord(parsed) || parsed.type !== 'session') return null
    return {
      id: typeof parsed.id === 'string' ? parsed.id : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
      startedAt: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    }
  } catch {
    return null
  }
}

/** Read just enough of a file to summarise it. */
async function summarise(path: string): Promise<SessionSummary | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }

  const lines = raw.split('\n')
  const header = lines[0] ? parseHeader(lines[0]) : null
  if (!header) return null

  let title = ''
  for (const line of lines.slice(1, 80)) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (isRecord(entry) && entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'user') {
      const text = textOfMessage(entry)
      if (text) {
        const candidate = titleFrom(text)
        // A message that was *only* scaffolding leaves nothing to title it with;
        // keep looking rather than falling back to a wall of skill text.
        if (candidate) {
          title = candidate
          break
        }
      }
    }
  }

  let updatedAt = header.startedAt
  try {
    updatedAt = (await stat(path)).mtime.toISOString()
  } catch {
    // keep the header timestamp
  }

  return { id: header.id, path, cwd: header.cwd, startedAt: header.startedAt, updatedAt, title }
}

/**
 * List sessions, newest first.
 *
 * Walks the per-project directories pi lays out as `--<path>--`. A missing root is
 * an empty list, not an error: a fresh machine has no sessions.
 */
export async function listSessions(root: string, limit = 50): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = []

  let projects: string[]
  try {
    projects = await readdir(root)
  } catch {
    return []
  }

  for (const project of projects) {
    const dir = join(root, project)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const summary = await summarise(join(dir, file))
      if (summary) summaries.push(summary)
    }
  }

  return summaries
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit)
}

/**
 * Load one session by id.
 *
 * The id is matched against the listing rather than concatenated into a path, so a
 * hostile id cannot escape the sessions root.
 */
export async function readSession(root: string, id: string): Promise<SessionDetail | null> {
  const summary = (await listSessions(root, Number.MAX_SAFE_INTEGER)).find((s) => s.id === id)
  if (!summary) return null

  let raw: string
  try {
    raw = await readFile(summary.path, 'utf8')
  } catch {
    return null
  }

  const turns: SessionTurn[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const text = textOfMessage(entry)
    if (!text) continue
    const role = (entry as Record<string, unknown> & { message: { role: 'user' | 'assistant' } }).message.role
    turns.push({ role, text })
  }

  return { summary, turns }
}

/**
 * Total price pi recorded for a session, summed from `message.usage.cost`.
 *
 * ACP's `usage_update` from pi-acp carries context occupancy only; pi keeps the
 * price in its own store, and this module already reads that store (read-only).
 * Returns null when there is no cost to report, so the caller can fall back.
 */
export async function readSessionCost(root: string, id: string): Promise<number | null> {
  const summary = (await listSessions(root, Number.MAX_SAFE_INTEGER)).find((s) => s.id === id)
  if (!summary) return null

  let raw: string
  try {
    raw = await readFile(summary.path, 'utf8')
  } catch {
    return null
  }

  let total = 0
  let seen = false
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue
    const usage = entry.message.usage
    if (!isRecord(usage) || !isRecord(usage.cost)) continue
    const cost = usage.cost
    const value =
      typeof cost.total === 'number'
        ? cost.total
        : (['input', 'output', 'cacheRead', 'cacheWrite'] as const).reduce(
            (sum, key) => sum + (typeof cost[key] === 'number' ? (cost[key] as number) : 0),
            0
          )
    if (Number.isFinite(value)) {
      total += value
      seen = true
    }
  }
  return seen ? total : null
}
