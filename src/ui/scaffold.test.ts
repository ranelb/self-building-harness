import { describe, it, expect } from 'vitest'
import { applyEvent, empty } from './state/transcript.ts'
import { scaffoldTree } from './scaffold.ts'

describe('scaffoldTree', () => {
  it('contains exactly the empty-box controls', () => {
    const json = JSON.stringify(scaffoldTree(empty()))
    expect(json).toContain('"button"')
    expect(json).toContain('"input"')
    expect(json.match(/"select"/g)).toHaveLength(2)
  })

  it('renders transcript text as markdown nodes', () => {
    const transcript = applyEvent(empty(), { type: 'chunk', text: 'hi' })
    expect(JSON.stringify(scaffoldTree(transcript))).toContain('hi')
  })

  it('renders a permission card with approve and deny while a request is pending', () => {
    const transcript = applyEvent(empty(), {
      type: 'permission.requested',
      requestId: 'r1',
      title: 'Run ls',
    })
    const json = JSON.stringify(scaffoldTree(transcript))
    expect(json).toContain('Run ls')
    expect(json).toContain('permission.allow')
    expect(json).toContain('permission.deny')
  })

  it('renders no permission card when nothing is pending', () => {
    expect(JSON.stringify(scaffoldTree(empty()))).not.toContain('permission.allow')
  })

  it('surfaces an error state', () => {
    const transcript = applyEvent(empty(), { type: 'error', message: 'agent exited with code 1' })
    expect(JSON.stringify(scaffoldTree(transcript))).toContain('agent exited with code 1')
  })

  it('carries the draft into the input so a re-render does not lose it', () => {
    const tree = scaffoldTree(empty(), { draft: 'half typed' })
    expect(JSON.stringify(tree)).toContain('half typed')
  })
})
