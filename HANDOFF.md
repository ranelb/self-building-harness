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

52 commits · **174 tests / 24 files** · `tsc -b` clean · `git status` clean.
`core`+`shared` ~2.1k · `src` ~1.6k lines of source. A `.deb` builds and runs.

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
npm test          # 149 tests, no network, no model, ~1s
npm run core      # the core, on ws://127.0.0.1:<SBH_PORT>/ws
npx tauri dev     # the window — spawns its own core; first cargo build ~45s
npm run build:core  # compile the core to a standalone binary (bun)
npx tauri build --bundles deb   # a .deb with the core bundled in
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

**Never verified:** an *installed* app. A `.deb` builds and the release binary was
run from the tree against its bundled core; nothing has been installed
system-wide, and there is no rpm/AppImage pass or an update story.

## What is left

### It is not an app yet
- ~~Tauri must spawn the core~~ — **done.** Development spawns Node + the repo
  script; a packaged build spawns the bundled binary. Both verified.
- ~~Open the window~~ — **done.** Verified on this Wayland session.
- ~~Origin check~~ — **done.** Exact-match allowlist on every route and the WS.
- ~~Packaging~~ — **done, mostly.** `npm run build:core` compiles the core to a
  standalone binary (`bun build --compile`, no Node on the target), shipped at
  `binaries/sbh-core` and resolved from the resource dir. `npx tauri build
  --bundles deb` produces a 38 MiB `SBH_0.1.0_amd64.deb`. Left: rpm/AppImage,
  installing it system-wide, and an update story.

### The thesis is proven enough
- **A second backend** — `goose` works end to end, including its own session
  list, model config option and resume. Still n=2; a third is untested.
  - goose (1.54), even in `approve` mode, never sends
    `session/request_permission`, so the permission gate is still only tested by
    pi-acp and the fake fixture.
- ~~Resume a session~~ — **done.** `session/load` replays the conversation as
  events; `session/list` (the agent's own store, now the sidebar source) supplies
  the ids. Works for pi and goose; verified in the browser.
- ~~Real pickers~~ — **done.** The backend registry and the session's
  `configOptions` feed the pickers over the state channel; switching reconnects.
- ~~Transcript virtualization~~ — **done, as count-windowing.** Only the last 80
  messages are in the DOM; older ones load a page at a time. Not position
  virtualization (markdown heights are unknowable before layout), so the
  guarantee is a bounded DOM, not a measured row.

### Daily-driver quality
- **Model picker depends on a session.** The list only arrives with a session, so
  the core opens one on client connect; under goose that creates an empty "New
  Chat" row each run.
- **Transcript windowing is bounded, not measured** — a very tall single message
  still costs its own height, and there is no search/jump-to-message.
- **Settings store.** `localStorage` works; it is not shared between components, not
  agent-visible, and not covered by revert.

### Designed, never built
- **Capability manifest — enforced, opt-in, off by default.** `core/capabilities.ts`
  loads a root-owned TOML manifest (user fallback for dev), classifies ACP tool
  calls, evaluates fail-closed, and audits. With it on the core decides and the UI
  is told (`permission.resolved`); off, the agent-authored card answers as before.
  The `.deb` installs a disabled `/etc/sbh/capabilities.toml`. Design:
  `specs/2026-10-15-capability-manifest-design.md`. Left: the pkexec switch UX.
- **`CATALOG.md`** — the design's generated inventory of components + contract in the
  UI directory, so an agent can read what exists. Does not exist.
- **Published docs** a harness can `web_fetch`. Does not exist; `AGENTS.md` and this
  file are the substitute.
- **MCP Apps hosting** — ratified standard, and the sandbox host is ~80% built.
- **Light/dark palettes** — the theme system supports swapping; only one theme ships.
- **Ryoku theming** — deliberately deferred. The goal was an app an agent can restyle
  to Ryoku by itself; nobody has tried.

### Deliberately deferred
Mobile/PWA client · rpm/AppImage packaging and an install/update story · the
repository split (**evaluated: don't**, until a second real client exists).

## Open decisions

- ~~**Resume mechanism**~~ — **decided: ACP `session/load`.** Both pi-acp and goose
  support it, and `session/list` gives the ids, so nothing harness-specific.
- **Capability manifest shape**: global flag vs per-capability list. The evaluation
  argues for the list; nothing is built.
- **Root-gated policy**: a root-owned file outside any user-writable directory as the
  policy source. Evaluated and recommended; not built.

## Traps

Each of these cost real time. They are in `PLAN.md` in more detail.

- **Twelve bugs were found by running the thing; the 149-test suite found none of
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

1. **Capability manifest** — the honest form of "full system integration": named
   capabilities, default-deny, policy in a root-owned file, approved through the
   same UI as tool calls. Designed, never built (`PLAN.md` has the evaluation).
2. `CATALOG.md` + published docs, per the design.
3. MCP Apps hosting; light/dark palettes; Ryoku theming (deliberately deferred).

The four-item roadmap batch (pickers, resume, virtualization, packaging) is done.
Remaining small gaps are listed above; the largest is the capability manifest.

To check capability instead of reading: run the `optional-basics` skill as a benchmark
and report per recipe — **built** / **partial** / **blocked**, naming the missing host
capability. Its verdicts are already corrected once; keep them honest.
