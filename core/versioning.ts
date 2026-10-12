/**
 * Versioning for the agent-authored UI directory.
 *
 * A UI that rewrites itself needs an undo. Every settled change to the config
 * directory is committed, so "revert the last thing the agent did" is one git
 * command rather than a bespoke snapshot format.
 *
 * The repo gets its own local identity so this never depends on (or touches) the
 * user's global git config.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface Commit {
  hash: string
  subject: string
  date: string
}

const git = async (dir: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

const tryGit = async (dir: string, args: string[]): Promise<string | null> => {
  try {
    return await git(dir, args)
  } catch {
    return null
  }
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await tryGit(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true'
}

export async function ensureRepo(dir: string): Promise<boolean> {
  if (await isRepo(dir)) return false

  await tryGit(dir, ['init', '-q'])
  await tryGit(dir, ['config', 'user.name', 'SBH'])
  await tryGit(dir, ['config', 'user.email', 'sbh@localhost'])

  // An empty directory stages nothing, so the snapshot no-ops. Commit the empty
  // state anyway: revert needs a baseline to return to.
  await snapshot(dir, 'sbh: initial UI state')
  if ((await commitCount(dir)) === 0) {
    await tryGit(dir, ['commit', '-q', '--allow-empty', '-m', 'sbh: initial UI state'])
  }
  return true
}

/** Commit everything. Returns the new hash, or null when there was nothing to commit. */
export async function snapshot(dir: string, message: string): Promise<string | null> {
  await tryGit(dir, ['add', '-A'])
  const staged = await tryGit(dir, ['diff', '--cached', '--name-only'])
  if (!staged) return null

  if ((await tryGit(dir, ['rev-parse', '--verify', 'HEAD'])) === null) {
    await tryGit(dir, ['config', 'user.name', 'SBH'])
    await tryGit(dir, ['config', 'user.email', 'sbh@localhost'])
  }

  if ((await tryGit(dir, ['commit', '-q', '-m', message])) === null) return null
  return tryGit(dir, ['rev-parse', 'HEAD'])
}

export async function history(dir: string, limit = 20): Promise<Commit[]> {
  const raw = await tryGit(dir, ['log', `-${limit}`, '--format=%H%x1f%s%x1f%cI'])
  if (!raw) return []
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', date = ''] = line.split('\u001f')
      return { hash, subject, date }
    })
}

/** Number of commits, or 0 when the repo is missing or empty. */
export async function commitCount(dir: string): Promise<number> {
  const raw = await tryGit(dir, ['rev-list', '--count', 'HEAD'])
  return raw ? Number(raw) : 0
}

/**
 * Undo the most recent commit by reverting it, which keeps the history honest —
 * the revert is itself a commit, so a bad revert is undoable too.
 */
export async function revertLast(dir: string): Promise<boolean> {
  if ((await commitCount(dir)) < 2) return false
  return (await tryGit(dir, ['revert', '--no-edit', 'HEAD'])) !== null
}
