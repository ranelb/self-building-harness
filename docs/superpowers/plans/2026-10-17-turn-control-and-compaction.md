# Turn control and compaction (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialise prompts inside `AcpConnection` with a steer/follow-up distinction, give every turn an identity the reducer can trust, and turn pi-acp's compaction prose into a divider on the timeline.

**Architecture:** The queue, the `inFlight` flag and the turn-id counter live in one object (`core/acp/client.ts`) so every socket inherits serialisation and a teardown drops its own queue. `core/events.ts` converts the two pi-acp sentinels into a `compaction` event and strips them from the chunk stream. The UI reads `host.queued`, dispatches `prompt.send` with or without `steer`, and renders one new `TimelineItem` kind.

**Tech Stack:** TypeScript (Node 22 type-stripping), Vitest, Preact + happy-dom for the UI, the scripted fake ACP agent over stdio.

**Spec:** `docs/superpowers/specs/2026-10-17-turn-control-and-compaction-design.md`

## Global Constraints

- Explicit `.ts`/`.tsx` in every import specifier.
- `shared/protocol.ts` additions are plain data (string/number/boolean) — compiled by `tsconfig.app.json` with no Node types.
- The UI imports nothing from `core/`; `PromptOptions` stays in `core/acp/client.ts`.
- No new spawn path: `queue.clear` uses `conn?.`, never `ensureConnection()`.
- One `session/prompt` in flight per connection, ever.
- `HostState.status` keeps exactly `'idle' | 'streaming' | 'error'`; the queue is a depth.
- Compaction carries no summary and never reads the pi session store.
- No model prose as HTML: the divider label is host text, and the sentinels are removed.
- `npm test` green with no network and no model; `npx tsc -b` clean.

## Review Focus

Failure modes no happy-path test covers; each gets a test in an owning task.

1. **A second prompt must not reach the agent concurrently** — the fixture *rejects* a concurrent prompt, so a missing queue fails loudly. Task 2.
2. **A stale `turn.finished` must not flip the composer to idle** while a newer turn streams. Task 1.
3. **Steering must not wait for the turn it is cancelling** — assert the elapsed time, not just the outcome. Task 3.
4. **A sentinel chunk must be replaced, never duplicated** — the transcript must not show it and the divider must appear. Task 5.
5. **The divider must land between the surrounding prose**, which means it has to break chunk coalescing. Task 6.
6. **Clearing an empty queue must not spawn an agent.** Task 4.

---

### Task 1: Turn identity — protocol, the client's ids, the reducer's staleness guard

**Files:**
- Modify: `shared/protocol.ts` (`UiEvent` L81-82: `turn.started` / `turn.finished` gain `turnId`)
- Modify: `core/acp/client.ts` (module-level `turnSequence`; `ensureSession` emits at L292/L300; `prompt` emits at L320/L326)
- Modify: `src/ui/state/transcript.ts` (`Transcript.liveTurn`; `turn.started` L108, `turn.finished` L226)
- Test: `core/acp/client.test.ts`, `src/ui/state/transcript.test.ts`

**Interfaces:**
- Produces: `{ type: 'turn.started'; turnId: number }`, `{ type: 'turn.finished'; turnId: number; stopReason: string }` — required fields, exactly as in the spec.
- Produces: `Transcript.liveTurn?: number` (internal, not surfaced on `HostState`).
- Produces: the reducer rule `if (event.turnId !== state.liveTurn) return state` in `turn.finished`.
- Consumes: nothing.

