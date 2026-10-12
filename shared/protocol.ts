/**
 * The wire contract between the core and any client.
 *
 * Lives outside both `core/` and `src/` so that the UI can speak the protocol
 * without importing core code — one definition, two consumers.
 */

export type UiEvent =
  | { type: 'chunk'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool'; toolCallId: string; title: string; status?: string }
  | { type: 'permission.requested'; requestId: string; title: string }
  | { type: 'turn.started' }
  | { type: 'turn.finished'; stopReason: string }
  | { type: 'error'; message: string }

/** Client -> core. */
export type ClientToCore =
  | { type: 'prompt'; text: string }
  | { type: 'permission'; requestId: string; decision: 'allow' | 'deny' }

/** Core -> client. */
export type CoreToClient =
  | { type: 'event'; event: UiEvent }
  /** A watched file changed; the client should re-fetch. Hot reload. */
  | { type: 'invalidate'; what: 'components' | 'theme' }
