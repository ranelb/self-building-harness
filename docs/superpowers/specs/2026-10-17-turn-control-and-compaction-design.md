# Turn control and compaction — Phase 2: the core-parity track

Status: design for review. Author: pi. Date: 2026-10-17.
Contract to change: `shared/protocol.ts` (`UiEvent`, `ClientToCore`), `shared/ui.ts`
(`TimelineItem`, `HostState`), `core/acp/client.ts` (the queue, turn ids),
`core/events.ts` (the compaction sentinels), `core/server.ts` (two cases),
`src/App.tsx` (dispatch), `src/ui/state/transcript.ts` (reducer),
`src/ui/host/components.ts` (composer + divider), `test/fixtures/fake-acp-agent.ts`.

Phase numbering note: this is **Phase 2 of the core-parity track**, not of the
project-file-panel track. `2026-10-17-project-file-panel-design.md` calls steer and
compaction "Phase 3"; that document's phase boundary is about the panel and its
routes, which nothing here touches. Read the two phase tracks as independent.

## Goal

Two things a harness does that SBH currently does not, done in the core so every
client gets them:

1. **A prompt sent while a turn is running is scheduled, not raced.** Today
   `core/server.ts:598-620` fire-and-forgets a `void (async () => …)()` per message
   with no queue, so two `prompt` messages produce two concurrent
   `session/prompt` requests. An agent that enforces one turn at a time answers the
   second with a JSON-RPC error; the transcript shows an error and the message is
   lost. Enter-while-streaming in the composer (`src/App.tsx:258-285` never checks
   `status`) already walks into this today.
2. **A compaction is visible.** pi-acp forwards compaction as two prose chunks and
   nothing else, so a transcript silently gains two lines of harness plumbing and no
   marker. A hairline divider says what happened.

Success: `npm test` is green with no network and no model; `npx tsc -b` clean; two
prompts submitted back to back produce two ordered turns and zero errors against the
fake agent; a steered prompt cancels the in-flight turn and jumps the queue; the
pi-acp compaction sentinels never appear as agent prose.

## Non-goals / explicitly out

- **Reading the pi session JSONL.** The divider is derived from prose on the wire,
  per the decision recorded below. No session-map dependency, no file parsing, no
  new `core/sessions.ts` surface.
- **Summary text on the divider.** It carries a marker, not the summary the agent
  wrote into its own store. SBH does not read the store, so it does not have one.
- **Queue persistence.** A restart, a backend switch or `session.new` drops the
  queue. Nothing is written to disk.
- **Re-sending dropped prompts.** See Risks; the user's text is still in the
  transcript and must be sent again.
- **A per-turn wire-scoped cancel.** ACP's `session/cancel` names a session, not a
  turn; we cannot fix that here.
- **Interrupting with a tool call, forking mid-turn, or a "stop after this turn"
  variant.** Not in this phase.
- **Anything from the project-file-panel track.** No route, no host component for
  files, no layout node.

## Why the queue lives in `AcpConnection` and not in `server.ts`

`core/server.ts:598-620` accepts a prompt, awaits `sessionSwitch`, then awaits
`live.prompt(...)`. Nothing serialises those async IIFEs, and `conn` is replaced by
`session.new` / `session.fork` / a backend switch (`ensureConnection`, L302-320) —
so a queue held in `server.ts` keys to a connection that may already be dead. Put it
in `connectAcp` and the invariant is owned by the object that owns the wire:

- one connection, one `session/prompt` in flight, ever;
- a teardown drops its own queue instead of orphaning it in the server;
- every client (desktop, phone, a CLI over the socket) inherits serialisation
  without knowing it exists;
- `core/acp/client.test.ts` can test the whole thing with the fixture, no server, no
  socket.

`server.ts` keeps exactly two responsibilities: hand the flag down, and refuse to
spawn an agent just to clear an empty queue.

## The state machine

Two observable facts, one state: `inFlight: boolean` and `queue: QueuedPrompt[]`
inside `connectAcp`. The connection states are derived, never stored.

