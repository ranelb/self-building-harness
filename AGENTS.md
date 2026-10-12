# SBH — agent instructions

Self-Building Harness: a barebones harness host whose interface is a declarative
tree of host atoms, driven by agent backends over ACP. The agent authors the UI;
the host owns the plumbing and the trust boundary.

**The design is settled and lives in the vault:**
`~/.local/share/ryoku/rashin/specs/2026-10-12-meta-harness-design.md`. Read it
before proposing a design change. Do not copy it into this repo — one source of
truth, N consumers.

**Implementing M1:** read `PLAN.md` and work the tasks in order with the
`executing-plans` skill.

## Invariants

Break one of these and you have broken the point of the project:

- **No HTML.** The UI is a JSON tree of atoms. Agent-authored strings are data,
  never markup, except inside the `markdown` atom.
- **Atoms are dumb.** An atom reads `node.props`, `ctx.tokens` and
  `ctx.dispatch`, and imports nothing from `core/`. All capability lives in the
  host, in one auditable place.
- **The core is the only spawner** of agent processes, and the only thing that
  answers permission requests.
- **Loopback only.** The core binds `127.0.0.1`; the agent channel has a shell
  behind it.
- **No expression language.** Templates are data with `if`/`foreach` control-flow
  atoms. No `eval`, no `new Function`.
- **Not the writer.** The app reads a harness's native session store; it never
  writes it.

## Layout

- `core/` — the local process: ACP connections, normalization, permissions, the
  loopback WebSocket server. The only place that spawns agents.
- `shared/protocol.ts` — the wire contract (`UiEvent`, `ClientToCore`). Lives
  here so the UI speaks the protocol **without importing `core/`**.
- `src/ui/tree/` — the tree renderer, the atom registry, focus preservation.
- `src/ui/atoms/` — one atom per file, each self-registering.
- `src/ui/state/` — the stream client and the pure transcript reducer.
- `src/ui/scaffold.ts` — the empty box as literal tree data. The first template;
  copy it when authoring your own chrome.
- `test/fixtures/` — the scripted fake ACP agent. Every core test runs against it,
  so the suite never calls a model.
- `test/integration.test.ts` — core → WebSocket → stream → reducer, with no mocks.

## Conventions

- **Explicit `.ts`/`.tsx` in import specifiers, everywhere.** Node's ESM resolver
  requires them even under type stripping, so `core/` and `test/` would break at
  runtime without them. One rule, no exceptions.
- Type checking is split across `tsconfig.app.json` (`src`, DOM), 
  `tsconfig.core.json` (`core`, `test`, `shared`, strict, no DOM) and
  `tsconfig.node.json` (configs). `npx tsc -b` runs all three; `npm run build`
  depends on it. The Vite template type-checked **none** of `core/` or `test/`.
- Vitest defaults to the `node` environment. Frontend tests opt into a DOM with a
  `// @vitest-environment happy-dom` docblock. (happy-dom's `fetch` enforces
  same-origin and would block core tests from reaching their own server.)

## Testing

`npm test` must stay green with no network and no model. New behaviour on the core
path gets a fake-agent scenario, not a mocked function.

## Verifying in a real browser

**Do not trust the unit suite alone for UI changes.** The input-focus and
fixture-path bugs both passed 49 unit tests and were only visible in a browser.

```bash
systemd-run --user --unit=sbh-core --collect \
  --working-directory=/home/ran/Projects/code/SBH \
  --setenv=SBH_BACKEND=fake:happy --setenv=SBH_PORT=45999 \
  /usr/bin/node --experimental-strip-types \
  /home/ran/Projects/code/SBH/core/index.ts

systemd-run --user --unit=sbh-vite --collect \
  --working-directory=/home/ran/Projects/code/SBH \
  --setenv=VITE_CORE_URL=ws://127.0.0.1:45999/ws \
  --setenv=PATH=/home/ran/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /usr/bin/npx vite --port 5199 --strictPort --host 127.0.0.1
```

Then load `http://127.0.0.1:5199/`, type, press Send, and confirm the transcript
and the permission card. `SBH_BACKEND=fake:permission` exercises the gate.
`systemctl --user stop sbh-core sbh-vite` when done.

A plain `&` background process dies with the invoking shell — hence the systemd
units. For the Tauri window: `npx tauri dev` (first `cargo` build is ~45 s).
