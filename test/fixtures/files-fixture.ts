/**
 * Temp trees for the file-read tests. Built at test time under os.tmpdir(), never
 * checked in: the "symlink pointing outside the root" case needs an absolute target
 * outside the fixture, which a committed tree cannot express.
 *
 * Git is run with the user's global and system config neutralised, so a signing
 * default or an alias in ~/.gitconfig cannot break a test run.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}

const identity = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false']

export const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await run('git', [...identity, ...args], { cwd, env: gitEnv })
  return stdout
}

export interface TempTree {
  /** The directory the core would know about. */
  root: string
  /** A directory beside `root`, outside it. */
  outside: string
  /** `<root>2`: a name-prefix sibling of `root`, never a root. */
  sibling: string
  cleanup: () => Promise<void>
}

/**
 * base/
 *   root/        a.txt, b.bin (NUL), .hidden, sub/b.ts,
 *                link-in -> sub, link-out -> ../outside/secret.txt
 *   outside/     secret.txt
 *   root2/       (sibling)
 */
export async function makeTempTree(): Promise<TempTree> {
  const base = await mkdtemp(join(tmpdir(), 'sbh-files-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  const sibling = join(base, 'root2')
  await mkdir(join(root, 'sub'), { recursive: true })
  await mkdir(outside)
  await mkdir(sibling)
  await writeFile(join(root, 'a.txt'), 'hello\nworld\n')
  await writeFile(join(root, 'b.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]))
  await writeFile(join(root, '.hidden'), 'dot\n')
  await writeFile(join(root, 'sub', 'b.ts'), 'export const b = 1\n')
  await writeFile(join(outside, 'secret.txt'), 'top secret\n')
  await symlink('sub', join(root, 'link-in'))
  await symlink('../outside/secret.txt', join(root, 'link-out'))
  return {
    root,
    outside,
    sibling,
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

export interface TempRepo {
  /** A git work tree with one commit: a.txt, sub/x.ts. */
  root: string
  cleanup: () => Promise<void>
}

/**
 * Committed: a.txt, sub/x.ts. Then, in the work tree: a.txt modified (unstaged),
 * new.txt untracked. Callers stage or move files themselves when they need that.
 */
export async function makeTempRepo(): Promise<TempRepo> {
  const base = await mkdtemp(join(tmpdir(), 'sbh-repo-'))
  const root = join(base, 'repo')
  await mkdir(join(root, 'sub'), { recursive: true })
  await git(root, ['init', '-q'])
  await writeFile(join(root, 'a.txt'), 'one\n')
  await writeFile(join(root, 'sub', 'x.ts'), 'export const x = 1\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'init'])
  await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(root, 'new.txt'), 'fresh\n')
  return { root, cleanup: () => rm(base, { recursive: true, force: true }) }
}
