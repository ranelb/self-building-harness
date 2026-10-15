# Design

SBH is a harness host whose interface an agent authors. This document records the
decisions and the reasoning behind them; the code is the authority on what exists
today, and [`HANDOFF.md`](../HANDOFF.md) on what works.

## The niche

ACP is the interop layer for coding agents. There is no shortage of ACP *clients*
— dozens, including Tauri and Vue/React ones — and no shortage of harnesses. What
none of them do is let the agent author the application's own interface. SBH is
that: not a harness, a host for harnesses, whose UI is written by the agent that
runs inside it.

Two claims are the whole bet:

1. A coding agent can build useful UI from the app's own contract, with no live
   tool.
2. The result is pleasant enough to switch to.

Everything else is plumbing in service of those.

## Architecture

```
┌─ core (Node/TS, loopback) ─┐        ┌─ client (Tauri + Preact) ─┐
│ spawns agents over ACP     │  WS    │ renders a tree            │
│ normalizes events          │◀──────▶│ loads components          │
│ answers permissions        │        │ dispatches actions        │
│ serves theme/layout/comps  │  HTTP  │ hot-reloads               │
└────────────────────────────┘        └───────────────────────────┘
```

The split is deliberate and load-bearing even on one machine. The core is the
only process that spawns an agent and the only one that answers permission
requests, so a second client (a phone, a CLI) is just another WebSocket. The
client speaks `shared/protocol.ts` and never imports `core/`.

- `core/` — ACP connections, event normalization, the permission gate, the
  loopback HTTP + WebSocket server, the watcher, versioning, config serving.
- `shared/` — the wire contract and the tree/host types, consumed by both sides.
- `src/ui/` — the tree renderer, the component registry, the host components, the
  stream client and the transcript reducer.
- `src-tauri/` — the shell: spawn the core, hand the client its port, kill the
  core on exit. No product logic in Rust.

## The UI is code, not data — the pivot

The original design was a declarative JSON tree of dumb *atoms* with `if`/`foreach`
control-flow nodes and no execution, sandboxed by construction.

That was abandoned. Dumb-data templates cannot express real interaction — drag,
resize, a canvas, a game — without inventing an expression language, and an
expression language is a sandbox with worse ergonomics. The premise of the project
is that the user runs their own harness and is already, in ACP's own terms, handing
an agent a shell. So the components are **trusted code**: an ES module with
`create` / `update` / `destroy` and full DOM access, loaded from disk and run in
the page.

What that bought: composition, control flow and state for free, and an interface
that can be anything the agent can write — see
[`examples/components/graph.js`](../examples/components/graph.js), a pannable,
zoomable, animated curve editor in one file.

What it costs: no sandbox. Handled by (a) *not* pretending there is one, (b) one
narrower invariant that still holds, and (c) an opt-in boundary:

- **No model prose as HTML.** Agent-authored strings are data. Model output is
  rendered by DOM-building code (`renderMarkdown`), never `innerHTML`.
- **The UI has no authority.** The core is still the only spawner and the only
  permission answerer.
- **The capability manifest** (below) is where control is moved outside the model,
  when the user wants it.

## The component contract

The extension surface is one interface, whether the component is built in or
authored by an agent:

```js
export const component = {
  name: 'my-panel',
  create(node, ctx) { /* return an element */ },
  update(el, node, ctx) { /* reconcile in place */ },
  destroy(el, node, ctx) { /* cancel timers, rAF, listeners */ },
  container: false,   // true = the renderer reconciles your children
}
```

- `ctx` gives `tokens` (theme values), `host` (live state), `dispatch`, and
  `bind`/`latest` so a listener installed once at `create` can read the *current*
  node.
- **Mount runs `create` then `update`.** Paint in `update` and never special-case
  the first render.
- Declare `update` for anything holding state (canvas, focus, scroll);
  declare `destroy` for timers, loops and window listeners, or a reconciliation
  replaces the element and leaves the loop running against a detached node.
- A component that throws or fails to import is named on screen and skipped; the
  built-ins keep working. That is safe mode, and it is why a broken component is
  an annoyance rather than a bricked app.

Components are served by the core over loopback (a webview cannot `import()` from
disk) and registered in the same map as the built-ins, so a loaded `sessions.js`
overrides the built-in `sessions`. The core watches the directory and pushes an
`invalidate`; the client re-fetches. **Edit a file, watch the app change — no
restart.**

## Layout and theme are files

`layout.json` is what is on screen, as a tree an agent can rewrite. There is no
binding language: the layout is static structure, and anything dynamic is a *host
component* reading `ctx.host`. That keeps the layout plain JSON while the transcript
and composer stay live, and it means "add a panel" or "move the pickers" is a file
edit, not a feature in the host.

`theme.json` is a *partial* override of design tokens, merged over the default.
Components reference `var(--sbh-color-accent)` and friends, never literals, so one
file restyles everything — including independently-authored components, which is
what keeps them looking like one app.

Both, and `components/`, live in a **git repo** (`~/.config/sbh`) that the core
commits to on every settled change. A failed load offers *Revert last change*,
which is itself a commit, so the undo can be undone.

## Surfaces: a profile per client

