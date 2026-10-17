# Composer context (Phase 3) — Implementation Plan

**Goal:** Resolve `@path:12-20` into confined content blocks in the core, and run `!cmd`/`!!cmd`
as a killed-on-demand process group streamed to a tool card, where `!!` cannot reach the model.

**Spec:** `docs/superpowers/specs/2026-10-17-composer-context-design.md`

## Global Constraints
- Explicit `.ts`/`.tsx` in every import specifier; `shared/` stays free of Node types.
- `confine()` is the only path gate. The wire names no cwd, shell or env.
- Two spawn sites in the core only: the agent (`core/acp/client.ts`), the user command (`core/shell.ts`).
- One permission story: the judging half of `handlePermission` is extracted, never duplicated.
- A shell run is not a turn: `status`, the queue and Stop are untouched.
- Shell output is `textContent` in a `<pre>`; never `innerHTML`, never `renderMarkdown`.
- `npm test` green with no network and no model; `npx tsc -b` clean.

## Review Focus
1. `!!` output must never reach `session/prompt` (Task 6).
2. A mention outside the known roots is refused, not clamped (Task 3).
3. A runaway command is killed by the cap (Task 5).
4. Cancel kills the GROUP, not just `sh` (Task 5).
5. A component-dispatched shell cannot dodge a manifest deny; a typed one can, by token (Task 7/7b).
6. A mention is shipped once, in place (Task 3).
7. A huge or binary file cannot produce a megabyte prompt (Tasks 2-3).

### Task 1: The grammar — `shared/mentions.ts` + tests
- [x] Test first (`shared/mentions.test.ts`), run red, implement `findMentions` / `parseShellCommand`, `npx vitest run shared/mentions.test.ts`, `npx tsc -b`.
- [x] Commit: `feat(shared): one grammar for mentions and shell commands`

### Task 2: `readLines` behind `confine()`
- [x] Tests first in `core/files.test.ts` (full range table + binary/dir/symlink/absolute/missing/over-cap), run red.
- [x] Implement next to `readText`, reusing `maxFileBytes` and the NUL probe.
- [x] `npx vitest run core/files.test.ts`; `npx tsc -b`.
- [x] Commit: `feat(core): a confined, ranged line read`

### Task 3: Mentions become blocks and `context` events
- [x] `UiEvent` gains the `context` member.
- [x] `core/mentions.test.ts` first (block forms, order, caps, refusals), run red.
- [x] `core/mentions.ts`; wire into the prompt handler after `live.ready()`, broadcasting events and prepending blocks; text unchanged.
- [x] `core/server.test.ts` scenario test for `@a.txt:1-2` with `fake:happy`.
- [x] `npx vitest run core/mentions.test.ts core/server.test.ts`; `npx tsc -b`.
- [x] Commit: `feat(core): expand @path:lines mentions into content blocks`

### Task 4: The `embeddedContext` fixture
- [x] `fake-acp-agent.ts`: scenario `blocks` advertising `embeddedContext: true`, emitting `<type>:<bytes>` per block; add to `SCENARIOS` and the sorted list in its test.
- [x] Test: with `fake:blocks` the stream shows `resource:`, and does NOT contain the file text.
- [x] `npx vitest run core/server.test.ts test/fixtures/fake-acp-agent.test.ts`.
- [x] Commit: `test: a fixture that advertises embedded context`

### Task 5: The shell runner
- [x] `core/shell.test.ts` first (the list in the spec), run red.
- [x] `core/shell.ts` per the spec: detached group, `/bin/sh`, no `-l`, timeout, cap that kills, coalescing, `stripControl`, `cancel()`.
- [x] `npx vitest run core/shell.test.ts`; `npx tsc -b`.
- [x] Commit: `feat(core): run a command as a killed-on-demand process group`

### Task 6: `!`/`!!` on the wire as a tool card
- [x] Protocol: `shell`, `shell.cancel`, `ContextEntry`, tool `origin`/`includeInContext`.
- [x] Server: `shell` case (reject empty, mint `shellId`, `cwd = sessionCwd`, broadcast spawn/chunk/exit), handle map, kill on `close()`, `shell.cancel`; track `sessionCwd` and add it to the known roots.
- [x] Reducer: accumulate `output`, keep `exitCode`/`origin`/`includeInContext`, capture `!` into `context` (capped 32 KiB), never capture `!!`.
- [ ] Render: `<pre>` output, exit code, `local only` tag, stop button.
- [x] Tests: `!` card, `!!` never reaches the prompt, `!` only with client-sent `context`, reducer capture/never-capture/cap.
- [x] Commit: `feat: ! and !! run in the core and stream into a tool card`

### Task 7: The permission story, two classes
- [x] Extract the judging half of `handlePermission` into one helper taking `class: 'agent' | 'operator'`; audit records the class.
- [x] Tests: manifest deny blocks a shell command; `commands = ["echo *"]` runs `echo hi` and denies `touch x`; all pre-existing manifest tests stay green UNCHANGED (that is the proof the extraction is behaviour-preserving).
- [x] Commit: `feat(core): a typed command faces the same manifest as the agent's`

### Task 7b: The operator token (escape hatch)
- [x] Core mints `operatorToken` at startup; never published on the state channel, `HostState`, `/state`, or `ctx`.
- [x] Host runtime attaches it only for BUILT-IN components; extension components get a `ctx.dispatch` that never attaches it.
- [x] Tests: (a) `[capabilities.shell] decision="deny"` + component-dispatched shell (no token) ⇒ denied; (b) same deny + valid token ⇒ RUNS (`operator` defaults allow); (c) `operator="deny"` ⇒ denied even with a token; (d) bogus token ⇒ treated as no token.
- [x] Commit: `feat: an operator token so a typed command can outrank the agent's manifest`

### Task 8: The client
- [x] `prompt.send` routes `!`/`!!` to `shell` before building a prompt; clears the input; no user bubble for a shell.
- [x] `Transcript.context` + `clearContext`; `context` reducer case; `HostState.pendingContext`; chip row + `context.remove`; `'context'` timeline row.
- [x] Add `pendingContext: []` to every `HostState` literal in the tree/host tests.
- [x] Tests: routing, context rides the next prompt only, context row, chips.
- [x] Commit: `feat(ui): ! and @ in the composer, and the context it will carry`

### Task 9: Suite, smoke, docs
- [x] Full suite + `tsc -b`.
- [x] Rendered check with Playwright against the LIVE config (verified: '[data-item="context"]' row `@a.txt:1-2 · 2 lines` with file lines reaching the agent; '!!echo SECRETLOCAL' card with output and 'local only' tag, secret absent from the following reply; '!echo HI' card with no tag plus composer chip) (the user's transcript override builds from raw events — it must be taught `context` and the shell card, or the smoke will silently miss them). Report screenshots.
- [x] `PLAN.md`, `docs/design.md`, and amend the spawner invariant in `AGENTS.md` to name both spawn sites. State both honest limits: `!!` hides output from the model, not from other clients; `!` puts whatever the command printed before the model, secrets included.
- [x] Commit: `docs: mentions resolve in the core, and !! only hides the output from the model`
