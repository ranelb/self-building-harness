/**
 * UI profiles — surfaces.
 *
 * One core serves more than one interface. A desktop window and a phone are
 * different trees, not one responsive tree: a layout authored for a wide screen
 * is wrong on a phone however the components adapt. So a profile layers over the
 * base config directory — its own layout, theme and components — and a client
 * declares which one it is (`client.hello`).
 *
 * The base directory is the default surface (and the fallback for any profile);
 * `profiles/<name>/` overrides it.
 */
import { join } from 'node:path'
import { listComponents, readComponent } from './components.ts'

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export const isProfileName = (value: unknown): value is string =>
  typeof value === 'string' && NAME.test(value)

export const profilesDir = (configDir: string): string => join(configDir, 'profiles')

export const profileDir = (configDir: string, profile: string): string =>
  join(configDir, 'profiles', profile)

export const profileComponentsDir = (configDir: string, profile: string): string =>
  join(profileDir(configDir, profile), 'components')

/**
 * The component names a surface sees: the base set plus the profile's, which
 * override any same-named base component.
 */
export async function listProfileComponents(
  baseDir: string,
  profileDir: string | null
): Promise<string[]> {
  const base = await listComponents(baseDir)
  if (!profileDir) return base
  const local = await listComponents(profileDir)
  return [...new Set([...base, ...local])].sort()
}

/** A component's source for a surface: the profile's override if present, else the base. */
export async function readProfileComponent(
  baseDir: string,
  name: string,
  profileDir: string | null
): Promise<string | null> {
  if (profileDir) {
    const local = await readComponent(profileDir, name)
    if (local !== null) return local
  }
  return readComponent(baseDir, name)
}
