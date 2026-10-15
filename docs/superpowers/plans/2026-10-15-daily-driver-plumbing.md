# Daily-driver plumbing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add new chat, attachments, stop, edit, and a changed-files panel to SBH as first-class built-ins, with the core plumbing each needs.

**Architecture:** Extend the wire contract in `shared/protocol.ts`, teach the ACP client and the core server the new messages (`cancel`, `session.new`, `session.fork`, attachments) and missing update (`tool_call_update`), then rework the transcript reducer into an ordered timeline and the host components to render and drive it. The UI still only renders and dispatches; the core still spawns agents and answers permissions.

**Tech Stack:** TypeScript, Preact, Vitest, Node `--experimental-strip-types`, ACP (`@agentclientprotocol/sdk` schema as reference), Tauri/WebKitGTK shell.

**Spec:** `docs/superpowers/specs/2026-10-15-daily-driver-plumbing-design.md`

## Global Constraints

- Explicit `.ts`/`.tsx` in every import specifier (Node ESM type-stripping).
- No model prose as HTML: render strings with DOM building / `renderMarkdown`, never `innerHTML`.
- Components read `node`, `ctx.tokens`, `ctx.host`, `ctx.dispatch`; they import nothing from `core/`.
- The core is the only spawner of agents and the only permission answerer; loopback only.
- The app never writes a harness's session store.
- `npm test` green with no network and no model; `npx tsc -b` clean; `cargo check` after any `src-tauri/` change.
- Theme via `var(--sbh-*)` tokens, never literals.
- Attachments travel as base64 over the socket, are capped at 25 MB each (visible error over the cap), and are persisted by the core under `$SBH_STATE_DIR/attachments/<id>/`.
- A live turn emits no `user.chunk`; user messages reach the UI only through `host.messages` on the client.

## Review Focus

Failure modes the spec implies that no single feature test obviously covers; each gets a test in its owning task.

1. **A live user message must appear immediately** — never via `user.chunk` (only replay). Test in Task 6.
2. **A tool call whose `tool_call_update` never arrives** must still render, not sit invisible or crash. Test in Task 1/6.
3. **An image attached to a backend that cannot see images** must be handed over (file link), not silently dropped. Test in Task 2.
4. **`session.new` while a turn is streaming** must cancel or settle it, never leave a turn pointing at a discarded session. Test in Task 4.
5. **An attachment that is too large or unreadable** must surface a visible error, not vanish. Test in Task 2/8.

---

### Task 1: Tool completion and locations on the wire

**Files:**
- Modify: `shared/protocol.ts` (`UiEvent` `tool` member)
- Modify: `core/events.ts` (`normalizeUpdate`)
- Test: `core/events.test.ts`

**Interfaces:**
- Produces: `UiEvent` `tool` becomes `{ type: 'tool'; toolCallId: string; title: string; status?: string; kind?: string; locations?: { path: string; line?: number }[]; content?: unknown }`.
- Produces: `normalizeUpdate` maps `sessionUpdate: 'tool_call_update'` to a `tool` event with the same `toolCallId` and whatever fields the update carries (it must not drop the event when `title` is absent).

- [ ] **Step 1: Write the failing test.** In `core/events.test.ts`, add `it('maps tool_call_update to a tool event with locations', ...)`: feed a `tool_call` (`toolCallId: 't1'`, `title: 'edit'`, `kind: 'edit'`, `status: 'pending'`), then a `tool_call_update` (`toolCallId: 't1'`, `status: 'completed'`, `locations: [{ path: '/a.ts', line: 3 }]`); assert two events, same id, second `status === 'completed'` and `locations[0].path === '/a.ts'`. Add `it('keeps a tool_call without a title')` asserting `title === 'tool'`.
- [ ] **Step 2: Run it.** `npx vitest run core/events.test.ts` — expect FAIL (no `tool_call_update` case; locations dropped).
- [ ] **Step 3: Implement.** In `core/events.ts`, extend the `tool_call` branch to copy `kind`, `locations` (validated) and `content`; add a `tool_call_update` case that emits the same shape using `update.title ?? update.name ?? 'tool'` and forwards `status`/`kind`/`locations`/`content`. Update `shared/protocol.ts`'s `tool` member to match.
- [ ] **Step 4: Run it.** `npx vitest run core/events.test.ts` — PASS. Then `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): forward tool_call_update, kind and locations"`

### Task 2: Attachment persistence and ACP content blocks

**Files:**
- Create: `core/attachments.ts`
- Modify: `shared/protocol.ts` (`Attachment`; `prompt.attachments?`)
- Test: `core/attachments.test.ts`

