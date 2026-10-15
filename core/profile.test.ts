import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LAYOUT } from '../shared/layout.ts'
import { DEFAULT_THEME } from '../shared/theme.ts'
import { readLayout } from './layout.ts'
import { readTheme } from './theme.ts'
import {
  isProfileName,
  listProfileComponents,
  profileComponentsDir,
  readProfileComponent,
} from './profile.ts'

const baseLayout = { type: 'row', children: [{ type: 'sessions' }] }
const phoneLayout = { type: 'column', children: [{ type: 'transcript' }] }

async function fixture() {
  const configDir = await mkdtemp(join(tmpdir(), 'sbh-profile-'))
  await mkdir(join(configDir, 'components'), { recursive: true })
  await writeFile(join(configDir, 'layout.json'), JSON.stringify(baseLayout))
  await writeFile(join(configDir, 'components', 'shared.js'), 'export const component = { name: "shared" }')
  await writeFile(join(configDir, 'components', 'base-only.js'), 'export const component = { name: "base-only" }')

  const phone = join(configDir, 'profiles', 'phone')
  await mkdir(join(phone, 'components'), { recursive: true })
  await writeFile(join(phone, 'layout.json'), JSON.stringify(phoneLayout))
  await writeFile(join(phone, 'components', 'shared.js'), 'export const component = { name: "shared", mobile: true }')
  await writeFile(join(phone, 'components', 'phone-only.js'), 'export const component = { name: "phone-only" }')
  return configDir
}

describe('isProfileName', () => {
  it('accepts bare names and rejects separators or traversal', () => {
    expect(isProfileName('phone')).toBe(true)
    expect(isProfileName('phone-2_x')).toBe(true)
    expect(isProfileName('a/b')).toBe(false)
    expect(isProfileName('..')).toBe(false)
    expect(isProfileName('')).toBe(false)
    expect(isProfileName(7)).toBe(false)
  })
})

describe('readLayout', () => {
  it('serves the base layout when no profile is asked for', async () => {
    const dir = await fixture()
    expect(await readLayout(dir)).toEqual(baseLayout)
    await rm(dir, { recursive: true, force: true })
  })

  it('serves the profile layout when it exists', async () => {
    const dir = await fixture()
    expect(await readLayout(dir, 'phone')).toEqual(phoneLayout)
    await rm(dir, { recursive: true, force: true })
  })

  it('falls back to the base for an unknown profile', async () => {
    const dir = await fixture()
    expect(await readLayout(dir, 'tablet')).toEqual(baseLayout)
    await rm(dir, { recursive: true, force: true })
  })

  it('falls back to the default layout when nothing is written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sbh-empty-'))
    expect(await readLayout(dir)).toEqual(DEFAULT_LAYOUT)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('readTheme', () => {
  it('layers the profile over the base over the default', async () => {
    const dir = await fixture()
    await writeFile(join(dir, 'theme.json'), JSON.stringify({ color: { accent: '#111111' } }))
    await writeFile(
      join(dir, 'profiles', 'phone', 'theme.json'),
      JSON.stringify({ color: { text: '#222222' } })
    )
    const base = await readTheme(dir)
    expect(base.color.accent).toBe('#111111')
    expect(base.color.text).toBe(DEFAULT_THEME.color.text)

    const phone = await readTheme(dir, 'phone')
    expect(phone.color.accent).toBe('#111111') // inherited from base
    expect(phone.color.text).toBe('#222222') // overridden by the profile
    await rm(dir, { recursive: true, force: true })
  })
})

describe('profile components', () => {
  it('sees the union of base and profile components', async () => {
    const dir = await fixture()
    const names = await listProfileComponents(join(dir, 'components'), profileComponentsDir(dir, 'phone'))
    expect(names).toEqual(['base-only', 'phone-only', 'shared'])
    await rm(dir, { recursive: true, force: true })
  })

  it('prefers the profile override for a same-named component', async () => {
    const dir = await fixture()
    const local = profileComponentsDir(dir, 'phone')
    expect(await readProfileComponent(join(dir, 'components'), 'shared', local)).toContain('mobile: true')
    expect(await readProfileComponent(join(dir, 'components'), 'base-only', local)).toContain('base-only')
    await rm(dir, { recursive: true, force: true })
  })

  it('lists only the base set when there is no profile', async () => {
    const dir = await fixture()
    expect(await listProfileComponents(join(dir, 'components'), null)).toEqual(['base-only', 'shared'])
    await rm(dir, { recursive: true, force: true })
  })
})
