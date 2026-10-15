import { describe, it, expect } from 'vitest'
import { DEFAULT_ALLOWED_ORIGINS, isOriginAllowed, resolveAllowedOrigins } from './origin.ts'

describe('isOriginAllowed', () => {
  it('allows a request with no Origin (a non-browser client)', () => {
    expect(isOriginAllowed(undefined, DEFAULT_ALLOWED_ORIGINS)).toBe(true)
  })

  it('allows the Vite dev origin', () => {
    expect(isOriginAllowed('http://127.0.0.1:5199', DEFAULT_ALLOWED_ORIGINS)).toBe(true)
  })

  it('allows the Tauri app origin', () => {
    expect(isOriginAllowed('tauri://localhost', DEFAULT_ALLOWED_ORIGINS)).toBe(true)
  })

  it('rejects a stranger web page', () => {
    expect(isOriginAllowed('https://evil.example', DEFAULT_ALLOWED_ORIGINS)).toBe(false)
  })

  it('rejects a look-alike origin (exact match only)', () => {
    expect(isOriginAllowed('http://127.0.0.1:5199.evil.example', DEFAULT_ALLOWED_ORIGINS)).toBe(false)
    expect(isOriginAllowed('https://127.0.0.1', DEFAULT_ALLOWED_ORIGINS)).toBe(false)
  })
})

describe('resolveAllowedOrigins', () => {
  it('uses the defaults when nothing is configured', () => {
    expect(resolveAllowedOrigins(undefined, {})).toEqual([...DEFAULT_ALLOWED_ORIGINS])
  })

  it('extends the defaults with SBH_ALLOWED_ORIGINS', () => {
    const allowed = resolveAllowedOrigins(undefined, { SBH_ALLOWED_ORIGINS: 'http://127.0.0.1:6000' })
    expect(allowed).toContain('http://127.0.0.1:6000')
    expect(allowed).toContain('tauri://localhost')
  })

  it('lets an explicit option replace the defaults', () => {
    expect(resolveAllowedOrigins(['http://only.example'], { SBH_ALLOWED_ORIGINS: 'http://x' })).toEqual([
      'http://only.example',
    ])
  })
})
