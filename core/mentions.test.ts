import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalRoots, type KnownRoot } from './files.ts'
import { expandMentions, maxMentionLines, maxMentionsPerPrompt, maxPromptContextBytes } from './mentions.ts'
import { makeTempTree, type TempTree } from '../test/fixtures/files-fixture.ts'
import type { UiEvent } from '../shared/protocol.ts'
import type { AcpContentBlock } from './attachments.ts'

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'

describe('expandMentions', () => {
  let tree: TempTree
  let roots: KnownRoot[]

  beforeEach(async () => {
    tree = await makeTempTree()
    roots = await canonicalRoots([tree.root])
  })
  afterEach(async () => {
    await tree.cleanup()
  })

  const run = async (text: string, embeddedContext = false, root = tree.root) => {
    const out = await expandMentions({ text, root, roots, caps: { embeddedContext } })
    return out as { blocks: AcpContentBlock[]; events: Extract<UiEvent, { type: 'context' }>[] }
  }

  it('exports the caps the spec names', () => {
    expect(maxMentionsPerPrompt).toBe(8)
    expect(maxMentionLines).toBe(400)
    expect(maxPromptContextBytes).toBe(256 * 1024)
  })

  it('ships a text block in the fallback form, with the range and total', async () => {
    const { blocks, events } = await run('see @a.txt:1-2 please')
    expect(blocks).toEqual([
      { type: 'text', text: '@a.txt:1-2 of 2 lines\n```\n1| hello\n2| world\n```' },
    ])
    expect(events).toEqual([
      { type: 'context', mention: '@a.txt:1-2', status: 'included', lines: { start: 1, end: 2 } },
    ])
  })

  it('ships a resource block when the agent embeds context', async () => {
    const { blocks } = await run('@a.txt:2', true)
    expect(blocks).toEqual([
      {
        type: 'resource',
        resource: {
          uri: `file://${join(tree.root, 'a.txt')}`,
          mimeType: 'text/plain',
          text: '@a.txt:2-2 of 2 lines\n```\n2| world\n```',
        },
      },
    ])
  })

  it('an open range runs to the end of the file', async () => {
    const { blocks, events } = await run('@a.txt:2-')
    expect(blocks[0]).toEqual({ type: 'text', text: '@a.txt:2-2 of 2 lines\n```\n2| world\n```' })
    expect(events[0]).toMatchObject({ status: 'included', lines: { start: 2, end: 2 } })
  })

  it('a bare mention ships the whole file', async () => {
    const { events } = await run('@a.txt')
    expect(events[0]).toMatchObject({ status: 'included', lines: { start: 1, end: 2 } })
  })

  it('ships the same file twice as two blocks, in place', async () => {
    const { blocks, events } = await run('@a.txt:1 and @a.txt:2')
    expect(blocks).toHaveLength(2)
    expect(events.map((e) => e.mention)).toEqual(['@a.txt:1', '@a.txt:2'])
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toContain('1| hello')
    expect((blocks[1] as { text: string }).text).toContain('2| world')
  })

  it('refuses a ninth mention with a skipped event', async () => {
    const text = Array.from({ length: 9 }, () => '@a.txt:1').join(' ')
    const { blocks, events } = await run(text)
    expect(blocks).toHaveLength(maxMentionsPerPrompt)
    expect(events).toHaveLength(9)
    expect(events[8]).toMatchObject({ status: 'skipped', reason: 'too-many-mentions' })
  })

  it('truncates a window over 400 lines and says so', async () => {
    await writeFile(join(tree.root, 'big.txt'), lines(500))
    const { blocks, events } = await run('@big.txt:1-500')
    const text = (blocks[0] as { text: string }).text
    expect(text.startsWith('@big.txt:1-400 of 500 lines\n')).toBe(true)
    expect(text).toContain('400| line 400\n```')
    expect(text).not.toContain('line 401')
    expect(events[0]).toMatchObject({ status: 'included', lines: { start: 1, end: 400 } })
    expect(events[0]?.reason).toBeDefined()
  })

  it('drops the LAST block and marks it skipped when the byte budget is exceeded', async () => {
    // Each window is ~200 KB: the first fits the 256 KiB budget, the second does not.
    const row = 'x'.repeat(1000)
    await writeFile(join(tree.root, 'wide.txt'), Array.from({ length: 200 }, () => row).join('\n'))
    const { blocks, events } = await run('@wide.txt:1-200 @wide.txt:1-200')
    expect(blocks).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'included' })
    expect(events[1]).toMatchObject({ status: 'skipped', reason: 'over-budget' })
  })

  it('refuses a missing file', async () => {
    const { blocks, events } = await run('@nope.txt')
    expect(blocks).toEqual([])
    expect(events).toEqual([
      { type: 'context', mention: '@nope.txt', status: 'skipped', reason: 'missing' },
    ])
  })

  it('refuses a directory', async () => {
    const { blocks, events } = await run('@sub')
    expect(blocks).toEqual([])
    expect(events[0]).toMatchObject({ status: 'skipped', reason: 'not-a-file' })
  })

  it('refuses a binary file', async () => {
    const { blocks, events } = await run('@b.bin')
    expect(blocks).toEqual([])
    expect(events[0]).toMatchObject({ status: 'skipped', reason: 'binary' })
  })

  it('refuses a symlink that escapes the root', async () => {
    const { blocks, events } = await run('@link-out')
    expect(blocks).toEqual([])
    expect(events[0]).toMatchObject({ status: 'skipped', reason: 'escapes-root' })
  })

  it('refuses a root the core does not know', async () => {
    const { blocks, events } = await run('@a.txt', false, join(tree.root, 'nope'))
    expect(blocks).toEqual([])
    expect(events[0]).toMatchObject({ status: 'skipped', reason: 'root-not-known' })
  })

  it('refuses an absolute path, never reinterpreting it', async () => {
    const { blocks, events } = await run('@/etc/hosts')
    expect(blocks).toEqual([])
    expect(events[0]).toMatchObject({ status: 'skipped', reason: 'absolute-path' })
  })

  it('refuses a range that selects nothing', async () => {
    const { blocks, events } = await run('@a.txt:9-12')
    expect(blocks).toEqual([])
    expect(events[0]).toMatchObject({ status: 'skipped', reason: 'empty-range' })
  })

  it('reports every mention in text order, included or not', async () => {
    const { events } = await run('@nope.txt then @a.txt:1')
    expect(events.map((e) => [e.mention, e.status])).toEqual([
      ['@nope.txt', 'skipped'],
      ['@a.txt:1', 'included'],
    ])
  })

  it('ignores mentions in prose and code', async () => {
    const { blocks, events } = await run('mail a@a.txt and `@a.txt` and \\@a.txt')
    expect(blocks).toEqual([])
    expect(events).toEqual([])
  })
})
