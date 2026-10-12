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
}

export const BACKEND_IDS = Object.keys(BACKENDS)

export function resolveBackend(id: string): BackendSpec {
  const spec = BACKENDS[id]
  if (!spec) throw new UnknownBackendError(id)
  return spec
}
