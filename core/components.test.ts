import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isComponentName, listComponents, readComponent } from './components.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sbh-components-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('component directory', () => {
  it('lists only .js component names, sorted', async () => {
    await writeFile(join(dir, 'zed.js'), 'export const component = {}')
    await writeFile(join(dir, 'alpha.js'), 'export const component = {}')
    await writeFile(join(dir, 'notes.txt'), 'ignore me')
    expect(await listComponents(dir)).toEqual(['alpha', 'zed'])
  })

  it('returns an empty list for a missing directory instead of throwing', async () => {
    expect(await listComponents(join(dir, 'nope'))).toEqual([])
  })

  it('reads a component source', async () => {
    await writeFile(join(dir, 'badge.js'), 'export const component = { name: "badge" }')
    expect(await readComponent(dir, 'badge')).toContain('badge')
  })

  it('refuses path traversal and odd names', async () => {
    expect(await readComponent(dir, '../secrets')).toBeNull()
    expect(await readComponent(dir, '..%2fsecrets')).toBeNull()
    expect(await readComponent(dir, 'has/slash')).toBeNull()
    expect(await readComponent(dir, 'has.dot')).toBeNull()
    expect(await readComponent(dir, '')).toBeNull()
  })

  it('validates names by the same rule the reader uses', () => {
    expect(isComponentName('badge')).toBe(true)
    expect(isComponentName('my-card_v2')).toBe(true)
    expect(isComponentName('../x')).toBe(false)
    expect(isComponentName('a.b')).toBe(false)
  })
})
