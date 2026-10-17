import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { basename, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { makeTempRepo, git as gitRun, type TempRepo } from '../test/fixtures/files-fixture.ts'
import { canonicalRoots, confine, FileAccessError, gitStatus, listTree, maxFileBytes, readText } from './files.ts'
import { makeTempTree, type TempTree } from '../test/fixtures/files-fixture.ts'

/** The reason a promise rejects with, or 'ok' if it resolves. */
const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (err) {
    if (err instanceof FileAccessError) return err.reason
    throw err
  }
}

describe('confine (the gate)', () => {
  let tree: TempTree

  beforeEach(async () => {
    tree = await makeTempTree()
  })
  afterEach(async () => {
    await tree.cleanup()
  })

  it('accepts the root itself with an empty path', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await confine(roots, tree.root, '')
    expect(got.rel).toBe('')
  })

  it('resolves a path inside the root', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await confine(roots, tree.root, 'sub/b.ts')
    expect(got.rel).toBe('sub/b.ts')
  })

  it('refuses a root that is not in the known set', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(confine(roots, tree.outside, ''))).toBe('root-not-known')
  })

  it('refuses .. that leaves the root', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(confine(roots, tree.root, '../../etc'))).toBe('escapes-root')
  })

  it('refuses an absolute path even when it points inside the root', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(confine(roots, tree.root, join(tree.root, 'a.txt')))).toBe(
      'absolute-path'
    )
  })

  it('refuses a symlink whose target is outside the root', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(confine(roots, tree.root, 'link-out'))).toBe('escapes-root')
  })

  it('allows a symlink whose target is inside the root, reporting the canonical path', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await confine(roots, tree.root, 'link-in/b.ts')
    expect(got.rel).toBe('sub/b.ts')
  })

  it('does not confuse a name-prefix sibling with the root', async () => {
    const roots = await canonicalRoots([tree.root])
    // `<root>2` starts with the root's string; only the separator makes it outside.
    expect(await reasonOf(confine(roots, tree.sibling, ''))).toBe('root-not-known')
    expect(await reasonOf(confine(roots, tree.root, `../${basename(tree.sibling)}/x`))).toBe(
      'escapes-root'
    )
  })

  it('reports a missing path', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(confine(roots, tree.root, 'nope.txt'))).toBe('missing')
  })

  it('drops relative and empty cwds from canonicalRoots', async () => {
    const roots = await canonicalRoots(['', 'relative/dir', tree.root])
    expect(roots.map((r) => r.given)).toEqual([tree.root])
  })

  it('keeps a null real for a root that does not exist, and refuses it', async () => {
    const gone = join(tree.outside, 'gone')
    const roots = await canonicalRoots([gone])
    expect(roots[0]?.real).toBeNull()
    expect(await reasonOf(confine(roots, gone, ''))).toBe('root-not-known')
  })
})

describe('listTree', () => {
  let tree: TempTree

  beforeEach(async () => {
    tree = await makeTempTree()
  })
  afterEach(async () => {
    await tree.cleanup()
  })

  it('lists one level of the root, dotfiles included, without recursing', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await listTree(roots, tree.root, '')
    const names = got.entries.map((e) => e.name)
    expect(names).toEqual(['sub', '.hidden', 'a.txt', 'b.bin', 'link-in', 'link-out'])
    expect(got.entries.find((e) => e.name === 'b.ts')).toBeUndefined()
    expect(got.truncated).toBe(false)
    expect(got.path).toBe('')
  })

  it('lists a subdirectory with root-relative paths', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await listTree(roots, tree.root, 'sub')
    expect(got.entries).toEqual([
      { name: 'b.ts', path: 'sub/b.ts', kind: 'file', size: 'export const b = 1\n'.length, outside: false },
    ])
  })

  it('marks a symlink whose target is outside the root as outside', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await listTree(roots, tree.root, '')
    const link = got.entries.find((e) => e.name === 'link-out')
    expect(link).toMatchObject({ kind: 'symlink', outside: true })
  })

  it('marks a symlink whose target is inside the root as not outside', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await listTree(roots, tree.root, '')
    const link = got.entries.find((e) => e.name === 'link-in')
    expect(link).toMatchObject({ kind: 'symlink', outside: false })
  })

  it('refuses a file where a directory is expected', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(listTree(roots, tree.root, 'a.txt'))).toBe('not-a-dir')
  })

  it('caps the listing and reports truncation', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await listTree(roots, tree.root, '', 2)
    expect(got.entries).toHaveLength(2)
    expect(got.truncated).toBe(true)
  })

  it('lists directories before files, each group by name', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await listTree(roots, tree.root, '')
    expect(got.entries[0]).toMatchObject({ name: 'sub', kind: 'dir', size: 0 })
  })
})