**Interfaces:**
- Produces: `interface Attachment { name: string; mimeType: string; data: string }` (base64 `data`).
- Produces: `type AcpContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: 'resource'; resource: { uri: string; mimeType: string; text?: string; blob?: string } } | { type: 'resource_link'; uri: string; name: string; mimeType: string }`.
- Produces: `isTextLike(mimeType: string, name: string): boolean`.
- Produces: `maxAttachmentBytes = 25 * 1024 * 1024`.
- Produces: `async attachmentBlocks(root: string, attachments: Attachment[], caps: { image: boolean }): Promise<AcpContentBlock[]>` — writes each attachment under `root`, then maps: image mime **and** `caps.image` → `image`; text-like → `resource` with `text`; otherwise → `resource_link` with a `file://` URI. An over-cap or unwritable attachment throws `AttachmentError` (exported) with a human message.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing test.** `core/attachments.test.ts` (with a temp dir): `it('maps an image to an image block when the agent can see images')`; `it('falls back to a resource_link for an image the agent cannot see')`; `it('inlines a text file as an embedded resource')`; `it('links a PDF as a file')` (assert the file exists on disk and the block is `resource_link`); `it('rejects an attachment over the cap with a visible error')`.
- [ ] **Step 2: Run it.** `npx vitest run core/attachments.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `core/attachments.ts` and add `Attachment` + `prompt.attachments?` to `shared/protocol.ts`. Use `node:fs/promises` `mkdir`/`writeFile`/`readFile`; `isTextLike` = `mimeType.startsWith('text/')` or a known set (`application/json`, `application/xml`, `application/javascript`, `application/x-yaml`, `+json`, `+xml`) or source extensions.
- [ ] **Step 4: Run it.** `npx vitest run core/attachments.test.ts` — PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): persist prompt attachments and map them to ACP blocks"`

### Task 3: Cancel an in-flight turn

**Files:**
- Modify: `shared/protocol.ts` (`ClientToCore.cancel`)
- Modify: `core/acp/client.ts` (`cancel()`)
- Test: `core/acp/client.test.ts`
- Modify: `core/server.ts` (handle `cancel`)
- Test: `core/server.test.ts`

**Interfaces:**
- Produces: `AcpConnection.cancel(): Promise<void>` — sends the JSON-RPC **notification** `{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }`; a no-op when no session exists.
- Produces: `ClientToCore` member `{ type: 'cancel' }`.

- [ ] **Step 1: Write the failing tests.** `client.test.ts`: `it('cancel sends a session/cancel notification')` against the fake agent (assert the written JSON has `method: 'session/cancel'` and the current `sessionId`). `server.test.ts`: `it('a cancel message reaches the agent')`.
- [ ] **Step 2: Run them.** `npx vitest run core/acp/client.test.ts core/server.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Add `cancel()` to `connectAcp`, the protocol member, and a `cancel` branch in `core/server.ts`'s socket handler calling `ensureConnection().cancel()`.
- [ ] **Step 4: Run them.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): cancel the in-flight turn over session/cancel"`

### Task 4: New chat

**Files:**
- Modify: `shared/protocol.ts` (`ClientToCore.session.new`; `UiEvent.session.reset`)
- Modify: `core/server.ts`
- Test: `core/server.test.ts`

**Interfaces:**
- Produces: `UiEvent` member `{ type: 'session.reset'; reason: 'new' | 'fork' | 'resume' }`.
- Produces: `ClientToCore` member `{ type: 'session.new' }`.
- Behavior: on `session.new`, cancel any in-flight turn, close the ACP connection, clear the resume target, open a fresh session, and broadcast `{ type: 'event', event: { type: 'session.reset', reason: 'new' } }`.

- [ ] **Step 1: Write the failing test.** `server.test.ts`: `it('session.new resets the session and broadcasts session.reset')` — connect a client, send `{ type: 'session.new' }`, assert the client receives a `session.reset` event and that a new agent process was spawned. Add `it('session.new during a streaming turn does not orphan the turn')` asserting a `cancel` reaches the old agent.
- [ ] **Step 2: Run it.** `npx vitest run core/server.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `core/server.ts` (mirror the existing `resumeSession` teardown, without a resume target). Add both protocol members.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): start a new session (session.new)"`

### Task 5: Fork (dormant) and agent capabilities

**Files:**
- Modify: `shared/protocol.ts` (`ClientToCore.session.fork`; internal `capabilities` event)
- Modify: `core/acp/client.ts` (`fork()`, capture `initialize.agentCapabilities`)
- Modify: `core/server.ts` (publish capabilities as a `state` key; handle `session.fork`)
- Modify: `test/fixtures/fake-acp-agent.ts` (advertise capabilities; a `fork` scenario)
- Test: `core/acp/client.test.ts`, `core/server.test.ts`

