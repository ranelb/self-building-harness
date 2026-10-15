# SBH — agent instructions

**Start with `HANDOFF.md`** — state, what is verified versus assumed, what is left,
and the traps. This file is the contract you work under; `PLAN.md` holds the plan,
status and decision records.

Self-Building Harness: a barebones harness host whose interface is a declarative
tree of components, driven by agent backends over ACP. The agent authors the UI;
the host owns the plumbing and the trust boundary.

**The design is settled and lives in the vault:**
`~/.local/share/ryoku/rashin/specs/2026-10-12-meta-harness-design.md`, and for the
capability model, `~/.local/share/ryoku/rashin/specs/2026-10-15-capability-manifest-design.md`.
Read them before proposing a design change. Do not copy them into this repo — one
source of truth, N consumers.

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

**A plain `&` background process dies with the invoking shell** — hence the
transient systemd units below.

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

### Verifying in Tauri (the real window)

The shell spawns its own core, so do not start one first. `npx tauri dev` runs
Vite at `http://localhost:5173` (the `devUrl`) and the window connects to the core
it spawned. On this box an agent shell has no display env, so pass it:

```bash
systemd-run --user --unit=sbh-window --collect \
  --working-directory=/home/ran/Projects/code/SBH \
  --setenv=WAYLAND_DISPLAY=wayland-1 \
  --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
  --setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  --setenv=XDG_SESSION_TYPE=wayland --setenv=GDK_BACKEND=wayland \
  --setenv=WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  --setenv=WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  --setenv=SBH_BACKEND=fake:happy --setenv=SBH_ROOT=/home/ran/Projects/code/SBH \
  /home/ran/Projects/code/SBH/src-tauri/target/debug/app
```

It needs Vite at 5173 first (`npx vite --port 5173 --strictPort`). Screenshot with
`WAYLAND_DISPLAY=wayland-1 grim /tmp/sbh.png`. Focus the window before trusting a
screenshot: Hyprland's `inactive_opacity = 0.9` plus blur makes an unfocused window
look transparent, which is not an app bug. The core is a child of the shell — close
the window (not just `systemctl stop`) to watch the lifecycle, or it is reaped by
the cgroup and the proof is worthless.

### Packaging

`npm run build:core` compiles `core/index.ts` into a standalone binary with
`bun build --compile` — no Node runtime on the target — written to
`src-tauri/binaries/sbh-core` (gitignored, ~80 MB). `bundle.resources` ships it in
the bundle, and the shell resolves `<resource_dir>/binaries/sbh-core`, falling back
to Node + the repo script only in dev (`SBH_CORE_BIN` overrides both).
`npx tauri build --bundles deb` builds the frontend, the core, and the `.deb`
(~38 MiB). The bundle identifier must not be `com.tauri.dev`.

To test the release binary against its bundled core without installing: extract
`usr/lib/SBH/binaries/sbh-core` from the `.deb` into
`src-tauri/target/release/binaries/`, then run `src-tauri/target/release/app` and
check the child process is that binary, not `node`.

## Writing a component

Components are the extension surface. A built-in and an agent-authored component
are the same object; loading one with a built-in's name **overrides** it. Drop
`.js` files into `~/.config/sbh/components/` (override with `SBH_COMPONENTS_DIR`).

```js
export const component = {
  name: 'my-panel',
  create(node, ctx) {
    const el = document.createElement('div')
    ctx.bind(el, node)          // remember this node
    el.addEventListener('click', () => {
      const live = ctx.latest(el)     // read the *current* node, not the mounted one
      if (live) live.ctx.dispatch('my.action', { id: live.node.props.id })
    })
    return el
  },
  update(el, node, ctx) { ctx.bind(el, node) },   // omit and the element is replaced
  container: false,        // true = the renderer owns and reconciles your children
}
```

- `ctx.bind` / `ctx.latest` exist because a listener is installed once, at
  `create` time, so it must read the latest node — a loaded module cannot import
  the registry's internals.
- Declare `update` for anything holding state (focus, scroll, canvas, animation).
  Without it the element is replaced on every change.
- `container: true` means the renderer appends and reconciles children; do not
  append them yourself.
- A component that throws, or fails to import, is reported by name on screen and
  skipped. The built-ins always keep working — that is safe mode.
