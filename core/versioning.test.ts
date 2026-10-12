import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitCount, ensureRepo, history, isRepo, revertLast, snapshot } from './versioning.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sbh-versioning-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const theme = (name: string) => JSON.stringify({ name }, null, 2) + '\n'

describe('versioning', () => {
  it('initialises a repo with its own local identity', async () => {
    expect(await isRepo(dir)).toBe(false)
    expect(await ensureRepo(dir)).toBe(true)
    expect(await isRepo(dir)).toBe(true)
    // Idempotent.
    expect(await ensureRepo(dir)).toBe(false)
  })

  it('snapshots a change and reports nothing to commit when clean', async () => {
    await ensureRepo(dir)
    await writeFile(join(dir, 'theme.json'), theme('one'))
    const hash = await snapshot(dir, 'sbh: theme changed')
    expect(hash).not.toBeNull()
    expect(await snapshot(dir, 'sbh: no change')).toBeNull()
  })

  it('lists history newest first', async () => {
    await ensureRepo(dir)
    await writeFile(join(dir, 'theme.json'), theme('one'))
    await snapshot(dir, 'sbh: first change')
    await writeFile(join(dir, 'theme.json'), theme('two'))
    await snapshot(dir, 'sbh: second change')

    const commits = await history(dir)
    expect(commits[0]?.subject).toBe('sbh: second change')
    expect(commits[1]?.subject).toBe('sbh: first change')
  })

  it('reverts the last change, restoring the file', async () => {
    await ensureRepo(dir)
    await writeFile(join(dir, 'theme.json'), theme('good'))
    await snapshot(dir, 'sbh: good state')

    await writeFile(join(dir, 'theme.json'), theme('broken'))
    await snapshot(dir, 'sbh: bad state')
    expect(await readFile(join(dir, 'theme.json'), 'utf8')).toContain('broken')

    expect(await revertLast(dir)).toBe(true)
    expect(await readFile(join(dir, 'theme.json'), 'utf8')).toContain('good')
    // The revert is itself a commit, so it can be undone in turn.
    expect((await history(dir))[0]?.subject).toContain('Revert')
  })

  it('refuses to revert when there is nothing to undo', async () => {
    await ensureRepo(dir)
    expect(await commitCount(dir)).toBe(1)
    expect(await revertLast(dir)).toBe(false)
  })

  it('does not throw on a directory that is not a repo', async () => {
    expect(await commitCount(dir)).toBe(0)
    expect(await history(dir)).toEqual([])
    expect(await revertLast(dir)).toBe(false)
  })
})