**Interfaces:**
- Produces: `interface AgentCapabilities { image: boolean; audio: boolean; embeddedContext: boolean; fork: boolean }`.
- Produces: `AcpConnection.capabilities(): AgentCapabilities` (defaults all false until `initialize` resolves).
- Produces: `AcpConnection.fork(): Promise<string>` — calls `session/fork` with `{ sessionId, cwd }`, returns the new `sessionId`; throws when the agent did not advertise `fork`.
- Produces: capabilities published as `{ type: 'state', key: 'capabilities', value: AgentCapabilities }`.
- Produces: `ClientToCore` member `{ type: 'session.fork'; id?: string }`; on success the server adopts the forked id and broadcasts `session.reset` with `reason: 'fork'`.

- [ ] **Step 1: Write the failing tests.** Fake agent advertises `promptCapabilities: { image: true }` and `sessionCapabilities: { fork: {} }` and handles `session/fork`. `client.test.ts`: `it('reads agent capabilities from initialize')` and `it('fork returns the new session id')`. `server.test.ts`: `it('publishes capabilities as a state key')` and `it('session.fork resets onto the forked session')`.
- [ ] **Step 2: Run them.** FAIL.
- [ ] **Step 3: Implement** in the fake agent, `client.ts` (capture in the `initialize` response, add `fork()`), and `server.ts` (send the `capabilities` state on connect; handle `session.fork`, catch an unsupported error into an `error` event).
- [ ] **Step 4: Run them.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): agent capabilities and session/fork"`

### Task 6: Transcript reducer — ordered timeline, tools, changed files, resets

**Files:**
- Modify: `src/ui/state/transcript.ts`
- Modify: `shared/ui.ts` (`HostState` / `HostMessage`)
- Test: `src/ui/state/transcript.test.ts`

**Interfaces:**
- Produces: `type TimelineItem = { id: string; kind: 'user'; text: string; attachments: Attachment[] } | { id: string; kind: 'agent'; text: string } | { id: string; kind: 'thought'; text: string } | { id: string; kind: 'tool'; toolCallId: string; title: string; status?: string; kind2?: string; locations: { path: string; line?: number }[] }`.
- Produces: `interface Transcript { items: TimelineItem[]; pendingPermission: PendingPermission[]; status: 'idle' | 'streaming' | 'error'; error?: string; changedFiles: { turn: number; files: { path: string; line?: number }[] }[]; capabilities: AgentCapabilities }`.
- Produces: `applyEvent` merges `tool` by `toolCallId`; on `session.reset` returns `empty()`; `withUserMessage(state, text, attachments?)`.
- Consumes: Task 1/5 event and capability types.

- [ ] **Step 1: Write the failing tests** (rewrite `transcript.test.ts` for the new shape): coalesced agent chunks; a live user message from `host` appears when applied via `withUserMessage`; `thought` and `tool` interleave; a second `tool` event with the same id updates rather than appends; `changedFiles` groups paths per turn and only for `kind === 'edit'`; `session.reset` clears; a replayed `attachment` attaches to the preceding user item; capabilities accumulate from `usage`-like states.
- [ ] **Step 2: Run it.** `npx vitest run src/ui/state/transcript.test.ts` — FAIL.
- [ ] **Step 3: Implement** the timeline reducer and the `HostState` additions (`items`, `changedFiles`, `capabilities`; keep `messages` as a derived selector only if a consumer still needs it).
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): transcript timeline with tools, changed files and attachments"`

### Task 7: Built-in transcript and changed-files panel

**Files:**
- Modify: `src/ui/host/components.ts` (`transcript`, new `changedFiles`)
- Modify: `shared/layout.ts` (add `{ type: 'changedFiles' }`)
- Test: `src/ui/host/components.test.ts` (create if absent; else extend a render test)

**Interfaces:**
- Consumes: `HostState.items`, `HostState.changedFiles` (Task 6).
- Produces: the `transcript` built-in renders `items` in order (reasoning blocks, tool cards, user/agent text, attachment chips, a dimmed "superseded" marker), windowed by item count.
- Produces: `changedFiles` component renders one bordered box per edited path, grouped per turn; hidden when there are none.

- [ ] **Step 1: Write the failing test** (happy-dom): render `transcript` with a thought, a tool (pending then completed), and a user item; assert the tool text updates in place rather than duplicating; render `changedFiles` with two turns and assert two groups and the path text (never as HTML).
- [ ] **Step 2: Run it.** FAIL.
- [ ] **Step 3: Implement** the two built-ins (DOM building only; `renderMarkdown` for agent text) and add the layout node.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): built-in transcript timeline and changed-files panel"`

### Task 8: Composer attachments and Stop

**Files:**
- Modify: `src/ui/host/components.ts` (`composer`)
- Modify: `src/App.tsx` (draft attachments; dispatch `turn.cancel`; send attachments; host wiring)
- Test: `src/App.test.tsx`, render test for the composer