| state      | inFlight | queue | observable (wire)                          |
|------------|----------|-------|--------------------------------------------|
| `idle`     | false    | 0     | `status: idle`, `queue.pending: 0`         |
| `streaming`| true     | 0     | `status: streaming`, `queue.pending: 0`    |
| `queued`   | true     | >0    | `status: streaming`, `queue.pending: N`    |

`queued` is **a depth, not a third status**. `Transcript.status` stays
`'idle' | 'streaming' | 'error'` (`src/ui/state/transcript.ts:21`) and `HostState.status`
stays as it is, so every existing status test and the Send/Stop toggle keep meaning
what they meant. The depth is published alongside as `Transcript.queued` / `HostState.queued`.

Transitions, each with what is emitted:

1. `idle --prompt(no steer)--> streaming`. Enqueue, see it is empty and idle, drain
   synchronously: `turn.started(id)`, then the request.
2. `idle --prompt(steer)--> streaming`. `steer` is a **hint**; with nothing in flight
   there is nothing to cancel. Same as (1). No `session/cancel` is sent.
3. `streaming --prompt(no steer)--> queued`. Push the tail, publish depth. Nothing
   else happens until the turn settles.
4. `streaming --prompt(steer)--> queued`. Insert ahead of the waiting follow-ups
   (after any earlier steers), publish depth, send `session/cancel`. The cancelled
   turn settles (`stopReason: 'cancelled'`), the queue drains: `turn.finished(idA)`
   then `turn.started(idB)`.
5. `queued --turn settles--> streaming | idle`. `finally` clears `inFlight`, resolves
   this entry's promise, republishes depth, drains. Non-empty queue ⇒ the next entry
   starts and `queued` drops by one rather than returning to `idle`.
6. `queued --cancel() (Stop, Escape)--> queued`. Cancels the **in-flight turn only**.
   A queued prompt is a promise the user already watched appear in the transcript;
   breaking it needs an explicit act (7).
7. `queued --queue.clear--> streaming | idle`. Drop every waiting entry, resolve
   their promises, publish depth 0. The in-flight turn is untouched.
8. any --close()--> terminal. Drop the queue, resolve those promises, kill the child.
   `closing` is already set, so a teardown emits no error
   (`core/acp/client.ts:240-250`).

## Type additions — verbatim

`shared/protocol.ts`, `UiEvent` — replace L81-82 and add the queue depth event:

```ts
  /**
   * A turn's identity. Monotonic across the whole core process, never reused, so
   * a settlement that arrives after a later turn began can be recognised as stale.
   */
  | { type: 'turn.started'; turnId: number }
  | { type: 'turn.finished'; turnId: number; stopReason: string }
  /**
   * pi-acp reports compaction only as prose chunks. The core strips those and emits
   * this instead; it carries no summary, because SBH does not read the session store.
   */
  | { type: 'compaction'; phase: 'start' | 'end' }
  /** How many prompts are waiting behind the in-flight turn. Emitted on change. */
  | { type: 'queue'; pending: number }
```

`shared/protocol.ts`, `ClientToCore` — L113-114 become:

```ts
  /**
   * Send a prompt. Without `steer` it is queued behind the in-flight turn; with it,
   * the in-flight turn is cancelled and this prompt jumps ahead of the queued
   * follow-ups. A no-op distinction when nothing is running.
   */
  | { type: 'prompt'; text: string; attachments?: Attachment[]; steer?: boolean }
  | { type: 'cancel' }
  /** Drop the prompts waiting behind the in-flight turn. Does not start an agent. */
  | { type: 'queue.clear' }
```

`shared/ui.ts`, `TimelineItem` — a new kind after the `thought` variant (L53):

```ts
  /**
   * A visual boundary, not a message: the agent compacted its context here. Carries
   * no text of its own — the host owns the wording, because the agent's summary is
   * in a store SBH deliberately does not read.
   */
  | { id: string; kind: 'divider'; pending?: boolean }
```

`shared/ui.ts`, `HostState` — one field next to `status`:

```ts
  /** Prompts waiting behind the in-flight turn; 0 when nothing is queued. */
  queued: number
```

