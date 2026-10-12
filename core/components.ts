/**
 * Agent-authored component modules on disk.
 *
 * The core serves them over loopback because the webview cannot `import()` a
 * file from the filesystem — a browser sandbox has no such API. Serving them also
 * gives hot reload for free: re-fetching a module URL re-runs it.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Bare module names only — the guard that makes the read path traversal-safe. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function isComponentName(name: string): boolean {
  return NAME.test(name)
}

export async function ensureComponentsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function listComponents(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => entry.name.slice(0, -'.js'.length))
      .filter(isComponentName)
      .sort()
  } catch {
    return []
  }
}

export async function readComponent(dir: string, name: string): Promise<string | null> {
  if (!isComponentName(name)) return null

  const root = resolve(dir)
  const path = resolve(root, `${name}.js`)
  // Defence in depth: the name regex already excludes separators and dots.
  if (!path.startsWith(`${root}/`)) return null

  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