- [x] **Step 1: Write the failing tests.** In `src/ui/state/transcript.test.ts`: `it('ignores a turn.finished that does not belong to the live turn')` — apply `turn.started{turnId:1}`, `turn.started{turnId:2}`, `turn.finished{turnId:1, stopReason:'cancelled'}` and expect `status === 'streaming'`; a second test expects `turn.finished{turnId:2}` to reach `'idle'`. In `core/acp/client.test.ts`: `it('pairs every turn.finished with its turn.started')` — two sequential `conn.prompt()` calls against `fake('happy')`, then assert the `turnId`s of the started list equal those of the finished list and are strictly increasing.
- [x] **Step 2: Run them.** `npx vitest run src/ui/state/transcript.test.ts` and `npx vitest run core/acp/client.test.ts` — FAIL (types reject the literals once the field is required; the pairing assertion fails today because there is no id).
- [x] **Step 3: Implement.** Add `turnId` to both union members in `shared/protocol.ts`. In `core/acp/client.ts` add `let turnSequence = 0` at module scope with the comment explaining why it is not per connection, and emit `{ type: 'turn.started', turnId: ++turnSequence }` / `{ type: 'turn.finished', turnId, stopReason }` from a single local `const turnId` in both the resume branch and the prompt body. In `transcript.ts` add `liveTurn` to the interface, set it in `turn.started`, and guard `turn.finished`.
- [x] **Step 4: Update the existing literals.** Every `{ type: 'turn.started' }` / `{ type: 'turn.finished', … }` in `src/ui/state/transcript.test.ts` (L17, 27, 29, 30, 47, 57, 70, 73, 74, 86, 124) needs a `turnId`, numbered per test so the section it belongs to stays one turn. `src/ui/state/stream.test.ts:53` and `src/App.test.tsx:63` send JSON strings and need no change.
- [x] **Step 5: Run it.** `npx vitest run core/acp/client.test.ts src/ui/state/transcript.test.ts` — PASS. Then `npx tsc -b` — clean.
- [x] **Step 6: Commit.** `git commit -m "feat(core): give every turn an id and ignore a stale finish"`

### Task 2: The queue inside `AcpConnection`

**Files:**
- Modify: `core/acp/client.ts` (`QueuedPrompt`, `inFlight`, `queued`, `enqueue`, `drain`; `prompt` L317-336; `close` L351-353)
- Modify: `test/fixtures/fake-acp-agent.ts` (`SCENARIOS` L13-21, `queue-turn` scenario, the concurrency guard and `stopReason` return in `serve`)
- Modify: `test/fixtures/fake-acp-agent.test.ts` (the exact sorted `SCENARIOS` array, L5-12)
- Test: `core/acp/client.test.ts`

**Interfaces:**
- Produces: `inFlight: boolean`, `queued: QueuedPrompt[]`, `async drain()`, `enqueue(entry)` — private to `connectAcp`, per the spec's pseudocode.
- Produces: `prompt()` serialises; a queued prompt's promise resolves when its own turn settles, or when it is dropped.
- Produces: fixture scenario `'queue-turn'` — echoes `start <prompt> `, holds 300 ms, echoes `end <prompt>`, answers `end_turn`; any concurrent `session/prompt` is answered `{ error: { code: -32000, message: 'concurrent prompt' } }`.
- Consumes: `turnSequence` (Task 1).

