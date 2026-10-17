# Project file panel — Phase 1: the core read path

Status: design for review. Author: pi. Date: 2026-10-17.
Contract to change: `shared/protocol.ts` (response types only), `core/files.ts` (new),
`core/server.ts` (three routes).

Phase 1 of three. This phase is the **core read path only**: list a directory, read a
file's text, report git status, report one path's diff — and refuse every request that
would read outside a directory the session already knows. No UI, no layout node, no
WebSocket message, nothing about steering, compaction or a shell.

## Goal

The core can answer four read questions about a project directory it already knows
about, over loopback HTTP behind the existing origin guard:

1. what is in this directory (one level, no recursion),
2. what is in this file (text, capped, binary detected),
3. which paths have changed in this work tree,
4. what changed in this one path.

Success: `curl` against a running core lists a project, reads a file, and gets a
refusal for `..`, for an absolute path, and for a symlink pointing outside the root;
`npm test` is green with no network and no model; `npx tsc -b` is clean.

## Non-goals / explicitly out

- **Any UI.** No host component, no `layout.json` node, no atom, no theme token. That
  is Phase 2, and it consumes this phase unchanged.
- **Any WebSocket message.** No new `UiEvent`, no new `ClientToCore` member. The panel
  is HTTP GET only, so Phase 1 does not touch the socket handler, the ACP client, or
  the fixture agent.
- **Writing anything.** No create, write, rename, delete, stage, checkout, or file
  watcher. The core already refuses to write a harness's session store; the same
  discipline extends here — SBH does not write what it does not own.
- **Search, blame, `git log`, commit-range diffs, staging.** One path, one diff.
- **Binary decoding, image preview, PDF extraction.** A binary file is reported as
  binary and not rendered.
- **A client-supplied root.** Roots are derived, never supplied (see below).
- **Steer / compaction / shell.** Phase 3. Nothing here anticipates them.

## Roots: what "a root the session already knows" means

A root is one of the working directories the core already has evidence for:

1. the active session's cwd — `resumeTarget?.cwd ?? options.cwd`, the same directory
   the backend is spawned in;
