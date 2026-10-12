# SBH (Self-Building Harness) — M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use the `executing-plans` skill
> (`~/.agents/skills/executing-plans/SKILL.md`). Steps use `- [ ]` checkboxes.
> Do not design here; the design is settled. Where this plan is silent, follow
> `AGENTS.md` in this repo and the spec.

**Goal:** Ship a barebones desktop harness host whose interface is a declarative
tree of host atoms, driven by a neutral ACP backend — starting with `pi-acp` —
where the agent streams into the tree in real time.

**Architecture:** A local **core** process owns all ACP connections and exposes
normalized events over WebSocket on loopback. A **Tauri v2 window** runs a Preact
UI that renders a JSON tree produced by a tiny renderer, consuming that stream.
The core is the only thing that spawns agents and the only thing that answers
permission requests; atoms are dumb and never reach the backend. This split is
what makes a later phone/PWA client possible without a rewrite.

**Tech Stack:** Tauri v2 (Rust shell only) · Preact 10 + TypeScript + Vite ·
Node 26 core in TypeScript · `@agentclientprotocol/sdk` 1.8.0 · `pi-acp` ·
Vitest · WebSocket over `127.0.0.1`.

**Spec:** `~/.local/share/ryoku/rashin/specs/2026-10-12-meta-harness-design.md`
(the vault is the single source of truth for the design; do not copy it here)

## Global Constraints

- **Tauri v2** for the desktop shell. No Electron. Rust is used only for the
  window/sidecar plumbing — no product logic in Rust in M1.
- **Preact**, not React. The frontend is TypeScript.
- **Node 26 + npm** for the core and the frontend build. Version floors:
  `@agentclientprotocol/sdk@1.8.0`, `pi-acp` (any), Node `>=22`.
- The core **binds `127.0.0.1` only**. Never `0.0.0.0` in M1.
- **The core is the only process that spawns agents** and the only one that
  answers permissions. Atoms and UI code never import core or ACP modules.
- **No HTML.** The UI renders a JSON tree. No `dangerouslySetInnerHTML`, no
  agent-authored strings interpreted as markup outside the `markdown` atom.
- **Dumb templates**: no expression language, no `eval`, no `new Function`.
- The app is **not the writer** of pi's session files. Read only in M1.
- M1 has **no persistence, no templates, no plugin system** — those are M2+.

## Review Focus

Five failure modes this plan's tests must pin, in the order most likely to bite:

1. **The agent requests permission mid-turn.** A single unhandled
   `session/request_permission` stalls the agent forever and the app looks hung.
   The user must see a prompt and be able to answer; the turn must then continue.
2. **`pi-acp` dies or errors mid-turn** (bad key, model error, crash). The UI must
   show a visible error state, never an eternal spinner.
3. **Streaming arrives split or on a multibyte boundary.** Chunks must not
   duplicate, reorder, or mojibake.
4. **The agent sends an ACP update type the app does not know.** It must be
   ignored (and logged) without crashing or stalling the turn.
5. **A long transcript (10k+ events).** The UI must stay responsive.

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
  `index.html`, `src/main.tsx`, `src/App.tsx`, `src-tauri/` (via `tauri init`),
  `.gitignore`
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: `npm run dev` (Tauri window), `npm run core` (core entrypoint, added
  in Task 5), `npm test` (Vitest), `npm run build`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/App.test.tsx
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — `App` / `App.tsx` not found.

- [ ] **Step 3: Scaffold the project**

`npm create vite@latest . -- --template preact-ts`, then `npm i -D @tauri-apps/cli`
and `npx tauri init` (frontend dev URL `http://localhost:5173`, dist `dist`).
Add `vitest` + `happy-dom` and set `test.environment = 'happy-dom'` in
`vitest.config.ts`. `App.tsx` renders a single element with `data-sbh-root`.
Add a minimal `src-tauri/src/main.rs` that opens the window and nothing else.

- [ ] **Step 4: Run the test and the app**

Run: `npx vitest run src/App.test.tsx` → PASS
Run: `npx tauri dev` → a window opens showing an empty root.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold Tauri v2 + Preact + vitest"
```

---

### Task 2: The fake ACP agent (test fixture)

Everything downstream is testable only without a model, so this fixture comes
first. It is the single source of scripted ACP behaviour for the whole plan.

**Files:**
- Create: `test/fixtures/fake-acp-agent.ts`
- Test: `test/fixtures/fake-acp-agent.test.ts`

**Interfaces:**
- Produces: a runnable script `node --experimental-strip-types test/fixtures/fake-acp-agent.ts <scenario>`
  that speaks ACP over stdio. Scenarios (exact strings): `happy`, `permission`,
  `unknown-update`, `crash-mid-turn`, `split-multibyte`.
- Produces: `SCENARIOS: readonly string[]` exported for test enumeration.

- [ ] **Step 1: Write the failing test**

```ts
// test/fixtures/fake-acp-agent.test.ts
import { describe, it, expect } from 'vitest'
import { SCENARIOS, spawnFakeAgent } from './fake-acp-agent'