`src/ui/state/transcript.ts` — `Transcript` (L18-33) gains one internal field:

```ts
  /** Prompts waiting behind the live turn, mirrored from the core's `queue` event. */
  queued: number
  /** The core's id for the turn currently streaming (internal). */
  liveTurn?: number
```

`core/acp/client.ts` — new options type and two interface members:

```ts
export interface PromptOptions {
  /**
   * Interrupt the in-flight turn and jump ahead of the queued follow-ups. A hint:
   * with nothing in flight it is an ordinary prompt.
   */
  steer?: boolean
}
```

```ts
  /**
   * Send a prompt. Resolves when *this* prompt's turn settles, or when it is dropped
   * by `clearQueue`/`close`. One `session/prompt` is in flight at a time.
   */
  prompt(text: string, extra?: AcpContentBlock[], options?: PromptOptions): Promise<void>
  /** Drop the prompts waiting behind the in-flight turn; returns how many. */
  clearQueue(): number
```

`cancel()` (L41, L356-361) keeps its meaning and its comment, with one added line:
it cancels the in-flight turn **and leaves the queue running**.

## The queue algorithm

Module scope in `core/acp/client.ts` (shared by every connection, see turn ids):

```ts
let turnSequence = 0
```

Inside `connectAcp`:

```ts
interface QueuedPrompt {
  text: string
  extra: AcpContentBlock[]
  steer: boolean
  resolve: () => void
}

let inFlight = false
let queued: QueuedPrompt[] = []
let queueReported = 0          // last depth published, so only changes are emitted

function publishQueue() {
  if (queued.length === queueReported) return
  queueReported = queued.length
  emit({ type: 'queue', pending: queueReported })
}

async function drain() {
  if (inFlight) return                 // re-entrant call from a settling turn
  const next = queued.shift()
  if (!next) return publishQueue()
  publishQueue()
  inFlight = true
  const turnId = ++turnSequence
  emit({ type: 'turn.started', turnId })
  try {
    const res = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: next.text }, ...next.extra],
    })
    emit({ type: 'turn.finished', turnId, stopReason: res?.result?.stopReason ?? 'end_turn' })
  } catch (err) {
    if (!closing) emit({ type: 'error', message: (err as Error).message })
  } finally {
    inFlight = false
    next.resolve()
    void drain()
  }
}

const enqueue = (entry: QueuedPrompt) => {
  if (!entry.steer) {
    queued.push(entry)
    return
  }
  // Steers keep their arrival order among themselves and stay ahead of follow-ups.
  const at = queued.findIndex((waiting) => !waiting.steer)
  if (at < 0) queued.push(entry)
  else queued.splice(at, 0, entry)
}

async prompt(text, extra = [], options = {}) {
  await ensureSession()
  if (handshakeError) return
  const steer = options.steer === true
  return new Promise<void>((resolve) => {
    enqueue({ text, extra, steer, resolve })
    publishQueue()
    if (steer && inFlight) {
      // A notification naming the session, not a turn: ACP cannot scope it further.
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    }
    void drain()
  })
}

clearQueue() {
  const dropped = queued
  queued = []
  publishQueue()
  for (const entry of dropped) entry.resolve()
  return dropped.length
}
```

`close()` gains `queued.splice(0).forEach((entry) => entry.resolve())` before the kill,
next to the existing `closing = true` (L351-353). `prompt()` no longer emits
`turn.started`/`turn.finished` itself; `drain()` is the only emitter, which is what
makes the pairing invariant true by construction.

Two details that are not stylistic:

- **`drain` is the only writer of `inFlight`**, and it sets the flag before its first
  `await`. Without that, two `prompt()` calls in the same tick both pass the guard
  and the agent gets a concurrent prompt.
- **`session/cancel` is sent at enqueue time, not at drain time.** Waiting for the
  cancelled turn's response before sending the cancel would make steering take as
  long as the turn it is trying to stop.

## Turn id semantics

