/**
 * The project file panel's read path. Every filesystem and git read the panel makes
 * lives here, and every reader takes `roots` first: the confinement gate
 * (`confine`) is the only way from a request to a path on disk.
 *
 * Read-only by construction. Nothing in this module writes, stages, or watches.
 */
import { execFile } from 'node:child_process'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  FileChange,
  FileDiffResponse,
  FileStatus,
  FileTextResponse,
  FileTreeEntry,
  FileTreeResponse,
} from '../shared/protocol.ts'

const execFileAsync = promisify(execFile)

/**
 * Run git read-only against a confined directory. Output is NOT trimmed: porcelain's
 * leading space in ` M path` is data. A read-only reader must not take index.lock
 * while the agent's own git runs, and must never block on a credential prompt.
 */
const runGit = async (dir: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], {
    timeout: gitTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

const tryGit = async (dir: string, args: string[]): Promise<string | null> => {
  try {
    return await runGit(dir, args)
  } catch {
    return null
  }
}

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
  /**
   * A line range that begins past the `maxFileBytes` prefix. The file exists, but the
   * part asked for was never read, so it is neither `missing` nor an empty window.
   */
  | 'beyond-cap'

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

  const status = await gitStatus(roots, root)
  return {
    root,
    path: got.rel,
    entries,
    truncated,
    status: { git: status.git, changes: status.changes },
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
  const buf = await readHead(got.abs, size)

  const binary = isBinary(buf)
  return {
    root,
    path: got.rel,
    size,
    text: binary ? '' : buf.toString('utf8'),
    truncated: size > maxFileBytes,
    binary,
  }
}

/** The first `maxFileBytes` of a file. The only place a file's bytes are read. */
async function readHead(abs: string, size: number): Promise<Buffer> {
  try {
    const fh = await open(abs, 'r')
    try {
      const want = Math.min(size, maxFileBytes)
      const scratch = Buffer.alloc(want)
      const { bytesRead } = await fh.read(scratch, 0, want, 0)
      return scratch.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EISDIR') throw new FileAccessError('not-a-file')
    if (code === 'ENOENT') throw new FileAccessError('missing')
    throw err
  }
}

/** A NUL in the first 8 KiB makes a file binary. */
const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0)

export interface FileLinesResponse {
  root: string
  path: string
  size: number
  /** 1-based, inclusive. When `startLine > endLine` the window is empty. */
  startLine: number
  endLine: number
  /** Null when the file is over the cap: the lines past the prefix were never read. */
  totalLines: number | null
  lines: string[]
  truncated: boolean
  binary: boolean
}

/**
 * A line window of a text file, read through the same gate and the same capped,
 * NUL-probed read as `readText`. Lines split on `\n` with a trailing `\r` stripped; a
 * trailing newline does not make a phantom last line. A range that begins past the
 * capped prefix throws `beyond-cap` rather than answering with an empty window that
 * would look like the end of the file.
 */
export async function readLines(
  roots: readonly KnownRoot[],
  root: string,
  path: string,
  range: { start?: number; end?: number } = {}
): Promise<FileLinesResponse> {
  const got = await confine(roots, root, path)
  const st = await stat(got.abs)
  if (!st.isFile()) throw new FileAccessError('not-a-file')

  const size = st.size
  const buf = await readHead(got.abs, size)
  const truncated = size > maxFileBytes
  const base = { root, path: got.rel, size, truncated }

  if (isBinary(buf)) {
    return { ...base, startLine: 1, endLine: 0, totalLines: null, lines: [], binary: true }
  }

  const text = buf.toString('utf8')
  const lines = text.split('\n')
  // A trailing newline ends the last line; it does not open a new one. Over the cap the
  // final segment may be cut mid-line, so it is dropped too.
  if (lines[lines.length - 1] === '') lines.pop()
  else if (truncated) lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1)
  }

  const start = Math.max(1, range.start ?? 1)
  if (truncated && start > lines.length) throw new FileAccessError('beyond-cap')
  const endLine = Math.min(range.end ?? lines.length, lines.length)
  const window = endLine >= start ? lines.slice(start - 1, endLine) : []

  return {
    ...base,
    startLine: start,
    endLine,
    totalLines: truncated ? null : lines.length,
    lines: window,
    binary: false,
  }
}

const noGit = (root: string): FileStatus & { root: string } => ({ root, git: false, changes: [] })

/**
 * Porcelain v1, NUL-separated, relative to the repository root even when run from a
 * subdirectory. `rev-parse --show-prefix` gives that subdirectory, so each path is
 * stripped of it and records outside the root are dropped. Read-only and never throws:
 * no repository, no git binary, or a timeout is `git: false`.
 */
export async function gitStatus(
  roots: readonly KnownRoot[],
  root: string
): Promise<FileStatus & { root: string }> {
  const got = await confine(roots, root, '')
  const prefixOut = await tryGit(got.abs, ['rev-parse', '--show-prefix'])
  if (prefixOut === null) return noGit(root)
  // The only trailing byte this trims is git's own newline; the path itself is untouched.
  const prefix = prefixOut.replace(/\n$/, '')

  const out = await tryGit(got.abs, ['status', '--porcelain=v1', '-z'])
  if (out === null) return noGit(root)

  const fields = out.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()

  const changes: FileChange[] = []
  const inRoot = (repoPath: string) => prefix === '' || repoPath.startsWith(prefix)
  const toRoot = (repoPath: string) => repoPath.slice(prefix.length)

  let i = 0
  while (i < fields.length && changes.length < maxChanges) {
    const rec = fields[i++] ?? ''
    if (rec.length < 4) continue
    const index = rec[0] ?? ' '
    const worktree = rec[1] ?? ' '
    const repoPath = rec.slice(3)
    // A rename or copy is followed by its origin path as its own NUL field.
    let origin: string | undefined
    if (index === 'R' || index === 'C') origin = fields[i++]
    if (!inRoot(repoPath)) continue

    const change: FileChange = { path: toRoot(repoPath), index, worktree }
    if (origin !== undefined) {
      // An origin outside this root is shown as a root-relative `../` path, never absolute.
      change.originPath =
        prefix === '' ? origin : posix.relative(prefix, origin)
    }
    changes.push(change)
  }

  return { root, git: true, changes }
}

/**
 * One path, three states. The work-tree diff first; if that is empty, the staged diff
 * (the change is fully staged); if still empty, the status decides whether the file is
 * untracked. The path is a literal pathspec after `--`, so a name with `*` or a leading
 * `-` is a path, never a glob or a flag. Any git failure is `no-git`.
 */
export async function gitDiff(
  roots: readonly KnownRoot[],
  root: string,
  path: string
): Promise<FileDiffResponse> {
  const got = await confine(roots, root, path)
  // The git repository is the confined root; the pathspec is relative to it.
  const spec = got.rel === '' ? '.' : `:(literal)${got.rel}`
  const cap = (text: string) => Buffer.from(text).subarray(0, maxFileBytes).toString('utf8')

  try {
    let patch = await runGit(got.root, ['diff', '--no-color', '--', spec])
    let staged = false
    if (patch === '') {
      const cached = await runGit(got.root, ['diff', '--no-color', '--cached', '--', spec])
      if (cached !== '') {
        patch = cached
        staged = true
      }
    }
    let untracked = false
    if (patch === '') {
      const status = await runGit(got.root, ['status', '--porcelain=v1', '--', spec])
      untracked = status.startsWith('??')
    }
    return { root, path: got.rel, patch: cap(patch), untracked, staged }
  } catch {
    throw new FileAccessError('no-git')
  }
}