describe('readText', () => {
  let tree: TempTree

  beforeEach(async () => {
    tree = await makeTempTree()
  })
  afterEach(async () => {
    await tree.cleanup()
  })

  it('reads a text file', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await readText(roots, tree.root, 'a.txt')
    expect(got).toMatchObject({
      root: tree.root,
      path: 'a.txt',
      size: 12,
      text: 'hello\nworld\n',
      truncated: false,
      binary: false,
    })
  })

  it('flags a binary file and returns no text', async () => {
    const roots = await canonicalRoots([tree.root])
    const got = await readText(roots, tree.root, 'b.bin')
    expect(got).toMatchObject({ binary: true, text: '' })
  })

  it('truncates a file over the cap to a prefix of the cap', async () => {
    await writeFile(join(tree.root, 'big.txt'), 'a'.repeat(maxFileBytes + 1024))
    const roots = await canonicalRoots([tree.root])
    const got = await readText(roots, tree.root, 'big.txt')
    expect(got.truncated).toBe(true)
    expect(got.size).toBe(maxFileBytes + 1024)
    expect(got.text.length).toBeLessThanOrEqual(maxFileBytes)
    expect(got.text.length).toBe(maxFileBytes)
  })

  it('refuses a directory', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(readText(roots, tree.root, 'sub'))).toBe('not-a-file')
  })

  it('refuses a symlink whose target is outside the root', async () => {
    const roots = await canonicalRoots([tree.root])
    expect(await reasonOf(readText(roots, tree.root, 'link-out'))).toBe('escapes-root')
  })
})

describe('gitStatus', () => {
  let repo: TempRepo

  beforeEach(async () => {
    repo = await makeTempRepo()
  })
  afterEach(async () => {
    await repo.cleanup()
  })

  it('reports a work-tree modification with the leading space intact', async () => {
    const roots = await canonicalRoots([repo.root])
    const got = await gitStatus(roots, repo.root)
    expect(got.git).toBe(true)
    expect(got.changes).toContainEqual({ path: 'a.txt', index: ' ', worktree: 'M' })
  })

  it('reports an untracked file', async () => {
    const roots = await canonicalRoots([repo.root])
    const got = await gitStatus(roots, repo.root)
    expect(got.changes).toContainEqual(expect.objectContaining({ path: 'new.txt', index: '?' }))
  })

  it('reports a staged change', async () => {
    await gitRun(repo.root, ['add', 'a.txt'])
    const roots = await canonicalRoots([repo.root])
    const got = await gitStatus(roots, repo.root)
    expect(got.changes).toContainEqual({ path: 'a.txt', index: 'M', worktree: ' ' })
  })

  it('reports a rename with its origin path', async () => {
    await gitRun(repo.root, ['mv', 'sub/x.ts', 'sub/y.ts'])
    const roots = await canonicalRoots([repo.root])
    const got = await gitStatus(roots, repo.root)
    expect(got.changes).toContainEqual(
      expect.objectContaining({ path: 'sub/y.ts', index: 'R', originPath: 'sub/x.ts' })
    )
  })

  it('returns git: false outside a repository', async () => {
    const tree = await makeTempTree()
    try {
      const roots = await canonicalRoots([tree.root])
      expect(await gitStatus(roots, tree.root)).toMatchObject({ git: false, changes: [] })
    } finally {
      await tree.cleanup()
    }
  })

  it('keeps paths relative to a subdirectory root and drops changes outside it', async () => {
    await writeFile(join(repo.root, 'sub', 'x.ts'), 'export const x = 2\n')
    const sub = join(repo.root, 'sub')
    const roots = await canonicalRoots([sub])
    const got = await gitStatus(roots, sub)
    expect(got.git).toBe(true)
    expect(got.changes).toEqual([{ path: 'x.ts', index: ' ', worktree: 'M' }])
  })
})

describe('listTree status', () => {
  it('carries the git status of the root on the listing', async () => {
    const repo = await makeTempRepo()
    try {
      const roots = await canonicalRoots([repo.root])
      const got = await listTree(roots, repo.root, '')
      expect(got.status.git).toBe(true)
      expect(got.status.changes).toContainEqual({ path: 'a.txt', index: ' ', worktree: 'M' })
    } finally {
      await repo.cleanup()
    }
  })
})
