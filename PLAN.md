# Plan and decisions

The roadmap, and the decision records behind the shape of the thing. The design
narrative is in [`docs/design.md`](docs/design.md); current state is in
[`HANDOFF.md`](HANDOFF.md).

## Roadmap

**Done.**

- **M1 — walking skeleton.** A Tauri window, a local core spawning an agent over
  ACP, and a tree rendering the stream over loopback. Proved the risky half:
  ACP integration, streaming into a tree, loopback-only.
- **The authoring loop.** Agent-authored components, an agent-authored layout, a
  theme token system, hot reload with a cache-buster, git-backed versioning with a
  first-class revert, and safe mode for a broken component.
- **The permission gate, then the capability manifest.** The gate (the trust
  boundary) first; then the opt-in, root-owned manifest and the `sbh-policy`
  operator CLI.
- **Neutrality.** A second backend (goose) alongside pi, with the session list,
  model selection and resume all ACP-native.
- **Daily-driver pass.** Real harness/model pickers, resumable sessions, transcript
  windowing, a filterable sessions sidebar.
- **Packaging.** The core as a standalone binary; an Arch package that installs
  root-owned system files and a disabled manifest; a `.deb` for Debian-family.

**Next.**

- **Mobile client.** A second client of the same protocol. Needs a transport that
  reaches the core off-device, and pairing that cannot widen the capability
  boundary.
- **Published docs + `CATALOG.md`.** A generated component inventory so an agent can
  read what exists, and web-fetchable docs so a harness can bootstrap itself.
- **Capability switch UI.** An in-app read-only view of grants and the audit tail;
  edits stay with `sbh-policy`.
- **Position virtualization** for the transcript, a **shared settings store**, and
  **MCP Apps hosting**.

## Decisions

### A local core, separate from the client

Even on one machine the core is a separate process over loopback. The core is the
only thing that spawns an agent and the only thing that answers permission requests,
so a second client is just another WebSocket, and the trust boundary has exactly one
implementation. It also means the client can be anything — today Tauri, tomorrow a
browser or a phone.

### Tauri v2 and Preact

Tauri for a small binary and a real system webview without shipping a browser;
Preact because the tree is the interface, so the framework is cheap and swappable.
Rejected Electron (weight), Wails (experimental mobile), and Qt/QML (fails the
TypeScript-plugin criterion; no webview module in the shell at the time).

### Trusted agent-authored components, not declarative atoms

The original plan was a JSON tree of dumb atoms with `if`/`foreach` nodes and no
execution, sandboxed by construction. It was abandoned: real interaction — drag,
resize, canvas, a game — cannot be expressed without inventing an expression
language, and an expression language is a sandbox with worse ergonomics. The
premise is that the user already hands the agent a shell, so the components are
trusted code with full DOM access, loaded from disk and hot-reloaded.

Two things keep this honest. Model-authored *prose* is still rendered as data, never
as HTML. And the UI still holds no capability: it renders and dispatches, the core
decides. The one place a boundary is genuinely wanted — permissions — is handled
below.

### Layout and theme as files, versioned and hot-reloaded

The layout is a plain JSON tree with no binding language; anything dynamic is a host
component reading `ctx.host`. This keeps the layout static and the app live at the
same time, and it makes "add a panel" a file edit. Theme is a partial override of
design tokens, so one file restyles everything and independently-authored components
still look like one app. Both, and the components, live in a git repo the core
commits to, so every settled change is revertable.

### Sessions and resume are ACP-native

The sidebar lists sessions from the agent's own `session/list`, and resume uses
`session/load`. This is neutral across harnesses (it is the only store goose has)
and it respects the rule that the app is never the writer of a harness's session
files. pi's JSON store remains a fallback for an agent that cannot list.

### Trust by default; the capability manifest is opt-in

The UI is agent-authored, so an agent-authored permission card can lie or
self-approve. Rather than pretend otherwise, the default trusts it: the card
answers, and the host stays out of the way. A separate manifest, **off by default**,
moves control outside the model when the user wants it — the core judges before the
UI sees the request and the card cannot widen the answer.

The manifest is **root-owned**, because an agent runs as the user and could rewrite
a user-owned policy: a toggle the policed party enforces is not a toggle. Grants are
made with `sbh-policy`, which **SBH never elevates itself** — it is run under
whatever the operator uses. Everything fails closed: no rule denies, and `ask` is a
deny, because a click is code the agent wrote.

This is consent and blast-radius, not a sandbox; the limits are stated in the design
doc.

### The core ships as a standalone binary

The core is compiled with `bun build --compile`, so the target needs no Node
runtime. The shell resolves it from the resource directory and falls back to Node
plus the repo script only in development. The Arch package installs the whole thing
root-owned, which is also what gives the capability manifest its meaning.
