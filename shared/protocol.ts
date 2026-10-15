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
  | { type: 'tool'; toolCallId: string; title: string; status?: string }
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
  | { type: 'error'; message: string }

/** A pending permission request as the host state carries it. */
export type PermissionRequest = Extract<UiEvent, { type: 'permission.requested' }>

/** Client -> core. */
export type ClientToCore =
  | { type: 'prompt'; text: string }
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
