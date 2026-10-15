/**
 * The backend registry: the one place that knows how to launch a harness.
 *
 * In M1 every backend is a literal entry. Later this becomes data-driven so an
 * agent can add backends without touching code.
 */

export class UnknownBackendError extends Error {
  constructor(id: string) {
    super(`UnknownBackend: ${id}`)
    this.name = 'UnknownBackendError'
  }
}

export interface BackendSpec {
  command: string
  args: string[]
}

const BACKENDS: Record<string, BackendSpec> = {
  pi: { command: 'npx', args: ['pi-acp@latest'] },
  // goose speaks ACP natively on stdio and needs no npm fetch. Its provider and
  // API key are configured once (out of band); the core only drives the protocol.
  goose: { command: 'goose', args: ['acp'] },
}

export const BACKEND_IDS = Object.keys(BACKENDS)

export function resolveBackend(id: string): BackendSpec {
  const spec = BACKENDS[id]
  if (!spec) throw new UnknownBackendError(id)
  return spec
}
