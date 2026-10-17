/**
 * The project file panel's read path. Every filesystem and git read the panel makes
 * lives here, and every reader takes `roots` first: the confinement gate
 * (`confine`) is the only way from a request to a path on disk.
 *
 * Read-only by construction. Nothing in this module writes, stages, or watches.
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const maxFileBytes = 1024 * 1024
export const maxTreeEntries = 2000
export const maxChanges = 5000
export const gitTimeoutMs = 5000

export type FileErrorReason =
  | 'root-not-known'
  | 'absolute-path'
  | 'escapes-root'
  | 'missing'
  | 'not-a-file'
  | 'not-a-dir'
  | 'no-git'

export class FileAccessError extends Error {
  readonly reason: FileErrorReason

  constructor(reason: FileErrorReason, message: string = reason) {
    super(message)
    this.name = 'FileAccessError'
    this.reason = reason
  }
}

/** A root the core has evidence for. `given` is what `/sessions` reports. */
export interface KnownRoot {
  readonly given: string
  /** `fs.realpath(given)`, or null when the directory does not resolve. */
  readonly real: string | null
}

const realOrNull = async (dir: string): Promise<string | null> => {
  try {
    return await realpath(dir)
  } catch {
    return null
  }
}

/**
 * Canonicalize the working directories the core knows about. Relative and empty
 * cwds are dropped (they would resolve against the core's own cwd, which is the
 * wrong directory); duplicates are dropped by `given`.
 */
export async function canonicalRoots(cwds: readonly string[]): Promise<KnownRoot[]> {
  const given = [...new Set(cwds)].filter((cwd) => cwd !== '' && isAbsolute(cwd))
  return Promise.all(
    given.map(async (dir) => ({ given: dir, real: await realOrNull(dir) }))
  )
}

/** True when `candidate` is `dir` or lies beneath it. The separator is the boundary. */
const inside = (candidate: string, dir: string): boolean => {
  if (candidate === dir) return true
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return candidate.startsWith(prefix)
}

/**
 * The single confinement gate. Every reader calls it first; nothing else takes a
 * path. `root` must name a known root exactly; `path` is root-relative. Returns the
 * canonical root, the canonical absolute path, and the canonical root-relative path
 * (`/`-separated, `''` at the root).
 */
export async function confine(
  roots: readonly KnownRoot[],
  root: string,
  path: string
): Promise<{ root: string; abs: string; rel: string }> {
  const entry =
    root === ''
      ? undefined
      : roots.find((r) => r.given === root || r.real === root)
  if (!entry || entry.real === null) {
    throw new FileAccessError('root-not-known')
  }
  const realRoot = entry.real

  // Gate 1, syntactic: refuse before touching the disk.
  if (path.includes('\0')) throw new FileAccessError('escapes-root')
  // An absolute path is refused, never reinterpreted: the wire speaks root-relative only.
  if (isAbsolute(path)) throw new FileAccessError('absolute-path')
  const candidate = resolve(realRoot, path)
  if (!inside(candidate, realRoot)) throw new FileAccessError('escapes-root')

  // Gate 2, physical: symlinks are resolved here, and only here.
  let abs: string
  try {
    abs = await realpath(candidate)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      throw new FileAccessError('missing')
    }
    throw err
  }
  if (!inside(abs, realRoot)) throw new FileAccessError('escapes-root')

  const rel = abs === realRoot ? '' : relative(realRoot, abs).split(sep).join('/')
  return { root: realRoot, abs, rel }
}
