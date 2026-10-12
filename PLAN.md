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

## Status — M1 complete (2026-10-12)

All 8 tasks done. **54 tests / 12 files**, `npx tsc -b` clean, `npm run build`
→ 19.8 kB (7.8 kB gzip). Suite needs no network and no model.

Verified against reality, not only the suite:

- **Real `pi-acp`**: `initialize` + `session/new` clean, and one real model turn
  reached `stop: end_turn` with zero errors.
- **Real browser** (Chromium) against a live core: a typed prompt streamed back;
  the permission card appeared, and clicking **Allow** resumed the turn.

### Deviations from this plan

1. The Vite template emits lowercase `app.tsx` + a demo page → replaced; would
   have broken `./App` on a case-sensitive filesystem.
2. Added `tsconfig.core.json`; the template type-checked **no** core/test file.
3. The plan's Task 3 permission test was wrong (`sessionUpdate: 'tool_call'` is
   not a permission request — different channels). Corrected.
4. Hand-rolled the ACP client; the SDK is used for types only.
5. Vitest defaults to `node`; frontend tests opt into happy-dom by docblock.
6. Added a `select` atom (Task 6's list omitted it, Task 8 needed two).
7. `scaffoldTree` takes `{ draft }` so a re-render does not lose the input.
8. `shared/protocol.ts` added so the UI can speak the wire type without
   importing `core/`.

### Bugs the plan's own tests could not catch

Every one of these passed the suite and was found by running the real thing:

- the input lost everything after its first character (the tree rebuild replaced
  the focused element) — found in the browser;
- the fake agent was resolved from `process.cwd()`, so a core started elsewhere
  reported `agent exited with code 1` — found in the browser;
- `session/new` omitted `mcpServers`, which the schema **requires** — rejected by
  real `pi-acp` as `Invalid params`; the fixture now enforces required fields;
- the handshake promise was floating, so that error became an unhandled
  rejection that killed the core process.

### Known gaps

- **Transcript virtualization (Review Focus 5) is still untested** — deliberately
  deferred; a long transcript is not yet known to be responsive.
- The renderer rebuilds the whole tree on every change; focus/caret is restored by
  hand (`src/ui/tree/focus.ts`). A diffing renderer is M2 work.
- `pi-acp` streams pi's startup banner (`pi v1.1.0`, `## Context`, `## Skills`) as
  message chunks, so the transcript opens with it. Adapter behaviour, not ours.
- Nothing from M2 exists: templates, hot reload, git backing, `CATALOG.md`, docs.

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

### Screenshot pass (2026-10-12, after M1)

Driving the real UI and *looking at it* found three more defects that the 49-test
suite and every DOM assertion had passed:

- **the layout was inverted** — the transcript pane collapsed to zero height
  (`#app > [data-sbh-root]` had auto height, so the tree's `grow` had nothing to
  grow into), leaving the composer at the top over dead space. Caught by
  measuring `scroll.getBoundingClientRect().height === 0`, then confirmed in a
  screenshot.
- **the markdown atom was a plain-text stub** while the scaffold emitted markdown,
  so `**you:**` rendered with literal asterisks. Replaced with a subset renderer
  (`src/ui/tree/markdown.ts`) that builds DOM nodes and never uses `innerHTML` —
  the same trust model as the rest of the tree, with a test asserting `<script>`
  and `onerror=` stay inert.
- **fast typing dropped characters** — a keystroke landing while the tree rebuilt
  was lost (`deete the production databasel` at 12 ms/char). The live DOM input
  value now wins over a stale render, and `send` reads the DOM rather than
  possibly-lagging React state. Verified exact at 5 ms/char.

Suite is now **62 tests / 13 files**. The `row` atom was added (it is in the
spec's v0 set and the composer needed it).

The lesson, again: a DOM assertion checks that an element exists, not that the
thing looks right. Four of the seven bugs found in this build were only visible by
rendering it.

## Pivot: trusted agent-authored components (2026-10-12)

ran approved code execution for UI, on the reasoning that anyone running their own
harness is already on YOLO. Accepted, with one thing kept native: **the permission
gate**, because a trusted component could otherwise draw its own approval prompt —
defeating the "control sits outside the model" rule.

What this changed:

- **Renderer reconciliation** (was the prerequisite, now done): mount once, patch in
  place. A component is `{create, update?, container?}`. This deleted the hand-rolled
  `focus.ts` hack — focus, caret and scroll now survive because the element does.
- **Component loading**: the core serves `~/.config/sbh/components/*.js` over
  loopback (a webview cannot `import()` from disk); the UI registers them through
  the same registry as the built-ins, so a loaded component **overrides** a built-in.
- **Safe mode**: a module that fails to fetch, import or match the contract is named
  on screen and skipped; the built-ins always keep working.

What this cancelled: the M4 atom-library plan and the "dumb templates +
if/foreach/slot" control-flow atoms. Code provides composition and control flow, so
~1× M1 of anticipated work evaporates.

Bugs found by doing it for real, not by the suite:
- reconciliation keyed on `node.type` alone, so overriding a component under the
  same name called the *new* implementation's `update` on an element the *old* one
  created — a hybrid element (new label, old styling). Elements are now tagged with
  the component identity.
- a loaded module had no way to install a listener reading the current node, since
  it cannot import registry internals. Added `ctx.bind` / `ctx.latest`.
- the server test's 3s wait was flaky under parallel load.

## Authoring loop complete (2026-10-12)

Steps 1–3 done, all verified in Chromium with real files on disk and no page reloads:

1. **Theme tokens** — `shared/theme.ts` → `--sbh-*` custom properties on the document
   root; a partial `~/.config/sbh/theme.json` restyles the whole app. The built-in
   controls style themselves only from tokens.
2. **Hot reload** — the core debounces `fs.watch` and pushes `invalidate`; the client
   re-fetches. Deleted components unregister.
3. **Versioning + undo** — the config dir is a git repo; every settled change is
   committed; a failed load offers "Revert last change".

Remaining: Tauri spawning the core (needs a real window), session list/resume, real
backend switching, published docs, and the deferred items (virtualization, mobile,
MCP Apps).

## Interactivity: the missing API surface (planned 2026-10-12)

The acceptance criteria, in ran's words: *"resize this"*, *"make this draggable"*,
*"add a setting for this"*, *"build me a tiny idle game while waiting for responses"*.

None of these are CSS. CSS styles the consequence of interaction (`:hover`,
transitions, `resize:` handles); it has no events, no state and no drag. What enables
them is that components are trusted code with real DOM access — but three pieces of
supporting API are missing.

| # | Addition | Unblocks | Size |
|---|---|---|---|
| 0 | **Capability probe** — drive all four scenarios in the browser, record how each fails today | replaces assertion with evidence before building | small |
| 1 | **`destroy` lifecycle hook** — `create`/`update`/`destroy` | the idle game: a `setInterval`/`rAF` loop or window listener currently has nowhere to clean up, and reconciliation replaces elements routinely, so timers leak against detached nodes | small |
| 2 | **Agent-authorable layout** — `~/.config/sbh/layout.json`, written once with the scaffold as the default, served by the core, hot-reloaded like `theme.json` | *"resize this"*, *"add a setting"*, *"add a panel"*. Today `scaffoldTree()` is hardcoded: the agent can write components but **cannot change what is in the tree or where it sits**, so there is nowhere to put anything. This is the addition that makes "the agent authors its own interface" literally true. | medium |
| 3 | **Namespaced state store** — `ctx.state('panel')`, persisted through the core into the config dir | *"add a setting for this"*. Component-local state already survives reconciliation; shared state and persistence do not exist. | small |

**Order: 0 → 1 → 2 → 3, then replay the four scenarios as the acceptance pass.**

Rationale for the order, and for why not "test first": the four scenarios cannot be
written as failing tests before the API exists — there is no way to express "add a
setting" when no settings API exists, so a red suite would be theatre. What *is*
worth doing first is the probe (#0): cheap, and this project's record is that
rendering it found five bugs the 90-test suite did not. Then build the three. The
scenarios are the verdict at the end, not a gate at the start.

**The idle game is the hardest case and the best final acceptance test** — a loop, a
`destroy`, state, and a placement in the agent-authored layout, all at once. If that
works, the other three are already covered.

Safety is already in place: a broken layout fails exactly like a broken component —
named on screen, skipped, with **Revert last change** available.

### Probe results (2026-10-12) — ran before building

A throwaway component exercising all four asks, mounted by temporarily patching the
scaffold. Verdict: **every component-level capability already works.** The blockers
are structural, not capability.

| Ask | Today | Verdict |
|---|---|---|
| "resize this" (leaf) | `resize: both` — computed style confirmed | works |
| "make this draggable" | real pointer drag moved it `translate(50px,30px)` | works |
| "add a setting" | persisted to `localStorage`, survived | works, unsound |
| "build a tiny idle game" | `rAF` loop, 43 frames in 700ms | works, **leaks** |
| place a component anywhere | **impossible** — needed a temporary patch to `scaffoldTree` | blocked (#2) |
| resize a *pane* | same | blocked (#2) |

**The leak, demonstrated:** hot-reloading the component replaced the element, and the
old `rAF` loop kept ticking at full rate against a detached node — 2 loops still
running after one edit (`framesEach: [49, 49]`). Every hot reload leaks one immortal
loop; twenty edits, twenty loops. A `destroy` hook is not hygiene here, it is
required.

**The probe also paid for itself:** it exposed that hot reload only worked for *new*
components. The browser caches ES modules by URL for the page's lifetime and ignores
`cache-control`, so re-importing the same URL returned the stale module and editing
an existing component did nothing. Module URLs now carry `?rev=<timestamp>`. The
earlier verification missed it because it only ever *added* files.

### Revised order

1. **`destroy` hook** — confirmed necessary (leak above), small.
2. **Agent-authorable layout** — confirmed necessary (could not place the probe), and
   the addition that makes "the agent authors its own interface" literally true.
3. **State store** — **downgraded**: `localStorage` means "add a setting" already
   functions. It is a quality improvement (shared between components, visible to the
   agent, tracked by the undo), not a blocker. Do it after the first two.

Then replay the four asks as the acceptance pass, with the idle game as the hardest
case.

### #1 and #2 done (2026-10-12)

**`destroy` hook** (`create`/`update`/`destroy`/`container`): `destroyTree` walks the
subtree deepest-first, isolating a cleanup that throws. Proven with a real hot
reload — a probe holding a rAF loop leaked one immortal loop per edit (2 ticking
after one edit, measured); with `destroy` cancelling it, the same edit leaves 1.

**Agent-authorable layout**: `~/.config/sbh/layout.json`, served at `GET /layout`,
hot-reloaded, committed, revertable. `scaffoldTree` is deleted; the dynamic pieces
became host components reading `ctx.host` — which is the binding model, and keeps
the layout as plain static JSON with no expression language.

Found while doing it:
- **`update` was never called after `create`**, so a component that paints in
  `update` — the obvious way — rendered blank on first mount. Mount is now
  create + update.
- the config-dir watcher swept a simultaneous layout+component write into one
  commit; harmless, but it means commit subjects are indicative, not exact.

Verified: wrote `banner.js` and placed it in the layout with the pickers moved
below the composer; both landed on the live page with no reload.

**#3 (state store) is still open and now less pressing** — `localStorage` covers the
simple case; the store is for sharing state between components and making it
agent-visible and revertable.
