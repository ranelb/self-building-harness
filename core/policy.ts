/**
 * sbh-policy — the operator CLI for the capability manifest.
 *
 * SBH never elevates itself. This is the intended writer of the root-owned policy,
 * run however the operator elevates (pkexec, sudo, doas, a root shell). It reuses
 * the parser the core reads with, so it cannot write a manifest the core would
 * reject, and it edits the file textually so hand-written comments survive.
 *
 * Run directly:  node --experimental-strip-types core/policy.ts <command>
 * Or bundled:    sbh-core policy <command>
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  loadManifest,
  parseManifest,
  ROOT_MANIFEST,
  type CapabilityRule,
  type RuleDecision,
} from './capabilities.ts'

export interface PolicyIo {
  out: (line: string) => void
  err: (line: string) => void
}

const DEFAULT_IO: PolicyIo = { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) }

// --- textual editing --------------------------------------------------------------

interface Block {
  header: string | null
  lines: string[]
}

const parseBlocks = (text: string): Block[] => {
  const blocks: Block[] = [{ header: null, lines: [] }]
  for (const line of text.split('\n')) {
    const match = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (match) blocks.push({ header: match[1] ?? '', lines: [] })
    else blocks[blocks.length - 1]?.lines.push(line)
  }
  return blocks
}

const renderBlocks = (blocks: Block[]): string => {
  const parts: string[] = []
  for (const block of blocks) {
    const body = block.lines.join('\n').replace(/^\n+|\n+$/g, '')
    if (block.header === null) {
      if (body) parts.push(body)
    } else {
      parts.push(body ? `[${block.header}]\n${body}` : `[${block.header}]`)
    }
  }
  return `${parts.join('\n\n')}\n`
}

/** `capabilities.fs.read` and `capabilities."fs.read"` both -> `fs.read`. */
const headerCapability = (header: string): string | null => {
  const match = /^capabilities\.(.+)$/.exec(header)
  if (!match) return null
  return (match[1] ?? '').split('.').map((part) => part.replace(/^"|"$/g, '')).join('.')
}

const quote = (value: string): string => JSON.stringify(value)

const renderRule = (rule: CapabilityRule): string => {
  const lines = [`decision = ${quote(rule.decision)}`]
  if (rule.paths?.length) lines.push(`paths = [${rule.paths.map(quote).join(', ')}]`)
  if (rule.commands?.length) lines.push(`commands = [${rule.commands.map(quote).join(', ')}]`)
  if (rule.hosts?.length) lines.push(`hosts = [${rule.hosts.map(quote).join(', ')}]`)
  return lines.join('\n')
}

export function setPolicyValue(text: string, key: string, value: string): string {
  const blocks = parseBlocks(text)
  let policy = blocks.find((block) => block.header === 'policy')
  if (!policy) {
    policy = { header: 'policy', lines: [] }
    blocks.push(policy)
  }
  const line = `${key} = ${value}`
  const index = policy.lines.findIndex((candidate) => new RegExp(`^\\s*${key}\\s*=`).test(candidate))
  if (index >= 0) policy.lines[index] = line
  else policy.lines.push(line)
  return renderBlocks(blocks)
}

export function upsertRule(text: string, capability: string, rule: CapabilityRule): string {
  const blocks = parseBlocks(text)
  const existing = blocks.find((block) => block.header !== null && headerCapability(block.header) === capability)
  const lines = renderRule(rule).split('\n')
  if (existing) existing.lines = lines
  else blocks.push({ header: `capabilities.${capability}`, lines })
  return renderBlocks(blocks)
}

export function removeRule(text: string, capability: string): string {
  const blocks = parseBlocks(text).filter(
    (block) => !(block.header !== null && headerCapability(block.header) === capability)
  )
  return renderBlocks(blocks)
}

// --- CLI --------------------------------------------------------------------------

const positionals = (args: string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg.startsWith('--')) {
      i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

const flagValue = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const flagList = (args: string[], name: string): string[] | undefined => {
  const value = flagValue(args, name)
  if (value === undefined) return undefined
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return list.length ? list : undefined
}

const readText = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

const writeManifest = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, text, { mode: 0o644 })
  await rename(temporary, path)
}

