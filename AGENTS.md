# Working in SBH

**Start with [`HANDOFF.md`](HANDOFF.md)** — what is verified versus assumed, and
what is left. The design and its reasoning live in [`docs/design.md`](docs/design.md);
read it before proposing a design change. [`PLAN.md`](PLAN.md) holds the roadmap and
decision records.

SBH is a harness host whose interface an agent authors: an ACP client that owns the
plumbing and the trust boundary while the agent writes the UI as files. This file is
the contract for changing the code and for writing components.

## Invariants

Break one of these and you have broken the point of the project.

- **No model prose as HTML.** The UI is a tree of components; agent/model-authored
  strings are *data*. Render model output with `renderMarkdown` and DOM building,
  never `innerHTML`. Component *code* is trusted; the text it displays is not.
- **Components are dumb about capability.** A component reads `node`, `ctx.tokens`,
  `ctx.host` and `ctx.dispatch`, and imports nothing from `core/`. All capability
  lives in the host, in one auditable place.
- **The core is the only spawner** of agent processes, and the only thing that
  answers permission requests. The UI has no authority.
- **Loopback only.** The core binds `127.0.0.1`; the agent channel behind it has a
  shell, so the origin guard is not optional.
- **The app is not the writer** of a harness's session store. It reads; it never
  writes, renames or deletes a session file.

## Layout

- `core/` — the local process: ACP connections, event normalization, the
  permission gate, the loopback HTTP + WebSocket server, config serving, versioning,
  the watcher, machine sampling. The only place that spawns agents.
- `shared/protocol.ts` — the wire contract (`UiEvent`, `ClientToCore`). Lives in
  `shared/` so the UI speaks it **without importing `core/`**.
- `src/ui/tree/` — the tree renderer, the component registry, patch/destroy.
- `src/ui/atoms/` — the built-in layout and control components, one per file, each
  self-registering. `src/ui/atoms/style.ts` is the styling reference.
- `src/ui/host/` — the dynamic components a static layout refers to (`transcript`,
  `composer`, `permission`, `sessions`, pickers, notices).
- `src/ui/state/` — the stream client and the pure transcript reducer.
- `src-tauri/` — the shell (Rust): spawn the core, inject its URL, stop it on exit.
- `test/fixtures/` — the scripted fake ACP agent. Every core test runs against it,
  so the suite never calls a model.
- `examples/` — a component override and the benchmark component; `capabilities.toml`
  is the annotated manifest reference.
- `packaging/` — the Arch package and the `sbh-policy` wrapper.

## Conventions

- **Explicit `.ts`/`.tsx` in import specifiers, everywhere.** Node's ESM resolver
  requires them even under type stripping, so `core/` and `test/` break at runtime
  without them. One rule, no exceptions.
- Type checking is split across `tsconfig.app.json` (`src`, DOM),
  `tsconfig.core.json` (`core`, `test`, `shared`, strict, no DOM) and
  `tsconfig.node.json` (configs). `npx tsc -b` runs all three; `npm run build`
  depends on it.
- Vitest defaults to the `node` environment. Frontend tests opt into a DOM with a
  `// @vitest-environment happy-dom` docblock.

## Testing

`npm test` must stay green with **no network and no model**. New behaviour on the
core path gets a fake-agent scenario, not a mocked function.

## Verifying a UI change in a browser

**Do not trust the unit suite alone for UI changes.** A DOM assertion proves an
element exists, not that it looks right; several real bugs here passed the whole
suite and were only visible rendered. A background process started with `&` dies
with the invoking shell — use transient units or an equivalent that survives.

Run the core and a dev server, then load the page and actually look at it:

```bash
npm run core &                       # or: SBH_BACKEND=fake:happy SBH_PORT=45999 npm run core
VITE_CORE_URL=ws://127.0.0.1:8787/ws npx vite --port 5173 --strictPort
```

