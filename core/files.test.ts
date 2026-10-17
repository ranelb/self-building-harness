import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { basename, join } from 'node:path'
import { canonicalRoots, confine, FileAccessError } from './files.ts'
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
