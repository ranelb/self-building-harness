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
    }
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
  /** Load an existing session; the agent replays it as events. */
  | { type: 'session.resume'; id: string; cwd: string }
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
