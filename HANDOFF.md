# SBH — handoff

Read this file, then `AGENTS.md` (the contract and how to write a component), then
`PLAN.md` (plan, status, roadmap, decision records). The design and the reasoning
behind every choice live in the vault:
`~/.local/share/ryoku/rashin/specs/2026-10-12-meta-harness-design.md`. Do not copy
that here — one source of truth, N consumers.

## What it is

A barebones harness host whose entire interface is authored by an AI agent. The core
owns the plumbing (agent connections, permissions, the wire) and the UI is a
declarative tree the agent writes as files. "Self-building harness."

## State

41 commits · **134 tests / 22 files** · `tsc -b` clean · `git status` clean.
`core`+`shared` ~1.6k · `src` ~1.5k lines of source.

```
core/      the process: ACP, permissions, WS server, theme/layout/components,
           versioning, watcher, machine sampling, sessions
shared/    the contract: protocol, UiNode/HostState, default layout, theme tokens
src/ui/    renderer + atoms + host components + state + loaders
src-tauri/ the shell — Rust: spawns the core, opens the window, kills the core
test/      scripted fake ACP agent + integration
.agents/skills/optional-basics/  recipes that double as the capability benchmark
```

## Running it

```bash
npm test          # 134 tests, no network, no model, ~1s
npm run core      # the core, on ws://127.0.0.1:<SBH_PORT>/ws
npx tauri dev     # the window — spawns its own core; first cargo build ~45s
```

Useful env: `SBH_BACKEND` (`pi`, `goose`, or `fake:happy|permission|usage|unknown-update|
crash-mid-turn|split-multibyte`), `SBH_PORT`, `SBH_CONFIG_DIR`,
`SBH_COMPONENTS_DIR`, `SBH_SESSIONS_DIR`, `SBH_ALLOWED_ORIGINS`.

**A plain `&` background process dies with the invoking shell.** For a browser
verification use transient systemd units — the exact recipe is in `AGENTS.md`
§ "Verifying in a real browser".

## Verified, and not

**Verified in Chromium against a live core:** streaming turns, the permission card
gating and resuming a turn, theme restyling from one file, component and layout hot
reload with no page reload, safe mode naming a broken component, revert removing it,
machine samples, a context meter, 50 real sessions listed and one replayed. The
origin guard was re-verified the same way (the app's own origin still connects; a
stranger origin is refused on both the routes and the WebSocket).

**Verified against a second backend:** `goose acp` (goose 1.54, speaks ACP
natively) handshakes and completes a real turn through the core — `turn.started`,
`usage`/`thought`/`chunk`, `turn.finished end_turn`, reply intact. This makes the
central claim n=2.

**Never verified:** anything *shipped*. Development works, but there is no
sidecar bundling, no port handshake for a packaged build, and nothing has been
packaged. The window runs against the repo's `core/index.ts` by path.

## What is left

### It is not an app yet
- ~~Tauri must spawn the core~~ — **done (development).** The shell spawns the core
  on a free port, reads the port off its stdout, injects the URL into the webview,
  and stops the core on exit. What is left is **packaging**: today it resolves
  `core/index.ts` from the repo (`CARGO_MANIFEST_DIR/..`, or `SBH_ROOT`); a bundled
  build ships the core as a sidecar resource instead. See `AGENTS.md` for the run
  recipe.
- ~~Open the window~~ — **done.** Verified on this Wayland session: the window
  opens, the webview connects to the spawned core over loopback, and a streamed
  turn renders. WebKitGTK found a layout bug Chromium hid (see the trap below).
- ~~No origin check~~ — **done.** Exact-match allowlist (Vite dev + Tauri origins,
  extended by `SBH_ALLOWED_ORIGINS`), enforced on every route and the WebSocket
  upgrade; a missing `Origin` is still admitted for non-browser clients.

### The thesis is unproven
- ~~A second backend~~ — **done, with two gaps.** `goose` is in the registry and a
  real turn works end to end. What it did *not* widen:
  - the **permission gate**: goose (1.54), even in `approve` mode, never sent
    `session/request_permission`, so that path is still tested only by pi-acp and
    the fake fixture;
  - **sessions**: the sidebar reads pi's JSON files, and goose keeps its sessions
    in `~/.local/share/goose/sessions/sessions.db` (SQLite). Under
    `SBH_BACKEND=goose` the list is therefore pi's, not goose's. The neutral fix is
    ACP `session/list` (goose advertises it); reading a second store is the
    un-neutral one.
