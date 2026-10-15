/**
 * The theme file.
 *
 * A theme belongs to a *surface* (see `core/profile.ts`): the base `theme.json`
 * is merged over the default, and `profiles/<name>/theme.json` is merged over
 * that. The UI applies the result as CSS custom properties, so a theme change
 * restyles the whole app without re-rendering a component.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_THEME, mergeTheme, type Theme } from '../shared/theme.ts'

export const themePath = (configDir: string, profile?: string): string =>
  profile ? resolve(configDir, 'profiles', profile, 'theme.json') : resolve(configDir, 'theme.json')

/** Create the theme file with the default if it does not exist yet. */
export async function ensureThemeFile(configDir: string): Promise<void> {
  const path = themePath(configDir)
  try {
    await readFile(path, 'utf8')
  } catch {
    await writeFile(path, `${JSON.stringify(DEFAULT_THEME, null, 2)}\n`, 'utf8')
  }
}

const readPartial = async (path: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** A surface's theme: base over the default, then profile over that. Never throws. */
export async function readTheme(configDir: string, profile?: string): Promise<Theme> {
  const base = mergeTheme(DEFAULT_THEME, await readPartial(themePath(configDir)))
  if (!profile) return base
  const overlay = await readPartial(themePath(configDir, profile))
  return overlay === null ? base : mergeTheme(base, overlay)
}
