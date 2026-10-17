# Project file panel (Phase 1: core read path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the core to list a project directory, read a file, report git status and report one path's diff — read-only, loopback, behind the origin guard, and confined to directories the session already knows.

**Architecture:** One new core module (`core/files.ts`) owns every filesystem and git read and exposes a single confinement gate that all four readers call first. `shared/protocol.ts` gains response types only. `core/server.ts` gains three GET routes next to `/sessions`, below the existing origin guard. No UI, no WebSocket message, no ACP change.

**Tech Stack:** TypeScript (Node 22 type-stripping, `node:fs/promises`, `node:child_process` `execFile`), Vitest, loopback `node:http`.

**Spec:** `docs/superpowers/specs/2026-10-17-project-file-panel-design.md`

## Global Constraints

- Explicit `.ts` in every import specifier (Node ESM type stripping).
- `shared/protocol.ts` additions are **plain data** (string/number/boolean) — that file is compiled by `tsconfig.app.json` with no Node types.
- Loopback only; every new route sits inside the origin-guarded request handler, below it, next to `/sessions`.
- Read-only: no write, create, rename, delete, stage, or watcher anywhere in this phase.
- Roots come from `resumeTarget?.cwd ?? options.cwd` plus the session listing; a `/files` request must never spawn an agent.
- Every path is canonicalized with `fs.realpath` **before** the containment check, and compared with `path.sep` (never a bare `startsWith(root)`).
- Absolute paths are refused, never reinterpreted.
- `npm test` green with no network and no model; `npx tsc -b` clean.
- No new `UiEvent`, no new `ClientToCore` member, no layout or component change.

## Review Focus

Failure modes the spec implies that no single happy-path test covers; each gets a test in an owning task.

1. **`/root2` must not satisfy a `/root` check** — the separator, not the prefix, is the boundary. Task 1.
2. **A symlink inside the root pointing outside is refused** *and* still listed as `outside: true`. Tasks 1-2.
3. **An absolute `path` is refused** even when it points inside the root. Task 1.
4. **A read works with no agent running** (no spawn from an HTTP GET). Task 6.
5. **A git failure (no repo, no binary, timeout) is a typed answer, not a 500.** Tasks 4-6.
6. **Porcelain's leading space survives** — a work-tree-only change parses as `worktree: 'M'`, not as a mangled path. Task 4.

---

### Task 1: Protocol response types and the confinement gate

**Files:**
- Modify: `shared/protocol.ts` (append `FileTreeEntry`, `FileChange`, `FileStatus`, `FileTreeResponse`, `FileTextResponse`, `FileDiffResponse`)
- Create: `core/files.ts` (constants, `FileAccessError`, `KnownRoot`, `canonicalRoots`, `confine` only)
- Create: `test/fixtures/files-fixture.ts`
- Test: `core/files.test.ts`

**Interfaces:**
- Produces: the six response types above, exactly as written in the spec.
- Produces: `maxFileBytes = 1024 * 1024`, `maxTreeEntries = 2000`, `maxChanges = 5000`, `gitTimeoutMs = 5000`.
- Produces: `type FileErrorReason = 'root-not-known' | 'absolute-path' | 'escapes-root' | 'missing' | 'not-a-file' | 'not-a-dir' | 'no-git'`; `class FileAccessError extends Error { readonly reason: FileErrorReason }`.
- Produces: `interface KnownRoot { readonly given: string; readonly real: string | null }`.
- Produces: `async canonicalRoots(cwds: readonly string[]): Promise<KnownRoot[]>` — skips empty and non-absolute cwds, dedupes by `given`, `realpath`s each in parallel, `null` on failure.
- Produces: `async confine(roots, root, path): Promise<{ root: string; abs: string; rel: string }>` implementing gates 1-9 of the spec.
- Produces (test helper): `makeTempTree(): Promise<{ root: string; outside: string; cleanup: () => Promise<void> }>` and `makeTempRepo(): Promise<{ root: string; cleanup: () => Promise<void> }>` in `test/fixtures/files-fixture.ts`.
- Consumes: nothing.

