// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown.ts'

const html = (source: string) => {
  const host = document.createElement('div')
  host.appendChild(renderMarkdown(source))
  return host
}

describe('renderMarkdown', () => {
  it('renders bold, italic and inline code', () => {
    const host = html('a **b** *c* `d`')
    expect(host.querySelector('strong')?.textContent).toBe('b')
    expect(host.querySelector('em')?.textContent).toBe('c')
    expect(host.querySelector('code')?.textContent).toBe('d')
    expect(host.textContent).toBe('a b c d')
  })

  it('renders the scaffold user prefix as bold, not literal asterisks', () => {
    const host = html('**you:** hello')
    expect(host.textContent).toBe('you: hello')
    expect(host.textContent).not.toContain('*')
  })

  it('renders a fenced code block as pre > code', () => {
    const host = html('before\n```\nconst x = 1\n```\nafter')
    expect(host.querySelector('pre > code')?.textContent).toBe('const x = 1')
  })

  it('renders headings and lists', () => {
    const host = html('## Title\n- one\n- two')
    expect(host.querySelector('h2')?.textContent).toBe('Title')
    expect(host.querySelectorAll('li')).toHaveLength(2)
  })

  it('leaves markup inert — no HTML injection', () => {
    const host = html('<script>window.pwned = 1</script> & <img src=x onerror=alert(1)>')
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('<script>')
    expect((globalThis as any).pwned).toBeUndefined()
  })

  it('builds DOM nodes rather than parsing innerHTML', () => {
    const host = html('**bold**')
    // An innerHTML implementation would also pass the text assertions; this pins
    // the construction path.
    expect(host.firstElementChild?.firstElementChild?.tagName).toBe('STRONG')
  })
})
