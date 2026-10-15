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

```
core/      the process: ACP, permissions, WS server, theme/layout/components,
           versioning, watcher, machine sampling, sessions, capabilities
shared/    the contract: protocol, UiNode/HostState, default layout, theme tokens
src/ui/    renderer + built-in components + host components + state + loaders
src-tauri/ the shell — spawns the core, opens the window, stops the core
test/      scripted fake ACP agent + integration
examples/  a component override, the benchmark component, the manifest reference
packaging/ the Arch package and the sbh-policy wrapper
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

**Never verified:** a non-Arch install of the *package* (the `.deb` builds but is
not installed anywhere), an upgrade path, and any mobile client — the remaining
piece.

## What is left

### Mobile

Profiles (surfaces) and a companion phone server are in place: the core serves a
layout/theme/component set per client-declared surface, and `npm run phone` serves
the built client while reverse-proxying the loopback core. So the phone is a
second *layout* and a proxy, not a fork. What remains is using it off-device —
running the companion and fronting it with TLS — and deciding pairing. There is
none today: the phone server has no auth, so it relies on the network (a tailnet,
an ssh tunnel) for access control. That is a deliberate default, but it should be
a documented one.

### Daily-driver quality

- **Position virtualization.** The transcript is windowed by count (a bounded DOM),
  not measured; a very tall single message still costs its height, and there is no
  search/jump.
- **Settings store.** Component state is per-element and `localStorage`; there is no
  shared, agent-visible, revertable store.
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
- **`git commit -F`**, not `-m`, when the message contains backticks.