One core serves several interfaces, and a desktop window and a phone are different
trees rather than one responsive tree. The config is therefore layered: the base
directory is the default surface, and `profiles/<name>/` overrides its layout, theme
and components. A client declares which surface it is, the core serves that profile,
and hot-reload invalidations are scoped to it, so editing the phone layout does not
churn the desktop.

The agent authors an interface *per surface*. That is the thesis at one more level
— the UI is authored, not merely themed, and a phone is a second deliberate
interface rather than a squeezed desktop one.

## Backends, sessions, resume — ACP-native
A backend is a registry entry: a command and arguments. `pi` (`pi-acp`) and `goose`
(`goose acp`) are wired and verified. Nothing in the host is privileged per harness.

Sessions and resume use ACP rather than a harness-specific store:

- `session/list` is the sidebar's source (the agent's own view of its sessions,
  and the only store goose has). pi's JSON files remain a fallback for an agent
  that cannot list.
- `session/load` resumes: the agent replays the conversation as `session/update`
  notifications and the next message continues that session.
- Models come from the session's `configOptions` (the `model`-category entry) and
  are set with `session/set_config_option`. The picker knows nothing about any
  harness's model names.

**The app is not the writer of a harness's session store, permanently.** A second
writer is how a store gets corrupted, and the point is that `pi` and SBH can both
run against the same machine.

## The capability model: trust by default, opt-in control

The UI is agent-authored and trusted, so the permission card can be authored to
look like anything or to answer itself. The honest resolution is not to make the
card native; it is to stop pretending the card is the boundary.

- **Off by default.** With no manifest, the core forwards a permission request to
  the UI and whatever the card answers is the answer. The card may lie. That is
  the user's call.
- **On, the core judges first**, before the UI sees the request, and the UI is
  told the outcome. The card can narrow a decision, never widen it.
- The manifest is **root-owned** (`/etc/sbh/capabilities.toml`), because an agent
  runs as the user and could rewrite a user-owned policy. Capabilities derive from
  ACP tool kinds (`fs.read`, `fs.write`, `shell`, `net`, `session.mode`), each
  `allow`/`deny`/`ask` with optional path, command or host scope. Everything fails
  closed: no rule is a deny, and `ask` is a deny — there is no click-to-allow,
  because a click is code the agent wrote. Grants are edits to the file, made with
  the root-side `sbh-policy` CLI.
- **SBH never elevates itself.** `sbh-policy` is run under pkexec, sudo, doas or a
  root shell; the app names no elevator.

Read the reasoning in full: the key principle is that **a toggle the policed party
enforces is not a toggle**, so authority — not presentation — is what lives
outside the model.

### Honest limits

- **Consent and blast-radius, not a sandbox.** Once an agent has `shell`, it has
  the user's authority. The manifest decides whether it gets it at all.
- **The boundary is as strong as the install.** Root-owned core and manifest plus
  a user-owned UI directory is a boundary; a dev checkout owned by one user is
  theatre.
- **It can only gate what the harness surfaces.** goose, measured, does not send
  `session/request_permission`; the manifest cannot clamp a backend that does not
  ask.

## Packaging

The core compiles to a standalone binary (`bun build --compile`), so the target
needs no Node runtime. The shell resolves it from the resource directory. A local
Arch package (`packaging/PKGBUILD`) installs `sbh`, `sbh-policy`, the core and a
disabled root manifest at system paths; a `.deb` builds for Debian-family.

## The transcript as a timeline, and the plumbing it needed

Earlier the transcript was a flat list of messages, which is why chain-of-thought
and tool calls were invisible: the reducer never kept them. It is now an ordered
timeline of items (user, agent, thought, tool), and the core forwards
`tool_call_update` with `kind` and `locations` so an `edit` call can be turned into
a changed-files list. A live user message comes only through `host.messages` (a live
turn emits no `user.chunk`), so the timeline is built on the host state, not the raw
stream.

Edit carries an honest limitation: ACP has no fork point, and pi does not implement
`session/fork`. So on pi, editing a prompt prefills the composer and dims the
superseded turn — the agent still sees the original — while the core's fork path
lights up for a backend that offers one. Attachments are shipped as bytes, persisted
by the core, and mapped to an ACP image block, embedded text, or a file link; a PDF
is handed to the harness, because ACP cannot inline it and SBH does not parse it.

## Not in scope (decided, not forgotten)

- **Mobile** — the next piece, and the reason the core is loopback-first. It is a
  client, not a rewrite: a phone surface (profile) plus a companion server that
  serves the built client and proxies the loopback core. The client names no
  transport; TLS is the operator's, via whatever fronts the companion.
- **MCP Apps hosting** — a ratified MCP extension; deferred, not rejected.
- **Published docs / catalog** — a generated component inventory (`CATALOG.md`)
  and web-fetchable docs so any harness can bootstrap itself. Open.

## Load-bearing assumptions, honestly

1. An ACP path streams enough to render a real transcript — **demonstrated** with
   pi and goose.
2. A tree can express it without perf pain — **mostly**; the transcript is
   windowed to a bounded DOM, position virtualization is not done.
3. An agent can build useful UI from the contract alone — **demonstrated once**
   (the benchmark component), not yet repeatedly.
4. It is pleasant enough to switch to — **unresolved**; it needs daily use,
   including on a phone.

If an agent can no longer build useful UI from the docs and contract, or it is less
pleasant than the harnesses it wraps, the premise has failed.
