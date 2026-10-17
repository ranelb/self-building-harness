import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_STATE_ENTRY_BYTES,
  ensureStateFile,
  readState,
  statePath,
  validateStateEntry,
  writeState,
} from './state.ts'

const temp = () => mkdtemp(join(tmpdir(), 'sbh-store-'))

describe('state store', () => {
  it('rejects keys that are not flat bare names', () => {
    expect(validateStateEntry('theme.accent', 1)).toBeNull()
    expect(validateStateEntry('bad key', 1)).toBe('invalid key')
    expect(validateStateEntry('../escape', 1)).toBe('invalid key')
    expect(validateStateEntry('', 1)).toBe('invalid key')
    expect(validateStateEntry('a/b', 1)).toBe('invalid key')
  })

  it('accepts null as a delete and rejects undefined / non-JSON / oversized values', () => {
    expect(validateStateEntry('k', null)).toBeNull()
    expect(validateStateEntry('k', undefined)).toBe('value must be JSON, not undefined')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(validateStateEntry('k', cyclic)).toBe('value is not JSON-serializable')
    expect(validateStateEntry('k', 'x'.repeat(MAX_STATE_ENTRY_BYTES + 1))).toBe('entry too large')
  })

  it('reads {} when the file is missing or not an object', async () => {
    const dir = await temp()
    try {
      expect(await readState(dir)).toEqual({})
      await writeFile(statePath(dir), 'not json', 'utf8')
      expect(await readState(dir)).toEqual({})
      await writeFile(statePath(dir), '[]', 'utf8')
      expect(await readState(dir)).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('round-trips through an atomic write and creates the file on demand', async () => {
    const dir = await temp()
    try {
      await ensureStateFile(dir)
      expect(JSON.parse(await readFile(statePath(dir), 'utf8'))).toEqual({})
      await writeState(dir, { density: 'compact', accent: '#abc' })
      expect(await readState(dir)).toEqual({ density: 'compact', accent: '#abc' })
      // No temp sibling survives a completed write.
      await expect(readFile(`${statePath(dir)}.tmp`, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
