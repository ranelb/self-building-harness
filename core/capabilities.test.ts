import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendAudit,
  classifyToolCall,
  evaluate,
  loadManifest,
  parseManifest,
  type Manifest,
} from './capabilities.ts'

const manifest = (capabilities: Record<string, { decision: 'allow' | 'deny' | 'ask'; paths?: string[]; commands?: string[]; hosts?: string[] }>): Manifest => ({
  enabled: true,
  audit: true,
  capabilities,
})

describe('parseManifest', () => {
  it('flattens TOML nested tables into dotted capability names', () => {
    const parsed = parseManifest(`
      [policy]
      enabled = true
      [capabilities.fs.read]
      decision = "allow"
      paths = ["~/Projects/**"]
      [capabilities.session.mode]
      decision = "allow"
    `)
    expect(parsed.enabled).toBe(true)
    expect(Object.keys(parsed.capabilities).sort()).toEqual(['fs.read', 'session.mode'])
    expect(parsed.capabilities['fs.read']).toMatchObject({ decision: 'allow', paths: ['~/Projects/**'] })
  })

  it('accepts a quoted flat key too', () => {
    const parsed = parseManifest(`[capabilities."fs.write"]\ndecision = "deny"\n`)
    expect(parsed.capabilities['fs.write']).toEqual({ decision: 'deny' })
  })

  it('defaults to disabled and audit-on', () => {
    expect(parseManifest('[capabilities.shell]\ndecision = "allow"\n')).toMatchObject({
      enabled: false,
      audit: true,
    })
  })

  it('treats an unknown decision as deny', () => {
    expect(parseManifest('[capabilities.shell]\ndecision = "maybe"\n').capabilities.shell?.decision).toBe('deny')
  })
})

