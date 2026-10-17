import { describe, it, expect } from 'vitest'
import { findMentions, parseShellCommand } from './mentions.ts'

describe('findMentions: where a token may open', () => {
  it('opens a token at the start of the message', () => {
    expect(findMentions('@a.ts')).toEqual([
      { raw: '@a.ts', path: 'a.ts', index: 0 },
    ])
  })

  it('opens a token after whitespace', () => {
    const got = findMentions('look at @src/x.ts')
    expect(got.map((m) => m.path)).toEqual(['src/x.ts'])
    expect(got[0]?.index).toBe(8)
  })

  it('treats an @ inside a word as prose (an email is not a mention)', () => {
    expect(findMentions('mail a@b.com now')).toEqual([])
  })
})

describe('findMentions: path charset', () => {
  it('accepts letters, digits, dot, underscore, slash, plus and dash', () => {
    expect(findMentions('@src/Foo_bar-1+2.tsx')[0]?.path).toBe('src/Foo_bar-1+2.tsx')
  })

  it('stops the path at a character outside the charset', () => {
    const got = findMentions('@a.ts, then')
    expect(got[0]?.path).toBe('a.ts')
  })
})

describe('findMentions: trailing dot', () => {
  it('strips one trailing dot that ends a sentence', () => {
    const got = findMentions('see @a.ts.')
    expect(got[0]).toMatchObject({ raw: '@a.ts', path: 'a.ts' })
  })
})

describe('findMentions: line ranges', () => {
  it(':12 is line 12 (a one-line range)', () => {
    expect(findMentions('@a.ts:12')[0]).toMatchObject({
      path: 'a.ts',
      range: { start: 12, end: 12 },
      raw: '@a.ts:12',
    })
  })

  it(':12-20 is inclusive', () => {
    expect(findMentions('@a.ts:12-20')[0]).toMatchObject({
      path: 'a.ts',
      range: { start: 12, end: 20 },
      raw: '@a.ts:12-20',
    })
  })

  it(':12- runs to the end of the file', () => {
    const got = findMentions('@a.ts:12-')[0]
    expect(got?.range).toEqual({ start: 12 })
    expect(got?.raw).toBe('@a.ts:12-')
  })

  it(':-20 is not a range: the path is bare and the suffix stays prose', () => {
    const got = findMentions('@a.ts:-20')
    expect(got).toHaveLength(1)
    expect(got[0]?.range).toBeUndefined()
    expect(got[0]?.raw).toBe('@a.ts')
  })

  it('does not read more than seven digits as a line number', () => {
    expect(findMentions('@a.ts:12345678')[0]?.range).toBeUndefined()
  })

  it('reports no range for a bare path', () => {
    expect(findMentions('@a.ts')[0]?.range).toBeUndefined()
  })
})

describe('findMentions: inert tokens', () => {
  it('a token preceded by a backslash is inert and the backslash stays in the text', () => {
    expect(findMentions('say \\@a.ts please')).toEqual([])
  })

  it('an odd number of backticks before the token makes it prose', () => {
    expect(findMentions('use `@a.ts')).toEqual([])
  })

  it('an even number of backticks before the token is live again', () => {
    expect(findMentions('`x` then @a.ts')[0]?.path).toBe('a.ts')
  })

  it('backticks on an earlier line do not affect this line', () => {
    const got = findMentions('`code\n@a.ts')
    expect(got.map((m) => m.path)).toEqual(['a.ts'])
  })

  it('finds several mentions in one message', () => {
    const got = findMentions('@a.ts:1-2 and @b/c.md')
    expect(got.map((m) => m.raw)).toEqual(['@a.ts:1-2', '@b/c.md'])
  })
})

describe('parseShellCommand', () => {
  it('a single ! is a shell command included in context', () => {
    expect(parseShellCommand('!ls -la')).toEqual({ command: 'ls -la', includeInContext: true })
  })

  it('!! is a shell command excluded from context', () => {
    expect(parseShellCommand('!!git status')).toEqual({
      command: 'git status',
      includeInContext: false,
    })
  })

  it('allows leading whitespace before the sigil', () => {
    expect(parseShellCommand('   !pwd')).toEqual({ command: 'pwd', includeInContext: true })
  })

  it('the command excludes the sigil and is trimmed', () => {
    expect(parseShellCommand('!  echo hi  ')?.command).toBe('echo hi')
  })

  it('no sigil is not a shell command', () => {
    expect(parseShellCommand('ls')).toBeNull()
  })

  it('an empty command is not a shell command', () => {
    expect(parseShellCommand('!')).toBeNull()
    expect(parseShellCommand('!!   ')).toBeNull()
  })

  it('an escaped \\! is not a shell command', () => {
    expect(parseShellCommand('\\!ls')).toBeNull()
  })
})