- **Model-authored prose must still go through `renderMarkdown`**, never
  `innerHTML`. Components are trusted code; the text they display is not.

`examples/components/button.js` is a working override to copy.

## Hot reload

The core watches `components/` and `theme.json` (debounced) and pushes an
`invalidate` message over the WebSocket; the client re-fetches. **Edit a file, look
at the app — no restart, no reload.** A deleted component unregisters; a broken one
stays reported. Changing `theme.json` re-applies the CSS variables, so everything
follows instantly without a re-render.

## Theming

`~/.config/sbh/theme.json` is written with the default on first start. It is a
**partial** override: state only what changes, the rest is merged from the default
(and unknown keys are ignored, so a typo cannot blank the UI).

Reference tokens as `var(--sbh-color-accent)`, `var(--sbh-space-md)`,
`var(--sbh-radius-md)`, `var(--sbh-font-mono)` and friends — never a literal colour.
That is what keeps independently-authored components looking like one app, and it is
why a theme change needs no code change anywhere. The built-in controls in
`src/ui/atoms/style.ts` are the worked example.

## Undo

`~/.config/sbh` is a git repo with its own local identity (never your global
config). Every settled change — a component written, a theme edited — is committed
as `sbh: …`. When something fails to load, the app offers **Revert last change**,
which runs `git revert` so the undo is itself a commit and can be undone in turn.

`GET /history` lists commits; `POST /revert` undoes the last one. Inspect it by hand
with `git -C ~/.config/sbh log --oneline`.

## The layout

`~/.config/sbh/layout.json` is what is on screen, as a tree an agent can rewrite.
Written once with the default; hot-reloaded like the theme. Add a panel, move the
pickers, delete the transcript — edit the file and watch it happen.

**There is no binding language.** The layout is plain static structure; anything
dynamic is a *host component* reading `ctx.host`:

| component | reads |
|---|---|
| `transcript` | `ctx.host.messages`, `status`, `error` |
| `composer` | `ctx.host.draft`; dispatches `prompt.draft` / `prompt.send` |
| `permission` | `ctx.host.pendingPermission`; dispatches `permission.allow` / `.deny` |
| `notices` | `ctx.host.notices`; dispatches `ui.revert` |
| `harnessPicker`, `modelPicker` | `ctx.host.harness` / `.model` |

They are ordinary components in the same registry, so an agent can restyle or
override any of them — that is how the whole interface becomes agent-authored
rather than agent-styled.

A layout that is not a tree falls back to the default, so a bad edit cannot leave
a blank window.

## Component lifecycle

`create` → `update` → `destroy`. **Mount runs `create` and then `update`**, so paint
in `update` alone and never worry about the first render. Declare `destroy` if you
hold a timer, a `rAF` loop or a `window`/`document` listener — reconciliation
replaces elements routinely (hot reload, a layout edit) and an unclean loop runs
against a detached node forever.

## Optional UI to build

`.agents/skills/optional-basics/SKILL.md` — recipes for a settings panel, a context
meter, light/dark mode and a sessions sidebar, each with an acceptance criterion and
the host capability it needs. Three of the four are buildable; the sessions sidebar
is buildable for **viewing** but cannot **resume** a conversation yet. The skill also
documents the machine-data channel (`ctx.host.data.system`), which is how any system
widget is built. Read it before building any of those, and before claiming SBH can.

Read it the same way for anything of the form "add a panel that shows X or lets the
user Y" — the four recipes are the worked examples, and the skill doubles as the
capability benchmark.

## Sessions

`GET /sessions` lists past conversations (newest first, with a title taken from the
first thing the user actually typed — injected skill text is stripped). `GET
/sessions/<id>` returns the turns. `ctx.host.sessions` carries the list; the
`sessions` host component renders it and dispatches `session.open`.

**Read-only, permanently.** The app never writes, renames or deletes a harness
session file — `pi` and `pi-web` must keep working on the same files, and a second
writer is how a store gets corrupted. `SBH_SESSIONS_DIR` overrides the root.

**Viewing is not resuming.** Opening a session replaces what is on screen; the agent
is still attached to its own session, so sending a message starts a new one. Resume
needs a core capability that does not exist yet.
