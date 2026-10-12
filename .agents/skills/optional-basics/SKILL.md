---
name: optional-basics
description: Optional first-run UI to build on top of SBH — a settings panel, a context meter, light/dark mode, and a sessions sidebar — as recipes with acceptance criteria, not shipped code. Use when asked to add settings, a context or token indicator, theme switching, or a past-chats sidebar to an SBH interface, or when benchmarking what SBH's component API can build today.
---

# Optional basics

Four things a new user expects an app to already have. They are deliberately **not
shipped as code**: each is a recipe you build as a component plus a layout entry, so
that the first thing anyone does with SBH is extend it.

**This is also SBH's capability benchmark.** Every recipe names the capability it
needs. One marked **blocked** cannot be built yet without inventing a host API —
which is a different job from building UI. Build the unblocked ones, and report the
blocked ones instead of forcing them.

## The loop, for every recipe

1. Write `~/.config/sbh/components/<name>.js` — one component, default export or a
   `component` export.
2. Add a node for it in `~/.config/sbh/layout.json`.
3. Watch it appear. Both files hot-reload; both are committed and revertable.

Read `AGENTS.md` for the component contract before starting. Two rules from it are
load-bearing here: **declare `destroy`** if you hold a timer, a `rAF` loop or a
`window`/`document` listener, and **style only from `var(--sbh-*)`** so the piece
follows the theme.

Every recipe ends the same way: the piece survives a hot reload, a theme change, and
a page reload, and `Revert last change` undoes it.

---

## 1. Settings panel — buildable

**Why:** a new user wants to change something and expects somewhere to do it.

**Build:** a component rendering your own controls, dispatched through `ctx.dispatch`
so the host handles the effect. Place it in the layout, or in a panel of your own.

**Needs:** `ctx.dispatch`, `localStorage`. Both exist.

**Acceptance:** toggling a control changes the app's behaviour, and the choice
survives a page reload.

**Known limit:** `localStorage` is not shared between components, not visible to you
on the next run, and not covered by `Revert last change`. A shared, persisted,
agent-visible settings store is not built yet — say so if someone asks for one rather
than faking it with one component's private state.

## 2. Context meter — **blocked**

**Why:** a user wants to see how full the model's context is before it compacts.

**Build:** a component showing used/total tokens, fed from `ctx.host`.

**Needs:** context or token usage reaching the UI. **It does not.** `HostState` has
`messages`, `status`, `error`, `draft`, `pendingPermission`, `notices` — no usage.
The core's `UiEvent` has no usage event either, so the number never leaves the agent.

**To unblock:** map the agent's usage into a new `UiEvent`, carry it into `HostState`,
then build the component. Until then, report this as a gap.

## 3. Light/dark toggle — buildable, not persisted

**Why:** some people cannot read the dark default in daylight.

**Build:** a component that writes the other palette's `--sbh-*` variables onto
`document.documentElement` via `style.setProperty`, and back. Ship the two palettes
as two JSON files beside `theme.json` and read them with `fetch`.

**Needs:** nothing new. `document` and CSS custom properties are both available, and
setting a variable restyles the whole app with no re-render.

**Acceptance:** clicking it swaps the whole interface, **including the body
background**, and clicking again swaps back.

**Known limit:** the choice does not survive a reload and does not touch
`theme.json`, because no component may currently write the theme. Combine with recipe
1's limit if a persisted toggle is wanted.

## 4. Sessions sidebar — **blocked**

**Why:** a user wants to reopen yesterday's conversation.

**Build:** a component listing past sessions that dispatches a resume action.

**Needs:** session listing and resume. **Neither exists.** The core holds one
in-memory session created at startup; nothing lists what came before, and there is no
action that switches sessions. `Get /history` lists *commits of the UI directory*,
which is not the same thing.

**To unblock:** a session API in the core — list, read, resume — reading the harness's
native session store (the design says read it, never write it). That is core work,
not a component.

---

## Reporting the benchmark

When asked to run this as a benchmark, answer per recipe with one of:

- **built** — it works, and say which of the three survival checks passed;
- **blocked** — name the missing host capability, in one line, and what would provide
  it.

Do not mark a recipe built because a component renders something. The acceptance
criterion is the behaviour, and for a blocked recipe the honest output is the gap.