- [x] **Step 1: Write the failing fixture.** Add `'queue-turn'` to `SCENARIOS` and to the sorted list in `fake-acp-agent.test.ts`. In `serve()`'s `session/prompt` case add the guard: if a prompt is already unresolved, answer with the `-32000` error and return; otherwise mark it in flight around the existing dispatch, and let `runScenario` return an optional `stopReason` string that overrides `'end_turn'`.
- [x] **Step 2: Write the failing test.** `core/acp/client.test.ts`: `it('runs a second prompt after the first finishes, not concurrently')` — `fake('queue-turn')`, `const a = conn.prompt('one')`, `const b = conn.prompt('two')`, `await Promise.all([a, b])`; assert no `error` events, exactly two `turn.started`, and that the joined chunk text has `start one … end one` before `start two`.
- [x] **Step 3: Run it.** `npx vitest run core/acp/client.test.ts -t 'runs a second prompt'` — FAIL (an `error` event from the fixture's `-32000`).
- [x] **Step 4: Implement** the queue exactly as the spec's pseudocode states: enqueue in `prompt()`, a single `drain()` that is the only writer of `inFlight` and the only emitter of `turn.started`/`turn.finished`, `next.resolve()` in the `finally`, and `queued.splice(0).forEach((entry) => entry.resolve())` in `close()`. `cancel()` keeps its body and gains one comment line: it cancels the in-flight turn and leaves the queue running.
- [x] **Step 5: Run it.** `npx vitest run core/acp/client.test.ts` — PASS, including the pre-existing `cancel` and resume tests. `npx tsc -b`.
- [x] **Step 6: Commit.** `git commit -m "feat(core): serialise prompts in the connection, not in the server"`

### Task 3: Steer — cancel, jump the queue, and say so on the wire

**Files:**
- Modify: `shared/protocol.ts` (`ClientToCore.prompt` L113 gains `steer?: boolean`)
- Modify: `core/acp/client.ts` (`PromptOptions`, `AcpConnection.prompt` signature L24-25, the steer branch of `enqueue`/`prompt`)
- Modify: `core/server.ts` (L598-620: pass `{ steer: msg.steer === true }`)
- Modify: `test/fixtures/fake-acp-agent.ts` (`steer` scenario; `waitCancel` helper reused by the existing `cancel` case)
- Test: `core/acp/client.test.ts`, `core/server.test.ts`

**Interfaces:**
- Produces: `export interface PromptOptions { steer?: boolean }` and `prompt(text, extra?, options?: PromptOptions)`.
- Produces: fixture scenario `'steer'` — the first prompt emits `"slow "`, awaits `waitCancel(3000)`, emits `"interrupted"` or `"finished"` and returns `'cancelled'` or `'end_turn'`; every later prompt emits `"echo <prompt>"` and answers immediately.
- Consumes: the queue (Task 2), turn ids (Task 1).

- [x] **Step 1: Write the failing fixture.** Add `'steer'` to `SCENARIOS` and to the sorted list in `fake-acp-agent.test.ts`. Extract the existing `cancelRequested`/`resolveCancel` pair into `waitCancel(ms): Promise<boolean>`, keep the `'cancel'` scenario's behaviour identical, and add the `'steer'` scenario on top of it.
- [x] **Step 2: Write the failing tests.** `core/acp/client.test.ts`: `it('steers: cancels the in-flight turn and jumps the queue')` — `fake('steer')`, `conn.prompt('slow')`, wait for a chunk, record `Date.now()`, `await conn.prompt('redirect', [], { steer: true })`, assert the first `turn.finished.stopReason === 'cancelled'`, the second turn's chunks contain `echo redirect`, no `error` events, and the elapsed time is under 2000 ms (the hold is 3000). `it('keeps a steer ahead of an earlier follow-up')` — start `slow`, queue `later` without steer, then steer `now`; the echo order is `now` then `later`.
- [x] **Step 3: Run them.** `npx vitest run core/acp/client.test.ts -t 'steer'` — FAIL.
- [x] **Step 4: Implement.** Add `steer` to the protocol's `prompt` member and `PromptOptions` to `client.ts`; enqueue steers after the leading steers and before every follow-up (`findIndex((waiting) => !waiting.steer)`), send `session/cancel` at enqueue time when `inFlight`, and let `drain` handle the rest. Then in `core/server.ts` pass the flag through.
- [x] **Step 5: Run them.** `npx vitest run core/acp/client.test.ts core/server.test.ts` — PASS. `npx tsc -b`.
- [x] **Step 6: Commit.** `git commit -m "feat: steer — cancel the turn and jump the queue"`

### Task 4: Queue depth, the badge, and `queue.clear`

**Files:**
- Modify: `shared/protocol.ts` (`UiEvent` gains `{ type: 'queue'; pending: number }`; `ClientToCore` gains `{ type: 'queue.clear' }`)
- Modify: `shared/ui.ts` (`HostState.queued: number`)
- Modify: `core/acp/client.ts` (`publishQueue`, `clearQueue()` on the interface, calls from `enqueue`/`drain`/`close`)
- Modify: `core/server.ts` (`if (msg.type === 'queue.clear') { conn?.clearQueue(); return }` after L622-624)
- Modify: `src/ui/state/transcript.ts` (`queued: number` on `Transcript`, `empty()`, a `queue` case)
- Modify: `src/App.tsx` (`hostState.queued`, `case 'queue.clear'` next to L231-233)
- Modify: `src/ui/host/components.ts` (badge `[data-queued]`, `button[data-queue-clear]` in create ~L680-700, wired in update ~L786-800)
- Test: `core/acp/client.test.ts`, `core/server.test.ts`, `src/ui/state/transcript.test.ts`, `src/ui/host/transcript.test.ts`

**Interfaces:**
- Produces: `clearQueue(): number` on `AcpConnection`; `Transcript.queued` / `HostState.queued`; action `queue.clear`.
- Consumes: the queue (Task 2).

- [x] **Step 1: Write the failing tests.** `src/ui/state/transcript.test.ts`: `it('counts the queue depth')` — `{ type: 'queue', pending: 2 }` ⇒ `queued === 2`, and `session.reset` ⇒ `0`. `core/acp/client.test.ts`: `it('clearQueue drops only the waiting prompts')` and `it('drops the queue when the connection closes')`. `core/server.test.ts`, `describe('turn control')`: `it('publishes the queue depth')` (`fake:queue-turn`, two prompts, expect a `queue` event with `pending: 1` then `pending: 0`) and `it('does not spawn an agent to clear an empty queue')` (send `queue.clear` first, then assert `/sessions` is empty / no session was created). `src/ui/host/transcript.test.ts`: `it('shows the depth badge and clears the queue')`.
- [x] **Step 2: Run them.** `npx vitest run src/ui/state/transcript.test.ts core/acp/client.test.ts core/server.test.ts -t 'queue'` — FAIL.
- [x] **Step 3: Implement** `publishQueue()` (emit only on a depth change), `clearQueue()`, the `queue` reducer case, the `HostState.queued` mapping in `src/App.tsx:179-199`, the `queue.clear` server case with `conn?.`, and the composer's badge plus Clear button.
- [x] **Step 4: Add `queued: 0` to every `HostState` literal.** `src/ui/host/transcript.test.ts:29`, `src/ui/tree/destroy.test.ts:17`, `src/ui/tree/reconcile.test.ts:18`, `src/ui/tree/render.test.ts:21`.
- [x] **Step 5: Run it.** `npx vitest run src/ui/state/transcript.test.ts src/ui/host/transcript.test.ts core/acp/client.test.ts core/server.test.ts` — PASS. `npx tsc -b`.
- [x] **Step 6: Commit.** `git commit -m "feat: queue depth on the wire, and a way to empty the queue"`

### Task 5: Compaction in the core — sentinels to an event

**Files:**
- Modify: `shared/protocol.ts` (`UiEvent` gains `{ type: 'compaction'; phase: 'start' | 'end' }`)
- Modify: `core/events.ts` (`COMPACTION_START` / `COMPACTION_END` / `compactionPhase` near `textOf` L17-21; the `agent_message_chunk` case L61-64)
- Modify: `test/fixtures/fake-acp-agent.ts` (`compaction` scenario; `SCENARIOS` and the sorted list)
- Test: `core/events.test.ts`, `core/acp/client.test.ts`

**Interfaces:**
- Produces: `compactionPhase(text): 'start' | 'end' | null`, trimmed exact equality on the two literals.
- Produces: fixture scenario `'compaction'` — four chunks: `"before "`, the start sentinel, the end sentinel, `"after"`.
- Consumes: nothing (parallel with Tasks 1-4).

- [ ] **Step 1: Write the failing tests.** `core/events.test.ts`: `it('turns a compaction sentinel into a compaction event, not text')` for both literals, and `it('leaves a sentence that mentions compaction alone')` (the end sentence plus `' ok'` stays a `chunk`). `core/acp/client.test.ts`: `it('emits a compaction event and no sentinel prose')` — joined chunk text is `'before after'`, phases `['start', 'end']`.
- [ ] **Step 2: Run them.** `npx vitest run core/events.test.ts -t 'compaction'` — FAIL.
- [ ] **Step 3: Implement** the constants, `compactionPhase`, and the branch in `agent_message_chunk` that returns the event instead of the chunk. Add the fixture scenario with both literals written out verbatim (deliberately duplicated, not imported).
- [ ] **Step 4: Run it.** `npx vitest run core/events.test.ts core/acp/client.test.ts test/fixtures/fake-acp-agent.test.ts` — PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): turn pi-acp's compaction prose into an event"`

