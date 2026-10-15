// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { applyTheme, loadTheme } from './apply.ts'
import { DEFAULT_THEME } from '../../../shared/theme.ts'

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

describe('applyTheme', () => {
  it('sets every token as a CSS custom property on the target', () => {
    const target = document.createElement('div')
    const tokens = applyTheme(target, DEFAULT_THEME)

    expect(target.style.getPropertyValue('--sbh-color-accent')).toBe(DEFAULT_THEME.color.accent)
    expect(target.style.getPropertyValue('--sbh-space-md')).toBe(DEFAULT_THEME.space.md)
    expect(tokens['--sbh-color-accent']).toBe(DEFAULT_THEME.color.accent)
  })

  it('overwrites a previous theme rather than accumulating', () => {
    const target = document.createElement('div')
    applyTheme(target, DEFAULT_THEME)
    applyTheme(target, { ...DEFAULT_THEME, name: 'other', color: { ...DEFAULT_THEME.color, accent: '#123456' } })
    expect(target.style.getPropertyValue('--sbh-color-accent')).toBe('#123456')
  })
})

describe('loadTheme', () => {
  it('reads and merges the theme from the core', async () => {
    const theme = await loadTheme('http://core', async () =>
      jsonResponse({ name: 'custom-theme', color: { accent: '#ff00aa' } })
    )
    expect(theme.name).toBe('custom-theme')
    expect(theme.color.accent).toBe('#ff00aa')
    expect(theme.color.text).toBe(DEFAULT_THEME.color.text)
  })

  it('falls back to the default when the core is unreachable', async () => {
    const theme = await loadTheme('http://core', async () => {
      throw new Error('connection refused')
    })
    expect(theme.name).toBe(DEFAULT_THEME.name)
  })

  it('falls back on an error status or junk body', async () => {
    expect((await loadTheme('http://core', async () => jsonResponse({}, 500))).name).toBe(DEFAULT_THEME.name)
    expect((await loadTheme('http://core', async () => jsonResponse('nonsense'))).name).toBe(DEFAULT_THEME.name)
  })
})