`turnSequence` is **module-level**, not per connection. Normally that would be
over-engineering for a value nobody persists; here it is load-bearing. A connection
that is replaced (`session.new`, `session.fork`, a backend switch: `core/server.ts:369-380`,
`L631-644`) can still deliver a settlement afterwards — the stdout line handler in
`connectAcp` (`L212-231`) does not consult `closed`, so a turn that settled while its
process was being killed can be decoded and broadcast after the next connection has
started a turn. A per-connection counter restarting at 1 makes those two ids equal and
the reducer cannot tell them apart. A process-wide counter cannot collide.

The pair is emitted only from `drain()`, so `turn.started.turnId === turn.finished.turnId`
for the same turn, always, and `finish.dropReason = 'cancelled'` never changes the id.

`ensureSession()`'s resume branch (`L292`, `L300`) also emits a started/finished pair
(a load replays a conversation and needs a turn boundary); it takes its ids from the
same counter.

**How `transcript.ts` uses it.** `turn.started` records `liveTurn`; `turn.finished`
applies only if it belongs to that turn:

```ts
    case 'turn.started':
      return {
        ...state,
        status: 'streaming',
        error: undefined,
        turn: state.turn + 1,
        liveTurn: event.turnId,
      }

    case 'turn.finished':
      // A settlement from a turn that is no longer the live one must not flip the
      // composer back to idle while a newer turn streams.
      if (event.turnId !== state.liveTurn) return state
      return { ...state, status: 'idle' }
```

`state.turn` (the internal counter, `L29`) is **not** replaced by `event.turnId`. It
keys `changedFiles` groups (`L83`) and agent-chunk coalescing (`L116`), it restarts at
0 on `reset()`/`session.reset`, and reusing a process-wide id would leave a fresh
transcript grouping under a number far from 1. Two numbers, two lifetimes, both named
so a reader can tell which is which.

## Compaction: the matching rule

`core/events.ts` gains two constants next to `textOf` (L17-21) and one helper:

```ts
/**
 * pi-acp reports compaction as ordinary agent prose, so these are string matches on
 * an unstable upstream detail. If pi-acp rewords them the divider silently stops
 * appearing; nothing else breaks, and no text is lost.
 */
const COMPACTION_START = 'Context nearing limit, running automatic compaction...'
const COMPACTION_END = 'Automatic compaction finished; context was summarized to continue the session.'

const compactionPhase = (text: string): 'start' | 'end' | null => {
  const trimmed = text.trim()
  if (trimmed === COMPACTION_START) return 'start'
  if (trimmed === COMPACTION_END) return 'end'
  return null
}
```

The `agent_message_chunk` case (`core/events.ts:61-64`) checks it **before** returning
a chunk:

```ts
    case 'agent_message_chunk': {
      const text = textOf(update.content)
      if (text === null) return []
      const phase = compactionPhase(text)
      return phase ? [{ type: 'compaction', phase }] : [{ type: 'chunk', text }]
    }
```

Rules, all of which a test pins:

- **Exact match on the trimmed chunk text**, not a substring, not a prefix. A chunk
  that merely mentions compaction renders as prose. A chunk that contains a sentinel
  plus more text is prose (pi-acp always sends each sentinel as its own chunk — it
  emits one `agent_message_chunk` per pi event; verified in
  `pi-acp/dist/index.js` at the `auto_compaction_start` / `auto_compaction_end` cases).
- **A matched chunk is replaced, never duplicated.** The sentinel must not also render
  as an agent message, or the divider would be decoration on top of the noise it exists
  to hide.
- **The same code path covers replay.** `session/load` replays an `agent_message_chunk`,
  so a resumed session shows its old compaction markers for free.

**Known limitation, accepted.** The pairs are prose. pi-acp can reword them in any
release; when it does, the divider stops appearing, silently. There is no version
check, no fallback probe, and no plan to read the session JSONL to recover it — the
divider is a convenience, not data, and SBH does not write or parse a harness's store.
The failure mode is "the marker is missing", never "the transcript is wrong".

Reducer, `src/ui/state/transcript.ts` — new case in `applyEvent` (before `default`, L238):

