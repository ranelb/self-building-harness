/**
 * Machine sampling for the state channel.
 *
 * Components run in the webview and can reach nothing; the core is an ordinary
 * Node process and can reach everything the user can. So the pattern for any
 * "show me X about this machine" widget is: the core samples, the state channel
 * carries it, a component renders it. The same mechanism as usage.
 */
import { cpus, freemem, loadavg, totalmem } from 'node:os'

export interface SystemSample {
  cpu: { usage: number; cores: number }
  memory: { usedBytes: number; totalBytes: number; usage: number }
  load: number[]
}

export interface CpuTimes {
  idle: number
  total: number
}

export function readCpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value
      if (kind === 'idle') idle += value
    }
  }
  return { idle, total }
}

/**
 * Usage across an interval, from two cumulative readings.
 *
 * Pure, because a single cumulative reading says nothing and the interesting
 * behaviour is entirely in the delta.
 */
export function cpuUsage(prior: CpuTimes, now: CpuTimes): number {
  const idle = now.idle - prior.idle
  const total = now.total - prior.total
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, 1 - idle / total))
}

/**
 * A sampler with its own baseline.
 *
 * Explicit rather than a module-level global so that a test (or a second consumer)
 * cannot be affected by another caller's readings — the first version kept the
 * baseline in module state and made the tests order-dependent.
 */
export function createSystemSampler(): { sample(): SystemSample } {
  let previous: CpuTimes | null = null

  return {
    sample(): SystemSample {
      const now = readCpuTimes()
      const prior = previous
      previous = now

      const totalBytes = totalmem()
      const usedBytes = totalBytes - freemem()

      return {
        cpu: {
          usage: prior ? cpuUsage(prior, now) : 0,
          cores: cpus().length,
        },
        memory: {
          usedBytes,
          totalBytes,
          usage: totalBytes > 0 ? usedBytes / totalBytes : 0,
        },
        load: loadavg(),
      }
    },
  }
}

const defaultSampler = createSystemSampler()

/** The process-wide sampler, for the core's publish loop. */
export const sampleSystem = (): SystemSample => defaultSampler.sample()