const USAGE = `sbh-policy — read and edit the SBH capability manifest

  sbh-policy list [--file P]                       show the effective policy
  sbh-policy path [--file P]                       print the manifest path
  sbh-policy check [--file P]                      validate it, write nothing
  sbh-policy enable | disable [--file P]           set [policy] enabled
  sbh-policy grant <capability> [options]          add or replace a rule
      --decision allow|deny|ask   (default allow)
      --paths a,b                 path globs (fs.read, fs.write)
      --commands a,b              command patterns (shell)
      --hosts a,b                 host globs (net)
  sbh-policy revoke <capability> [--file P]        remove a rule

The default file is ${ROOT_MANIFEST} (root-owned). Override with --file or
SBH_MANIFEST for development. Elevate however you like; sbh-policy names no
elevator and SBH never calls one.`

export async function runPolicyCli(argv: string[], io: PolicyIo = DEFAULT_IO): Promise<number> {
  const [command, ...rest] = argv
  const file = flagValue(rest, '--file') ?? process.env.SBH_MANIFEST ?? ROOT_MANIFEST

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE)
    return command ? 0 : 1
  }

  if (command === 'path') {
    io.out(file)
    return 0
  }

  if (command === 'list') {
    const loaded = await loadManifest({ rootPath: file })
    if (loaded.error) io.err(`warning: ${loaded.error}`)
    io.out(loaded.source ? `manifest: ${loaded.source}` : 'manifest: (none) — enforcement off')
    io.out(`enabled: ${loaded.manifest.enabled}`)
    io.out(`audit: ${loaded.manifest.audit}`)
    for (const [name, rule] of Object.entries(loaded.manifest.capabilities)) {
      const scope = [
        rule.paths ? `paths=${rule.paths.join(',')}` : '',
        rule.commands ? `commands=${rule.commands.join(',')}` : '',
        rule.hosts ? `hosts=${rule.hosts.join(',')}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      io.out(`  ${name}: ${rule.decision}${scope ? ` ${scope}` : ''}`)
    }
    return 0
  }

  if (command === 'check') {
    const text = await readText(file)
    if (!text.trim()) {
      io.err(`no manifest at ${file}`)
      return 1
    }
    try {
      const manifest = parseManifest(text)
      io.out(`ok: ${file} (enabled: ${manifest.enabled}, ${Object.keys(manifest.capabilities).length} rules)`)
      return 0
    } catch (error) {
      io.err(`invalid: ${(error as Error).message}`)
      return 1
    }
  }

  if (command === 'enable' || command === 'disable') {
    const text = await readText(file)
    const next = setPolicyValue(text, 'enabled', command === 'enable' ? 'true' : 'false')
    return commit(file, next, `${command}d enforcement in ${file}`, io)
  }

  if (command === 'grant') {
    const [capability] = positionals(rest)
    if (!capability) {
      io.err('grant needs a capability, e.g. `grant shell --commands "git *"`')
      return 1
    }
    const rawDecision = flagValue(rest, '--decision') ?? 'allow'
    if (rawDecision !== 'allow' && rawDecision !== 'deny' && rawDecision !== 'ask') {
      io.err(`unknown --decision ${rawDecision} (allow, deny, ask)`)
      return 1
    }
    const paths = flagList(rest, '--paths')
    const commands = flagList(rest, '--commands')
    const hosts = flagList(rest, '--hosts')
    const rule: CapabilityRule = {
      decision: rawDecision as RuleDecision,
      ...(paths ? { paths } : {}),
      ...(commands ? { commands } : {}),
      ...(hosts ? { hosts } : {}),
    }
    const next = upsertRule(await readText(file), capability, rule)
    const scope = [paths, commands, hosts].filter(Boolean).flat().join(', ')
    return commit(file, next, `grant ${capability}: ${rule.decision}${scope ? ` (${scope})` : ''}`, io)
  }

  if (command === 'revoke') {
    const [capability] = positionals(rest)
    if (!capability) {
      io.err('revoke needs a capability')
      return 1
    }
    const next = removeRule(await readText(file), capability)
    return commit(file, next, `revoke ${capability}`, io)
  }

  io.err(`unknown command: ${command}\n\n${USAGE}`)
  return 1
}

async function commit(file: string, text: string, message: string, io: PolicyIo): Promise<number> {
  try {
    parseManifest(text)
  } catch (error) {
    io.err(`refusing to write an invalid manifest: ${(error as Error).message}`)
    return 1
  }
  try {
    await writeManifest(file, text)
    io.out(message)
    return 0
  } catch (error) {
    io.err(`could not write ${file}: ${(error as Error).message}`)
    io.err('it is root-owned; run this under whatever you use to become root.')
    return 1
  }
}

// Deliberately no import-time self-run: `core/index.ts` dispatches the `policy`
// subcommand, and a second entry point would double-fire inside a bundled binary,
// where `process.argv[1]` and `import.meta.url` both point at the virtual entry.