```ts
    case 'compaction': {
      // The divider breaks agent-text coalescing: without this, the chunks on either
      // side of the compaction merge into one item and the marker lands after both.
      const last = state.items[state.items.length - 1]
      if (event.phase === 'end' && last?.kind === 'divider' && last.pending) {
        const items = state.items.slice()
        items[items.length - 1] = { ...last, pending: false }
        return { ...state, items, agentTurn: undefined }
      }
      return {
        ...state,
        items: [...state.items, { id: nextId(), kind: 'divider', pending: event.phase === 'start' }],
        agentTurn: undefined,
      }
    }
```

`agentTurn: undefined` makes `chunk` fail its `state.agentTurn === state.turn` test,
so the next chunk opens a fresh agent item. One divider per compaction: `start` creates
it pending, `end` closes it in place, and an `end` with no matching pending divider
(a resumed session that replayed only the tail) inserts a closed one.

Rendering, `src/ui/host/components.ts` — a branch in `renderItem` before the `// tool`
fallthrough (L189):

- `wrap.dataset.item = item.kind` (L129) already yields `data-item="divider"`, which is
  what the test asserts.
- Two hairline rules with the label between them, `display:flex;align-items:center;
  gap:var(--sbh-space-sm)`, `color:var(--sbh-color-text-muted)`,
  `font-size:var(--sbh-font-size-sm)`.
- The label is host-owned text — `'compacting context'` while `pending`, `'context
  compacted'` after. Nothing from the agent, no `innerHTML`, no `renderMarkdown`.
- The trailing `// tool` branch becomes reachable only for `kind === 'tool'`; add an
  explicit `if (item.kind === 'tool')` or leave the fallthrough and note it, but the
  divider branch must come first.

## The composer control

The reflexive key must not be the destructive one. So:

| key / control                | while idle        | while streaming                                  |
|------------------------------|-------------------|--------------------------------------------------|
| `Enter`                      | `prompt.send`     | `prompt.send` (no `steer`) — queued as a follow-up |
| `Shift+Enter`                | `prompt.send`     | `prompt.send { steer: true }` — interrupt and send |
| `Escape`                     | nothing           | `turn.cancel` (unchanged, `L732`)                |
| `button[data-send]` "Send"    | `prompt.send`     | "Stop" → `turn.cancel` (unchanged, `L756-773`, `L788`) |
| `button[data-queue]` "Queue"  | hidden            | `prompt.send` — mouse parity for plain `Enter`   |
| `button[data-queue-clear]`    | hidden            | `queue.clear`, shown with the depth badge        |

`Shift+Enter` is the deliberate act, so it gets the interrupted turn; `Enter` is muscle
memory, so it queues and destroys nothing. The `Queue` button's `title` says
`'Send after this turn — Enter queues, Shift+Enter interrupts'`, which is the only
place the bindings are documented in the UI.

Edits, file by file:

- `src/ui/host/components.ts:731-732` — replace the two-line key handler:

  ```ts
      if (key === 'Enter') {
        // Enter queues: the reflexive key must not cancel work. Shift+Enter is the
        // deliberate interruption, and the core is what serialises either way.
        live.ctx.dispatch('prompt.send', event.shiftKey ? { steer: true } : {})
      } else if (key === 'Escape' && live.ctx.host.status === 'streaming') live.ctx.dispatch('turn.cancel')
  ```

- `src/ui/host/components.ts:756-773` — after `send`, build `button[data-queue]`
  ("Queue") and append it: `row.append(attach, input, queue, send)`.
- `src/ui/host/components.ts:680-700` (create) — a depth badge `span[data-queued]` and
  `button[data-queue-clear]` ("Clear") in the tray row, hidden by default.
- `src/ui/host/components.ts:786-800` (update) — set `queue.style.display` from
  `ctx.host.status`, and the badge from `ctx.host.queued`:
  `queued > 0 ? `${queued} queued` : ''`, clear button hidden at 0.

- `src/App.tsx:203-213` — the dispatch props type gains `steer?: unknown`.
- `src/App.tsx:258-285` (`prompt.send`) — read `const steer = props?.steer === true`
  and add `...(steer ? { steer: true } : {})` to the `{ type: 'prompt', … }` message.
  The existing early return for an empty draft stays first: an empty composer must not
  cancel a turn.
