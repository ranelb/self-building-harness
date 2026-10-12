/**
 * The layout file — what is on screen, as data an agent can edit.
 *
 * Written once with the default so there is always something concrete to edit,
 * then served to the UI and hot-reloaded like the theme and the components.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_LAYOUT } from '../shared/layout.ts'
import { isValidLayout, type UiNode } from '../shared/ui.ts'

export const layoutPath = (configDir: string): string => resolve(configDir, 'layout.json')

export async function ensureLayoutFile(configDir: string): Promise<void> {
  const path = layoutPath(configDir)
  try {
    await readFile(path, 'utf8')
  } catch {
    await writeFile(path, `${JSON.stringify(DEFAULT_LAYOUT, null, 2)}\n`, 'utf8')
  }
}

/** Read the layout. Falls back to the default rather than throwing. */
export async function readLayout(configDir: string): Promise<UiNode> {
  try {
    const raw = await readFile(layoutPath(configDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isValidLayout(parsed) ? parsed : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}
