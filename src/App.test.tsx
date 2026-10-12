import { describe, it, expect } from 'vitest'
import { render } from 'preact'
import { App } from './App'

describe('App', () => {
  it('mounts a root element', () => {
    const host = document.createElement('div')
    render(<App />, host)
    expect(host.querySelector('[data-sbh-root]')).not.toBeNull()
  })
})
