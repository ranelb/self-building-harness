/**
 * The project file panel's read path. Every filesystem and git read the panel makes
 * lives here, and every reader takes `roots` first: the confinement gate
 * (`confine`) is the only way from a request to a path on disk.
 *
 * Read-only by construction. Nothing in this module writes, stages, or watches.
 */
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileTextResponse, FileTreeEntry, FileTreeResponse } from '../shared/protocol.ts'

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

/**
 * One level of a directory. Does not recurse, does not follow a symlink to describe
 * it, does not hide dotfiles. Directories first, then by name with plain `<` so the
 * order does not depend on the locale. A symlink whose target escapes the root is
 * listed with `outside: true`: visible, and unopenable because `confine` refuses it.
 */
export async function listTree(
  roots: readonly KnownRoot[],
  root: string,
  path: string,
  limit: number = maxTreeEntries
): Promise<FileTreeResponse> {
  const got = await confine(roots, root, path)
  const st = await lstat(got.abs)
  if (!st.isDirectory()) throw new FileAccessError('not-a-dir')

  const dirents = await readdir(got.abs, { withFileTypes: true })
  const rank = (d: { isDirectory(): boolean }) => (d.isDirectory() ? 0 : 1)
  dirents.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const truncated = dirents.length > limit
  const shown = dirents.slice(0, limit)

  const entries: FileTreeEntry[] = await Promise.all(
    shown.map(async (d): Promise<FileTreeEntry> => {
      const full = join(got.abs, d.name)
      const info = await lstat(full)
      const kind: FileTreeEntry['kind'] = info.isSymbolicLink()
        ? 'symlink'
        : info.isDirectory()
          ? 'dir'
          : info.isFile()
            ? 'file'
            : 'other'
      let outside = false
      if (kind === 'symlink') {
        // A broken link has no realpath; it cannot be opened either, so it counts as outside.
        try {
          outside = !inside(await realpath(full), got.root)
        } catch {
          outside = true
        }
      }
      return {
        name: d.name,
        path: got.rel === '' ? d.name : `${got.rel}/${d.name}`,
        kind,
        size: kind === 'dir' ? 0 : info.size,
        outside,
      }
    })
  )

  return {
    root,
    path: got.rel,
    entries,
    truncated,
    status: { git: false, changes: [] },
  }
}

/**
 * A capped read. `text` is the first `maxFileBytes` decoded as UTF-8 (a multi-byte
 * character cut at the cap decodes as U+FFFD, which is acceptable for a viewer). A
 * NUL in the first 8 KiB makes the file binary and `text` empty.
 */
export async function readText(
  roots: readonly KnownRoot[],
  root: string,
  path: string
): Promise<FileTextResponse> {
  const got = await confine(roots, root, path)
  const st = await stat(got.abs)
  if (!st.isFile()) throw new FileAccessError('not-a-file')

  const size = st.size
  let buf: Buffer
  try {
    const fh = await open(got.abs, 'r')
    try {
      const want = Math.min(size, maxFileBytes)
      const scratch = Buffer.alloc(want)
      const { bytesRead } = await fh.read(scratch, 0, want, 0)
      buf = scratch.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EISDIR') throw new FileAccessError('not-a-file')
    if (code === 'ENOENT') throw new FileAccessError('missing')
    throw err
  }

  const binary = buf.subarray(0, 8192).includes(0)
  return {
    root,
    path: got.rel,
    size,
    text: binary ? '' : buf.toString('utf8'),
    truncated: size > maxFileBytes,
    binary,
  }
}
