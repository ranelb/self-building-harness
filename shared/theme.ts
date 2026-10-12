/**
 * Theme tokens — the coherence mechanism.
 *
 * With agent-authored components, nothing else stops two of them looking like
 * they came from different apps. Components reference `var(--sbh-…)`; a theme
 * change rewrites those variables on the root, so the whole app restyles without
 * re-rendering anything.
 *
 * Shared because the core writes the default file and the UI consumes it.
 */

export interface Theme {
  name: string
  color: {
    background: string
    surface: string
    surfaceAlt: string
    border: string
    text: string
    textMuted: string
    accent: string
    accentText: string
    danger: string
    success: string
  }
  space: { xs: string; sm: string; md: string; lg: string; xl: string }
  radius: { sm: string; md: string; lg: string; full: string }
  font: {
    sans: string
    mono: string
    sizeSm: string
    size: string
    sizeLg: string
    weightBold: string
  }
  shadow: { sm: string; md: string }
}

export const DEFAULT_THEME: Theme = {
  name: 'default-dark',
  color: {
    background: '#16161a',
    surface: '#1e1e24',
    surfaceAlt: '#25252c',
    border: '#33333d',
    text: '#e6e6e6',
    textMuted: '#9a9aa5',
    accent: '#4b7bec',
    accentText: '#ffffff',
    danger: '#e05a5a',
    success: '#4bbf7a',
  },
  space: { xs: '0.25rem', sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem' },
  radius: { sm: '3px', md: '6px', lg: '10px', full: '999px' },
  font: {
    sans: 'system-ui, sans-serif',
    mono: 'ui-monospace, monospace',
    sizeSm: '0.8rem',
    size: '0.95rem',
    sizeLg: '1.1rem',
    weightBold: '600',
  },
  shadow: { sm: '0 1px 2px rgba(0,0,0,0.3)', md: '0 4px 16px rgba(0,0,0,0.45)' },
}

/**
 * Flatten a theme into CSS custom properties.
 *
 * Keys are kebab-cased: custom property names are case-sensitive, so emitting
 * `--sbh-color-surfaceAlt` while the CSS asks for `--sbh-color-surface-alt`
 * silently resolves to nothing.
 */
export function toCssVariables(theme: Theme): Record<string, string> {
  const variables: Record<string, string> = { '--sbh-theme-name': theme.name }
  const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

  for (const [group, values] of Object.entries(theme)) {
    if (group === 'name') continue
    for (const [key, value] of Object.entries(values as Record<string, string>)) {
      variables[`--sbh-${group}-${kebab(key)}`] = value
    }
  }

  return variables
}

/**
 * Merge a partial theme over the default, so a theme file only states what it
 * changes and an unknown/renamed key can never blank out the UI.
 */
export function mergeTheme(base: Theme, override: unknown): Theme {
  if (!override || typeof override !== 'object') return base
  const source = override as Record<string, unknown>
  const merged: Theme = { ...base, color: { ...base.color }, space: { ...base.space }, radius: { ...base.radius }, font: { ...base.font }, shadow: { ...base.shadow } }

  if (typeof source.name === 'string') merged.name = source.name

  for (const group of ['color', 'space', 'radius', 'font', 'shadow'] as const) {
    const incoming = source[group]
    if (!incoming || typeof incoming !== 'object') continue
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (typeof value === 'string' && (merged[group] as Record<string, string>)[key] !== undefined) {
        ;(merged[group] as Record<string, string>)[key] = value
      }
    }
  }

  return merged
}
