# Composer context — Phase 3: `@path:12-20` and `!` / `!!`

Status: design for review. Author: pi. Date: 2026-10-17.

## Goal

1. **`@path:12-20`** — the core resolves the mention against a directory it already knows,
   confined by Phase 1's `confine()`, and ships the referenced lines to the agent as content
   blocks. The prompt text is NOT rewritten: the model sees the reference and the excerpt.
2. **`!cmd` / `!!cmd`** — the core runs the command in the session cwd and streams its output
   into the transcript as a tool card. `!` output may ride the next prompt; `!!` output
   structurally cannot.

## Non-goals

No shell pane, no PTY, no `terminal/*`, no client-supplied cwd/shell/env, no core-side buffer
of shell output, no multi-line composer, no change to the existing attachment path's
capability gate.

## Grammar — `shared/mentions.ts` (new, pure, no imports)

```ts
const MENTION = /(^|\s)@([A-Za-z0-9._/+-]+)(?::(\d{1,7})(?:-(\d{0,7}))?)?/g
export interface Mention { raw: string; path: string; range?: { start: number; end?: number }; index: number }
export function findMentions(text: string): Mention[]
export function parseShellCommand(text: string): { command: string; includeInContext: boolean } | null
```

Rules, each pinned by a test:
- `@` must open the message or follow whitespace, so `a@b.com` is prose.
- Path charset `[A-Za-z0-9._/+-]`; one trailing `.` is stripped.
- `:12` = line 12; `:12-20` inclusive; `:12-` to the end; `:-20` is not a range.
- A token preceded by `\` is inert and the backslash stays in the text.
- An odd number of backticks before the token on its line makes it prose.
- `!` must open the message (leading whitespace allowed); `!!` sets `includeInContext:false`;
  `\!…` is prose; `!` alone is null; the returned command excludes the sigil.
- ONE grammar, used by both the composer (chips) and the core (resolution), so they cannot
  disagree about what a mention is.

## Resolution — core side

The UI has no filesystem and the protocol has no request/response frame, so the core parses
`prompt.text` in the existing prompt handler, after `live.ready()` (capabilities known) and
before `live.prompt()`.

`core/mentions.ts`:
```ts
export const maxMentionsPerPrompt = 8
export const maxMentionLines = 400
export const maxPromptContextBytes = 256 * 1024
export async function expandMentions(params: {
  text: string; root: string; roots: readonly KnownRoot[]; caps: { embeddedContext: boolean }
}): Promise<{ blocks: AcpContentBlock[]; events: UiEvent[] }>
```
- `confine(roots, root, path)` is the ONLY path gate; its `FileErrorReason` is the user-visible reason.
- `embeddedContext` gates the block FORM, never whether content is sent:
  - true → `{ type:'resource', resource: { uri:'file:///abs/p', mimeType:'text/plain', text } }`
  - false (default) → `{ type:'text', text:'@p:12-20\n```\n12| …\n```' }`
- Header names the range and total line count when known, so a truncation is legible.
- Caps: 8 mentions; 400 lines; 256 KiB total, dropping the LAST block with a `skipped` event.
- Binary, directory, missing, escaping and unknown roots → a `skipped` event, no block.
- The same file mentioned twice yields two blocks in place (no dedupe: it would move an
  excerpt away from the sentence that asked for it).

`core/files.ts` gains `readLines(roots, root, path, range)`: reuses `confine()`, `maxFileBytes`
and the NUL binary probe; splits on `\n`, strips a trailing `\r`, no phantom final line;
`totalLines: null` when truncated. A range past the 1 MiB prefix is REFUSED, not streamed.

`UiEvent` gains:
```ts
| { type: 'context'; mention: string; status: 'included' | 'skipped';
    lines?: { start: number; end: number }; reason?: string }
```
Broadcast per mention, in text order, so every client sees the outcome.

## Shell — `core/shell.ts` (new)

```ts
export const DEFAULT_SHELL_LIMITS = { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, graceMs: 5_000 }
export interface ShellResult { exitCode: number|null; signal: string|null; truncated: boolean;
  timedOut: boolean; cancelled: boolean; durationMs: number }
export interface ShellHandle { readonly id: string; readonly result: Promise<ShellResult>; cancel(): void }
export function runShell(o: { command: string; cwd: string; onChunk: (c:{stream:'stdout'|'stderr';text:string})=>void;
  shell?: string; limits?: Partial<typeof DEFAULT_SHELL_LIMITS>; env?: NodeJS.ProcessEnv }): ShellHandle