### Task 6: The divider on the timeline

**Files:**
- Modify: `shared/ui.ts` (`TimelineItem` gains `{ id: string; kind: 'divider'; pending?: boolean }` after L53)
- Modify: `src/ui/state/transcript.ts` (a `compaction` case before `default` L238)
- Modify: `src/ui/host/components.ts` (`renderItem` L127: a divider branch before the `// tool` fallthrough L189)
- Test: `src/ui/state/transcript.test.ts`, `src/ui/host/transcript.test.ts`

**Interfaces:**
- Produces: `TimelineItem` kind `'divider'`; one divider per compaction; `agentTurn: undefined` so chunk coalescing breaks across it.
- Consumes: the `compaction` event (Task 5).

- [ ] **Step 1: Write the failing tests.** `src/ui/state/transcript.test.ts`: `it('inserts a divider between the prose around a compaction')` — `turn.started`, `chunk 'before'`, `compaction start`, `chunk 'after'` ⇒ kinds `['agent', 'divider', 'agent']` and the divider is `pending: true`; `it('closes the pending divider on the end sentinel')`; `it('inserts a closed divider for an end with no matching start')`. `src/ui/host/transcript.test.ts`: `it('renders a divider item')` — `[data-item="divider"]` exists and its text is `context compacted`.
- [ ] **Step 2: Run them.** `npx vitest run src/ui/state/transcript.test.ts src/ui/host/transcript.test.ts -t divider` — FAIL.
- [ ] **Step 3: Implement** the union member, the reducer case (with the `agentTurn` reset and its comment), and the render branch: two hairline rules with the host-owned label between them, `var(--sbh-color-text-muted)`, no `innerHTML`, no `renderMarkdown`. `'compacting context'` while pending, `'context compacted'` after.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b` — the `// tool` fallthrough must still type-check as `'tool'` after the new branch.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): a divider where the agent compacted its context"`

