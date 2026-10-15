import { describe, it, expect } from 'vitest'
import { DEFAULT_THEME, mergeTheme, toCssVariables } from './theme.ts'

describe('toCssVariables', () => {
  it('flattens every group into --sbh-* variables', () => {
    const variables = toCssVariables(DEFAULT_THEME)
    expect(variables['--sbh-color-accent']).toBe(DEFAULT_THEME.color.accent)
    expect(variables['--sbh-space-md']).toBe(DEFAULT_THEME.space.md)
    expect(variables['--sbh-radius-full']).toBe(DEFAULT_THEME.radius.full)
    expect(variables['--sbh-font-mono']).toBe(DEFAULT_THEME.font.mono)
    expect(variables['--sbh-theme-name']).toBe(DEFAULT_THEME.name)
  })

  it('kebab-cases multi-word keys, because custom properties are case-sensitive', () => {
    const variables = toCssVariables(DEFAULT_THEME)
    expect(variables['--sbh-color-surface-alt']).toBe(DEFAULT_THEME.color.surfaceAlt)
    expect(variables['--sbh-font-size-sm']).toBe(DEFAULT_THEME.font.sizeSm)
    expect(variables['--sbh-font-size-lg']).toBe(DEFAULT_THEME.font.sizeLg)
    expect(variables['--sbh-font-weight-bold']).toBe(DEFAULT_THEME.font.weightBold)
    for (const name of Object.keys(variables)) {
      expect(name).toBe(name.toLowerCase())
    }
  })

  it('emits no nested objects', () => {
    for (const value of Object.values(toCssVariables(DEFAULT_THEME))) {
      expect(typeof value).toBe('string')
    }
  })
})

describe('mergeTheme', () => {
  it('applies a partial override and keeps the rest', () => {
    const merged = mergeTheme(DEFAULT_THEME, { name: 'custom-theme', color: { accent: '#ff00aa' } })
    expect(merged.name).toBe('custom-theme')
    expect(merged.color.accent).toBe('#ff00aa')
    expect(merged.color.text).toBe(DEFAULT_THEME.color.text)
    expect(merged.space.md).toBe(DEFAULT_THEME.space.md)
  })

  it('ignores unknown keys rather than blanking the theme', () => {
    const merged = mergeTheme(DEFAULT_THEME, { color: { nonsense: '#fff', text: '#000' } })
    expect(merged.color.text).toBe('#000')
    expect(Object.keys(merged.color)).toEqual(Object.keys(DEFAULT_THEME.color))
  })

  it('ignores non-string values', () => {
    const merged = mergeTheme(DEFAULT_THEME, { color: { text: 42 } })
    expect(merged.color.text).toBe(DEFAULT_THEME.color.text)
  })

  it('survives a junk override', () => {
    expect(mergeTheme(DEFAULT_THEME, null).color.text).toBe(DEFAULT_THEME.color.text)
    expect(mergeTheme(DEFAULT_THEME, 'nonsense').color.text).toBe(DEFAULT_THEME.color.text)
    expect(mergeTheme(DEFAULT_THEME, [1, 2]).color.text).toBe(DEFAULT_THEME.color.text)
  })

  it('does not mutate the default theme', () => {
    mergeTheme(DEFAULT_THEME, { color: { accent: '#123456' } })
    expect(DEFAULT_THEME.color.accent).toBe('#4b7bec')
  })
})
