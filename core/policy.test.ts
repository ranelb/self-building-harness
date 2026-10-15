import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManifest } from './capabilities.ts'
import { removeRule, runPolicyCli, setPolicyValue, upsertRule, type PolicyIo } from './policy.ts'

const SAMPLE = `# my policy
[policy]
enabled = false

# shell stuff
[capabilities.shell]
decision = "allow"
commands = ["git *"]
`

describe('setPolicyValue', () => {
  it('replaces the value in place and keeps the comments', () => {
    const next = setPolicyValue(SAMPLE, 'enabled', 'true')
    expect(next).toContain('# my policy')
    expect(next).toContain('# shell stuff')
    expect(parseManifest(next).enabled).toBe(true)
  })

  it('creates [policy] when it is absent', () => {
    const next = setPolicyValue('[capabilities.shell]\ndecision = "allow"\n', 'enabled', 'true')
    expect(parseManifest(next).enabled).toBe(true)
  })
})

describe('upsertRule / removeRule', () => {
  it('adds a rule and keeps everything else, comments included', () => {
    const next = upsertRule(SAMPLE, 'fs.read', { decision: 'allow', paths: ['~/Projects/**'] })
    const manifest = parseManifest(next)
    expect(manifest.capabilities['fs.read']).toMatchObject({ decision: 'allow', paths: ['~/Projects/**'] })
    expect(manifest.capabilities.shell).toMatchObject({ decision: 'allow' })
    expect(next).toContain('# shell stuff')
  })

  it('replaces an existing rule instead of duplicating it', () => {
    const once = upsertRule(SAMPLE, 'shell', { decision: 'deny' })
    const twice = upsertRule(once, 'shell', { decision: 'allow', commands: ['ls *'] })
    expect(twice.match(/\[capabilities\.shell\]/g)).toHaveLength(1)
    expect(parseManifest(twice).capabilities.shell).toMatchObject({ decision: 'allow', commands: ['ls *'] })
  })

  it('removes a rule and leaves the preamble', () => {
    const next = removeRule(SAMPLE, 'shell')
    expect(parseManifest(next).capabilities.shell).toBeUndefined()
    expect(next).toContain('# my policy')
  })
})

describe('runPolicyCli', () => {
  const sink = (): { out: string[]; err: string[]; io: PolicyIo } => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
  }

  it('grant writes the file and list reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-pol-'))
    const file = join(dir, 'capabilities.toml')
    const a = sink()
    expect(await runPolicyCli(['grant', 'shell', '--file', file, '--commands', 'git *, npm run *'], a.io)).toBe(0)
    expect(a.err).toEqual([])
    const b = sink()
    expect(await runPolicyCli(['list', '--file', file], b.io)).toBe(0)
    expect(b.out.join('\n')).toContain('shell: allow')
    expect(b.out.join('\n')).toContain('git *')
    await rm(dir, { recursive: true, force: true })
  })

  it('enable flips the flag, check validates, revoke removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-pol-'))
    const file = join(dir, 'capabilities.toml')
    await runPolicyCli(['grant', 'net', '--file', file, '--decision', 'deny'], sink().io)
    await runPolicyCli(['enable', '--file', file], sink().io)
    expect(parseManifest(await readFile(file, 'utf8')).enabled).toBe(true)
    expect(await runPolicyCli(['check', '--file', file], sink().io)).toBe(0)
    await runPolicyCli(['revoke', 'net', '--file', file], sink().io)
    expect(parseManifest(await readFile(file, 'utf8')).capabilities.net).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects an unknown command and a bad decision', async () => {
    const a = sink()
    expect(await runPolicyCli(['wat'], a.io)).toBe(1)
    const b = sink()
    expect(await runPolicyCli(['grant', 'shell', '--decision', 'maybe', '--file', '/tmp/x'], b.io)).toBe(1)
    expect(b.err.join('\n')).toContain('unknown --decision')
  })
})
