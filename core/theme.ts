/**
 * The theme file.
 *
 * Written once with the default so an agent has a concrete file to edit, then
 * served to the UI. The UI applies it as CSS custom properties, so a theme change
 * restyles the whole app without re-rendering a single component.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_THEME, mergeTheme, type Theme } from '../shared/theme.ts'

export const themePath = (configDir: string): string => resolve(configDir, 'theme.json')

/** Create the theme file with the default if it does not exist yet. */
export async function ensureThemeFile(configDir: string): Promise<void> {
  const path = themePath(configDir)
  try {
    await readFile(path, 'utf8')
  } catch {
    await writeFile(path, `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`, 'utf8')
  }
}

/** Read the theme file, merged over the default. Never throws. */
export async function readTheme(configDir: string): Promise<Theme> {
  try {
    const raw = await readFile(themePath(configDir), 'utf8')
    return mergeTheme(DEFAULT_THEME, JSON.parse(raw))
  } catch {
    return DEFAULT_THEME
  }
}
