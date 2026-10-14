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

36 commits · **116 tests / 21 files** · `tsc -b` clean · `git status` clean.
`core` 978 · `shared` 233 · `src` ~1.6k lines of source.

```
core/      the process: ACP, permissions, WS server, theme/layout/components,
           versioning, watcher, machine sampling, sessions
shared/    the contract: protocol, UiNode/HostState, default layout, theme tokens
src/ui/    renderer + atoms + host components + state + loaders
src-tauri/ the shell — Rust, compiles, NEVER LAUNCHED
test/      scripted fake ACP agent + integration
.agents/skills/optional-basics/  recipes that double as the capability benchmark
```

## Running it

```bash
npm test          # 116 tests, no network, no model, ~1s
npm run core      # the core, on ws://127.0.0.1:<SBH_PORT>/ws
npx tauri dev     # the window — first cargo build ~45s
```

Useful env: `SBH_BACKEND` (`pi`, or `fake:happy|permission|usage|unknown-update|
crash-mid-turn|split-multibyte`), `SBH_PORT`, `SBH_CONFIG_DIR`,
`SBH_COMPONENTS_DIR`, `SBH_SESSIONS_DIR`.

**A plain `&` background process dies with the invoking shell.** For a browser
verification use transient systemd units — the exact recipe is in `AGENTS.md`
§ "Verifying in a real browser".

## Verified, and not

**Verified in Chromium against a live core:** streaming turns, the permission card
gating and resuming a turn, theme restyling from one file, component and layout hot
reload with no page reload, safe mode naming a broken component, revert removing it,
machine samples, a context meter, 50 real sessions listed and one replayed.

**Never verified:** anything inside Tauri. WebKitGTK is not Chromium, and this is the
largest untested surface in the project. The Rust shell compiles; the window has never
opened, and no core has ever been spawned by the shell.

## What is left

### It is not an app yet
- **Tauri must spawn the core.** Today a terminal starts it first. Needs sidecar
  bundling, a port handshake, lifecycle, and killing it on exit. **This is the whole
  distance between "project" and "program".**
- **Open the window.** See above.
- **No origin check on the loopback WebSocket** — any web page can connect and drive
  the agent. Small, real, cheap to close; do it with the Tauri work, since packaging
  changes the origin story.

### The thesis is unproven
- **A second backend.** The registry has only `pi`, so *"compatible with most
  harnesses"* is n=1. `goose` is installed, speaks ACP natively, and the fake-agent
  pattern already exists. Cheapest possible test of the central premise.
- **Resume a session.** Viewing works; continuing a past chat does not. Needs the core
  to open an existing harness session (`session/load`, or the harness's resume flag).

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

- **Eight bugs were found by running the thing; the 116-test suite found none of
  them.** A DOM assertion proves an element exists, not that it looks right. Render it.
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

1. **Tauri spawns the core; open the window.** Needs a human at the machine, and
   unblocks everything.
2. **A goose backend.** No window needed, and it turns the central claim into a result.
3. Resume → real pickers → the origin guard.

To check capability instead of reading: run the `optional-basics` skill as a benchmark
and report per recipe — **built** / **partial** / **blocked**, naming the missing host
capability. Its verdicts are already corrected once; keep them honest.