### Task 7: The composer's deliberate choice

**Files:**
- Modify: `src/ui/host/components.ts` (`keydown` L731-732; `button[data-queue]` in create L756-773; `update` L786-800)
- Modify: `src/App.tsx` (dispatch props type L203-213; `prompt.send` L258-285)
- Test: `src/ui/host/transcript.test.ts`, `src/App.test.tsx`

**Interfaces:**
- Consumes: `host.queued` (Task 4), `steer` on the wire (Task 3).
- Produces: `Enter` ⇒ `prompt.send` with no payload; `Shift+Enter` ⇒ `prompt.send { steer: true }`; `button[data-queue]` ⇒ plain `prompt.send`, visible only while streaming.

- [ ] **Step 1: Write the failing tests.** `src/ui/host/transcript.test.ts`: extend the `withStatus` helper's dispatch spy to record `(action, payload)` in a separate array while keeping `actions: string[]` so existing assertions are untouched; add `it('queues on Enter while streaming and steers on Shift+Enter')` dispatching real `KeyboardEvent`s on `input[data-atom="input"]`, and `it('shows a Queue button only while streaming')`. `src/App.test.tsx`: `it('puts steer on the wire')` — `turn.started`, type a draft, `Shift+Enter`, then assert `socket.sent` contains `{ type: 'prompt', text: 'hi', steer: true }`.
- [ ] **Step 2: Run them.** `npx vitest run src/ui/host/transcript.test.ts src/App.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the key handler, the Queue button, the `steer` prop plumbing in `prompt.send`, and the button's `title` naming both bindings. Leave the `Send`/`Stop` toggle (`L788`) and the Escape handler (`L732`) exactly as they are.
- [ ] **Step 4: Run it.** `npx vitest run src/ui/host/transcript.test.ts src/App.test.tsx` — PASS, including the two pre-existing composer button tests. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): Enter queues a follow-up, Shift+Enter steers"`

### Task 8: Full suite, manual smoke, docs

**Files:**
- Modify: `PLAN.md` (decision records), `docs/design.md` (one paragraph: prompts are serialised in the connection; compaction is a marker derived from prose)

- [ ] **Step 1:** `npx vitest run core/acp/client.test.ts core/events.test.ts core/server.test.ts src/ui/state/transcript.test.ts src/ui/host/transcript.test.ts src/App.test.tsx` — green.
- [ ] **Step 2:** `npx tsc -b` clean; `npm test` green with no network and no model.
- [ ] **Step 3: Manual smoke, no model:**

  ```bash
  SBH_BACKEND=fake:queue-turn SBH_PORT=45999 npm run core &
  VITE_CORE_URL=ws://127.0.0.1:45999/ws npx vite --port 5173 --strictPort
  ```

  Type `one`, press Enter, then `two`, press Enter while the first is streaming. Expect: two messages, the `1 queued` badge, then two answers in order and no error. Then repeat against `SBH_BACKEND=fake:compaction` and check the divider lands between `before` and `after`.

