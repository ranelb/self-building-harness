# Handoff

Read this for current state; the design and reasoning are in
[`docs/design.md`](docs/design.md), and the contract for changing code is
[`AGENTS.md`](AGENTS.md).

## What it is

A harness host whose interface an agent authors. The core owns the plumbing (agent
connections, permissions, the wire); the UI is a tree of components the agent writes
as files and the app hot-reloads.

## State

Desktop is usable and installed. The suite is green and needs no network or model;
`npx tsc -b` is clean.

Since the installed build, three phases are in the repo and tested but **not packaged or
installed**: the project file read path (`core/files.ts`, `GET /files`, `/files/tree`,
`/files/diff`), turn control (queue, steer, `queue.clear`, turn ids, the compaction
divider for pi), and composer context (`@path:lines` in `core/mentions.ts`, `!`/`!!` in
`core/shell.ts`, with the grammar in `shared/mentions.ts`). They are not yet rendered
in a real window: the Playwright check on the live config and the manual curl smoke
are unticked in their plans.

```
core/      the process: ACP, permissions, WS server, theme/layout/components,
           versioning, watcher, machine sampling, sessions, capabilities; the
           `policy` CLI and the `phone` server are subcommands of the same binary
shared/    the contract: protocol, UiNode/HostState, default layout, theme tokens
src/ui/    renderer + built-in components + host components + state + loaders
src-tauri/ the shell — spawns the core, opens the window, stops the core
test/      scripted fake ACP agent + integration
examples/  a component override, the benchmark component, the manifest + phone surface
packaging/ the Arch package, the sbh-policy / sbh-phone wrappers, a systemd user unit
```

## Verified, and not

**Verified against real agents.** A turn streams end to end through the core for
both **pi** (`pi-acp`) and **goose** (`goose acp`). Model selection
(`session/set_config_option`), the session list (`session/list`) and resume
(`session/load`) work against both.

**Verified in a real window.** The Tauri/WebKitGTK window loads the embedded
frontend, spawns the bundled core over loopback, and closing it reaps the core.
Streaming, the permission card, theme/layout/component hot reload, safe mode and
revert, the sessions sidebar with a filter, and an agent-authored canvas component
were all confirmed visually.

**Verified installed.** The Arch package installs root-owned system files; the
installed `sbh` runs the same way. `sbh-policy` reads and edits the installed
manifest. The capability manifest was exercised end to end: a granted tool call ran
with no card, a denied one was refused, the turn continued, and the decision landed
in the audit log.

**Verified: surfaces and the phone server.** The core serves a layout, theme and
component set per client-declared profile, and a profile edit hot-reloads only that
surface. The companion phone server serves the built client and reverse-proxies a
loopback core over HTTP and WebSocket; loading it as a phone (390×780) rendered the
phone layout with no sidebar, and a prompt round-tripped through the proxy.

**Verified on the host.** `sbh-phone` is installed and enabled as a systemd user
unit; it discovers the running core's advertised port, proxies `/health` and
`/layout?profile=phone`, and serves the phone client. Switching the backend from the
phone (goose → Pi) followed by a prompt returns a real reply with no error.

**Never verified:** the phase 1–3 work in a real window, a non-Arch install of the *package* (the `.deb` builds but is
not installed anywhere), an upgrade path, and any mobile client *off this machine* —
the transport works locally, but a real phone over a tailnet has not been used.

## What is left

### Mobile

Profiles (surfaces) and a companion phone server **ship and are installed**. The
core serves a layout/theme/component set per client-declared surface, and `sbh-phone`
(a systemd user unit) serves the built client while reverse-proxying the loopback
core, discovering the core's advertised port. What remains is (a) using it on a real
phone over a tailnet, and (b) **pairing**: there is no auth, so it relies on the
network for access control. That is a deliberate default and is documented, but it
is the one genuine gap — anyone who can reach the port drives the agent.

### Daily-driver quality

- **Position virtualization.** The transcript is windowed by count (a bounded DOM),
  not measured; a very tall single message still costs its height, and there is no
  search/jump.
- **Settings store.** A persisted, agent-visible, revertable keyed store now exists:
  `core/state.ts` (`state.json` in the config dir, atomic writes), `state.set` /
  `GET /state`, published to components as `ctx.host.data.store`. The core only
  validates and persists; keys are a component's convention, not the core's.
  `~/.config/sbh/components/sbh-settings.js` is the first consumer. Still missing: a
  typed settings schema and per-profile scoping of the store.
- **Phone proxy misses `/state`.** `CORE_ROUTES` in `core/phone-server.ts` does not
  list `/state`, so the settings store is unreachable from a phone. Fix before pairing.
- **Agent-authored transcript overrides** must handle the `divider` item kind and the
  `context` / shell tool-card events, or they silently miss them. The built-in does.
- **The model list needs a session** to exist, so the core opens one on client
  connect. Under goose that leaves an empty "New Chat" row per run.
- **The composition of the shipped chrome** is still a small set of built-ins; a
  generated component inventory (`CATALOG.md`) and web-fetchable docs are not built.

### Extensions, designed but not built

- **MCP Apps hosting** — a ratified MCP extension; the sandbox host is most of the
  machinery and was deferred, not rejected.
- **A capability switch UI** in the app: today `sbh-policy` is the interface, and
  the app only displays grants and recent denials.

## Traps

Each of these cost real time; they are the reason a change here should be rendered,
not just unit-tested.

- **Many bugs passed the whole suite and were only visible by running the thing.**
  A DOM assertion proves an element exists, not that it looks right.
- **WebKitGTK is not Chromium.** A flex bug that collapsed a 50-row list to 50
  hairlines showed only in WebKit, and a Canvas/DOM layout that Chromium absorbed
  did not. Always check the real window, and always with the window *focused* —
  an unfocused window can look transparent because of the compositor's opacity.
- **A bare `cargo build --release` leaves the Tauri app in dev mode.** Build the
  release binary through the Tauri CLI (`npx tauri build --no-bundle`); otherwise
  the window loads the dev server URL and shows "connection refused".
- **WebKitGTK's DMA-BUF renderer can kill the window before it shows** on an
  NVIDIA + Wayland stack, orphaning the core the shell already spawned. The shell
  sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` itself. Orphaned `sbh-core` processes mean
  an app died after spawning one.
- **A list inside a flex column shrinks its rows.** Give rows `flex-shrink: 0` and
  scroll an inner container.
- **The browser caches ES modules by URL for the page's lifetime**, ignoring
  `cache-control`, so component hot reload silently only works for *new* files
  unless the URL carries a cache-buster.
- **Reconciliation replaces elements routinely** (hot reload, a layout edit), so a
  timer or `rAF` loop without a `destroy` runs forever against a detached node.
- **The core resolves paths from its package root, not `cwd`**, and binds loopback
  only, by design.
- **An intentional close is not an error.** Switching a backend (or shutting down)
  closes the ACP connection; a request in flight is rejected by that close. Emitting
  it as an error event made selecting a harness look like a crash. The client tracks
  `closing` and stays quiet about a teardown it asked for.
- **A packaged core cannot run a `fake:` backend.** The fixture is not on disk, and
  `process.execPath` is the core itself, so it re-execs as a nested server (three
  deep, once) and clobbers the advertised port file. `isRunnableBackend` refuses it
  at startup. Fake backends are a development seam; keep real ones in the package.
- **`tsc` does not compile Rust.** A dropped `mut` in the shell sat until `makepkg`
  failed. Run `cargo check` after any `src-tauri/` change, separately from the JS
  checks.
- **`git commit -F`**, not `-m`, when the message contains backticks.
