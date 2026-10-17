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

- **Mobile: pairing.** The client, the surfaces and the companion server ship; the
  transport reaches the core (front it with TLS) and a phone must not be able to
  widen the capability boundary. What is missing is **auth** — the phone server has
  none and relies on the network for access control.
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

### Surfaces: one core, a profile per client

A phone is not a narrow desktop. A layout authored for a wide screen is wrong on a
phone however the components adapt, and asking an agent to author one tree that is
good on both asks it to fail at both. So the interface is selected per client: the
base config directory is the default surface, and `profiles/<name>/` overrides its
layout, theme and components. The client declares its surface (`client.hello`), the
core layers base ← profile and serves it, and hot-reload is scoped so editing the
phone layout does not churn the desktop.

This generalizes the thesis rather than adding a special case: the agent authors an
interface **per surface**. A phone surface can be authored by the agent or pinned to
something hand-tuned; the mechanism is the same either way.

### The phone is a companion server, not a second core

A phone cannot reach a loopback core and the core cannot serve the app's static
bundle, so a small **companion server** does both: it serves the built client and
reverse-proxies the core's HTTP and WebSocket to it. The core stays loopback, the
invariant holds, and the phone is just another client with the `phone` surface.

It binds loopback and names no transport — front it with TLS (`tailscale serve`)
so the phone gets a secure context. It has no endpoints beyond static files and
the proxy, which is what keeps a trusted phone from meaning a phone that can widen
the capability boundary. (And the alternative — putting the core itself on the
tailnet — would expose the process that spawns agents and answers permissions, and
still wouldn't serve the client bundle.)

### The transcript is an ordered timeline, and the core carries the rest

The transcript is a list of ordered items (user, agent, thought, tool), not a flat
message list, so reasoning and tool calls sit where they happened. The core forwards
`tool_call_update` (with `kind`, `locations`, diffs) instead of dropping it, which is
what makes a changed-files panel possible. Edit is honest about the protocol: ACP has
no fork point and pi does not implement `session/fork`, so on pi an edit prefills the
composer and dims the superseded turn; the fork path exists for a backend that offers
one. Attachments travel as bytes and are persisted by the core, which maps them to an
image block, embedded text, or a file link — the frontend names no transport.

## Project file panel (core read path)

Decisions recorded for the project file panel (see
`docs/superpowers/specs/2026-10-17-project-file-panel-design.md`):

- **Git status rides on `/files/tree`.** The tree response carries per-entry git
  state, so the panel needs one request per directory, not a second status call.
- **Absolute paths are refused (400).** `path` is always relative to a known root;
  an absolute path is a malformed request, not a lookup to resolve.
- **Escaping symlinks are listed as `outside: true` but refused.** The entry is
  visible so the user sees it exists, but reading through it returns 403 because
  the realpath leaves the root.
- **Roots only grow, and a GET never spawns an agent.** A root enters the known set
  when a session's cwd is established; file reads never create a session or start a
  backend process. Verified by a smoke run: 15 reads left the core with no child.

## Turn control and compaction

Decisions recorded for turn control and compaction (see
`docs/superpowers/plans/2026-10-17-turn-control-and-compaction.md`):

- **The prompt queue lives inside the ACP connection, not the server.** One
  `session/prompt` is in flight per connection, ever. `drain()` is the only writer of
  the in-flight flag and the only emitter of `turn.started` / `turn.finished`.
- **Enter queues a follow-up; Shift+Enter steers.** A steer cancels the in-flight turn
  and jumps ahead of queued follow-ups. Escape and Stop still cancel the in-flight turn
  only; they do not touch the queue.
- **Stop keeps the queue.** `queue.clear` is the explicit way to drop waiting prompts.
  It uses `conn?.`, so clearing an empty queue never spawns an agent.
- **Turn ids are process-global.** A settlement that arrives after a connection swap
  cannot be mistaken for the live turn; the reducer ignores any `turn.finished` whose
  id is not the live one.
- **Compaction is matched by trimmed exact equality** on two pi-acp prose sentinels. A
  match is replaced, never duplicated, and carries no summary; the core never reads the
  pi session store for it.
- **Known limitation, stated plainly:**
  - If pi-acp rewords those sentinels, the divider silently stops appearing. Nothing
    fails loudly.
  - goose emits no compaction signal at all, so the divider never appears for goose.
  - An agent-authored transcript override in `~/.config/sbh/components/` that does not
    handle the `divider` item kind will not render it. The built-in transcript does.
