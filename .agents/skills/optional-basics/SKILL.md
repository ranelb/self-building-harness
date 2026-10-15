---
name: optional-basics
description: Optional first-run UI to build on top of SBH — a settings panel, a context meter, light/dark mode, and a sessions sidebar — as recipes with acceptance criteria, not shipped code. Use when asked to add settings, a context or token indicator, theme switching, or a past-chats sidebar to an SBH interface, or when benchmarking what SBH's component API can build today.
---

# Optional basics

Four things a new user expects an app to already have. They are deliberately **not
shipped as code**: each is a recipe you build as a component plus a layout entry, so
that the first thing anyone does with SBH is extend it.

**This is also SBH's capability benchmark.** Every recipe names the capability it
needs. All four are buildable today; the settings recipe is **partial** — a control
can persist to `localStorage`, but there is no shared, agent-visible store — and no
recipe is **blocked**. Say so per recipe, and name a missing capability instead of
inventing one.

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

## 2. Context meter — buildable

**Why:** a user wants to see how full the model's context is before it compacts.

**Build:** a component reading `ctx.host.data.usage`, which is
`{ used, size, cost? }` — tokens currently in context, the window size, and the
cumulative session cost when the agent reports one. Render a bar, a percentage, or
both.

**Needs:** nothing new. The agent reports it as an ACP `usage_update`; the core
normalises it into a `usage` event and the app folds it into `data.usage`.

**Acceptance:** it shows a dash before the first turn and a real percentage after
one, and it updates as the conversation grows.

**Note:** the number arrives with the turn, so it is not live between turns. That is
the agent's reporting cadence, not a limitation of the component.

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

## Anything else about this machine

The same channel carries it. Components run in the webview and can reach nothing,
but **the core is an ordinary process running as you**, so it can read anything you
can. The pattern is always: core samples → a `state` message → the app folds it into
`ctx.host.data[key]` → your component renders it.

`ctx.host.data.system` already carries a machine sample, refreshed every couple of
seconds:

```
{ cpu: { usage: 0..1, cores }, memory: { usedBytes, totalBytes, usage: 0..1 }, load: [1m, 5m, 15m] }
```

So a CPU widget, a memory bar or a load average is a component reading one field —
as is a disk, GPU, battery, network or MPRIS widget, once the core samples that too.
Adding a source is core work, not component work.

**One limit worth stating:** SBH is a window. It cannot put anything in your desktop's
bar — that is a shell plugin in a different toolkit, not a webview. It can *display*
anything the core can read, and the core could equally publish a file a bar consumes.
Say that plainly rather than implying the widget will appear in the bar.

## 4. Sessions sidebar — buildable

**Why:** a user wants to reopen yesterday's conversation and continue it.

**Build:** a component reading `ctx.host.sessions` — `{ id, title, cwd, startedAt,
updatedAt }`, newest first — and dispatching `session.open` with an id. The host asks
the core to `session/load` it: the agent replays the conversation as events, and the
next message continues that session. The default layout already ships this as the
`sessions` host component, with a filter and a count; restyle it or write your own.

**Needs:** nothing new. `GET /sessions` lists the agent's own sessions (pi's file
store is a fallback), read-only.

**Acceptance:** past conversations are listed with titles you recognise; opening one
shows its history, and sending a message continues it rather than starting a new one.

---

## Reporting the benchmark

When asked to run this as a benchmark, answer per recipe with one of:

- **built** — it works, and say which of the three survival checks passed;
- **partial** — say exactly which half works and which does not (the settings recipe
  is the current example: a control can persist to `localStorage`, but there is no
  shared, agent-visible store);
- **blocked** — name the missing host capability, in one line, and what would provide
  it.

Do not mark a recipe built because a component renders something. The acceptance
criterion is the behaviour, and for a blocked or partial recipe the honest output is
the gap.