- [ ] **Step 1: Write the fixture helper.** `test/fixtures/files-fixture.ts`: `mkdtemp` under `os.tmpdir()`, build `root/{a.txt,sub/b.ts,.hidden,b.bin}` (the `.bin` containing a NUL byte), `root/link-in -> sub`, `root/link-out -> ../outside/secret.txt`, and a sibling `outside/secret.txt` **above** the root. `makeTempRepo` runs `git -c user.email=t@t -c user.name=t -c commit.gpgsign=false init -q`, writes `a.txt`, `git add -A`, commits, then modifies `a.txt` and writes `new.txt` untracked — with `env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }`.
- [ ] **Step 2: Write the failing tests.** `core/files.test.ts` with `const roots = await canonicalRoots([tree.root])`: `it('accepts the root itself with an empty path')`; `it('resolves a path inside the root')`; `it('refuses a root that is not in the known set')` (`reason === 'root-not-known'`); `it('refuses .. that leaves the root')` (`'../../etc'` → `escapes-root`); `it('refuses an absolute path even inside the root')` (`join(root, 'a.txt')` → `absolute-path`); `it('refuses a symlink pointing outside the root')` (`'link-out'` → `escapes-root`); `it('allows a symlink pointing inside the root')` (`'link-in/b.ts'` → `rel === 'sub/b.ts'`); `it('does not confuse a name-prefix sibling with the root')` (create `<root>2` next to the root, assert `canonicalRoots([root])` does not accept `<root>2` and `'../<base>2/x'` is `escapes-root`); `it('reports a missing path')`.
- [ ] **Step 3: Run it.** `npx vitest run core/files.test.ts` — expect FAIL (module missing).
- [ ] **Step 4: Implement.** Append the response types to `shared/protocol.ts`; write `core/files.ts` up to and including `confine`, following the nine gates in the spec exactly and mapping `ENOENT`/`ENOTDIR` from `realpath` to `FileAccessError('missing')`. `rel` is canonical, `/`-separated, `''` at the root.
- [ ] **Step 5: Run it.** `npx vitest run core/files.test.ts` — PASS. Then `npx tsc -b`.
- [ ] **Step 6: Commit.** `git commit -m "feat(core): file read gate — canonicalize before the prefix check"`

### Task 2: `listTree` — one level, escapees marked

**Files:**
- Modify: `core/files.ts` (`listTree`)
- Test: `core/files.test.ts`

**Interfaces:**
- Produces: `async listTree(roots, root, path): Promise<FileTreeResponse>` — `confine`, `lstat` (`not-a-dir` when it is not a directory), `readdir(withFileTypes)`, `kind` from `lstat` (`file`/`dir`/`symlink`/`other`), `size` in bytes (0 for a directory), `outside` = `realpath(entry)` escaping the root (a broken symlink counts as outside), entries sorted directories-first then by name with plain `<`, capped at `maxTreeEntries` with `truncated`, `status` from the Task 4 function once it exists (in this task, `{ git: false, changes: [] }`).
- Consumes: `confine` (Task 1).

- [ ] **Step 1: Write the failing tests.** `it('lists one level of the root')` (names include `a.txt`, `sub`, `.hidden`; `sub` has no children of its own in the result); `it('lists a subdirectory')` (`path: 'sub'` yields `b.ts`); `it('marks a symlink that points outside')` (`link-out.outside === true`, `kind === 'symlink'`); `it('marks a symlink that points inside as inside')`; `it('refuses a file as a directory')` (`path: 'a.txt'` → `not-a-dir`); `it('caps a huge directory')` (create 3 entries, call with a tiny injected cap if the cap is exported, else assert the real cap is respected by a 2001-entry loop guarded behind a `it.skipIf`; prefer parameterizing `maxTreeEntries` through an optional argument).
- [ ] **Step 2: Run it.** `npx vitest run core/files.test.ts -t listTree` — FAIL.
- [ ] **Step 3: Implement** `listTree`. Do not recurse, do not follow a symlink to describe it (its `kind` stays `symlink`), do not hide dotfiles.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): one-level directory listing with escapees marked"`

### Task 3: `readText` — capped, binary-detected

**Files:**
- Modify: `core/files.ts` (`readText`)
- Test: `core/files.test.ts`

**Interfaces:**
- Produces: `async readText(roots, root, path): Promise<FileTextResponse>` — `confine`, refuse a directory (`not-a-file`), `open` and read at most `maxFileBytes` from offset 0, `size` from `stat`, `truncated = size > maxFileBytes`, `binary = the first 8 KiB contain a NUL` (text then `''`).
- Consumes: `confine`.

