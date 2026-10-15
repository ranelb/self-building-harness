/**
 * Runtime state the core advertises for its companions.
 *
 * The core picks a free port at random, which is fine for the window that spawned
 * it but useless to a separate process. So it writes a small file a companion (the
 * phone server) can read to find it. The reader re-reads per request, so a core
 * restart on a new port just works.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const stateDir = (): string =>
  process.env.SBH_STATE_DIR ?? join(homedir(), '.local', 'state', 'sbh')

export const coreInfoPath = (): string => join(stateDir(), 'core.json')

export async function writeCoreInfo(info: { port: number; backend: string }): Promise<void> {
  try {
    await mkdir(stateDir(), { recursive: true })
    await writeFile(
      coreInfoPath(),
      `${JSON.stringify({ ...info, pid: process.pid, startedAt: new Date().toISOString() })}\n`
    )
  } catch {
    // Advertising the port is best-effort; the window still works without it.
  }
}

export async function clearCoreInfo(): Promise<void> {
  try {
    await unlink(coreInfoPath())
  } catch {
    // already gone
  }
}

/** The running core's port, or null when there is none (or it is unreadable). */
export async function readCorePort(): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(coreInfoPath(), 'utf8'))
    const port = (parsed as { port?: unknown }).port
    return typeof port === 'number' ? port : null
  } catch {
    return null
  }
}