- [ ] **Step 4:** Record the decisions in `PLAN.md` (queue in the connection; Enter queues / Shift+Enter steers; Stop keeps the queue; turn ids are process-global; compaction is prose-matched with no summary) and a paragraph in `docs/design.md`. State the sentinel limitation there, not only in the spec.
- [ ] **Step 5: Commit.** `git commit -m "docs: prompts are serialised, and compaction is a marker"`

---

## Self-Review

- **Spec coverage:** turn ids (Task 1), queue (2), steer (3), depth/clear (4), compaction core (5), divider (6), composer control (7), docs and smoke (8). The spec's non-goals map to "no task": no session JSONL, no summary, no persistence, no re-send of dropped prompts, no turn-scoped cancel.
- **Step scan:** every task is write-the-failing-test → run → implement → run → `npx tsc -b` → commit, with the command spelled out.
- **Type consistency:** `turnId`, `compaction.phase`, `queue.pending`, `PromptOptions.steer`, `clearQueue()` and `TimelineItem 'divider'` are each declared once (Tasks 1, 3, 4, 5, 6) and consumed verbatim, never re-declared.
- **Review Focus:** modes 1-2 in Tasks 2 and 1, 3 in Task 3, 4 in Task 5, 5 in Task 6, 6 in Task 4.
- **Ordering:** Task 1 blocks 2 and 3. Task 2 blocks 3 and 4. Task 7 needs 3 and 4. Tasks 5-6 are independent of 1-4 and can run in parallel; they share only `shared/protocol.ts` (union members) with the others, so land them as separate commits and expect a trivial rebase there.
- **Proportion:** no task reproduces a body a signature plus a test already determines, except where the spec pins the pseudocode, which Task 2 must follow literally.

## Risks

- **Required `turnId` breaks compilation in `src/ui/state/transcript.test.ts`** (11 literals). Task 1 Step 4 fixes them in the same commit; a worker who skips it will see `npx tsc -b` fail and should not "fix" it by making the field optional.
- **The fixture's concurrency guard is the whole test for the queue.** If it only tolerated a concurrent prompt instead of rejecting it, Task 2 would pass without a queue. Verify the guard answers `-32000`.
- **Steering's elapsed-time assertion is the only proof the cancel is not just a no-op waiting for the hold.** Keep the 3000 ms hold and the `under 2000 ms` assertion; a shorter hold makes it flaky in both directions.
- **`agentTurn: undefined` is what puts the divider in the right place.** A reducer that appends the divider without it renders `before after` as one item with the divider below both.
- **Session switches discard the queue.** `session.new` / `session.fork` / a backend switch drop it silently; the queued user messages stay in the transcript unanswered. Documented, not fixed.
- **A backend that ignores `session/cancel` wedges the queue**; the remedy is a teardown. The fixture and pi-acp both answer a cancel, so the suite cannot catch a regression here.
- **`queue.clear` and the badge are cuttable.** If the phase must shrink, Task 4 loses its badge and the `queue.clear` member; the queue then cannot be emptied except by a teardown, which makes rule 6 a trap — say so out loud if you cut it.

## Assumptions

- "Phase 2 of the core-parity work" is the turn-control/compaction track, independent of the project-file-panel track, whose own spec calls this work "Phase 3". Both dated 2026-10-17.
- `Enter` queues and `Shift+Enter` steers (the brief's example listed the inverse). The brief said "e.g." and the choice is made for safety: the reflexive key must not cancel work. Inverting it is a two-line edit in Task 7 and changes nothing else — `steer` is a hint, so the queue, the wire and the tests are all unchanged.
- The composer stays a single-line `<input>`, so `Shift+Enter` is free (no multi-line draft to protect).
- pi-acp keeps emitting each compaction sentinel as its own `agent_message_chunk` with no surrounding whitespace; verified against the installed `pi-acp/dist/index.js`. If it starts wrapping them, the trimmed-exact match stops firing and the divider disappears — the accepted failure mode.
- goose emits no compaction signal at all, so the divider is pi-only for now. Nothing in the code assumes a backend; it simply never fires for goose.
- The scratch tree already has `git` available and the fixture runnable, since `npm test` is the baseline.
