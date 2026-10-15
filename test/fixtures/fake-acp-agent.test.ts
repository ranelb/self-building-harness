import { describe, it, expect } from 'vitest'
import { SCENARIOS, spawnFakeAgent } from './fake-acp-agent.ts'

describe('fake ACP agent', () => {
  it('advertises every scenario this plan relies on', () => {
    expect([...SCENARIOS].sort()).toEqual(
      ['cancel', 'crash-mid-turn', 'happy', 'permission', 'split-multibyte', 'unknown-update', 'usage'].sort()
    )
  })

  it('answers initialize and exits 0', async () => {
    const agent = spawnFakeAgent('happy')
    const out = await agent.runOneTurn('hello')
    expect(out.exitCode).toBe(0)
    expect(out.updates.some(u => u.kind === 'agent_message_chunk')).toBe(true)
  })
})
