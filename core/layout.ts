/**
 * The layout file — what is on screen, as data an agent can edit.
 *
 * A layout belongs to a *surface* (see `core/profile.ts`): the base
 * `layout.json` is the default, and `profiles/<name>/layout.json` overrides it
 * for one client. Written once with the default so there is always something
 * concrete to edit, then served to the UI and hot-reloaded.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_LAYOUT } from '../shared/layout.ts'
import { isValidLayout, type UiNode } from '../shared/ui.ts'

export const layoutPath = (configDir: string, profile?: string): string =>
  profile ? resolve(configDir, 'profiles', profile, 'layout.json') : resolve(configDir, 'layout.json')

export async function ensureLayoutFile(configDir: string): Promise<void> {
  const path = layoutPath(configDir)
  try {
    await readFile(path, 'utf8')
  } catch {
    await writeFile(path, `${JSON.stringify(DEFAULT_LAYOUT, null, 2)}\n`, 'utf8')
  }
}

const readValid = async (path: string): Promise<UiNode | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isValidLayout(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A surface's layout: the profile's if it exists, else the base, else the default. */
export async function readLayout(configDir: string, profile?: string): Promise<UiNode> {
  if (profile) {
    const local = await readValid(layoutPath(configDir, profile))
    if (local) return local
  }
  return (await readValid(layoutPath(configDir))) ?? DEFAULT_LAYOUT
}