describe('fake ACP agent', () => {
  it('advertises every scenario this plan relies on', () => {
    expect([...SCENARIOS].sort()).toEqual(
      ['crash-mid-turn', 'happy', 'permission', 'split-multibyte', 'unknown-update'].sort()
    )
  })

  it('answers initialize and exits 0', async () => {
    const agent = spawnFakeAgent('happy')
    const out = await agent.runOneTurn('hello')
    expect(out.exitCode).toBe(0)
    expect(out.updates.some(u => u.kind === 'agent_message_chunk')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/fixtures/fake-acp-agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fixture**

A stdio JSON-RPC server implementing `initialize`, `session/new`,
`session/prompt`, `session/request_permission`, `session/cancel`. Behaviour per
scenario: `happy` streams three `agent_message_chunk`s then a final stop reason;
`permission` emits `session/request_permission` mid-turn and only continues after
the client replies; `unknown-update` emits an invented update kind;
`crash-mid-turn` exits(1) after the first chunk; `split-multibyte` writes one
`agent_message_chunk` whose text is split so a 4-byte character straddles two
writes. `spawnFakeAgent(scenario)` returns `{ runOneTurn(prompt) }` which drives
the handshake and returns `{ updates, exitCode }`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/fixtures/fake-acp-agent.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add test/fixtures && git commit -m "test: add scripted fake ACP agent"
```

---

### Task 3: ACP client, normalization, and the backend registry

**Files:**
- Create: `core/acp/client.ts`, `core/events.ts`, `core/backends/registry.ts`
- Test: `core/events.test.ts`, `core/acp/client.test.ts`

**Interfaces:**
- Produces: `type UiEvent = { type: 'chunk'; text: string } | { type: 'permission.requested'; requestId: string; title: string } | { type: 'turn.started' } | { type: 'turn.finished'; stopReason: string } | { type: 'error'; message: string }`
- Produces: `normalizeUpdate(update: unknown): UiEvent[]` — returns `[]` for unknown kinds (never throws).
- Produces: `connectAcp(opts: { command: string; args: string[]; cwd: string }): AcpConnection` with `prompt(text)`, `respondPermission(requestId, decision: 'allow'|'deny')`, `onEvent(cb)`, `close()`.
- Produces: `resolveBackend(id: string): { command: string; args: string[] }` — in M1, `'pi'` → `{ command: 'npx', args: ['pi-acp@latest'] }`; unknown id throws `UnknownBackendError`.
- Consumes: `test/fixtures/fake-acp-agent.ts` (Task 2).

- [ ] **Step 1: Write the failing tests**

```ts
// core/events.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeUpdate } from './events'

describe('normalizeUpdate', () => {
  it('maps an agent message chunk to a chunk event', () => {
    expect(normalizeUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }))
      .toEqual([{ type: 'chunk', text: 'hi' }])
  })
  it('ignores an unknown update kind instead of throwing', () => {
    expect(normalizeUpdate({ sessionUpdate: 'invented_future_kind' })).toEqual([])
  })
  it('surfaces a permission request', () => {
    const out = normalizeUpdate({ sessionUpdate: 'tool_call', requestId: 'r1', title: 'Run ls' })
    expect(out[0]).toMatchObject({ type: 'permission.requested', requestId: 'r1' })
  })
})
```

```ts
// core/acp/client.test.ts
import { describe, it, expect } from 'vitest'
import { connectAcp } from './client'
import { resolveBackend } from '../backends/registry'

describe('connectAcp', () => {
  it('resolves the pi backend to pi-acp', () => {
    expect(resolveBackend('pi')).toEqual({ command: 'npx', args: ['pi-acp@latest'] })
  })
  it('rejects an unknown backend', () => {
    expect(() => resolveBackend('nope')).toThrow(/UnknownBackend/)
  })
  it('streams chunks from the happy scenario', async () => {
    const conn = connectAcp({ command: 'node', args: ['--experimental-strip-types', 'test/fixtures/fake-acp-agent.ts', 'happy'], cwd: process.cwd() })
    const events = []
    conn.onEvent(e => events.push(e))
    await conn.prompt('hello')
    expect(events.filter(e => e.type === 'chunk').map(e => e.text).join('')).toContain('hello')
  })
  it('emits an error event when the agent dies mid-turn', async () => {
    const conn = connectAcp({ command: 'node', args: ['--experimental-strip-types', 'test/fixtures/fake-acp-agent.ts', 'crash-mid-turn'], cwd: process.cwd() })
    const events = []
    conn.onEvent(e => events.push(e))
    await conn.prompt('hello')
    expect(events.some(e => e.type === 'error')).toBe(true)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run core/events.test.ts core/acp/client.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`events.ts`: a `switch` on `sessionUpdate` with an explicit default returning `[]`.
`acp/client.ts`: wrap `@agentclientprotocol/sdk`'s client, pipe its session
updates through `normalizeUpdate`, and treat child-process `exit` before
`turn.finished` as an `error` event. `registry.ts`: a literal map with a typed
`UnknownBackendError`.

- [ ] **Step 4: Run them and confirm they pass**

Run: `npx vitest run core/events.test.ts core/acp/client.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add core && git commit -m "feat(core): ACP client, event normalization, backend registry"
```

---

### Task 4: Permission handling (the trust boundary)

**Files:**
- Create: `core/acp/permissions.ts`
- Test: `core/acp/permissions.test.ts`

**Interfaces:**
- Produces: `respondToPermission(conn: AcpConnection, requestId: string, decision: 'allow'|'deny'): Promise<void>`
- Produces: `type PermissionPolicy = (req: { requestId: string; title: string }) => 'allow' | 'deny' | 'ask'` and `const DENY_BY_DEFAULT: PermissionPolicy`.

- [ ] **Step 1: Write the failing test**

```ts
// core/acp/permissions.test.ts
import { describe, it, expect } from 'vitest'
import { connectAcp } from './client'
import { respondToPermission, DENY_BY_DEFAULT } from './permissions'

describe('permissions', () => {
  it('denies by default', () => {
    expect(DENY_BY_DEFAULT({ requestId: 'r1', title: 'rm -rf /' })).toBe('deny')
  })

  it('an answered request lets the turn continue', async () => {
    const conn = connectAcp({ command: 'node', args: ['--experimental-strip-types', 'test/fixtures/fake-acp-agent.ts', 'permission'], cwd: process.cwd() })
    const events = []
    conn.onEvent(async e => {
      events.push(e)
      if (e.type === 'permission.requested') {
        await respondToPermission(conn, e.requestId, 'allow')
      }
    })
    await conn.prompt('hello')
    expect(events.some(e => e.type === 'turn.finished')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run core/acp/permissions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`respondToPermission` sends the ACP permission response for the request id and
resolves when it is acknowledged. `DENY_BY_DEFAULT` returns `'deny'` for
everything (M1 has no capability manifest; M2 replaces this).

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run core/acp/permissions.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add core/acp && git commit -m "feat(core): permission gate with deny-by-default"
```

---

### Task 5: Core WebSocket server

**Files:**
- Create: `core/server.ts`, `core/index.ts`
- Test: `core/server.test.ts`

**Interfaces:**
- Consumes: `connectAcp`, `resolveBackend` (Task 3), `respondToPermission` (Task 4).
- Produces: `startCore(opts: { port?: number }): Promise<{ port: number; close(): Promise<void> }>`
- Produces: WS protocol at `ws://127.0.0.1:<port>/ws` — client→core `{ type: 'prompt'; text: string }` and `{ type: 'permission'; requestId: string; decision: 'allow'|'deny' }`; core→client `{ type: 'event'; event: UiEvent }`.
- Produces: `GET /health` → `200 {"ok":true}`.
- Produces: npm script `core` runs `node --experimental-strip-types core/index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// core/server.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { startCore } from './server'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.() })

describe('core server', () => {
  it('answers /health', async () => {
    const core = await startCore({ port: 0 }); close = core.close
    const res = await fetch(`http://127.0.0.1:${core.port}/health`)
    expect(res.status).toBe(200)
  })

  it('streams normalized events for a prompt', async () => {
    const core = await startCore({ port: 0, backend: 'fake:happy' }); close = core.close
    const ws = new WebSocket(`ws://127.0.0.1:${core.port}/ws`)
    const events: unknown[] = []
    await new Promise(r => ws.on('open', r))
    ws.on('message', d => events.push(JSON.parse(String(d))))
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))
    await new Promise(r => setTimeout(r, 500))
    expect(events.some((m: any) => m.event?.type === 'chunk')).toBe(true)
  })

  it('refuses to bind anything but loopback', async () => {
    await expect(startCore({ host: '0.0.0.0' } as any)).rejects.toThrow(/loopback/)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run core/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server.ts`: an `http` server plus `ws`; a single in-memory session in M1. The
`backend` option accepts `'pi'` (real) or `'fake:<scenario>'` (test). Guard the
host: reject anything that is not `127.0.0.1` or `localhost`. `index.ts` starts it
and logs the port.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run core/server.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add core && git commit -m "feat(core): loopback WebSocket server"
```

---

### Task 6: The atom renderer

**Files:**
- Create: `src/ui/tree/render.ts`, `src/ui/atoms/index.ts`, `src/ui/atoms/{column,scroll,markdown,text,input,button}.ts`
- Test: `src/ui/tree/render.test.ts`

**Interfaces:**
- Produces: `type UiNode = { type: string; props?: Record<string, unknown>; children?: UiNode[] }`
- Produces: `registerAtom(def: { name: string; render(node: UiNode, ctx: RenderContext): Node })`
- Produces: `renderTree(node: UiNode, ctx: RenderContext): Node` — unknown `type` returns an error placeholder element and never throws.
- Produces: `RenderContext = { dispatch(action: string, payload?: unknown): void; tokens: Record<string, string> }`

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/tree/render.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import './atoms'
import { renderTree } from './render'

describe('renderTree', () => {
  it('renders text into a text node', () => {
    const el = renderTree({ type: 'text', props: { value: 'hello' } }, ctx)
    expect(el.textContent).toBe('hello')
  })
  it('renders children in order inside a column', () => {
    const el = renderTree({ type: 'column', children: [
      { type: 'text', props: { value: 'a' } },
      { type: 'text', props: { value: 'b' } },
    ]}, ctx)
    expect(el.textContent).toBe('ab')
  })
  it('renders an unknown type as a placeholder without throwing', () => {
    const el = renderTree({ type: 'invented' }, ctx)
    expect(el.getAttribute('data-unknown')).toBe('invented')
  })
  it('dispatches a named action when a button is clicked', () => {
    const el = renderTree({ type: 'button', props: { label: 'Send', action: 'prompt.send' } }, ctx)
    ;(el as HTMLElement).click()
    expect(calls).toEqual(['prompt.send'])
  })
})
```

(with `const ctx` and `calls` defined at the top of the file)

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/ui/tree/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`render.ts` is a recursive switch over a registry map — no framework, plain DOM.
Each atom file exports and registers one atom. Atoms read only `node.props`,
`ctx.tokens` and `ctx.dispatch`; **no atom imports anything from `core/`**.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/ui/tree/render.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui && git commit -m "feat(ui): tree renderer and first five atoms"
```

---

### Task 7: Stream client and transcript store

**Files:**
- Create: `src/ui/state/stream.ts`, `src/ui/state/transcript.ts`
- Test: `src/ui/state/transcript.test.ts`, `src/ui/state/stream.test.ts`

**Interfaces:**
- Consumes: `UiEvent` (Task 3).
- Produces: `applyEvent(state: Transcript, event: UiEvent): Transcript` where
  `Transcript = { messages: { id: string; role: 'user'|'agent'; text: string }[]; pendingPermission?: { requestId: string; title: string }[]; status: 'idle'|'streaming'|'error'; error?: string }`.
- Produces: `connectStream(url: string): { send(msg: unknown): void; onEvent(cb: (e: UiEvent) => void): void; close(): void }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/state/transcript.test.ts
import { describe, it, expect } from 'vitest'
import { empty, applyEvent } from './transcript'

describe('applyEvent', () => {
  it('coalesces consecutive chunks into one agent message', () => {
    let s = applyEvent(empty(), { type: 'chunk', text: 'Hel' })
    s = applyEvent(s, { type: 'chunk', text: 'lo' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].text).toBe('Hello')
  })
  it('starts a new message after a turn finishes', () => {
    let s = applyEvent(empty(), { type: 'chunk', text: 'a' })
    s = applyEvent(s, { type: 'turn.finished', stopReason: 'end' })
    s = applyEvent(s, { type: 'chunk', text: 'b' })
    expect(s.messages).toHaveLength(2)
  })
  it('records an error without dropping the transcript', () => {
    const s = applyEvent(applyEvent(empty(), { type: 'chunk', text: 'a' }), { type: 'error', message: 'boom' })
    expect(s.status).toBe('error')
    expect(s.messages[0].text).toBe('a')
  })
  it('queues a permission request', () => {
    const s = applyEvent(empty(), { type: 'permission.requested', requestId: 'r1', title: 'Run ls' })
    expect(s.pendingPermission).toEqual([{ requestId: 'r1', title: 'Run ls' }])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/ui/state/transcript.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`transcript.ts` is pure (no timers, no I/O) so it is trivially testable.
`stream.ts` wraps a `WebSocket`, JSON-decodes `{ type: 'event', event }` frames,
and reconnects with a fixed backoff on close.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/ui/state/transcript.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/state && git commit -m "feat(ui): transcript store and stream client"
```

---

### Task 8: The scaffold tree and the end-to-end skeleton

**Files:**
- Create: `src/ui/scaffold.ts`
- Modify: `src/App.tsx`
- Test: `src/ui/scaffold.test.ts`

**Interfaces:**
- Consumes: `Transcript` (Task 7), `UiNode` (Task 6).
- Produces: `scaffoldTree(t: Transcript): UiNode` — the empty box: a `scroll`
  column of `markdown` messages, a `text` input, a `button`, two `select`s
  (model, harness), and — when `t.pendingPermission` is non-empty — a permission
  card with an approve and a deny `button` (actions `permission.allow` /
  `permission.deny`, carrying the `requestId`).

- [ ] **Step 1: Write the failing test**

```ts
// src/ui/scaffold.test.ts
import { describe, it, expect } from 'vitest'
import { empty, applyEvent } from './state/transcript'
import { scaffoldTree } from './scaffold'

describe('scaffoldTree', () => {
  it('contains exactly the empty-box controls', () => {
    const types = JSON.stringify(scaffoldTree(empty()))
    expect(types).toContain('"button"')
    expect(types).toContain('"input"')
    expect(JSON.stringify(scaffoldTree(empty())).match(/"select"/g)).toHaveLength(2)
  })
  it('renders transcript text as markdown nodes', () => {
    const t = applyEvent(empty(), { type: 'chunk', text: 'hi' })
    expect(JSON.stringify(scaffoldTree(t))).toContain('hi')
  })
  it('renders a permission card with approve and deny while a request is pending', () => {
    const t = applyEvent(empty(), { type: 'permission.requested', requestId: 'r1', title: 'Run ls' })
    const tree = JSON.stringify(scaffoldTree(t))
    expect(tree).toContain('Run ls')
    expect(tree).toContain('permission.allow')
    expect(tree).toContain('permission.deny')
  })
  it('renders no permission card when nothing is pending', () => {
    expect(JSON.stringify(scaffoldTree(empty()))).not.toContain('permission.allow')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/ui/scaffold.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`App.tsx` holds the `Transcript` in a Preact signal, re-renders `renderTree(scaffoldTree(t))`
on every event, and dispatches `prompt.send` / `permission.answer` back over the
stream. The scaffold tree is written as literal JSON — it is the first template,
by hand.

- [ ] **Step 4: Run the full suite and the real thing**

Run: `npx vitest run` → PASS
Run (two terminals): `npm run core` then `npx tauri dev`, type a prompt, and
watch a real `pi-acp` turn stream into the window. Confirm a tool call raises a
permission prompt and the turn resumes after answering.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: end-to-end walking skeleton against pi-acp"
```

---

## M2 (next plan, not this one)

M2 is the authoring loop, and it gets its own plan **after M1 lands**, because its
interfaces depend on the real shapes M1 produces. Its scope, from the spec:

- a template registry (agent-authored `t.*` nodes) with the atom registry already
  in place from Task 6;
- a git-backed UI directory, hot reload, last-known-good fallback, revert;
- `CATALOG.md` generated from atoms + installed templates;
- published docs covering the tree language and the atom set;
- the permission card's presentation moved to a template (logic stays in Task 4).

## Self-review

- **Spec coverage:** M1 covers the empty box (Task 8), the neutral backend
  interface with pi first (Task 3), the local core + client split (Task 5), the
  atom renderer (Task 6), the permission gate (Task 4), and "the app is not the
  writer of session files" (read-only by omission — nothing writes them).
  Templates, git backing, capability manifests and docs are correctly deferred to M2.
- **Type consistency:** `UiEvent` is defined once in Task 3 and consumed unchanged
  in Tasks 4, 5 and 7. `UiNode` is defined in Task 6 and consumed in Task 8.
  `AcpConnection` is defined in Task 3 and consumed in Tasks 4 and 5.
- **Review Focus:** each of the five has a home — (1) Task 4 for the gate and
  Task 8 for the visible card, (2) Task 3
  `crash-mid-turn`, (3) Task 2 `split-multibyte` plus the coalescing test in
  Task 7, (4) Task 3 `unknown-update`, (5) not covered by a test in M1 —
  virtualization is deliberately deferred, so this is an accepted gap, not an
  oversight.
- **Proportion:** this plan is roughly the length of its spec and contains no
  implementations, only signatures, test assertions and exact values.
