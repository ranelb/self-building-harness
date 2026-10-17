# Event schema versioning and override staleness notice

Status: design, 2026-10-17. Task 1 implemented; Task 2 (runtime notice) pending.

## Problem

Components in `~/.config/sbh/components` may override built-ins. A user's
`sbh-transcript.js` builds its timeline from raw websocket events, so every new
`UiEvent` kind is silently dropped until the component is taught it. This has
happened twice (compaction, then context). The failure must be visible.

## Design

**Contract in `shared/protocol.ts`.**
- `EVENT_SCHEMA_VERSION`: an integer, bumped whenever `UiEvent` gains a kind.
  Starts at `1`.
- `UI_EVENT_KINDS`: a readonly array of every `UiEvent['type']`. Exhaustive by
  construction: a test asserts it matches the union, so it cannot drift silently.

**Publication by the core.** On every socket connect, the core sends
`{ type: 'state', key: 'schema', value: { version, kinds } }`, next to the
harness/model/config/capabilities states. Any client can then know what it may
receive.

**Host state.** `HostState` gains `schema: { version: number; kinds: string[] }`.
Components read it from `ctx.host.schema`. Until the state arrives the client
holds `{ version: 0, kinds: [] }`, which means "unknown", not "nothing handled".

**Component contract (optional export).** A component may export
`handledEvents?: string[]`: the `UiEvent` kinds it renders. Documented in the
component API. Omitting it is valid; no existing component breaks.

**Runtime check (Task 2).** The host runtime compares each component's
`handledEvents` with `host.schema.kinds`:
- missing kinds: a visible notice inside that component's container,
  e.g. `component is out of date — missing: context, compaction`. Muted,
  design tokens only, `textContent` only.
- overrides a built-in by name but declares no `handledEvents`: a softer notice,
  `does not declare handledEvents; new event kinds may be dropped silently`.
- full coverage: nothing.

The notice never throws and never replaces the component's output. It is added
beside the output, not instead of it.

## Non-goals

- No enforcement: a component may still ignore kinds.
- No auto-fixing and no version negotiation.
- No breaking change to the component API; the export is optional.
- No change to the wire format of existing events.

## Risks

- A stale `schema` value on a reconnect: the core re-sends it on every connect,
  so the client overwrites it.
- Kinds the client does not know (a newer core): the list is data, not an enum,
  so unknown names are reported, not crashed on.