export function stripControl(text: string): string
```
- `spawn(shell, ['-c', command], { detached: true, stdio: ['ignore','pipe','pipe'], cwd })`.
  Not `shell:true`, not `-l` (a login shell sources profiles and prints banners).
  `shell = process.env.SBH_SHELL ?? '/bin/sh'`; the client names none of it.
- `detached: true` + `process.kill(-pid)` so the GROUP dies; otherwise `sleep 30 &` outlives the card.
- stdin is /dev/null so an interactive command cannot eat the core's stdin.
- Output cap KILLS the group (`truncated: true`); timeout TERMs then KILLs after `graceMs`.
- Chunks coalesced at 16 ms / 8 KiB and passed through `stripControl`.
- `Core.close()` kills every live handle. A SIGKILLed core can orphan a group; documented.

## Wire

```ts
| { type: 'prompt'; text: string; attachments?: Attachment[]; context?: ContextEntry[] }
| { type: 'shell'; command: string; includeInContext: boolean; operatorToken?: string }
| { type: 'shell.cancel'; shellId: string }
export interface ContextEntry { label: string; text: string; truncated?: boolean }
```
`UiEvent.tool` gains `origin?: 'shell'` and `includeInContext?: boolean`. The shell reuses the
existing tool event (spawn / chunk / exit), with `toolCallId = 'shell-' + randomUUID()`.
`TimelineItem` gains `output?`, `exitCode?`, `origin?`, `includeInContext?` on the tool member
and a `'context'` member. `HostState` gains `pendingContext: ContextEntry[]`.

## The `!!` exclusion is structural

The core keeps NO copy of shell output. The model's context is built in exactly one place — the
prompt handler — from `msg.text`, `msg.attachments`, `msg.context` and the mentions parsed from
the text. The only writer of `msg.context` is the client, gated on a tool event with
`origin === 'shell' && includeInContext === true`. A `!!` run emits `includeInContext: false` on
every event, so no branch can carry it. `!!` keeps output out of the MODEL's context, not off
other clients or the transcript — say so in the docs.

## Permission: one story, two classes

A typed command is NOT an ACP permission request (there is no `requestId`, and faking one to
"go through handlePermission" would let the UI answer a request ACP never made). Instead:

- The judging half of `handlePermission` is extracted into ONE helper, used by both callers:
  `loadManifest` → `classifyToolCall` → `evaluate` → audit + `permission.resolved` broadcast.
- `class: 'agent'` → judged by `[capabilities.shell]` (circumventing this would let an
  agent-authored component dodge `capabilities.toml`, which is why it exists).
- `class: 'operator'` → judged by `[capabilities.shell] operator`, defaulting to `allow`.

**Operator token (escape hatch, user-requested).** The core mints `operatorToken = randomUUID()`
at startup. It is NOT published on the state channel, NOT in `HostState`, NOT in
`ctx.host`/`ctx.tokens`/`data`, NOT in `/state`. The host runtime attaches it only to messages
dispatched by BUILT-IN components; extension components loaded from `~/.config/sbh/components`
receive a `ctx.dispatch` that never attaches it. A `shell` message carrying a valid token is
judged as `operator`; a missing or bogus token is judged as `agent`.

Documented limit: the token defends against in-page components, not against a local process
reading the loopback wire — anything that can open that socket can already send prompts to an
agent that has a shell.

## Invariants preserved

Core is the only spawner (two sites: the agent in `core/acp/client.ts`, the user command in
`core/shell.ts`, plus the pre-existing `execFile` for git in `core/files.ts`); loopback and the
origin guard untouched; the UI imports nothing from `core/`; components stay dumb about
capability; no model prose as HTML (shell output is `textContent` in a `<pre>`, mention rows are
the user's own token); the app never writes a session store; the reducer stays pure; a shell run
is not a turn, so `status`/queue/Stop are untouched; no network and no model in tests.

## Tests

- `shared/mentions.test.ts`: the grammar table above.
- `core/files.test.ts`: `readLines` whole/`:1`/`:2-2`/`:2-`/`:5-9`/`:0`, trailing newline, binary,
  directory, `link-out`, absolute, missing, over-cap.
- `core/mentions.test.ts`: one block (both block forms), two mentions of one file ⇒ two blocks,
  order, nine ⇒ eight + skipped, `link-out` ⇒ skipped `escapes-root`, 500 lines ⇒ 400 + truncated.
- `core/shell.test.ts`: `echo hi`; `exit 3`; `pwd` equals the cwd passed in; ANSI stripped;
  4 MiB against a 64 KiB cap ⇒ killed; `sleep 5` with `timeoutMs:100` ⇒ timedOut fast;
  `sh -c 'sleep 3 & wait'` + cancel ⇒ settles fast and no group leak; `stripControl` cases.
- `core/server.test.ts`: resource vs text block gate (fixture scenario `blocks` advertising
  `embeddedContext: true`); mention refused when escaping; `!` shows a tool card; **`!!` output
  never reaches session/prompt** (send `!!echo SECRET`, then a prompt; assert no SECRET anywhere);
  `!` reaches the model only when the client sends `context`; manifest denies a shell command;
  manifest allows a scoped command; **operator token**: component-dispatched shell (no token)
  denied under `decision="deny"`, same deny + valid token RUNS (`shell.operator` defaults allow),
  `shell.operator="deny"` denies even with a token, a bogus token is treated as no token.
- `src/ui/state/transcript.test.ts`: output accumulation; captures `!` into pending context;
  never captures `!!`; caps a captured result; inserts a `context` row; reset clears it.
- `src/ui/host/transcript.test.ts`: renders shell output with a `local only` tag; renders a
  context row; lists pending context and `context.remove` dispatch.
- `src/App.test.tsx`: `!` routes to `shell` with `includeInContext:true`; `!!` with `false`;
  captured context rides the next prompt only.

## Phase boundary

No shell pane, no background tasks, no `terminal/*`, no mention picker. Phase 4 consumes
`core/shell.ts`, `readLines`, and the `context` timeline row.