2. every `cwd` in `acpSessions()` (the agent's own listing), or in
   `listSessions(sessionsRoot)` when the agent cannot list — the same two sources
   `GET /sessions` already uses.

Two rules keep this cheap and honest:

- **A read never spawns an agent.** `acpSessions()` calls `ensureConnection()`, which
  spawns a backend. So the roots refresh consults the agent's listing **only when a
  connection already exists** (`conn !== null`); otherwise it reads `listSessions`.
  Opening a file must not cost a process.
- **The set only grows.** It refreshes at most once every 5 s, and a failed refresh
  keeps what was already known, so a dead agent or an unreadable session store does
  not blind a panel that was working a second ago. Old cwds staying readable is
  acceptable: they are the same user's directories, and every answer is read-only.

The membership test is an **exact string match**, in the spirit of `core/sessions.ts`
(`readSession` matches an id against the listing rather than concatenating it into a
path — see its comment at L175-184). A request names a root by the exact string
`/sessions` handed the client; the canonical form (`fs.realpath`) of that root is also
accepted, for a cwd that is itself a symlink. Anything else is refused before a single
`stat`.

`canonicalRoots()` resolves each cwd once per refresh, so the per-request gate does no
filesystem work beyond one `realpath` of the target. Hauling 200 session cwds through
`realpath` on every keystroke would be a genuine bug, not a theoretical one.

## The confinement algorithm

A filesystem path has no id to look up, so it is canonicalized **before** it is
compared. Prefix string comparison alone is the classic hole and is explicitly not
used here.

`confine(roots, root, path)`:

1. `root` must be a non-empty string.
2. **Root gate.** Find an entry in `roots` where `entry.given === root` or
   `entry.real === root`. No match, or an entry whose `real` is `null` (the directory
   does not resolve) → `root-not-known`. Plain string equality: no prefix reasoning,
   no path construction from the request.
3. `path` defaults to `''`. A `NUL` byte → `escapes-root`.
4. `isAbsolute(path)` → `absolute-path`. An absolute path is **refused, not
   reinterpreted**; the wire speaks root-relative paths only, so an absolute one is a
   bug or an attack, never a convenience.
5. `candidate = resolve(realRoot, path)`. `..` collapses here. If `candidate !== realRoot`
   and it does not start with `realRoot + path.sep` → `escapes-root`. This is the
   **syntactic** gate: it refuses `../../etc/passwd` without touching the disk.
6. `real = await realpath(candidate)`. `ENOENT` → `missing`. Symlinks are resolved
   here.
7. If `real !== realRoot` and it does not start with `realRoot + path.sep` →
   `escapes-root`. This is the **physical** gate, and it is the one that matters: it
   runs after canonicalization, so a symlink inside the root that points outside is
   refused.
8. `rel = real === realRoot ? '' : real.slice(realRoot.length + 1)` with separators
   normalized to `/`.
9. Return `{ realRoot, abs: real, rel }`.

Both gates are needed. Step 5 stops traversal even when the target exists; step 7 stops
a symlink, which no amount of lexical normalization can see.

`path.sep`, not `'/'`, in both comparisons: `'/srv/app2'.startsWith('/srv/app' + '/')`
is false, so a sibling directory whose name merely starts with the root's name is not
inside it. `startsWith(realRoot)` without the separator is the bug this line exists
for.

Three consequences worth stating because a later reviewer will ask:

- **Absolute paths never leave the core.** Responses carry `root` (echoed as
  requested) and root-relative, posix-separated paths. Phase 2's UI cannot fabricate
  an absolute path that works, because the field does not exist.
- **`rel` is canonical.** Reading `link-in/b.ts` where `link-in -> sub` reports
  `path: "sub/b.ts"`. The client keys its view by what it asked for; the answer is
  the canonical truth.
- **A symlink is listed but marked.** `listTree` reports entries whose realpath
  escapes the root with `outside: true` — visible, honest, and unopenable, because
  steps 6-7 refuse it independently. Two layers, one of them load-bearing.

## `shared/protocol.ts` additions — response types only

`shared/` is compiled by `tsconfig.app.json` too, so these carry **no Node types**: strings,
numbers and booleans only.

```ts
/** One entry of a single-level listing. `path` is root-relative, `/`-separated. */
export interface FileTreeEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'symlink' | 'other'
  /** Bytes; 0 for a directory. For a symlink, the link's own size. */
  size: number
  /** True when the entry resolves outside the root: shown, never openable. */
  outside: boolean
}

/** One record of `git status --porcelain=v1`. */
export interface FileChange {
  /** Root-relative, `/`-separated. */
  path: string
  /** Porcelain X (index): `' '`, `M`, `A`, `D`, `R`, `?`, … */
  index: string
  /** Porcelain Y (work tree). */
  worktree: string
  /** For `R`/`C`, the previous path. */
  originPath?: string
}

export interface FileStatus {
  /** False when the root is not a work tree, git is missing, or the call failed. */
  git: boolean
  changes: FileChange[]
}

export interface FileTreeResponse {
  root: string
  /** The requested directory, root-relative; `''` for the root itself. */
  path: string
  entries: FileTreeEntry[]
  /** True when the directory had more than `maxTreeEntries` entries. */
  truncated: boolean
  status: FileStatus
}

export interface FileTextResponse {
  root: string
  path: string
  size: number
  text: string
  /** True when the file is larger than `maxFileBytes`; `text` is the prefix. */
  truncated: boolean
  /** True when a NUL byte appeared in the first 8 KiB; `text` is then `''`. */
  binary: boolean
}

export interface FileDiffResponse {
  root: string
  path: string
  patch: string
  /** The path is untracked: `patch` is empty and the client should show the file. */
  untracked: boolean
  /** The patch came from `--cached` because the work tree matches the index. */
  staged: boolean
}
```

Nothing is added to `UiEvent` or `ClientToCore`.

## `core/files.ts` — the only reader

```ts
export const maxFileBytes: number      // 1 MiB; also the diff cap
export const maxTreeEntries: number    // 2000
export const maxChanges: number        // 5000
export const gitTimeoutMs: number      // 5000

export type FileErrorReason =
  | 'root-not-known'
  | 'absolute-path'
  | 'escapes-root'
  | 'missing'
  | 'not-a-file'
  | 'not-a-dir'
  | 'no-git'

export class FileAccessError extends Error {
  readonly reason: FileErrorReason
  constructor(reason: FileErrorReason, message?: string)
}

/** A root the core has evidence for. `given` is what /sessions reports. */
export interface KnownRoot {
  readonly given: string
  readonly real: string | null
}

export async function canonicalRoots(cwds: readonly string[]): Promise<KnownRoot[]>

/** The single gate. Every reader below calls it first; nothing else takes a path. */
export async function confine(
  roots: readonly KnownRoot[],
  root: string,
  path: string
): Promise<{ root: string; abs: string; rel: string }>

export async function listTree(
  roots: readonly KnownRoot[],
  root: string,
  path: string
): Promise<FileTreeResponse>

export async function readText(
  roots: readonly KnownRoot[],
  root: string,
  path: string
): Promise<FileTextResponse>

export async function gitStatus(
  roots: readonly KnownRoot[],
  root: string
): Promise<FileStatus & { root: string }>

export async function gitDiff(
  roots: readonly KnownRoot[],
  root: string,
  path: string
): Promise<FileDiffResponse>
```

There is **no exported function that takes a raw filesystem path**. `roots` is the first
parameter of every entry point, so "did we confine this?" has one answer in one place.

### Behaviour

- `canonicalRoots`: drops empty and non-absolute cwds (a relative cwd would resolve
  against the core's own cwd — the wrong directory), dedupes by `given`, resolves
  `realpath` for each in parallel, keeps `null` on failure.
- `listTree`: `confine`, then `lstat` the target (`not-a-dir` if it is not a directory),
  then `readdir(withFileTypes)`, sorted directories-first then by name with plain `<`
  (locale-independent, so tests are stable). Hidden entries are included — this is a
  file explorer, not a build tool. Cap `maxTreeEntries`, set `truncated`.
- `readText`: `confine`, `open`, read at most `maxFileBytes` from offset 0, `truncated =
  size > maxFileBytes`. A NUL in the first 8 KiB sets `binary: true` and `text: ''`.
  1 MiB is generous for a viewer and small enough that a wrong click cannot wedge the
  client.
- `gitStatus`: `git -C <root> rev-parse --show-prefix` gives the root's path inside the
  repository (empty at the top level). Then `git -C <root> status --porcelain=v1 -z`.
  Porcelain prints paths **relative to the repository root even when run from a
  subdirectory**, so each path is stripped of that prefix and records outside it are
  dropped. Parse on `NUL`: `index = rec[0]`, `worktree = rec[1]`, `path = rec.slice(3)`;
  for `R`/`C` consume the next field as `originPath`. Any failure (not a work tree, git
  absent, non-zero exit, timeout) yields `{ git: false, changes: [] }`, not an error.
  Cap at `maxChanges`.
- `gitDiff`: `confine`, then in order — `diff --no-color -- <rel>`; if empty,
  `diff --no-color --cached -- <rel>` (`staged: true`); if still empty,
  `status --porcelain=v1 -- <rel>` to set `untracked` (a `??` record). Pathspecs passed
  with `-C <root>` are already relative to the root, so no prefix dance is needed here.
  Patch capped at `maxFileBytes`. Any git failure → `FileAccessError('no-git')`.

Git is invoked through `execFile` (the pattern in `core/versioning.ts`) with
`{ timeout: gitTimeoutMs, maxBuffer: 8 MiB }` and `GIT_OPTIONAL_LOCKS=0`,
`GIT_TERMINAL_PROMPT=0` in the env — a read-only reader must not take `index.lock` while
the agent's own git is running, and must never block on a credential prompt. Output is
**not trimmed**: a porcelain record for a work-tree-only change is `' M path'`, and
`.trim()` would eat that leading space and corrupt the parse.

## Routes — `core/server.ts`

Inserted after the `/sessions/:id` block and before `/history`, inside the existing
request handler, so they sit **below the origin guard** (which runs before routing and
therefore already covers them) and cannot be shadowed by a prefix.

| Method | Path | Query | 200 body | Refusals |
|---|---|---|---|---|
| GET | `/files` | `root`, `path` | `FileTextResponse` | 400 `absolute-path` / `not-a-file`; 403 `root-not-known` / `escapes-root`; 404 `missing` |
| GET | `/files/tree` | `root`, `path` | `FileTreeResponse` | 400 `absolute-path` / `not-a-dir`; 403 `root-not-known` / `escapes-root`; 404 `missing` |
| GET | `/files/diff` | `root`, `path` | `FileDiffResponse` | 400 `absolute-path` / `not-a-file`; 403 `root-not-known` / `escapes-root`; 404 `missing`; 409 `no-git` |

- Error bodies are `{ "error": "<reason>" }`, matching the existing
  `{ error: 'origin not allowed' }`. 403 never distinguishes "outside" from "not
  allowed to name that root": both are the same refusal.
- Query values come from `searchParams`, which percent-decodes — `%2e%2e` arrives as
  `..` and hits gate 5 like any other traversal. No pre-decoding anywhere.
- Git status rides on `/files/tree` rather than getting a fourth route: it is a
  per-root fact, and a listing that decorates its entries needs it in the same
  response. Cost: one `git status` per directory expand.
- `cache-control: no-store` on all three. This is live local state; a heuristically
  cached file body would be a lie.
- The three handlers are `void (async () => { … })()` like the neighbouring `/sessions`
  route, and map `FileAccessError.reason` to the status codes above. Any other throw is
  a 500 — a bug, and it should look like one.

The roots the routes use come from one closure in `startCore`, refreshed lazily:

```ts
const knownRoots = async (): Promise<KnownRoot[]> => { /* 5 s TTL, union, no spawn */ }
```

## Testing

Project rule: fake-agent scenarios, no network, no model. Phase 1 needs no agent at
all, which is itself the point.

- `test/fixtures/files-fixture.ts` (helper, not a test — vitest only collects
  `test/**/*.test.ts`): `makeTempTree()` builds a root with `a.txt`, `sub/b.ts`,
  `.hidden`, a `link-in -> sub` symlink, a `link-out -> ../outside/secret.txt` symlink
  and an `outside/` sibling **outside** the root; `makeTempRepo()` runs `git init` and
  one commit. Both return `{ root, outside?, cleanup }` and use `mkdtemp`.
  The repo helper passes `-c user.email=… -c user.name=… -c commit.gpgsign=false` and
  `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`: a user's global git config
  must not be able to break a test run (commit signing in particular).
- `core/files.test.ts`: the gate and the four readers, no HTTP.
- `core/server.test.ts`: one `describe('file routes')` against
  `startCore({ port: 0, backend: 'fake:happy', cwd: fixtureRoot })`, which makes the
  fixture the only known root.

Refusals asserted, at both levels: `..` traversal, an absolute `path`, a symlink whose
target is outside the root, an unknown `root`, and a root that is a name-prefix sibling
(`<root>2`). Plus: a foreign `Origin` on `/files` is 403, proving the route sits under
the guard rather than beside it.

## Verification

```bash
npx vitest run core/files.test.ts
npx vitest run core/server.test.ts
npx tsc -b
npm test
```

Manual smoke, no model:

```bash
SBH_BACKEND=fake:happy SBH_CWD="$PWD" SBH_PORT=45999 npm run core &
curl -s 'http://127.0.0.1:45999/files/tree?root='"$PWD"'&path=core' | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:45999/files?root='"$PWD"'&path=../../etc/passwd'      # 403
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:45999/files?root='"$PWD"'&path=/etc/passwd'            # 400
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://evil.example' \
     'http://127.0.0.1:45999/files/tree?root='"$PWD"                                   # 403
```

## Risks

- **`git status` on a large repo per directory expand.** Porcelain is fast in practice,
  but a monorepo with 50k changes is not. Capped at `maxChanges`, timed out at 5 s, and
  degradable to `git: false`. If it hurts, the next move is a separate status route
  with the client holding it, not a cache in the core.
- **The roots set is derived, so it can be surprising.** A cwd that `/sessions` never
  reported and is not the active session's cwd is not reachable — by design. If the
  panel ever needs a directory outside that set, the answer is a user-visible grant,
  not a client-supplied root.
- **`realpath` on a broken or racing path.** `ENOENT` is `missing`, never a 500. A path
  that disappears between `confine` and the read is also `missing` — the reader's
  `open` failure is mapped, not thrown.
- **`path.sep` is `/` everywhere SBH ships.** The comparison is written with `path.sep`
  as instructed; Windows is not a supported target (see the packaging notes in
  `AGENTS.md`), so no `win32` special-casing is pretended.
- **The phone server proxies a route allowlist** (`CORE_ROUTES` in
  `core/phone-server.ts`). `/files` is not in it, so a phone client would get static-file
  404s. Correct for Phase 1 (no client uses it yet); it must be added when Phase 2 ships
  the panel, and that is one line plus one test.

## Resolved decisions

1. **Git status rides on `/files/tree`**, not a fourth route. It is a per-root fact and
   the listing is the thing that decorates with it.
2. **An absolute `path` is refused**, not silently reinterpreted as root-relative. The
   wire has one spelling for a path and the core enforces it.
3. **A symlink that escapes is listed with `outside: true`**, not hidden. Hiding it
   makes the panel lie about the directory; refusing it is already guaranteed by the
   physical gate.
4. **`rel` is canonical**, so `link-in/b.ts` answers `sub/b.ts`.
5. **Roots only grow**, refreshed at most once per 5 s, and a refresh that fails keeps
   the previous set. A read never spawns an agent.
6. **Binary is a fact, not an error**: 200 with `binary: true` and `text: ''`.
7. **No trimming of git output** — porcelain's leading space is data.

## Phase boundary

Phase 2 consumes exactly this: three GET routes, five response types, and root-relative
posix paths on the wire. It adds the `files` host component, the layout node and the
phone allowlist entry, and changes nothing here. Phase 3 (steer, compaction, shell) is
unrelated to this module and is not anticipated by any type or route above.