- [ ] **Step 1: Write the failing tests.** `it('reads a text file')` (`text` contains the fixture content, `binary === false`); `it('flags a binary file and returns no text')` (`b.bin` → `binary: true`, `text === ''`); `it('truncates a file over the cap')` (write `maxFileBytes + 1024` bytes, asset `truncated === true` and `text.length <= maxFileBytes`); `it('refuses a directory')` (`not-a-file`); `it('refuses a path outside the root')` via the fixture symlink.
- [ ] **Step 2: Run it.** `npx vitest run core/files.test.ts -t readText` — FAIL.
- [ ] **Step 3: Implement** `readText` with a single `open`/`read` into a `Buffer` sized `min(size, maxFileBytes)`; map `EISDIR` and `ENOENT` to `not-a-file`/`missing`.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): capped, binary-aware file read"`

### Task 4: `gitStatus` — porcelain, root-relative

**Files:**
- Modify: `core/files.ts` (git runner + `gitStatus`)
- Test: `core/files.test.ts`

**Interfaces:**
- Produces: an internal `runGit(root: string, args: string[]): Promise<string>` using `execFile('git', ['-C', root, ...args], { timeout: gitTimeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })`, returning **untrimmed** stdout; and `tryGit` returning `null` on failure (the `core/versioning.ts` pattern, plus a timeout).
- Produces: `async gitStatus(roots, root): Promise<FileStatus & { root: string }>` — `rev-parse --show-prefix`, then `status --porcelain=v1 -z`, prefix-stripped, `R`/`C` records consuming the next NUL field as `originPath`, capped at `maxChanges`, `git: false` on any failure.
- Consumes: `confine` with an empty path (for the root gate).

- [ ] **Step 1: Write the failing tests** against `makeTempRepo()`. `it('reports a work-tree modification')` (`worktree === 'M'` — this is the leading-space parse); `it('reports an untracked file')` (`index === '?'`); `it('reports a staged change')` (`index === 'M'`, `worktree === ' '` after `git add`); `it('reports a rename with its origin path')` (`git mv`, then assert `originPath`); `it('returns git: false outside a repository')` (`makeTempTree()`); `it('keeps paths relative to a subdirectory root')` (`roots = canonicalRoots([join(repo.root, 'sub')])`, assert the reported path has no `sub/` prefix, and that a change outside `sub/` is dropped).
- [ ] **Step 2: Run it.** `npx vitest run core/files.test.ts -t gitStatus` — FAIL.
- [ ] **Step 3: Implement** the runner and `gitStatus`. Never trim stdout; split records on `\0`; ignore a trailing empty field.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`. Then wire `status` into `listTree`'s response and re-run Task 2's tests.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): git status, root-relative and read-only"`

### Task 5: `gitDiff` — one path, three states

**Files:**
- Modify: `core/files.ts` (`gitDiff`)
- Test: `core/files.test.ts`

**Interfaces:**
- Produces: `async gitDiff(roots, root, path): Promise<FileDiffResponse>` — `confine`, then `diff --no-color -- <rel>`; if empty, `diff --no-color --cached -- <rel>` with `staged: true`; if still empty, `status --porcelain=v1 -- <rel>` to set `untracked`. Patch capped at `maxFileBytes`. Any git failure → `FileAccessError('no-git')`.
- Consumes: `runGit`/`tryGit` and `confine`.

- [ ] **Step 1: Write the failing tests.** `it('diffs a modified file')` (patch contains `-`/`+` lines and the changed text, `staged === false`); `it('falls back to the index for a staged-only change')` (`git add`, then `staged === true` and a non-empty patch); `it('marks an untracked file without inventing a patch')` (`untracked === true`, `patch === ''`); `it('reports no-git outside a repository')` (`FileAccessError` with `reason === 'no-git'`); `it('refuses a path outside the root')`.
- [ ] **Step 2: Run it.** `npx vitest run core/files.test.ts -t gitDiff` — FAIL.
- [ ] **Step 3: Implement** `gitDiff`. Pass the path after `--` so a name starting with `-` is a path and not a flag.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): per-path diff with a staged fallback"`

### Task 6: The three routes, below the origin guard

**Files:**
- Modify: `core/server.ts` (roots closure; three GET handlers after the `/sessions/:id` block)
- Test: `core/server.test.ts`