- `src/App.tsx:231-233` — a `case 'queue.clear': stream.current?.send({ type: 'queue.clear' }); return`
  next to `turn.cancel`.
- `src/App.tsx:119-143` (`onEvent`) — nothing new to divert: `queue` and `compaction`
  both go through `applyEvent` like any other transcript event.

- `core/server.ts:598-620` — pass the flag: `await live.prompt(msg.text, blocks, { steer: msg.steer === true })`.
  Nothing else changes; the existing `await sessionSwitch` + `await live.ready()` stay
  exactly where they are, because attachments and capabilities must resolve before the
  prompt is enqueued.
- `core/server.ts` after `L622-624` — `if (msg.type === 'queue.clear') { conn?.clearQueue(); return }`.
  `conn?.`, not `ensureConnection()`: clearing an empty queue must not spawn an agent
  (the same discipline as the panel's roots refresh).

## Why `queue` rides `ClientToCore` rather than a `state` key

`{ type: 'state', key, value }` would work and needs no type change. It is rejected
because the depth is a first-class input to a host component's behaviour (the badge and
the Clear button), not a metrics blob like `usage`, and `Transcript.queued` is pure and
testable without a socket or a DOM. The extra cost is four `queued: 0` lines in test
`HostState` literals (`src/ui/host/transcript.test.ts:29`, `src/ui/tree/destroy.test.ts:17`,
`src/ui/tree/reconcile.test.ts:18`, `src/ui/tree/render.test.ts:21`) — cheaper than a
value that only exists at runtime.

`queue.clear` exists because the state machine would otherwise have no exit. A user who
queues three follow-ups by reflex needs a way to take them back; under rule 6, Stop does
not drop them, and dropping them without being asked would discard messages that are
already visible in the transcript.

## Invariants preserved

1. **The core is the only spawner.** `queue.clear` uses `conn?.`; no new path calls
   `ensureConnection()`/`connectAcp`.
2. **Loopback and the origin guard are untouched.** No route, no upgrade handler, no
   new socket message that bypasses `verifyClient`.
3. **The UI imports nothing from `core/`.** `PromptOptions` lives in
   `core/acp/client.ts`; the wire only carries `steer?: boolean`.
4. **Components stay dumb about capability.** The composer reads `ctx.host.status` and
   `ctx.host.queued` and dispatches `prompt.send` / `turn.cancel` / `queue.clear`.
5. **No model prose as HTML.** The divider's label is host text; the sentinels are
   *removed*, not rendered.
6. **The app is not the writer** of a harness's session store. Nothing here reads or
   writes one; the compaction marker is derived from the wire.
7. **The transcript reducer stays pure.** No timer, no I/O, no import from `core/`.
8. **`HostState.status` keeps two values.** `queued` is a depth, so every existing
   status assertion and the Send/Stop toggle still describe reality.
9. **`npm test` needs no network and no model.** Every new behaviour is a fixture
   scenario over stdio.
10. **One `session/prompt` per connection, ever.** Guaranteed by a single writer of
    `inFlight`, not by convention.

## Testing — the fixture scenarios

`test/fixtures/fake-acp-agent.ts`. Three new `SCENARIOS` entries (`L13-21`), plus a
concurrency guard in `serve()`'s `session/prompt` case (L~380) that applies to all
three: a second `session/prompt` while one is unresolved is answered with a JSON-RPC
error `{ code: -32000, message: 'concurrent prompt' }` and no chunks. That is what
makes a missing queue fail loudly instead of quietly interleaving. `runScenario`
returns `Promise<string | void>`, the value being a `stopReason` override, so a
scenario can report `'cancelled'`. The existing `cancel` machinery
(`cancelRequested` / `resolveCancel`) becomes a `waitCancel(ms): Promise<boolean>`
helper reused by `cancel` and `steer`, so the current `cancel` test stays green.

