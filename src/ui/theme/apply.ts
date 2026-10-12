/**
 * Applying a theme.
 *
 * Tokens become CSS custom properties on a root element, so a component styled
 * with `var(--sbh-color-accent)` restyles the instant the variable changes —
 * no re-render, no component involvement.
 */
import { DEFAULT_THEME, mergeTheme, toCssVariables, type Theme } from '../../../shared/theme.ts'

/** Returns the variables applied, which double as `RenderContext.tokens`. */
export function applyTheme(target: HTMLElement, theme: Theme): Record<string, string> {
  const variables = toCssVariables(theme)
  for (const [name, value] of Object.entries(variables)) {
    target.style.setProperty(name, value)
  }
  return variables
}

/** Read the theme from the core. A failure falls back to the default, never throws. */
export async function loadTheme(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<Theme> {
  try {
    const response = await fetchImpl(`${baseUrl}/theme`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return mergeTheme(DEFAULT_THEME, await response.json())
  } catch {
    return DEFAULT_THEME
  }
}
