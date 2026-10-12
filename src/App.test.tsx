// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from 'preact'
import { App } from './App'

describe('App', () => {
  it('mounts a root element', () => {
    const host = document.createElement('div')
    // A dead port keeps the test offline; unmounting closes the stream so the
    // reconnect timer cannot outlive the test.
    render(<App coreUrl="ws://127.0.0.1:9/ws" />, host)
    expect(host.querySelector('[data-sbh-root]')).not.toBeNull()
    render(null, host)
  })
})