| scenario | wire behaviour that must be implemented |
|---|---|
| `queue-turn` | On `session/prompt`: emit `agent_message_chunk` `"start <prompt> "`, `await delay(300)`, emit `"end <prompt>"`, answer `end_turn`. A concurrent prompt is rejected by the guard. |
| `steer` | On the **first** `session/prompt`: emit `"slow "`, `await waitCancel(3000)`, emit `"interrupted"` if cancelled else `"finished"`, and return `stopReason` `'cancelled'` / `'end_turn'` accordingly. Every later prompt emits `"echo <prompt>"` and answers `end_turn` immediately, so a steered turn costs nothing and the test can assert it jumped the queue. |
| `compaction` | On `session/prompt`, four chunks in order: `"before "`, `"Context nearing limit, running automatic compaction..."`, `"Automatic compaction finished; context was summarized to continue the session."`, `"after"`. No delays, no cancellation. |

The two sentinel literals are **duplicated on purpose** in the fixture rather than
imported from `core/events.ts`. A fake that imports the constant it is validating is
tautological: a reworded sentinel would change both sides and the test would stay green.

`test/fixtures/fake-acp-agent.test.ts:5-12` asserts the exact sorted `SCENARIOS` array;
it must list the three new names.

What each test asserts:

- `core/acp/client.test.ts`, `describe('turn control')`:
  - `runs a second prompt after the first finishes` — `queue-turn`, two `prompt()`
    calls without awaiting the first; assert zero `error` events, two `turn.started`,
    and the echoed text in order (`start one` before `start two`).
  - `pairs every turn.finished with its turn.started` — the ids of the two lists are
    equal and strictly increasing.
  - `steers: cancels the in-flight turn and jumps the queue` — `steer`, start `slow`,
    wait for a chunk, `prompt('redirect', [], { steer: true })`; assert the first turn's
    `stopReason === 'cancelled'`, the second's echo, no concurrent-prompt error, and
    that the whole thing finished well under the 3000 ms hold.
  - `keeps a steer ahead of an earlier follow-up` — start `slow`, queue `later` (no
    steer), then steer `now`; the echo order is `now` then `later`.
  - `clearQueue drops only the waiting prompts` — start `slow`, queue two, `clearQueue()`
    returns 2, the in-flight turn still settles, no further turns start.
  - `drops the queue when the connection closes` — queue two, `close()`; both promises
    resolve, no hang, no error event.
- `core/server.test.ts`, `describe('turn control')`:
  - `answers two prompts in order` — `fake:queue-turn`, two `prompt` messages sent back
    to back; two `turn.finished`, no `error`, chunk order preserved. This is the test
    that would fail today.
  - `publishes the queue depth` — observe `{ type: 'queue', pending }` events, expect
    a `1` then a `0`.
  - `clears the queue on queue.clear` and `does not spawn an agent to clear an empty
    queue` (send `queue.clear` first, assert no session is created).
- `core/events.test.ts`:
  - `turns a compaction sentinel into a compaction event, not text` — both literals,
    expecting `[{ type: 'compaction', phase: 'start' }]` / `'end'`.
  - `leaves a sentence that mentions compaction alone` — the end sentence with
    `' ok'` appended is a `chunk`.
- `core/acp/client.test.ts`: `emits a compaction event and no sentinel prose` — the
  joined `chunk` text is `'before after'`, and the compaction phases are
  `['start', 'end']`.
- `src/ui/state/transcript.test.ts`:
  - `inserts a divider between the prose around a compaction` — kinds
    `['agent', 'divider', 'agent']`, divider `pending === true`.
  - `closes the pending divider on the end sentinel`.
  - `inserts a closed divider for an end with no matching start`.
  - `ignores a turn.finished that does not belong to the live turn` — started(1),
    started(2), finished(1) ⇒ `status === 'streaming'`.
  - `counts the queue depth` — `{ type: 'queue', pending: 2 }` ⇒ `queued === 2`, and
    `session.reset` ⇒ 0.
- `src/ui/host/transcript.test.ts`:
  - `renders a divider item` — `[data-item="divider"]` exists and its text is
    `context compacted`.
  - `queues on Enter while streaming and steers on Shift+Enter` — the dispatch spy
    records `('prompt.send', {})` and `('prompt.send', { steer: true })`.
  - `shows Queue only while streaming, and the depth badge with Clear`.