Then open the page, type, press Send, and confirm the transcript and the permission
card. `SBH_BACKEND=fake:permission` exercises the gate. The `fake:*` backends are
the scripted fixtures and need no model.

## Verifying the real window (Tauri)

The shell spawns its own core, so do not start one first. `npx tauri dev` serves
Vite at the configured dev URL and the window connects to the core it spawned. On a
headless or agent shell, pass the display environment explicitly (example is a
Wayland session):

```bash
systemd-run --user --unit=sbh-window --collect --working-directory="$PWD" \
  --setenv=WAYLAND_DISPLAY=wayland-1 --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
  --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  --setenv=SBH_ROOT="$PWD" --setenv=SBH_BACKEND=fake:happy \
  src-tauri/target/debug/app
```

The core is a child of the shell — **close the window** (not just `systemctl stop`)
to watch the lifecycle, or it is reaped by the cgroup and the proof is nothing.

**A window with no content is usually a GPU-stack workaround, not env you forgot.**
On an NVIDIA + Wayland stack, WebKitGTK's DMA-BUF renderer can die with
`Error 71 (Protocol error) dispatching to Wayland display` before the window shows,
and the app exits with the core it already spawned **orphaned**. The shell sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` itself unless you set it, so every launch path
gets it. If you see orphaned `sbh-core` processes, an app died after spawning one.
A screenshot of an *unfocused* window can look transparent — that is window-manager
opacity, not an app bug.

## Packaging

`npm run build:core` compiles the core to a standalone binary with
`bun build --compile` (no Node runtime on the target), written to
`src-tauri/binaries/sbh-core` (gitignored). `bundle.resources` ships it, and the
shell resolves `<resource_dir>/binaries/sbh-core`, falling back to Node plus the
repo script only in dev (`SBH_CORE_BIN` overrides both).

- **Arch:** `cd packaging && makepkg -si`. Installs `sbh`, `sbh-policy`, the core,
  a `.desktop` and a disabled `/etc/sbh/capabilities.toml` at root-owned paths.
  `pkgver` must track `src-tauri/tauri.conf.json`.
- **Debian-family:** `npx tauri build --bundles deb`. The bundle identifier must
  not be the Tauri default.

**Build the release binary through the Tauri CLI**, never bare
`cargo build --release`: the CLI sets the env that selects the *embedded* frontend,
and a bare cargo build leaves the app in dev mode, so the window tries the dev URL
and shows "connection refused". The Arch `PKGBUILD` uses `npx tauri build
--no-bundle` for exactly this reason.

## Writing a component

Components are the extension surface. A built-in and an agent-authored component
are the same object; loading one with a built-in's name **overrides** it. Drop
`.js` files into `~/.config/sbh/components/` (override with `SBH_COMPONENTS_DIR`).

```js
export const component = {
  name: 'my-panel',
  create(node, ctx) {
    const el = document.createElement('div')
    ctx.bind(el, node)                 // remember this node
    el.addEventListener('click', () => {
      const live = ctx.latest(el)      // read the *current* node, not the mounted one
      if (live) live.ctx.dispatch('my.action', { id: live.node.props.id })
    })
    return el
  },
  update(el, node, ctx) { ctx.bind(el, node) },   // omit and the element is replaced
  container: false,        // true = the renderer owns and reconciles your children
}
```

- `ctx.bind` / `ctx.latest` exist because a listener is installed once, at `create`
  time, so it must read the *latest* node — a loaded module cannot import the
  registry's internals.
- Declare `update` for anything holding state (focus, scroll, canvas, animation);
  without it the element is replaced on every change. Declare `destroy` for timers,
  `rAF` loops and `window`/`document` listeners.
- **Mount runs `create` then `update`**, so paint in `update` and never special-case
  the first render.
- `container: true` means the renderer appends and reconciles children; do not
  append them yourself.
- A component that throws, or fails to import, is named on screen and skipped; the
  built-ins always keep working. That is safe mode.
- **A list inside a flex column shrinks its rows to fit.** Give list rows
  `flex-shrink: 0` and put the scroll on an inner container, or a long list renders
  as hairlines. The built-in `sessions` sidebar is the worked example.

`examples/components/button.js` is a small override to copy.
`examples/components/graph.js` ("CurveLab") is the larger reference: a pannable,
zoomable, animated curve editor in one file, no imports, driven by `ctx` and theme
tokens. To run it, copy it into the components directory and add a `graph` node to
the layout.

**A built-in must be usable on a fresh install; the agent authors the *taste*.**
Filtering, grouping, density and looks are the agent's job; a row you cannot read
or a control you cannot reach is a default that ships broken and belongs in a fix.

## Hot reload

The core watches `components/`, `layout.json` and `theme.json` (debounced) and
pushes an `invalidate` over the WebSocket; the client re-fetches. **Edit a file,
look at the app — no restart, no reload.** A deleted component unregisters; a broken
one stays reported. A theme change re-applies the CSS variables, so the whole app
follows without a re-render.

## Theming

`~/.config/sbh/theme.json` is written with the default on first start. It is a
**partial** override: state only what changes, the rest is merged from the default,
and unknown keys are ignored so a typo cannot blank the UI.

Reference tokens as `var(--sbh-color-accent)`, `var(--sbh-space-md)`,
`var(--sbh-radius-md)`, `var(--sbh-font-mono)`, never a literal. That is what keeps
independently-authored components looking like one app, and why a theme change needs
no code change anywhere.

## Undo

`~/.config/sbh` is a git repo with its own local identity (never your global
config). Every settled change is committed as `sbh: …`. When something fails to
load, the app offers **Revert last change**, which runs `git revert`, so the undo is
itself a commit and can be undone in turn. `GET /history` lists commits; `POST
/revert` undoes the last.

## The layout

`~/.config/sbh/layout.json` is what is on screen, as a tree an agent can rewrite,
hot-reloaded like the theme. **There is no binding language**: the layout is plain
static structure, and anything dynamic is a *host component* reading `ctx.host`.

| component | reads |
|---|---|
| `transcript` | `ctx.host.messages`, `status`, `error` |
| `composer` | `ctx.host.draft`; dispatches `prompt.draft` / `prompt.send` |
| `permission` | `ctx.host.pendingPermission`; dispatches `permission.allow` / `.deny` |
| `sessions` | `ctx.host.sessions`; dispatches `session.open` |
| `harnessPicker`, `modelPicker` | `ctx.host.harness` / `.model` |
| `notices` | `ctx.host.notices`, `ctx.host.data.policy`; dispatches `ui.revert` |

They are ordinary components in the same registry, so an agent can restyle or
override any of them — that is how the whole interface becomes agent-authored
rather than agent-styled. A layout that is not a tree falls back to the default, so
a bad edit cannot leave a blank window.

## Profiles (surfaces)

One core serves more than one interface. A desktop window and a phone are different
trees, not one responsive tree — a layout authored for a wide screen is wrong on a
phone however the components adapt. So a **profile** layers over the base config:

- base: `~/.config/sbh/{layout.json,theme.json,components/}` — the default surface.
- profile: `~/.config/sbh/profiles/<name>/{layout.json,theme.json,components/}` —
  overrides any of them for that surface.

A client declares its surface with `client.hello { profile }` on the WebSocket, and
its HTTP fetches carry `?profile=`. The core layers base ← profile and serves that:
the profile layout if present else the base; the theme merged (base over the
default, then the profile over that); the components unioned, with the profile's
overriding same-named base ones. A name must be a bare word
(`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`), which is also what keeps the read path
traversal-safe.

Hot reload is scoped: a base change reaches every surface, a profile change only
the clients that declared it, so editing the phone layout does not churn the
desktop window.

Authoring a phone surface is exactly like authoring the desktop one — write
`profiles/phone/layout.json` and any components under `profiles/phone/components/`.
In a checkout the Vite dev server previews it with `?profile=phone`.
`examples/profiles/phone/layout.json` is a starting point (a column, no sidebar).

## Sessions

`GET /sessions` lists past conversations from the **agent's own** `session/list`
(the only store goose has; pi's files are the fallback), newest first. `ctx.host.
sessions` carries the list; the `sessions` component dispatches `session.open`,
which asks the core to `session/load` it. The agent replays the conversation as
events and the next message continues that session.

**Read-only, permanently.** The app never writes a harness's session file.
`SBH_SESSIONS_DIR` overrides pi's store for the fallback path.

## Capability enforcement (opt-in)

**Off by default.** With no manifest the core trusts the UI, and whatever the
agent-authored permission card answers is the answer. That is deliberate: the user
runs their own harness, and a host that second-guesses them is a nanny.

Turn it on and the core judges every ACP `session/request_permission` before the UI
sees it, answering allow or deny itself; the card is told the outcome
(`permission.resolved`) and cannot overrule it. **A toggle the policed party
enforces is not a toggle**, so authority — not presentation — is what moves.

The manifest is **root-owned**, because an agent runs as the user and could rewrite
a user-owned policy:

- `/etc/sbh/capabilities.toml` — authoritative, installed disabled by the package.
- `~/.config/sbh/capabilities.toml` — consulted only when the root file is absent,
  for development, not as a boundary.

`examples/capabilities.toml` is the annotated reference. Capabilities derive from ACP
tool kinds (`fs.read`, `fs.write`, `shell`, `net`, `session.mode`, `other`); each
rule is `allow` / `deny` / `ask` with optional path / command / host scopes.
Everything fails closed: no rule is a deny, `ask` is a deny (no click-to-allow), and
a scoped allow with no readable subject is a deny. Decisions append to
`~/.local/state/sbh/audit.log`; recent denials also show in the notices bar.

**`sbh-policy` is the writer** (`core/policy.ts`, run as `sbh-core policy …`; `npm
run policy` in a checkout). It reuses the core's parser, so it cannot write a
manifest the core would reject, and it edits the file textually so comments survive.
**SBH never elevates itself** — run it under pkexec, `sudo`, `doas`, or a root shell:

```bash
sbh-policy list                      # reads; no root needed
sbh-policy check
sudo sbh-policy grant shell --commands 'git *, npm run *'
sudo sbh-policy grant fs.read --paths '~/Projects/**'
sudo sbh-policy enable
```

`--file` (or `SBH_MANIFEST`) points it elsewhere for development. Hand-editing works
too — the CLI is a convenience, not the only path.

## The phone server

A companion process, not the core. `npm run phone` (`core/phone-server.ts`) serves
the built client (`npm run build:phone` → `dist-phone/`) and reverse-proxies the
core's HTTP routes and `/ws` to it, injecting `__SBH_PROFILE__` (default `phone`)
and a same-origin `__SBH_CORE_URL__` into `index.html`. One origin, so the phone
has no CORS story.

- It **binds loopback by default**. It names no transport; front it with TLS
  (e.g. `tailscale serve`) so the browser gets a secure context — a PWA needs one.
- It **strips the `Origin` header** on the proxy hop, so the core's origin guard
  sees a plain server-to-server request and needs no allowlist entry.
- It has **no endpoints of its own** beyond static files and the proxy. That is
  what keeps "trust the phone" from becoming "the phone can grant": there is
  nothing to grant, and the manifest is edited by `sbh-policy`, not over HTTP.
- The core must be reachable: run it on a fixed port (`SBH_PORT=8787`), or pin the
  desktop app's core with an ambient `SBH_PORT` (the shell passes it through now).

Env: `SBH_CORE_URL` (default `ws://127.0.0.1:8787/ws`), `SBH_PHONE_PORT` (8788),
`SBH_PHONE_HOST` (loopback), `SBH_PHONE_DIST` (`dist-phone`), `SBH_PHONE_PROFILE`
(`phone`).
