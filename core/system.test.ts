import { describe, it, expect } from 'vitest'
import { cpuUsage, createSystemSampler, sampleSystem } from './system.ts'

describe('cpuUsage', () => {
  it('is half idle when half the ticks were idle', () => {
    expect(cpuUsage({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBeCloseTo(0.5)
  })

  it('is 1 when nothing was idle', () => {
    expect(cpuUsage({ idle: 0, total: 0 }, { idle: 0, total: 100 })).toBe(1)
  })

  it('is 0 when everything was idle', () => {
    expect(cpuUsage({ idle: 0, total: 0 }, { idle: 100, total: 100 })).toBe(0)
  })

  it('is 0 rather than NaN when no time passed', () => {
    expect(cpuUsage({ idle: 5, total: 9 }, { idle: 5, total: 9 })).toBe(0)
  })
})

describe('createSystemSampler', () => {
  it('reports 0 cpu on the very first call, because there is no baseline yet', () => {
    expect(createSystemSampler().sample().cpu.usage).toBe(0)
  })

  it('reports a real delta once time has passed', async () => {
    const sampler = createSystemSampler()
    sampler.sample()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const sample = sampler.sample()
    expect(sample.cpu.usage).toBeGreaterThanOrEqual(0)
    expect(sample.cpu.usage).toBeLessThanOrEqual(1)
  })

  it('keeps each sampler independent', () => {
    const first = createSystemSampler()
    first.sample()
    // A second sampler has its own baseline, so it is unaffected by the first.
    expect(createSystemSampler().sample().cpu.usage).toBe(0)
  })
})

describe('sampleSystem', () => {
  it('reports a plausible sample', () => {
    const sample = sampleSystem()
    expect(sample.cpu.usage).toBeGreaterThanOrEqual(0)
    expect(sample.cpu.usage).toBeLessThanOrEqual(1)
    expect(sample.cpu.cores).toBeGreaterThan(0)
    expect(sample.memory.totalBytes).toBeGreaterThan(0)
    expect(sample.memory.usedBytes).toBeGreaterThanOrEqual(0)
    expect(sample.memory.usage).toBeGreaterThan(0)
    expect(sample.memory.usage).toBeLessThanOrEqual(1)
    expect(sample.load).toHaveLength(3)
  })
})
