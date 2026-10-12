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
  loopback WebSocket server.
- `src/ui/tree/` — the tree renderer and the atom registry.
- `src/ui/atoms/` — one atom per file, each self-registering.
- `src/ui/state/` — the stream client and the pure transcript reducer.
- `test/fixtures/` — the scripted fake ACP agent. Every core test runs against it,
  so the suite never calls a model.

## Testing

`npm test` must stay green with no network and no model. New behaviour on the core
path gets a fake-agent scenario, not a mocked function.
