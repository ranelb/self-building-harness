import { describe, it, expect } from 'vitest'
import { loadComponents } from './load.ts'
import { registeredComponents } from '../tree/render.ts'

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

const fakeComponent = (name: string) => ({
  name,
  create: () => {
    const el = document.createElement('div')
    el.setAttribute('data-atom', name)
    return el
  },
})

describe('loadComponents', () => {
  it('registers every module the core lists', async () => {
    const report = await loadComponents({
      baseUrl: 'http://core',
      fetchImpl: async () => jsonResponse({ components: ['alpha', 'beta'] }),
      importImpl: async (url) => ({ component: fakeComponent(url.split('/').pop()!.replace('.js', '')) }),
    })

    expect(report.loaded.sort()).toEqual(['alpha', 'beta'])
    expect(report.failed).toEqual([])
    expect(registeredComponents()).toContain('alpha')
  })

  it('accepts a default export as well as a named one', async () => {
    const report = await loadComponents({
      baseUrl: 'http://core',
      fetchImpl: async () => jsonResponse({ components: ['viaDefault'] }),
      importImpl: async () => ({ default: fakeComponent('viaDefault') }),
    })
    expect(report.loaded).toEqual(['viaDefault'])
  })

  it('skips a module that is not a component and keeps the rest', async () => {
    const report = await loadComponents({
      baseUrl: 'http://core',
      fetchImpl: async () => jsonResponse({ components: ['bad', 'good'] }),
      importImpl: async (url) =>
        url.includes('bad') ? { component: { name: 'bad' } } : { component: fakeComponent('good') },
    })

    expect(report.loaded).toEqual(['good'])
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.name).toBe('bad')
  })

  it('survives a module that throws at import time', async () => {
    const report = await loadComponents({
      baseUrl: 'http://core',
      fetchImpl: async () => jsonResponse({ components: ['exploding'] }),
      importImpl: async () => {
        throw new Error('SyntaxError: unexpected token')
      },
    })

    expect(report.loaded).toEqual([])
    expect(report.failed[0]).toEqual({ name: 'exploding', error: 'SyntaxError: unexpected token' })
  })

  it('reports a missing index rather than throwing — safe mode', async () => {
    const report = await loadComponents({
      baseUrl: 'http://core',
      fetchImpl: async () => {
        throw new Error('connection refused')
      },
    })

    expect(report.loaded).toEqual([])
    expect(report.failed[0]).toEqual({ name: '(index)', error: 'connection refused' })
  })

  it('ignores a malformed index body', async () => {
    const report = await loadComponents({
      baseUrl: 'http://core',
      fetchImpl: async () => jsonResponse({ components: 'not-an-array' }),
      importImpl: async () => ({}),
    })
    expect(report).toEqual({ loaded: [], failed: [] })
  })
})
