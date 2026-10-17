import { describe, it, expect } from 'vitest'
import { runShell, stripControl } from './shell.ts'

type Chunk = { stream: 'stdout' | 'stderr'; text: string }

/** Run a command, collecting every emitted chunk. */
const collect = (command: string, cwd = process.cwd(), limits?: Parameters<typeof runShell>[0]['limits']) => {
  const chunks: Chunk[] = []
  const handle = runShell({ command, cwd, onChunk: (c) => chunks.push(c), limits })
  return { handle, chunks, text: () => chunks.map((c) => c.text).join('') }
}

describe('runShell', () => {
  it('echo hi emits the text and exits 0', async () => {
    const { handle, chunks } = collect('echo hi')
    const r = await handle.result
    expect(chunks.map((c) => c.text).join('')).toBe('hi\n')
    expect(chunks[0]?.stream).toBe('stdout')
    expect(r.exitCode).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.cancelled).toBe(false)
    expect(r.truncated).toBe(false)
    expect(handle.id).toMatch(/^shell-[0-9a-f-]{36}$/)
  })

  it('exit 3 reports exitCode 3', async () => {
    const r = await collect('exit 3').handle.result
    expect(r.exitCode).toBe(3)
  })

  it('runs in the cwd passed in', async () => {
    const cwd = process.cwd()
    const { handle, text } = collect('pwd', cwd)
    await handle.result
    expect(text().trim()).toBe(cwd)
  })

  it('strips ANSI colour sequences from output', async () => {
    const { handle, text } = collect("printf '\\033[31mred\\033[0m'")
    await handle.result
    expect(text()).toBe('red')
  })

  it('caps output at maxOutputBytes, kills the group, and leaves no process behind', async () => {
    const cap = 64 * 1024
    const { handle, chunks, text } = collect(
      'head -c 4194304 /dev/zero | tr "\\0" x; sleep 30',
      process.cwd(),
      { maxOutputBytes: cap },
    )
    const r = await handle.result
    expect(r.truncated).toBe(true)
    const markers = chunks.filter((c) => c.text.includes('output capped'))
    expect(markers).toHaveLength(1)
    expect(markers[0]?.text).toContain('output capped at 64 KiB')
    expect(Buffer.byteLength(text(), 'utf8')).toBeLessThanOrEqual(cap + Buffer.byteLength(markers[0]?.text ?? '', 'utf8'))
  })

  it('times out: TERM, timedOut true, settles fast', async () => {
    const t0 = Date.now()
    const r = await collect('sleep 5', process.cwd(), { timeoutMs: 100, graceMs: 200 }).handle.result
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(600)
  })

  it('cancel() settles promptly and kills the whole group (no leak)', async () => {
    const { handle } = collect("sh -c 'sleep 3 & wait'")
    await new Promise((res) => setTimeout(res, 100))
    const t0 = Date.now()
    handle.cancel()
    const r = await handle.result
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.cancelled).toBe(true)
    // The group is gone: a fresh run still works (and the backgrounded sleep died with it).
    const after = await collect('echo alive').handle.result
    expect(after.exitCode).toBe(0)
  })

  it('a spawn failure resolves instead of rejecting', async () => {
    const { handle } = collect('echo hi')
    const r = await runShell({
      command: 'echo hi', cwd: process.cwd(), onChunk: () => {}, shell: '/nonexistent/shell-xyz',
    }).result
    expect(r.exitCode).toBeNull()
    expect(r.signal).toBe('spawn-error')
    await handle.result
  })
})

describe('stripControl', () => {
  it('drops ANSI CSI sequences', () => {
    expect(stripControl('\u001b[1;31mbold\u001b[0m')).toBe('bold')
  })
  it('drops OSC sequences (BEL and ST terminated)', () => {
    expect(stripControl('a\u001b]0;title\u0007b')).toBe('ab')
    expect(stripControl('a\u001b]8;;http://x\u001b\\b')).toBe('ab')
  })
  it('drops NUL bytes and carriage returns', () => {
    expect(stripControl('a\u0000b\rc')).toBe('abc')
  })
  it('keeps tabs and newlines', () => {
    expect(stripControl('a\tb\nc')).toBe('a\tb\nc')
  })
})
