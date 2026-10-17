// Run a user-typed command as a process group that can be killed on demand.
// The promise never rejects: every outcome, including a spawn failure, is a ShellResult.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export const DEFAULT_SHELL_LIMITS = { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, graceMs: 5_000 }

export interface ShellResult {
  exitCode: number | null
  signal: string | null
  truncated: boolean
  timedOut: boolean
  cancelled: boolean
  durationMs: number
}

export interface ShellHandle {
  readonly id: string
  readonly result: Promise<ShellResult>
  cancel(): void
}

type Stream = 'stdout' | 'stderr'
type OnChunk = (c: { stream: Stream; text: string }) => void

const FLUSH_MS = 16
const FLUSH_BYTES = 8 * 1024

// CSI (ESC [ ... final), OSC (ESC ] ... BEL | ESC \), other 2-byte ESC sequences, NUL, CR.
// eslint-disable-next-line no-control-regex
const CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000\r]/g

/** Drop terminal control noise; keep tabs and newlines. */
export function stripControl(text: string): string {
  return text.replace(CONTROL, '')
}

const formatBytes = (n: number): string =>
  n % (1024 * 1024) === 0 ? `${n / (1024 * 1024)} MiB` : n % 1024 === 0 ? `${n / 1024} KiB` : `${n} bytes`

export function runShell(o: {
  command: string
  cwd: string
  onChunk: OnChunk
  shell?: string
  limits?: Partial<typeof DEFAULT_SHELL_LIMITS>
  env?: NodeJS.ProcessEnv
}): ShellHandle {
  const limits = { ...DEFAULT_SHELL_LIMITS, ...o.limits }
  const id = 'shell-' + randomUUID()
  const shell = o.shell ?? process.env.SBH_SHELL ?? '/bin/sh'
  const t0 = Date.now()

  let child: ChildProcess | undefined
  let settled = false
  let truncated = false
  let timedOut = false
  let cancelled = false
  let bytes = 0
  let resolveResult!: (r: ShellResult) => void
  const result = new Promise<ShellResult>((res) => (resolveResult = res))

  const timers = new Set<NodeJS.Timeout>()
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    timers.add(t)
  }
  const clearTimers = () => { for (const t of timers) clearTimeout(t); timers.clear() }

  // Coalescing: one pending run, flushed every 16 ms, at 8 KiB, or when the stream changes.
  let pending: { stream: Stream; text: string; bytes: number } | null = null
  let flushTimer: NodeJS.Timeout | undefined
  const emit = (stream: Stream, text: string) => {
    const clean = stripControl(text)
    if (clean) o.onChunk({ stream, text: clean })
  }
  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined }
    if (!pending) return
    const p = pending
    pending = null
    emit(p.stream, p.text)
  }
  const push = (stream: Stream, text: string, n: number) => {
    if (pending && pending.stream !== stream) flush()
    if (!pending) pending = { stream, text: '', bytes: 0 }
    pending.text += text
    pending.bytes += n
    if (pending.bytes >= FLUSH_BYTES) return flush()
    flushTimer ??= setTimeout(flush, FLUSH_MS)
  }

  // Kill the whole group; fall back to the leader if the group is already gone.
  const signalGroup = (sig: NodeJS.Signals) => {
    if (!child) return
    const pid = child.pid
    try {
      if (pid !== undefined) process.kill(-pid, sig)
      else child.kill(sig)
    } catch {
      try { child.kill(sig) } catch { /* already gone */ }
    }
  }
  // TERM now, KILL after the grace period (unless the run has already settled).
  const terminate = () => {
    signalGroup('SIGTERM')
    later(limits.graceMs, () => signalGroup('SIGKILL'))
  }

  const settle = (exitCode: number | null, signal: string | null) => {
    if (settled) return
    settled = true
    clearTimers()
    flush()
    resolveResult({ exitCode, signal, truncated, timedOut, cancelled, durationMs: Date.now() - t0 })
  }

  try {
    child = spawn(shell, ['-c', o.command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: o.cwd,
      env: o.env,
    })
  } catch {
    settle(null, 'spawn-error')
    return { id, result, cancel: () => {} }
  }

  const proc = child
  proc.on('error', () => settle(null, 'spawn-error'))
  proc.on('exit', () => {
    // Leftover group members would hold the pipes open and stall 'close'; the command is over.
    signalGroup('SIGKILL')
  })
  proc.on('close', (code, signal) => settle(code, signal))

  const decoders: Record<Stream, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }
  const onData = (stream: Stream) => (buf: Buffer) => {
    if (truncated || settled) return
    const room = limits.maxOutputBytes - bytes
    const take = buf.length <= room ? buf : buf.subarray(0, Math.max(0, room))
    bytes += take.length
    if (take.length) push(stream, decoders[stream].write(take), take.length)
    if (take.length < buf.length) {
      truncated = true
      flush()
      signalGroup('SIGKILL')
      emit('stderr', `\u2404 output capped at ${formatBytes(limits.maxOutputBytes)}`)
    }
  }
  proc.stdout?.on('data', onData('stdout'))
  proc.stderr?.on('data', onData('stderr'))

  if (limits.timeoutMs > 0) {
    later(limits.timeoutMs, () => {
      if (settled) return
      timedOut = true
      terminate()
    })
  }

  return {
    id,
    result,
    cancel() {
      if (settled || cancelled) return
      cancelled = true
      terminate()
    },
  }
}
