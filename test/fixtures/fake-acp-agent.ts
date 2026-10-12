/**
 * A scripted ACP agent over stdio, for tests.
 *
 * Deliberately hand-rolled JSON-RPC rather than built on the SDK's typed
 * `agent()` builder: the `unknown-update`, `crash-mid-turn` and
 * `split-multibyte` scenarios need to emit messages a typed builder refuses to
 * produce.
 *
 * Run directly:   node test/fixtures/fake-acp-agent.ts <scenario>
 * Use in tests:   spawnFakeAgent('happy').runOneTurn('hello')
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SCENARIOS = [
  'happy',
  'permission',
  'unknown-update',
  'usage',
  'crash-mid-turn',
  'split-multibyte',
] as const

export type Scenario = (typeof SCENARIOS)[number]

export const SESSION_ID = 'fake-session-1'
export const PROTOCOL_VERSION = 1

const SELF = fileURLToPath(import.meta.url)

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const textOf = (params: { prompt?: { type: string; text?: string }[] } | undefined): string =>
  (params?.prompt ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')

// ---------------------------------------------------------------------------
// Server side (runs only when this file is the entrypoint)
// ---------------------------------------------------------------------------

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function chunkUpdate(text: string, messageId = 'm1') {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId }
}

async function runScenario(
  scenario: Scenario,
  prompt: string,
  sendRequest: (method: string, params: unknown) => Promise<any>
): Promise<void> {
  const notify = (update: unknown) =>
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update } })
  const chunk = (text: string) => notify(chunkUpdate(text))

  switch (scenario) {
    case 'happy':
      // Three chunks that echo the prompt, so a client can prove it coalesces.
      chunk('echo ')
      chunk(prompt)
      chunk(' (fake)')
      return

    case 'permission': {
      chunk('before ')
      const reply = await sendRequest('session/request_permission', {
        sessionId: SESSION_ID,
        toolCall: { toolCallId: 'tc1', title: 'Run ls', kind: 'execute' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      })
      const outcome = reply?.result?.outcome
      const allowed = outcome?.outcome === 'selected' && outcome?.optionId === 'allow'
      chunk(allowed ? 'after' : 'denied')
      return
    }

    case 'usage':
      // The context meter's data source, so it is testable without a model.
      notify({ sessionUpdate: 'usage_update', used: 12_345, size: 100_000, cost: { amount: 0.02, currency: 'USD' } })
      chunk('counted')
      return

    case 'unknown-update':
      notify({ sessionUpdate: 'invented_future_kind', payload: 1 })
      chunk('known')
      return

    case 'crash-mid-turn':
      chunk('partial')
      await delay(10)
      process.exit(1)

    case 'split-multibyte': {
      // Emit an update whose text contains an astral character, then write the
      // line's bytes split *inside* that character on purpose.
      const update = chunkUpdate('a\u{1F389}b')
      const line =
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: SESSION_ID, update },
        }) + '\n'
      const buf = Buffer.from(line, 'utf8')
      const at = buf.indexOf(Buffer.from('\u{1F389}', 'utf8'))
      process.stdout.write(buf.subarray(0, at + 2))
      await delay(15)
      process.stdout.write(buf.subarray(at + 2))
      await delay(15)
      return
    }
  }
}

async function serve(scenario: Scenario): Promise<void> {
  let nextId = 100
  const pending = new Map<number, (msg: any) => void>()

  const sendRequest = (method: string, params: unknown): Promise<any> => {
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      write({ jsonrpc: '2.0', id, method, params })
    })
  }

  const handle = async (msg: any): Promise<void> => {
    // A response to one of our own requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve?.(msg)
      return
    }

    switch (msg.method) {
      case 'initialize':
        write({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
            agentCapabilities: {},
            agentInfo: { name: 'fake-acp-agent', version: '0.0.0' },
          },
        })
        return

      case 'session/new': {
        // Enforce the schema's required fields rather than accepting anything: a
        // fixture that says yes to everything cannot catch client drift, and
        // real agents answer "Invalid params".
        const params = msg.params ?? {}
        if (typeof params.cwd !== 'string' || !Array.isArray(params.mcpServers)) {
          write({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params' } })
          return
        }
        write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION_ID } })
        return
      }

      case 'session/prompt':
        await runScenario(scenario, textOf(msg.params), sendRequest)
        if (msg.id !== undefined) {
          write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
        }
        return

      case 'session/cancel':
        return
    }
  }

  // Byte-safe line splitting: never decode a chunk that may end mid-character.
  let buf = Buffer.alloc(0)
  process.stdin.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    let i: number
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, i).toString('utf8').replace(/\r$/, '')
      buf = buf.subarray(i + 1)
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      void handle(msg)
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

// ---------------------------------------------------------------------------
// Test side
// ---------------------------------------------------------------------------

export interface FakeAgentTurn {
  updates: { kind: string; [k: string]: unknown }[]
  exitCode: number | null
  stderr: string
}

export function spawnFakeAgent(
  scenario: Scenario,
  opts: { cwd?: string } = {}
): { runOneTurn(prompt: string): Promise<FakeAgentTurn> } {
  const cwd = opts.cwd ?? process.cwd()

  return {
    async runOneTurn(prompt: string): Promise<FakeAgentTurn> {
      const child = spawn(process.execPath, [SELF, scenario], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const updates: FakeAgentTurn['updates'] = []
      const stderr: string[] = []
      const pending = new Map<number, (m: any) => void>()
      let nextId = 1
      let buf = Buffer.alloc(0)

      const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + '\n')
      const request = (method: string, params: unknown): Promise<any> =>
        new Promise((resolve) => {
          const id = nextId++
          pending.set(id, resolve)
          send({ jsonrpc: '2.0', id, method, params })
        })

      child.stderr.on('data', (d: Buffer) => stderr.push(d.toString('utf8')))
      child.stdout.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        let i: number
        while ((i = buf.indexOf(0x0a)) >= 0) {
          const line = buf.subarray(0, i).toString('utf8').replace(/\r$/, '')
          buf = buf.subarray(i + 1)
          if (!line.trim()) continue
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }

          if (msg.method === 'session/update') {
            updates.push({ kind: msg.params.update.sessionUpdate, ...msg.params.update })
          } else if (msg.method === 'session/request_permission') {
            // Auto-allow so scenarios that need a permission round-trip complete.
            send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { outcome: { outcome: 'selected', optionId: 'allow' } },
            })
          } else if (msg.id !== undefined && msg.method === undefined) {
            const resolve = pending.get(msg.id)
            pending.delete(msg.id)
            resolve?.(msg)
          }
        }
      })

      const exited = new Promise<number | null>((resolve) =>
        child.on('exit', (code) => resolve(code))
      )

      await request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const created = await request('session/new', { cwd, mcpServers: [] })

      const turn = request('session/prompt', {
        sessionId: created?.result?.sessionId ?? SESSION_ID,
        prompt: [{ type: 'text', text: prompt }],
      })

      await Promise.race([turn.catch(() => null), exited])
      child.stdin.end()
      const exitCode = await Promise.race([exited, delay(2000).then(() => null)])

      return { updates, exitCode, stderr: stderr.join('') }
    },
  }
}

// ---------------------------------------------------------------------------

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isEntrypoint) {
  const scenario = process.argv[2] as Scenario
  if (!SCENARIOS.includes(scenario)) {
    process.stderr.write(`unknown scenario: ${scenario}\n`)
    process.exit(2)
  }
  void serve(scenario)
}