**Interfaces:**
- Produces: `const knownRoots = async (): Promise<KnownRoot[]>` in `startCore` — 5 s TTL; cwds = `resumeTarget?.cwd ?? cwd` plus, **only when `conn !== null`**, the `acpSessions()` listing, else `listSessions(sessionsRoot)`; unioned with the previously known `given` values; built with `canonicalRoots`; a failed refresh keeps the old set.
- Produces: routes `GET /files`, `GET /files/tree`, `GET /files/diff` with the exact table, status mapping and `cache-control: no-store` from the spec.
- Consumes: `listTree`, `readText`, `gitDiff`, `FileAccessError` (Tasks 1-5).

- [ ] **Step 1: Write the failing tests** in `core/server.test.ts`, `describe('file routes')`, with `core = await startCore({ port: 0, backend: 'fake:happy', cwd: tree.root })` and **no prompt sent**. `it('lists a directory')` (`/files/tree?root=<tree.root>&path=''` → 200, entries contain `a.txt`); `it('reads a file')` (`/files?root=…&path=a.txt` → 200 `text`); `it('reports a diff')` (against `makeTempRepo()` as cwd → 200 with a patch); `it('refuses an unknown root')` (403, body `{ error: 'root-not-known' }`); `it('refuses .. traversal')` (403 `escapes-root`); `it('refuses an absolute path')` (400 `absolute-path`); `it('refuses a symlink out of the root')` (403 `escapes-root`); `it('404s a missing file')`; `it('409s a diff outside a repository')`; `it('refuses a foreign origin on /files')` (fetch with `headers: { origin: 'https://evil.example' }` → 403); `it('answers with no agent spawned')` (assert the listing above already answered 200 before any prompt; additionally assert `core` reports no session list via `/sessions` — keep it cheap and behavioural).
- [ ] **Step 2: Run it.** `npx vitest run core/server.test.ts -t 'file routes'` — FAIL (404 from the router).
- [ ] **Step 3: Implement** the roots closure and the three handlers. Use `url === '/files'` etc. and `searchParams.get('root') ?? ''`; map `FileAccessError.reason` to 400/403/404/409 as specified and rethrow anything else as a 500.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): /files, /files/tree and /files/diff behind the origin guard"`

### Task 7: Full suite, manual smoke, docs

**Files:**
- Modify: `PLAN.md` (decision records), `docs/design.md` (one paragraph: the core reads a project it already knows, canonically confined)

- [ ] **Step 1:** `npx vitest run core/files.test.ts core/server.test.ts` — green.
- [ ] **Step 2:** `npx tsc -b` — clean; `npm test` — green, with no network and no model (nothing in these tasks calls one).
- [ ] **Step 3: Manual smoke** per the spec's curl block, with `SBH_BACKEND=fake:happy SBH_CWD="$PWD" SBH_PORT=45999 npm run core &`. Expect 200 / 403 / 400 / 403 in that order. Kill the core afterwards.
- [ ] **Step 4:** Record the four decisions in `PLAN.md` (status on `/files/tree`; absolute paths refused; escapees listed as `outside`; roots only grow, no spawn) and a paragraph in `docs/design.md`.
- [ ] **Step 5: Commit.** `git commit -m "docs: the core file read path and its confinement rule"`

### Task 8: Phone proxy allowlist (boundary, before Phase 2 ships)

**Files:**
- Modify: `core/phone-server.ts` (`CORE_ROUTES`)
- Test: `core/phone-server.test.ts`

**Interfaces:**
- Consumes: the routes from Task 6.
- Produces: `/files` in `CORE_ROUTES`, so `/files` and `/files/tree` proxy to the core instead of falling through to the static handler. No client uses it in Phase 1; without it a phone client gets static-file 404s the day the panel ships.

- [ ] **Step 1: Write the failing test.** `it('proxies the file routes to the core')` — extend the existing proxy test to assert a `/files/tree?…` request reaches the core rather than the static handler.
- [ ] **Step 2: Run it.** `npx vitest run core/phone-server.test.ts` — FAIL.
- [ ] **Step 3: Implement** — add `/files` to the array. Nothing else.
- [ ] **Step 4: Run it.** PASS. `npx tsc -b`.
- [ ] **Step 5: Commit.** `git commit -m "feat(phone): proxy the file routes to the core"`

---

## Self-Review

