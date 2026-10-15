# Self-Building Harness

A desktop host for coding agents whose **interface the agent builds itself**.

Most ACP clients ship a fixed UI that you theme. SBH ships plumbing — agent
connections, permissions, a wire protocol — and a UI that is a tree of
components the agent authors as files. Edit a component, watch the app change.
The agent can restyle the whole thing, or replace it, including the permission
card.

It is not a harness. It is a harness *host*: [ACP](https://agentclientprotocol.com)
in, an agent-authored interface out.

## The idea

A declarative tree is the interface. Nothing is hardcoded in the renderer:

- **Layout** — `~/.config/sbh/layout.json`, a plain JSON tree. Move a panel by
  editing the file; it hot-reloads.
- **Components** — `~/.config/sbh/components/*.js`. Each is an ES module with
  `create`/`update`/`destroy` and full DOM access. Drop one named after a
  built-in and it replaces it.
- **Theme** — `~/.config/sbh/theme.json`, a partial override of design tokens.
  Every built-in reads `var(--sbh-…)`, so one file restyles the app.
- **Surfaces** — a profile per client (`~/.config/sbh/profiles/<name>/`). A phone
  is authored as its own layout, not a squeezed desktop one.
- **Versioned** — the config dir is a git repo; every settled change is a commit,
  and the app can revert the last one.

The core is the only thing that spawns an agent and the only thing that answers
permission requests. The UI holds no capability: it renders state and dispatches
named actions.

## Install

Linux only, desktop first. Backends are whatever speaks ACP.

**Arch** (the packaged path):

```bash
cd packaging && makepkg -si
```

Installs `sbh`, `sbh-policy`, a standalone core binary, a `.desktop` entry and a
disabled `/etc/sbh/capabilities.toml`.

**From source** (any distro with Rust + Node 22+ + a webview):

```bash
npm install
npm run build:core     # compile the core to a standalone binary (bun)
npx tauri build        # or `npx tauri dev` for a live window
```

A `.deb` also builds (`npx tauri build --bundles deb`).

## Running it

```bash
npm run core      # the core alone, on ws://127.0.0.1:<port>/ws
npx tauri dev     # the window; it spawns its own core
npm test          # the suite: no network, no model
npm run policy -- list          # inspect the capability manifest
npm run build:phone && npm run phone   # serve the phone client (proxies a loopback core)
```

Environment: `SBH_BACKEND` (`pi`, `goose`, or a `fake:` fixture), `SBH_PORT`,
`SBH_CONFIG_DIR`, `SBH_COMPONENTS_DIR`, `SBH_ALLOWED_ORIGINS`; for the phone server,
`SBH_CORE_URL`, `SBH_PHONE_PORT`, `SBH_PHONE_HOST`, `SBH_PHONE_DIST`.

## Phone / remote

The core is loopback-only, and a phone can't reach loopback — nor can the core
serve the app's static bundle. So `npm run phone` runs a small **companion server**
that does two things: serve the built phone client, and reverse-proxy the core's
HTTP and WebSocket to it. One origin, so the phone has no CORS story at all.

It binds loopback by default; front it with something that terminates TLS (for
example `tailscale serve`) and the client gets a **secure context**, which a PWA
needs. **SBH names no transport** — Tailscale, a reverse proxy, an ssh tunnel are
all the same to it. It has no endpoints beyond static files and the proxy, so it
cannot widen the capability boundary.

**Installed**, it is `sbh-phone` plus a systemd user unit:

```bash
systemctl --user enable --now sbh-phone     # serve at http://127.0.0.1:8788/
sudo tailscale serve --bg 8788              # ...or whatever terminates TLS
```

The server **discovers the running core's port** (`~/.local/state/sbh/core.json`,
written by the core), so there is nothing to configure; point `SBH_CORE_URL` at a
core elsewhere if you want to. There is no auth: it relies on the network for
access control, so front it with something that does (a tailnet, a tunnel) rather
than exposing the port.

## Trust model

The UI is agent-authored, so an agent-authored permission card can look like
anything — including a lie. That is accepted, not papered over: SBH **trusts by
default**. A separate, **opt-in** capability manifest is what moves control
outside the model when you want it:

- root-owned `/etc/sbh/capabilities.toml`, disabled unless you enable it;
- when on, the core judges each permission request *before* the UI sees it, and
  the card cannot widen the answer;
- grants are made with `sbh-policy`, run under whatever you elevate with. SBH
  never elevates itself.

It is consent and blast-radius, not a sandbox: once an agent has `shell`, it has
your authority. See [`docs/design.md`](docs/design.md) for the reasoning.

## Backends

Two are wired and verified end to end: **pi** (`pi-acp`) and **goose** (`goose
acp`). Backends are a registry entry; the premise is that the host does not care
which harness is behind ACP.

## Status

Desktop is usable and installed: streaming, permissions, session list and resume,
hot-reloaded components and layout, theming, undo, a second backend, and an Arch
package. The phone client is the remaining piece — deliberately a *client*, since
the core is loopback HTTP/WebSocket. See [`HANDOFF.md`](HANDOFF.md).

## Documentation

- [`docs/design.md`](docs/design.md) — the design and its reasoning.
- [`AGENTS.md`](AGENTS.md) — the contract for working in this repo (and for
  writing components).
- [`HANDOFF.md`](HANDOFF.md) — current state and what's left.
- [`PLAN.md`](PLAN.md) — roadmap and decision records.

## License

MIT — see [`LICENSE`](LICENSE).