**Interfaces:**
- Consumes: `attachmentBlocks` behavior on the core (Task 2); `capabilities` from `host`.
- Produces: `App` dispatch actions `turn.cancel` → `stream.send({ type: 'cancel' })`, `attachment.add` / `attachment.remove`, `prompt.send` includes base64 attachments.
- Produces: composer UI: paperclip → hidden multi-file input; paste and drag-drop handlers; an attachment tray with thumbnails (images) / chips (others) and remove; Send becomes **Stop** while `host.status === 'streaming'`.

- [ ] **Step 1: Write the failing tests.** `App.test.tsx`: sending with an attachment includes `attachments` on the `prompt` message; `turn.cancel` sends `{ type: 'cancel' }`. Render test: with `status: 'streaming'` the button reads "Stop"; with idle it reads "Send".
- [ ] **Step 2: Run them.** FAIL.
- [ ] **Step 3: Implement** the composer and the `App` state/dispatch. Read files with `FileReader.readAsDataURL` and split off the base64 payload; enforce the 25 MB cap with a visible notice.
- [ ] **Step 4: Run them.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): composer attachments, paste/drop and Stop"`

### Task 9: New Chat button and the edit affordance

**Files:**
- Modify: `src/ui/host/components.ts` (`sessions`, `transcript` user row)
- Modify: `src/App.tsx` (dispatch `session.new`, `message.edit`)
- Test: render test; `src/App.test.tsx`

**Interfaces:**
- Produces: `session.new` dispatch → `stream.send({ type: 'session.new' })`.
- Produces: `message.edit` dispatch with `{ id }`; `App` prefills `draft`, marks the item superseded, and (when `capabilities.fork` and the item is the last user item) sends `{ type: 'session.fork' }` before the resend.

- [ ] **Step 1: Write the failing tests.** `sessions` render test asserts a New Chat button dispatching `session.new`. `App.test.tsx`: `message.edit` sets the draft from that item; with `capabilities.fork === true` on the last user item it sends `session.fork`, otherwise it does not.
- [ ] **Step 2: Run them.** FAIL.
- [ ] **Step 3: Implement** the button, the hover-revealed Edit control on user items (`dispatch('message.edit', { id })`), and the `App` handling.
- [ ] **Step 4: Run them.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): New Chat and edit-from-message"`

### Task 10: This user's override components

**Files:**
- Modify (outside the repo): `~/.config/sbh/components/sbh-transcript.js`, `~/.config/sbh/components/sbh-sidebar.js`

**Interfaces:**
- Consumes: `ctx.host.changedFiles`, `ctx.host.capabilities`, and the new dispatch actions.

- [ ] **Step 1:** Update `sbh-transcript.js` to render changed files per turn, a Stop-aware composer is out of scope here (the built-in composer is used), and stop/gating; keep the existing reasoning/tool polish.
- [ ] **Step 2:** Update `sbh-sidebar.js` with a New Chat button.
- [ ] **Step 3:** Verify by hot reload (screenshot) that the overrides still load and the new host fields appear.
- [ ] **Step 4: Commit** the repo only if any shared helper changed; the overrides live in `~/.config` and are committed by the core's own git.

### Task 11: Docs, build, install, verify, push

**Files:**
- Modify: `docs/design.md`, `PLAN.md` (decision records), optionally `HANDOFF.md`.

- [ ] **Step 1:** Add the decisions to `PLAN.md` (edit = dimmed superseded + dormant fork; changedFiles per turn; no PDF extraction) and a paragraph to `docs/design.md` on the timeline being host state.
- [ ] **Step 2:** `npm test` and `npx tsc -b` clean.
- [ ] **Step 3:** Visual check in the real dev window with `SBH_BACKEND=fake:*` (per AGENTS.md), then the installed app.
- [ ] **Step 4:** `npm run build`, then `cd packaging && pkexec makepkg -si` (announce the Ryoku auth island).
- [ ] **Step 5:** Relaunch `sbh` and confirm new chat, attach, stop, edit and changed files; screenshot.
- [ ] **Step 6:** `git push origin main`.

---

## Self-Review

- **Spec coverage:** protocol (Tasks 1-5), attachments (2), stop (3), new chat (4), edit/fork (5, 9), changed files (1, 6, 7), media gating (2, 5, 8), custom overrides (10), rollout (11). Covered.
- **Step scan:** each step is one test/implement/run/commit action; bodies are left to the implementer except where a signature or exact value is pinned.
- **Type consistency:** `Attachment`/`AcpContentBlock`/`AgentCapabilities`/`TimelineItem`/`changedFiles` are named once and reused; `attachmentBlocks(root, attachments, caps)` is the only attachment entry point.
- **Review Focus:** each of the five lines is pinned to a named test in Tasks 1, 2, 4, 6, 8.
- **Proportion:** the plan is tasks and interfaces; no task reproduces a body the signature and test already determine.