- `src/App.test.tsx`: `puts steer on the wire` — `turn.started`, type, `Enter` and
  `Shift+Enter`, assert `socket.sent` contains `{ type: 'prompt', text: 'hi' }` and
  `{ type: 'prompt', text: 'hi', steer: true }`.

## Risks

- **Compaction depends on 11 words of upstream prose.** Reworded ⇒ the divider vanishes
  silently. Accepted, documented above; the sentinels are the whole mechanism by decision.
- **`session/cancel` cannot name a turn.** If the cancelled turn settles in the window
  between sending the notification and the agent reading it, the *steered* turn can be
  the one cancelled. Symptom: a steer whose `turn.finished` is `'cancelled'` with no
  chunks of its own. ACP gives no scope to fix it; the answer is "send it again".
- **An agent that ignores `session/cancel` wedges the queue.** The in-flight turn never
  settles, so `drain` never runs. `Stop` sends the same notification again; the real
  remedy is a connection teardown (`session.new`), which drops the queue. Fixture and
  pi-acp both answer a cancel, so this is not exercised by the suite.
- **A session switch discards the queue** (`session.new`, `session.fork`, backend
  switch). Queued prompts resolve silently and their user messages stay in the
  transcript unanswered. Re-queueing them across a connection would mean owning
  messages the agent never saw, which is worse.
- **`turnSequence` is process-global.** Two connections' ids interleave instead of
  restarting; nothing reads them as an index, only as identity, so this is safe by
  construction — but a future feature that assumes "ids start at 1" would be wrong.
- **The queue can hide a mis-typed prompt behind a long turn.** The depth badge is the
  only signal, and it is a one-liner in the composer. Anything richer is a later phase.
- **Reducer change touches every turn in every test.** A required `turnId` fails to
  compile in the literal events in `src/ui/state/transcript.test.ts`; they must be
  updated in the same commit as the type, not left for the next task.
- **`queue.clear` and the badge are the cuttable 20 lines.** If the phase must shrink,
  drop them; the queue then cannot be emptied except by a teardown, and rule 6 (Stop
  keeps the queue) becomes a trap.

## Resolved decisions

1. **The queue lives in `AcpConnection`**, not `server.ts`: the object that owns the
   wire owns the serialisation, and a teardown drops its own queue.
2. **`Enter` queues; `Shift+Enter` steers.** The reflexive key must not cancel work;
   the deliberate key carries the deliberate act. The brief's suggested inverse mapping
   was considered and rejected for that reason.
3. **`steer` is a hint, not a state.** With nothing in flight it is an ordinary prompt.
4. **Stop cancels the in-flight turn only; the queue keeps running.** Queued prompts are
   already visible in the transcript, so they are dropped only by an explicit
   `queue.clear`.
5. **Turn ids are process-global and required on both ends of a turn.** Pairing is
   guaranteed by a single emitter; staleness is decided by the reducer, not the core.
6. **`Transcript.turn` stays.** It keys grouping and coalescing and resets with the
   transcript; `liveTurn` is the core's identity for the live turn. Two lifetimes.
7. **Compaction is matched by trimmed exact equality** on the two pi-acp sentinels,
   replaced rather than duplicated, and carries no summary.
8. **One divider per compaction**: created pending on `start`, closed in place on `end`,
   and an orphan `end` inserts a closed one.
9. **The divider breaks agent-text coalescing**, so it lands between the prose rather
   than after it.
10. **The depth rides `ClientToCore`/`Transcript.queued`, not the `state` channel**,
    because the composer's behaviour depends on it and a pure reducer can test it.

## Phase boundary

Phase 3 of this track (a shell pane, background tasks, whatever the harness comparison
says is next) consumes: a serialised prompt path, a depth counter, and a divider kind on
the timeline. It changes nothing here. The project-file-panel track is untouched: no
route, no host component, no `layout.json` node, and the phone `CORE_ROUTES` allowlist
is not involved.
