/**
 * The capability manifest: the one place a permission request is judged.
 *
 * **Off by default.** When off, a request goes to the UI and whatever it answers
 * is the answer — the host stays out of the way. When on, the core evaluates the
 * request *before* the UI sees it and answers allow or deny itself; the UI is told
 * the outcome and cannot change it.
 *
 * The manifest is root-owned on purpose. An agent runs as the user and can write
 * anything the user can, so a user-writable policy is a policy the agent can
 * rewrite, and a toggle the policed party enforces is not a toggle. The user-path
 * manifest exists only so this can be tried without root, and only when the
 * root-owned one is absent.
 *
 * See `docs/design.md` (the capability model section).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

export type RuleDecision = 'allow' | 'deny' | 'ask'
export type Decision = 'allow' | 'deny'

export interface CapabilityRule {
  decision: RuleDecision
  /** Path globs (fs.*). `~` is expanded. A glob-less path also matches its children. */
  paths?: string[]
  /** Command patterns (shell); `*` is a wildcard, whitespace-normalised. */
  commands?: string[]
  /** Host globs (net). Bare `example.com` also matches its subdomains. */
  hosts?: string[]
}

export interface Manifest {
  enabled: boolean
  audit: boolean
  capabilities: Record<string, CapabilityRule>
}

export interface LoadedManifest {
  manifest: Manifest
  /** Where it came from, or '' when none was found. */
  source: string
  /** Set when a manifest existed but could not be parsed. Fails closed. */
  error?: string
}

export const ROOT_MANIFEST = '/etc/sbh/capabilities.toml'

/** The built-in when nothing is configured: trust by default. */
export const DISABLED_MANIFEST: Manifest = { enabled: false, audit: true, capabilities: {} }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined

/**
 * TOML turns `[capabilities.fs.read]` into `{ fs: { read: … } }`, so nested tables
 * are flattened on `.` into capability names. `[capabilities."fs.read"]` (quoted)
 * lands flat and is left alone.
 */
function flattenRules(input: Record<string, unknown>, prefix = ''): Record<string, CapabilityRule> {
  const out: Record<string, CapabilityRule> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) continue
    const name = prefix ? `${prefix}.${key}` : key
    if ('decision' in value) {
      const decision = value.decision
      out[name] = {
        decision: decision === 'allow' || decision === 'ask' ? decision : 'deny',
        ...(strings(value.paths) ? { paths: strings(value.paths) } : {}),
        ...(strings(value.commands) ? { commands: strings(value.commands) } : {}),
        ...(strings(value.hosts) ? { hosts: strings(value.hosts) } : {}),
      }
    } else {
      Object.assign(out, flattenRules(value, name))
    }
  }
  return out
}

export function parseManifest(text: string): Manifest {
  const raw: unknown = parseToml(text)
  if (!isRecord(raw)) return { ...DISABLED_MANIFEST }
  const policy = isRecord(raw.policy) ? raw.policy : {}
  const capabilities = isRecord(raw.capabilities) ? flattenRules(raw.capabilities) : {}
  // `[capabilities.shell] operator = "…"` judges a typed command (class 'operator') as
  // the capability `shell.operator`. Absent means allow; it is only recorded when set.
  const shell = isRecord(raw.capabilities) ? raw.capabilities.shell : undefined
  if (isRecord(shell) && 'operator' in shell) {
    const value = shell.operator
    capabilities[OPERATOR_CAPABILITY] = {
      decision: value === 'allow' || value === 'ask' ? value : 'deny',
    }
  }
  return {
    enabled: policy.enabled === true,
    audit: policy.audit !== false,
    capabilities,
  }
}

/** The capability a typed (operator-class) shell command is judged as. */
export const OPERATOR_CAPABILITY = 'shell.operator'

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export interface LoadManifestOptions {
  /** Defaults to `/etc/sbh/capabilities.toml`. */
  rootPath?: string
  /** Consulted only when the root manifest does not exist (development). */
  userPath?: string
}

export async function loadManifest(options: LoadManifestOptions = {}): Promise<LoadedManifest> {
  const rootPath = options.rootPath ?? ROOT_MANIFEST
  const rootSource = await tryRead(rootPath)
  if (rootSource !== null) return fromText(rootSource, rootPath)
  if (options.userPath) {
    const userSource = await tryRead(options.userPath)
    if (userSource !== null) return fromText(userSource, options.userPath)
  }
  return { manifest: { ...DISABLED_MANIFEST }, source: '' }
}

function fromText(text: string, source: string): LoadedManifest {
  try {
    return { manifest: parseManifest(text), source }
  } catch (error) {
    // A broken root manifest must not silently disable the boundary: fail closed
    // (enabled, nothing allowed) and say why so it is visible, not mysterious.
    return {
      manifest: { enabled: true, audit: true, capabilities: {} },
      source,
      error: (error as Error).message,
    }
  }
}

// --- classification ---------------------------------------------------------------

export type SubjectKind = 'path' | 'command' | 'host' | 'none'

export interface Classification {
  capability: string
  subjectKind: SubjectKind
  subject?: string
}

