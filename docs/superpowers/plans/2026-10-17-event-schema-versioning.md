# Event schema versioning — plan

Spec: `../specs/2026-10-17-event-schema-versioning-design.md`

## Task 1 — publish the schema (this change)

- [ ] 1.1 RED: `shared/protocol.test.ts` asserts `UI_EVENT_KINDS` has every
      `UiEvent` type (exhaustive list check) and no duplicates.
- [ ] 1.2 GREEN: add `EVENT_SCHEMA_VERSION = 1` and `UI_EVENT_KINDS` to
      `shared/protocol.ts`; add a `satisfies` check against `UiEvent['type']`.
- [ ] 1.3 RED: `core/server.test.ts` asserts a new client receives
      `state/schema` with `version === EVENT_SCHEMA_VERSION` and kinds
      containing `context`, `compaction`, `queue`.
- [ ] 1.4 GREEN: send the `schema` state in the connection handler in `core/server.ts`.
- [ ] 1.5 `HostState.schema` in `shared/ui.ts`; populate in `src/App.tsx` from
      `data.schema` (default `{ version: 0, kinds: [] }`); add `schema` to every
      HostState literal in the tree/host/App tests.
- [ ] 1.6 Verify: `npx vitest run shared core`, `npx tsc -b`, `npm test`.
- [ ] 1.7 Commit `docs: spec and plan for event schema versioning`, then
      `feat: publish the event schema so an override can know what it must handle`.
      No push.

## Task 2 — runtime notice (not started)

- [ ] 2.1 Optional `handledEvents` on the component contract (type + docs).
- [ ] 2.2 Host runtime computes missing kinds; renders the muted notice beside output.
- [ ] 2.3 Tests: missing kinds, no declaration on an override, full coverage, no throw.
