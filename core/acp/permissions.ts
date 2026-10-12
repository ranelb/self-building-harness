/**
 * The permission gate — the trust boundary, in one named place.
 *
 * ACP sends `session/request_permission` as an inbound *request*; something must
 * answer it or the agent stalls forever. In M1 the answer comes from the UI
 * (the agent-authored permission card). The policy exists so that an *unattended*
 * turn still has a defined answer: deny.
 *
 * M2 replaces `DENY_BY_DEFAULT` with a capability manifest. Until then this is
 * deliberately the dumbest possible policy.
 */
import type { AcpConnection } from './client.ts'

export type PermissionDecision = 'allow' | 'deny'

export interface PermissionRequest {
  requestId: string
  title: string
}

/** `ask` means "defer to the UI"; otherwise the policy decides alone. */
export type PermissionPolicy = (request: PermissionRequest) => PermissionDecision | 'ask'

/** The M1 policy: nothing is permitted without a human (or the UI) saying so. */
export const DENY_BY_DEFAULT: PermissionPolicy = () => 'deny'

/** The single place a permission request is answered. */
export async function respondToPermission(
  conn: AcpConnection,
  requestId: string,
  decision: PermissionDecision
): Promise<void> {
  await conn.respondPermission(requestId, decision)
}
