import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchPaths, type Watcher } from './watch.ts'

let dir: string
let watcher: Watcher | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sbh-watch-'))
})

afterEach(async () => {
  watcher?.close()
  watcher = undefined
  await rm(dir, { recursive: true, force: true })
})

const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('watchPaths', () => {
  it('reports the changed file', async () => {
    const seen: string[] = []
    watcher = watchPaths([dir], (path) => seen.push(path))
    await writeFile(join(dir, 'component.js'), 'export const component = {}')

    await waitFor(() => seen.length > 0)
    expect(seen.some((path) => path.includes('component.js'))).toBe(true)
  })

  it('debounces a burst of writes into one report', async () => {
    const seen: string[] = []
    watcher = watchPaths([dir], (path) => seen.push(path), 120)

    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(dir, 'burst.js'), `export const component = { v: ${i} }`)
    }

    await waitFor(() => seen.length > 0)
    await new Promise((r) => setTimeout(r, 400))
    expect(seen.length).toBe(1)
  })

  it('does not throw when given a path that does not exist', () => {
    expect(() => {
      watcher = watchPaths([join(dir, 'missing')], () => {})
    }).not.toThrow()
  })
})
