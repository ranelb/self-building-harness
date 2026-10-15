# Daily-driver plumbing: new chat, attachments, stop, edit, changed files

Status: design for review. Author: pi. Date: 2026-10-15.
Contract to change: `shared/protocol.ts`, `core/`, `src/ui/`, `shared/layout.ts`.

## Goal

The four interaction gaps that keep SBH from being a daily driver, as first-class
built-ins that ship to every install and surface:

1. **New chat** — start a fresh session from the sessions sidebar.
2. **Attachments** — images, PDFs and arbitrary files in the composer, by paste,
   drag-drop and file picker.
3. **Stop** — cancel an in-flight turn from the composer.
4. **Edit** — act on any user message from the transcript (see the correction below).
5. **Changed files** — a list of the files the agent edited, at the end of the turn,
   in neat boxes.

Success: with the installed app, a user can start a new chat, attach a file, stop a
run, edit a prompt, and see which files changed — with no component authoring.

## Non-goals / explicitly out

- True "replace this message and regenerate from here" on backends without a fork
  point (see Correction). This is an ACP limitation, not a UI gap.
- Writing a harness's session store. The invariant holds: SBH is never the writer.
- Position virtualization, a shared settings store, MCP Apps hosting (still future).
- Making the built-ins as polished as an agent-authored component. Built-ins are
  functional and correct; taste lives in `~/.config/sbh/components/`.

## Correction: "edit b" is not implementable as described

I described edit option (b) as "fork the session and send the edited text". That
was wrong on two counts, both verified:

- ACP's `ForkSessionRequest` is `{sessionId, cwd, additionalDirectories, mcpServers}`
  — **there is no fork point / message index.** A fork copies the session at its
  end, so it still contains the message being edited.
- **pi-acp 0.0.34 does not implement `session/fork` at all** (`grep -c fork` = 0)
  and advertises only `sessionCapabilities: { list, delete }`. So on pi it is not
  merely blunt, it is unavailable.

Rejected alternatives: replaying prior turns as one prompt into a fresh session
(mangles context, inflates tokens); editing pi's session JSON (violates the
invariant); "delete and resend" (pi has no ACP truncate).

**Resolution — implement the honest version, plus the fork path for future
backends:**

