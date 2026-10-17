/**
 * The wire contract between the core and any client.
 *
 * Lives outside both `core/` and `src/` so that the UI can speak the protocol
 * without importing core code — one definition, two consumers.
 */

/**
 * A session's configuration selectors, as the agent reports them.
 *
 * The model picker is the `model`-category entry; nothing in the UI knows that
 * the agent calls it "model", only that a category exists.
 */
export interface SessionConfigOption {
  id: string
  name: string
  category?: string
  currentValue: string
  options: { value: string; label: string }[]
}

/** A command an agent advertises (ACP `available_commands_update`). */
export interface AvailableCommand {
  name: string
  description: string
  /** Non-null when the command takes input (ACP AvailableCommandInput). */
  input?: unknown
}

export type UiEvent =
  | { type: 'chunk'; text: string }
  | { type: 'user.chunk'; text: string }
  | { type: 'thought'; text: string }
  | {
      type: 'tool'
      toolCallId: string
      title: string
      status?: string
      /** ACP ToolKind: `edit`, `read`, `execute`, … */
      kind?: string
      /** Files the call touched, so the UI can list what changed. */
      locations?: { path: string; line?: number }[]
      /** ACP ToolCallContent (may carry a diff). */
      content?: unknown
      /** ACP `rawInput`: the call's arguments, so a card can show what ran. */
      rawInput?: unknown
      /**
       * Incremental terminal output for a running tool, from ACP
       * `_meta.terminal_output.data`. pi-acp sends *bash* output here, not as
       * `content`, so without this the UI never sees it. Deltas; a client
       * accumulates them per `toolCallId`.
       */
      outputDelta?: string
      /** Exit code of a finished terminal tool (`_meta.terminal_exit.exit_code`). */
      exitCode?: number
    }
  /** A replayed user attachment (non-text content block). */
  | { type: 'attachment'; mimeType: string; name?: string; data?: string; uri?: string }
  | {
      type: 'permission.requested'
      requestId: string
      title: string
      /** ACP ToolCall fields, so an agent-authored card can show the real thing. */
      toolCallId?: string
      kind?: string
      name?: string
      rawInput?: unknown
    }
  | { type: 'usage'; used: number; size: number; cost?: unknown }
  | { type: 'config'; options: SessionConfigOption[] }
  /** The core decided (manifest on), for display and the audit log. */
  | {
      type: 'permission.resolved'
      requestId: string
      title: string
      capability: string
      subject?: string
      decision: 'allow' | 'deny'
      reason: string
    }
  | { type: 'turn.started' }
  | { type: 'turn.finished'; stopReason: string }
  | { type: 'session.reset'; reason: 'new' | 'fork' | 'resume' }
  /** The agent's slash commands (skills, builtins), for the composer's `/` menu. */
  | { type: 'commands'; commands: AvailableCommand[] }
  /** Agent capabilities from `initialize`; the core republishes as state. */
  | { type: 'capabilities'; image: boolean; audio: boolean; embeddedContext: boolean; fork: boolean }
  | { type: 'error'; message: string }

/** A pending permission request as the host state carries it. */
export type PermissionRequest = Extract<UiEvent, { type: 'permission.requested' }>

/**
 * A prompt attachment, shipped as bytes so the client names no transport.
 * `data` is base64; the core persists it and builds the ACP content block.
 */
export interface Attachment {
  name: string
  mimeType: string
  data: string
}

/** What an agent reported it can do, from its `initialize` result. */
export interface AgentCapabilities {
  image: boolean
  audio: boolean
  embeddedContext: boolean
  fork: boolean
}

/** Client -> core. */
export type ClientToCore =
  | { type: 'prompt'; text: string; attachments?: Attachment[] }
  | { type: 'cancel' }
  | { type: 'session.new' }
  | { type: 'session.fork'; id?: string }
  | { type: 'permission'; requestId: string; decision: 'allow' | 'deny' }
  /** Switch the agent backend; the core reconnects. */
  | { type: 'backend'; id: string }
  /** Set the agent's model config option. */
  | { type: 'model'; id: string }
  /** Set any other ACP session config option (e.g. `thought_level`). */
  | { type: 'config'; id: string; value: string }
  /** Load an existing session; the agent replays it as events. */
  | { type: 'session.resume'; id: string; cwd: string }
  /**
   * Write one key of the persisted store. `null` deletes it. The core owns the
   * file and re-broadcasts the whole store on `state` with key `store`.
   */
  | { type: 'state.set'; key: string; value: unknown }
  /**
   * Declare which UI surface this client is. One core serves several: a desktop
   * and a phone author different layouts and must not inherit each other's.
   */
  | { type: 'client.hello'; profile: string }

/** Core -> client. */
export type CoreToClient =
  | { type: 'event'; event: UiEvent }
  /**
   * A keyed value the host is publishing — usage, machine samples, anything the
   * core can reach. One channel, so a new widget needs no protocol change.
   */
  | { type: 'state'; key: string; value: unknown }
  /** A watched file changed; the client should re-fetch. Hot reload. */
  | { type: 'invalidate'; what: 'components' | 'theme' | 'layout'; profile?: string }

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
