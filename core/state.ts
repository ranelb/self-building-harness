/**
 * The persisted keyed store: the raw surface an agent builds on.
 *
 * This is deliberately *not* a settings feature. It is one flat, agent-visible,
 * revertable JSON object. Components read the whole thing off the state channel
 * and write single keys through `state.set`; whatever semantics those keys carry
 * (theme overrides, panel sizes, feature flags) belong to the component, not to
 * the core. The core validates and persists; it never interprets a key.
 *
 * The file lives in the config directory on purpose: that directory is the git
 * repo the core already snapshots, so every store change is revertable with the
 * same `POST /revert` that undoes a bad layout edit.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Per key, so the store stays a flat map and a typo cannot nest a tree. */
export const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** One entry, so a component cannot turn the store into an arbitrary blob. */
export const MAX_STATE_ENTRY_BYTES = 64 * 1024

export type StateStore = Record<string, unknown>

export const statePath = (configDir: string): string => resolve(configDir, 'state.json')

/** True when `value` can survive JSON round-tripping; guards against cycles too. */
export function isJsonValue(value: unknown): boolean {
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

/**
 * Validate one store entry. Returns a reason when rejected, `null` when fine.
 * `null` as a value is a delete, not an error.
 */
export function validateStateEntry(key: string, value: unknown): string | null {
  if (typeof key !== 'string' || !STATE_KEY.test(key)) return 'invalid key'
  if (value === null) return null
  if (value === undefined) return 'value must be JSON, not undefined'
  if (!isJsonValue(value)) return 'value is not JSON-serializable'
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_ENTRY_BYTES) return 'entry too large'
  return null
}

/** The store on disk, or `{}` when missing or unreadable. Never throws. */
export async function readState(configDir: string): Promise<StateStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(configDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as StateStore
  } catch {
    return {}
  }
}

/** Create an empty store if absent, so the agent can edit it before any client. */
export async function ensureStateFile(configDir: string): Promise<void> {
  try {
    await readFile(statePath(configDir), 'utf8')
  } catch {
    await writeState(configDir, {})
  }
}

/**
 * Replace the store. Written to a sibling temp file and renamed so a reader
 * (the watcher, another process) never sees a half-written JSON object.
 */
export async function writeState(configDir: string, state: StateStore): Promise<void> {
  const path = statePath(configDir)
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
