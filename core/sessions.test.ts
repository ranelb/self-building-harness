import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSessions, readSession } from './sessions.ts'

let root: string

const header = (id: string, cwd: string, timestamp: string) =>
  JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp })

const message = (role: string, content: unknown[]) =>
  JSON.stringify({ type: 'message', id: 'ab', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role, content } })

const writeSession = async (project: string, file: string, lines: string[]) => {
  const dir = join(root, project)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), lines.join('\n') + '\n')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sbh-sessions-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listSessions', () => {
  it('lists a session with its id, cwd and a title from the first user message', async () => {
    await writeSession('--home-user--', 'stamp_abc.jsonl', [
      header('abc', '/home/user', '2026-01-01T10:00:00.000Z'),
      message('system', [{ type: 'text', text: 'system prompt' }]),
      message('user', [{ type: 'text', text: 'how do I make a meta harness?' }]),
      message('assistant', [{ type: 'text', text: 'by splitting it' }]),
    ])

    const sessions = await listSessions(root)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: 'abc',
      cwd: '/home/user',
      startedAt: '2026-01-01T10:00:00.000Z',
      title: 'how do I make a meta harness?',
    })
    expect(sessions[0]?.path.endsWith('stamp_abc.jsonl')).toBe(true)
  })

  it('truncates a very long first message', async () => {
    await writeSession('--home-user--', 'big.jsonl', [
      header('big', '/home/user', '2026-01-01T10:00:00.000Z'),
      message('user', [{ type: 'text', text: 'x'.repeat(500) }]),
    ])
    const title = (await listSessions(root))[0]?.title ?? ''
    expect(title.length).toBeLessThanOrEqual(90)
    expect(title.endsWith('…')).toBe(true)
  })

  it('titles a session from what the user typed, not the injected skill', async () => {
    await writeSession('--home-user--', 'skill.jsonl', [
      header('sk', '/home/user', '2026-01-01T10:00:00.000Z'),
      message('user', [
        {
          type: 'text',
          text: '<skill name="grilling" location="/x">\nReferences are relative.\n</skill>\n\nbuild me a meta harness',
        },
      ]),
    ])

    expect((await listSessions(root))[0]?.title).toBe('build me a meta harness')
  })

  it('keeps looking past a message that is nothing but scaffolding', async () => {
    await writeSession('--home-user--', 'only-skill.jsonl', [
      header('os', '/home/user', '2026-01-01T10:00:00.000Z'),
      message('user', [{ type: 'text', text: '<skill name="x">body</skill>' }]),
      message('user', [{ type: 'text', text: 'the real question' }]),
    ])

    expect((await listSessions(root))[0]?.title).toBe('the real question')
  })

  it('sorts newest first across project directories', async () => {
    await writeSession('--home-user--', 'old.jsonl', [
      header('old', '/home/user', '2026-01-01T00:00:00.000Z'),
      message('user', [{ type: 'text', text: 'old' }]),
    ])
    await writeSession('--home-user-projects--', 'new.jsonl', [
      header('new', '/home/user/projects', '2026-06-01T00:00:00.000Z'),
      message('user', [{ type: 'text', text: 'new' }]),
    ])

    const sessions = await listSessions(root)
    expect(sessions[0]?.id).toBe('new')
    expect(sessions[1]?.id).toBe('old')
  })

  it('ignores files that are not sessions, and sessions with no user message', async () => {
    await writeSession('--home-user--', 'notes.txt', ['not a session'])
    await writeSession('--home-user--', 'broken.jsonl', ['{ not json', header('h', '/x', 't')])
    await writeSession('--home-user--', 'empty.jsonl', [header('empty', '/home/user', '2026-01-01T00:00:00.000Z')])

    const sessions = await listSessions(root)
    expect(sessions.map((s) => s.id)).toEqual(['empty'])
    expect(sessions[0]?.title).toBe('')
  })

  it('returns an empty list when the root does not exist', async () => {
    expect(await listSessions(join(root, 'nope'))).toEqual([])
  })

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await writeSession('--home-user--', `s${i}.jsonl`, [
        header(`id${i}`, '/home/user', `2026-01-0${i + 1}T00:00:00.000Z`),
        message('user', [{ type: 'text', text: `m${i}` }]),
      ])
    }
    expect(await listSessions(root, 2)).toHaveLength(2)
  })
})

describe('readSession', () => {
  const seed = async () =>
    writeSession('--home-user--', 'stamp_abc.jsonl', [
      header('abc', '/home/user', '2026-01-01T10:00:00.000Z'),
      message('system', [{ type: 'text', text: 'system prompt' }]),
      message('user', [{ type: 'text', text: 'hello' }]),
      message('assistant', [
        { type: 'thinking', thinking: 'secret reasoning' },
        { type: 'text', text: 'hi there' },
      ]),
      message('toolResult', [{ type: 'text', text: 'tool output' }]),
    ])

  it('returns user and assistant text, skipping system, tools and thinking', async () => {
    await seed()
    const detail = await readSession(root, 'abc')
    expect(detail?.turns).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ])
    expect(JSON.stringify(detail)).not.toContain('secret reasoning')
    expect(JSON.stringify(detail)).not.toContain('tool output')
  })

  it('returns null for an unknown id', async () => {
    await seed()
    expect(await readSession(root, 'nope')).toBeNull()
  })

  it('cannot be tricked into reading outside the sessions root', async () => {
    await seed()
    // Ids are matched against the listing, never concatenated into a path.
    expect(await readSession(root, '../../../../etc/passwd')).toBeNull()
    expect(await readSession(root, '..%2f..%2fetc%2fpasswd')).toBeNull()
    expect(await readSession(root, '')).toBeNull()
  })
})