- **Spec coverage:** protocol types (Task 1), gate (1), tree (2), text (3), status (4), diff (5), routes + origin guard (6), docs and smoke (7), phone boundary (8). The spec's non-goals map to "not in any task": no UI, no WS message, no write path, no steer/compaction/shell.
- **Step scan:** each task is write-the-test → run → implement → run → commit, with the command spelled out each time; bodies are left to the implementer except where the spec pins a signature, a constant or an argv.
- **Type consistency:** the six response types are declared once in `shared/protocol.ts` and used verbatim by `core/files.ts` and the routes; `KnownRoot`/`confine`/`FileAccessError` are the only gate abstractions, and every reader takes `roots` first.
- **Review Focus:** each of the six failure modes is pinned to a named test in Tasks 1, 2, 4, 6.
- **Ordering:** Task 1 blocks everything. Tasks 2, 3 and 4 can run in parallel after it (they touch different functions of one file — merge careful, but independent). Task 5 needs Task 4's git runner. Task 6 needs 2-5. Task 8 needs Task 6.
- **Proportion:** no task reproduces a body that the signature and the test already determine.

## Risks

- **Not written to disk.** `codemode` returns "Tool codemode not found" and no write tool exists in this session, so both files above are deliverables, not artifacts. Persist them before handing off to a worker.
- `core/server.ts` has no route table abstraction — the three handlers are inline `if (req.method === 'GET' && url === …)` blocks. Inserting them after the `/sessions/:id` block keeps `/files` out of the `/sessions` prefix's way; putting them before it would still work today but invites shadowing later.
- `acpSessions()` spawns a backend (`ensureConnection()`); a naive roots refresh would spawn an agent on the first file listing. The plan guards with `conn !== null` and a 5 s TTL union — verify that guard in review, it is the difference between "opens a file" and "starts a process".
- `listTree` embedding `gitStatus` couples listing latency to git. Capped, timed out, degradable to `git: false`; still the first thing to watch on a large repo.
- Phase 2 will want the phone `CORE_ROUTES` entry (Task 8) — it is one line, but forgetting it produces a 404 that looks like a client bug.

## Assumptions

- "Phase 1 only" means core read path: `core/files.ts`, three routes, protocol response types, tests. I treated UI, layout, WebSocket messages and `shared/layout.ts` as Phase 2, and steer/compaction/shell as Phase 3. If Phase 1 was meant to include the panel component, the plan needs a Task 9 that consumes these routes unchanged.
- Git status is expected on `/files/tree` rather than a fourth route, because the task listed exactly three routes and four capabilities. If a separate `GET /files/status` is preferred, it is a six-line handler plus a test; the `gitStatus` signature is already route-shaped.
- Fixtures are built at test time in `os.tmpdir()` (not checked in) because the "symlink pointing outside the root" case needs an absolute target outside the fixture, which cannot be committed.
- The test box has `git` on `PATH` and no network is needed (`git init`/`commit` are local). Global git config is neutralised (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, `-c commit.gpgsign=false`) so a signed-commit default cannot break the suite.

## Design decisions, in ten lines

1. One module owns every read; `roots` is the first parameter of every entry point, so there is no unconfined path to forget.
2. Confinement is three ordered gates: exact root membership, syntactic `resolve` (catches `..` without touching disk), then physical `realpath` (catches symlinks).
3. `realpath` runs **before** the prefix check; the check is `real === root || real.startsWith(root + path.sep)`, never a bare `startsWith`.
4. Root membership is an exact string match against cwds from `resumeTarget?.cwd ?? cwd` plus the session listing — the `sessions.ts` id-lookup discipline applied to directories.
5. Roots are canonicalized once per 5 s refresh, so the gate does no filesystem work per request; the set only grows and a failed refresh keeps the old one.
6. A read never spawns an agent: the agent's listing is consulted only when a connection already exists, else pi's session files.
7. Absolute paths are refused outright (400), and no absolute path ever appears in a response — the wire speaks root-relative posix only.
8. A symlink that escapes is listed with `outside: true` (honest) and refused by the gate (safe) — two layers, one load-bearing.
9. Git is read with `-C root`, `GIT_OPTIONAL_LOCKS=0`, untrimmed output, `--porcelain=v1 -z`, prefix-stripped via `rev-parse --show-prefix`; failure is `git: false` (or 409 for a diff), never a 500.
10. Binary is a fact (200, `binary: true`, empty text), large files truncate at 1 MiB, and nothing in this phase can write.