export interface ToolCallLike {
  kind?: unknown
  name?: unknown
  title?: unknown
  rawInput?: unknown
}

/** ACP `ToolKind` -> capability. Unknown kinds are `other` (default-deny). */
const KIND_TO_CAPABILITY: Record<string, string> = {
  read: 'fs.read',
  search: 'fs.read',
  edit: 'fs.write',
  move: 'fs.write',
  delete: 'fs.write',
  execute: 'shell',
  fetch: 'net',
  switch_mode: 'session.mode',
}

const decodeInput = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isRecord(raw) ? raw : {}
}

const pick = (input: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

export const hostOf = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  try {
    return new URL(value).hostname
  } catch {
    return /^[a-z0-9.-]+$/i.test(value) ? value : undefined
  }
}

export function classifyToolCall(toolCall: ToolCallLike): Classification {
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other'
  const capability = KIND_TO_CAPABILITY[kind] ?? 'other'
  const input = decodeInput(toolCall.rawInput)

  if (capability === 'fs.read' || capability === 'fs.write') {
    const subject = pick(input, ['path', 'file_path', 'filePath', 'file', 'filename', 'target', 'absolute_path'])
    return { capability, subjectKind: 'path', subject }
  }
  if (capability === 'shell') {
    const subject =
      pick(input, ['command', 'cmd', 'script']) ??
      (typeof toolCall.title === 'string' ? toolCall.title : undefined)
    return { capability, subjectKind: 'command', subject }
  }
  if (capability === 'net') {
    const host = hostOf(pick(input, ['url', 'href', 'uri'])) ?? pick(input, ['host', 'hostname'])
    return { capability, subjectKind: 'host', subject: host }
  }
  return { capability, subjectKind: 'none' }
}

// --- evaluation -------------------------------------------------------------------

export interface Verdict {
  decision: Decision
  capability: string
  reason: string
}

const expandHome = (path: string): string =>
  (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path).replace(/\/+$/, '')

const globToRegExp = (glob: string): RegExp => {
  let out = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${out}$`)
}

const matchPath = (pattern: string, subject: string): boolean => {
  const glob = expandHome(pattern)
  const path = expandHome(subject)
  if (/[*?]/.test(glob)) return globToRegExp(glob).test(path)
  // A glob-less path is a directory-or-file grant, so it covers its children.
  return path === glob || path.startsWith(`${glob}/`)
}

const commandToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`
  )

const matchCommand = (pattern: string, subject: string): boolean => {
  const clean = (s: string) => s.trim().replace(/\s+/g, ' ')
  const pat = clean(pattern)
  const cmd = clean(subject)
  return /[*?]/.test(pat) ? commandToRegExp(pat).test(cmd) : cmd === pat
}

const matchHost = (pattern: string, host: string): boolean => {
  const lower = host.toLowerCase()
  return /[*?]/.test(pattern)
    ? globToRegExp(pattern.toLowerCase()).test(lower)
    : lower === pattern.toLowerCase() || lower.endsWith(`.${pattern.toLowerCase()}`)
}

/**
 * Judge a classified request against the manifest. Fail closed everywhere: an
 * `ask` is a deny (there is no click-to-allow), a scoped allow with no readable
 * subject is a deny, and a missing rule is a deny.
 */
export function evaluate(manifest: Manifest, classification: Classification): Verdict {
  const { capability } = classification
  const deny = (reason: string): Verdict => ({ decision: 'deny', capability, reason })

  const rule = manifest.capabilities[capability]
  if (!rule) return deny('no rule: default-deny')
  if (rule.decision === 'deny') return deny('denied by rule')
  if (rule.decision === 'ask') return deny('ask is answered deny (no click-to-allow)')

  if (classification.subjectKind === 'path' && rule.paths) {
    if (!classification.subject) return deny('scoped allow, but no path was readable')
    if (!rule.paths.some((pattern) => matchPath(pattern, classification.subject as string))) {
      return deny(`path not in the allowlist: ${classification.subject}`)
    }
  }
  if (classification.subjectKind === 'command' && rule.commands) {
    if (!classification.subject) return deny('scoped allow, but no command was readable')
    if (!rule.commands.some((pattern) => matchCommand(pattern, classification.subject as string))) {
      return deny(`command not in the allowlist: ${classification.subject}`)
    }
  }
  if (classification.subjectKind === 'host' && rule.hosts) {
    if (!classification.subject) return deny('scoped allow, but no host was readable')
    if (!rule.hosts.some((pattern) => matchHost(pattern, classification.subject as string))) {
      return deny(`host not in the allowlist: ${classification.subject}`)
    }
  }
  return { decision: 'allow', capability, reason: 'granted' }
}

// --- audit ------------------------------------------------------------------------

export interface AuditEntry {
  at: string
  source: string
  capability: string
  subject?: string
  decision: Decision
  reason: string
  title: string
}

/** Append-only JSONL. A logging failure must never break the turn. */
export async function appendAudit(path: string, entry: AuditEntry): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(entry)}\n`)
  } catch {
    // visibility is best-effort; the decision already happened
  }
}