- **Resume a session.** Viewing works; continuing a past chat does not. goose
  advertises `loadSession: true` (pi-acp did not), so it is the better prototype
  target for the `session/load` route.

### Daily-driver quality
- **The harness/model pickers are decorative** — they dispatch into the void with
  single-entry hardcoded options. Real switching means reconnecting the ACP session.
- **Transcript virtualization** — flagged in the first review, still untested. 260
  bubbles render; 10,000 is unknown.
- **Settings store.** `localStorage` works; it is not shared between components, not
  agent-visible, and not covered by revert.

### Designed, never built
- **Capability manifest** — named capabilities, default-deny, policy in a root-owned
  file, approved through the same UI as tool calls. This is the honest form of "full
  system integration"; see `PLAN.md` for the evaluation.
- **`CATALOG.md`** — the design's generated inventory of components + contract in the
  UI directory, so an agent can read what exists. Does not exist.
- **Published docs** a harness can `web_fetch`. Does not exist; `AGENTS.md` and this
  file are the substitute.
- **MCP Apps hosting** — ratified standard, and the sandbox host is ~80% built.
- **Light/dark palettes** — the theme system supports swapping; only one theme ships.
- **Ryoku theming** — deliberately deferred. The goal was an app an agent can restyle
  to Ryoku by itself; nobody has tried.

### Deliberately deferred
Mobile/PWA client · packaging and an install story · the repository split
(**evaluated: don't**, until a second real client exists).

## Open decisions

- **Resume mechanism**: `session/load` over ACP, or the harness's CLI resume flag.
  Test which the adapter supports before designing around it.
- **Capability manifest shape**: global flag vs per-capability list. The evaluation
  argues for the list; nothing is built.
- **Root-gated policy**: a root-owned file outside any user-writable directory as the
  policy source. Evaluated and recommended; not built.

## Traps

Each of these cost real time. They are in `PLAN.md` in more detail.

- **Nine bugs were found by running the thing; the 134-test suite found none of
  them.** A DOM assertion proves an element exists, not that it looks right. Render it.
- **WebKitGTK is not Chromium.** `applyLayout` set only `min-width:0` on growing
  flex items; WebKit's automatic minimum size let the 50-entry session list stretch
  the root row to 1575px inside a 974px parent, pushing the composer to y=1548,
  off-screen. `min-height:0` too fixes it. Chromium had absorbed it silently.
- **A transparent-looking Tauri window is usually Hyprland.** The wallpaper showed
  through the shell because the window was unfocused and this config sets
  `inactive_opacity = 0.9` + blur. The app is opaque when focused; do not chase it.
- A shared layout helper stamped `data-atom` over a component's own attribute. Two
  components using one styling helper will collide over `data-atom`.
- The browser **caches ES modules by URL for the page's lifetime and ignores
  `cache-control`** — hot reload silently only worked for *new* files until the URL
  got a `?rev=` cache-buster.
- `update` was never called after `create`, so a component that paints in `update`
  rendered blank on first mount. Mount is now create + update.
- A module-level sampler global made tests order-dependent. Prefer explicit instances.
- Reconciliation keyed on node *type* alone, so overriding a component under the same
  name patched a stale element with the new implementation's `update`.
- `git init` on an empty directory stages nothing — hence an explicit empty baseline.
- Use `git commit -F <file>`. Backticks inside `-m "…"` run as command substitutions
  and silently mangle the message. (I did this twice.)
- The core resolves paths from its own package root, not `cwd`; and it binds loopback
  only, by design.

## Where to start

1. **Resume a session.** Viewing works; continuing a past chat does not. goose
   advertises `loadSession: true`, so it is the better prototype target for the
   `session/load` route.
2. Real pickers (backend switching) → the `optional-basics` capability pass.
3. **Packaging**: sidecar-bundle the core so the window is a program, not a dev
   run against the repo.

(Done since the last handoff: the origin guard, the goose backend, and Tauri
spawning the core with the window open.)

To check capability instead of reading: run the `optional-basics` skill as a benchmark
and report per recipe — **built** / **partial** / **blocked**, naming the missing host
capability. Its verdicts are already corrected once; keep them honest.
