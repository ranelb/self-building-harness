// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render } from 'preact'
import { App } from './App'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('App', () => {
  it('mounts a root element', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    // A dead port keeps the test offline; unmounting closes the stream so the
    // reconnect timer cannot outlive the test.
    render(<App coreUrl="ws://127.0.0.1:9/ws" />, host)
    await tick()
    expect(host.querySelector('[data-sbh-root]')).not.toBeNull()
    render(null, host)
    host.remove()
  })

  // The input's focus/caret across a rebuild is unit-tested in
  // `src/ui/tree/focus.test.ts`: Preact's effect timing under happy-dom does not
  // reproduce the browser bug, so an assertion here would pass either way.
})