- Core gains `session/fork` support and publishes an agent `fork` capability.
- The Edit action on a user message:
  1. If the backend advertises `fork` **and** the message is the last user turn,
     fork the session and send the edited text as the branch's first prompt.
  2. Otherwise (today's pi): prefill the composer with the text, **dim** the
     original turn and mark it **"superseded"**, and resend as a new turn. The
     agent's context still contains the original turn; the marker says so rather
     than pretending.
- The transcript never silently rewrites history the agent can see.

This gives a real edit affordance now, and it becomes true branching the day a
backend offers a fork point.

## Protocol changes (`shared/protocol.ts`)

`UiEvent` gains / changes:

- `tool`: add `kind?: string`, `locations?: { path: string; line?: number }[]`,
  `content?: unknown` (ACP `ToolCallContent`, includes `diff`). Completion arrives
  as further `tool` events with the same `toolCallId`; the reducer merges by id.
- new `attachment` for a replayed user attachment (non-text `user_message_chunk`).
- new `session.reset` `{ reason: 'new' | 'fork' | 'resume' }` — clears the view.
- `state` key `capabilities` (not a `UiEvent`): `{ image: boolean; audio: boolean;
  fork: boolean; embeddedContext: boolean }` derived from the agent's initialize
  result, so the composer can gate the attacher honestly.

`ClientToCore` gains:

- `prompt` gains `attachments?: Attachment[]`, where
  `Attachment = { name: string; mimeType: string; data: string /* base64 */ }` —
  uniform and transport-agnostic (works in the desktop webview, a browser, a phone).
- `cancel` — cancel the in-flight turn.
- `session.new` — start a fresh session.
- `session.fork` `{ id?: string }` — branch a session (no fork point; see above).

`HostState` (`src/ui/tree/render.ts`) gains `capabilities` and `changedFiles`.

## Core changes

- `core/events.ts`: handle `tool_call_update` (currently dropped — this is why tool
  cards never leave `pending`), forwarding `kind`, `locations`, `content`; emit
  `attachment` for non-text user content on replay.
- `core/acp/client.ts`: `cancel()` (sends the `session/cancel` notification),
  `fork()`, `prompt(text, blocks)` accepting composed content blocks, and capture
  of `agentCapabilities` from `initialize` for the capabilities state. The ACP
  connection is still the only spawner and the only permission answerer.
- `core/server.ts`: handle `cancel`, `session.new`, `session.fork`; persist prompt
  attachments and compose ACP content blocks; broadcast `session.reset`.
- Attachments are persisted by the **core** (it is local and has the filesystem):
  `$SBH_STATE_DIR/attachments/<id>/<safe-name>`. This is SBH state, not a harness
  session store, so the invariant holds, and the frontend stays a byte pipe.

### Attachment → ACP content block

For each attachment, in order, before the text block(s):

| Attachment | ACP block | Why |
|---|---|---|
| `image/*` (agent `image` capable) | `image` | pi supports vision (`image: true`) |
| `image/*` (not capable) | `resource_link` to the persisted file | don't drop it |
| text-like (`text/*`, json, xml, yaml, source) | `resource` with `text` | the model reads the content inline |
| everything else (PDF, binary) | `resource_link { uri: file://<path> }` | the harness opens it with its own tools |

PDFs are **not parsed by SBH**; they are handed to the harness as a file path, which
is the honest limit of ACP content blocks (pi translates a blob resource to a
byte-count note). This is stated in the UI: a PDF chip, and the agent decides.

## UI changes

- `src/ui/state/transcript.ts`: replace `messages` with an ordered `items`
  discriminated union (`user` with `attachments`, `agent`, `thought`, `tool`,
  `error`) so reasoning, tools and text interleave correctly; merge tool updates by
  id; track `changedFiles` (paths from `kind: 'edit'` tools) and `superseded` flags;
  handle `session.reset`.
- `src/App.tsx`: draft attachments state; dispatch `turn.cancel`, `session.new`,
  `session.fork`, `message.edit`; send attachments with `prompt`; expose
  `capabilities` and `changedFiles` on `HostState`.
- `src/ui/host/components.ts`:
  - `transcript` — render the timeline (reasoning, tool cards, attachments,
    superseded marker). Windowing pages over `items`.
  - `composer` — paperclip (hidden multi-file input), paste handler, drag-drop; an
    attachment tray with thumbnails/chips and remove; the Send button becomes
    **Stop** while `status === 'streaming'` (Esc also cancels).
  - `sessions` — a **New Chat** button above the filter.
  - `changedFiles` — new host component; files grouped **per turn**, each file a
    bordered box, with a count; reflects the transcript's edited files.
- `shared/layout.ts`: add `{ type: 'changedFiles' }` after the transcript in the
  default layout (and in the phone layout where appropriate).

## Custom overrides (this user's setup only, not the project)

`~/.config/sbh/components/sbh-transcript.js` and `sbh-sidebar.js` are the polished
overrides. They are **not** merged upstream. They will be updated to consume the new
`ctx.host` (`changedFiles`, capabilities, superseded) so the user keeps the nicer
look and the new plumbing, while the repo ships the functional built-ins.

## Testing (project rule: fake-agent scenarios, no network, no model)

- `core/events.test.ts`: `tool_call_update` merge and `locations`; replayed image
  `user_message_chunk` → `attachment`.
- `core/acp/client.test.ts`: `cancel` sends `session/cancel`; `fork` call shape;
  capabilities captured from initialize.
- `core/server.test.ts`: `session.new` → `session.reset`; attachment persistence and
  the image/text/resource_link mapping.
- `src/ui/state/transcript.test.ts`: timeline ordering, tool merge, `changedFiles`,
  `session.reset`, superseded.
- `src/ui/host` render tests for the new composer states and `changedFiles`.
- `npx tsc -b` clean.

## Verification and rollout

- Render it, per the project trap: run the core against `fake:*`, load the page, and
  look. Then the real installed app.
- Build: `npm run build` (tsc + vite + core), then `packaging && makepkg -si` via
  `pkexec` (a Ryoku auth island will ask for the password).
- The running installed app keeps the old binary until relaunched; relaunching it
  closes the window this session is displayed in. The pi session survives and can be
  reopened.
- Push to `origin main` once green.

## Risks

- **Timeline refactor** touches the reducer and windowing; the existing transcript
  tests encode the old `messages` shape and must be rewritten, not deleted.
- **Attachment size**: base64 over local WebSocket is fine, but a multi-hundred-MB
  file will hurt. Cap per-file (e.g. 25 MB) with a visible error.
- **`session.new` while streaming**: must cancel first; otherwise a turn resolves
  into a session the client has stopped showing.
- **Fork path is dead code on pi** until a backend advertises it; it is still tested
  against the fake agent.

## Resolved decisions (2026-10-15)

1. **Edit fallback** — the superseded turn is shown **dimmed** with a "superseded"
   marker, not hidden. The agent still sees it; the UI says so.
2. **changedFiles** — grouped **per turn**, not one deduped list.
3. **PDFs** — **no** core-side text extraction. A PDF is persisted and handed to the
   harness as a `resource_link`; whether it can be read is the harness's business.

## Known follow-up (outside this spec)

A live user message only reaches `host.messages` (a live turn emits no
`user.chunk`). Any component that renders the transcript from the raw event stream
alone must also render new user messages from `host.messages`; `sbhTranscript` hit
this as a bug and was fixed by tracking host user-message ids. The timeline refactor
in this spec removes the trap by making host state the single source.