describe('loadManifest', () => {
  it('is disabled when nothing exists', async () => {
    const loaded = await loadManifest({ rootPath: '/nonexistent/root.toml', userPath: '/nonexistent/user.toml' })
    expect(loaded.manifest.enabled).toBe(false)
    expect(loaded.source).toBe('')
  })

  it('prefers the root manifest and ignores the user one when it exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-cap-'))
    const root = join(dir, 'root.toml')
    const user = join(dir, 'user.toml')
    await writeFile(root, '[policy]\nenabled = true\n')
    await writeFile(user, '[policy]\nenabled = false\n')
    const loaded = await loadManifest({ rootPath: root, userPath: user })
    expect(loaded.source).toBe(root)
    expect(loaded.manifest.enabled).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('falls back to the user manifest only when the root one is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-cap-'))
    const user = join(dir, 'user.toml')
    await writeFile(user, '[policy]\nenabled = true\n')
    const loaded = await loadManifest({ rootPath: join(dir, 'missing.toml'), userPath: user })
    expect(loaded.source).toBe(user)
    expect(loaded.manifest.enabled).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('fails closed on a malformed manifest, and says why', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-cap-'))
    const root = join(dir, 'root.toml')
    await writeFile(root, 'this is not = = toml')
    const loaded = await loadManifest({ rootPath: root })
    expect(loaded.manifest.enabled).toBe(true)
    expect(loaded.manifest.capabilities).toEqual({})
    expect(loaded.error).toBeTruthy()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('classifyToolCall', () => {
  it('maps ACP tool kinds to capabilities', () => {
    expect(classifyToolCall({ kind: 'execute' })).toMatchObject({ capability: 'shell', subjectKind: 'command' })
    expect(classifyToolCall({ kind: 'edit' })).toMatchObject({ capability: 'fs.write', subjectKind: 'path' })
    expect(classifyToolCall({ kind: 'read' })).toMatchObject({ capability: 'fs.read' })
    expect(classifyToolCall({ kind: 'fetch' })).toMatchObject({ capability: 'net', subjectKind: 'host' })
    expect(classifyToolCall({ kind: 'invented' })).toMatchObject({ capability: 'other', subjectKind: 'none' })
  })

  it('reads the subject out of a raw input object or a JSON string', () => {
    expect(classifyToolCall({ kind: 'read', rawInput: { path: '/etc/hosts' } }).subject).toBe('/etc/hosts')
    expect(classifyToolCall({ kind: 'execute', rawInput: '{"command":"git status"}' }).subject).toBe('git status')
    expect(classifyToolCall({ kind: 'fetch', rawInput: { url: 'https://api.github.com/x' } }).subject).toBe('api.github.com')
  })
})

describe('evaluate', () => {
  it('denies when there is no rule (default-deny)', () => {
    expect(evaluate(manifest({}), { capability: 'shell', subjectKind: 'command', subject: 'ls' })).toMatchObject({
      decision: 'deny',
    })
  })

  it('treats ask as deny', () => {
    const m = manifest({ shell: { decision: 'ask' } })
    expect(evaluate(m, { capability: 'shell', subjectKind: 'command', subject: 'ls' }).decision).toBe('deny')
  })

  it('allows an unscoped grant', () => {
    const m = manifest({ shell: { decision: 'allow' } })
    expect(evaluate(m, { capability: 'shell', subjectKind: 'command', subject: 'anything' }).decision).toBe('allow')
  })

  it('enforces a command allowlist, including wildcards', () => {
    const m = manifest({ shell: { decision: 'allow', commands: ['git *', 'npm run *'] } })
    expect(evaluate(m, { capability: 'shell', subjectKind: 'command', subject: 'git status' }).decision).toBe('allow')
    expect(evaluate(m, { capability: 'shell', subjectKind: 'command', subject: 'npm run build' }).decision).toBe('allow')
    expect(evaluate(m, { capability: 'shell', subjectKind: 'command', subject: 'rm -rf /' }).decision).toBe('deny')
    // a wildcard must not leak across the space
    expect(evaluate(m, { capability: 'shell', subjectKind: 'command', subject: 'github' }).decision).toBe('deny')
  })

  it('enforces a path allowlist, expanding ~ and covering directories', () => {
    const m = manifest({ 'fs.write': { decision: 'allow', paths: ['~/Projects', '~/.config/**'] } })
    const at = (subject: string) => evaluate(m, { capability: 'fs.write', subjectKind: 'path', subject }).decision
    expect(at(join(homedir(), 'Projects/code/x.ts'))).toBe('allow')
    expect(at(join(homedir(), 'Projects'))).toBe('allow')
    expect(at(join(homedir(), '.config/sbh/theme.json'))).toBe('allow')
    expect(at('/etc/passwd')).toBe('deny')
    // a sibling prefix is not inside the grant
    expect(at(join(homedir(), 'Projects-evil/x'))).toBe('deny')
  })

  it('denies a scoped allow when the subject could not be read', () => {
    const m = manifest({ 'fs.write': { decision: 'allow', paths: ['~/Projects'] } })
    expect(evaluate(m, { capability: 'fs.write', subjectKind: 'path' }).decision).toBe('deny')
  })

  it('enforces a host allowlist with subdomains', () => {
    const m = manifest({ net: { decision: 'allow', hosts: ['github.com'] } })
    const at = (subject: string) => evaluate(m, { capability: 'net', subjectKind: 'host', subject }).decision
    expect(at('github.com')).toBe('allow')
    expect(at('api.github.com')).toBe('allow')
    expect(at('evil.com')).toBe('deny')
  })
})

describe('appendAudit', () => {
  it('writes one JSON line per decision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-audit-'))
    const path = join(dir, 'audit.log')
    await appendAudit(path, {
      at: 't',
      source: 'manifest',
      capability: 'shell',
      subject: 'ls',
      decision: 'allow',
      reason: 'granted',
      title: 'Run ls',
    })
    await appendAudit(path, {
      at: 't',
      source: 'manifest',
      capability: 'shell',
      decision: 'deny',
      reason: 'denied by rule',
      title: 'Run rm',
    })
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ capability: 'shell', decision: 'allow', subject: 'ls' })
    await rm(dir, { recursive: true, force: true })
  })
})
