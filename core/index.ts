/**
 * Core entrypoint. `npm run core`, or `sbh-core policy …` for the operator CLI.
 *
 * Binds loopback only; the agent channel behind this has a shell.
 */
import { startCore } from './server.ts'
import { runPolicyCli } from './policy.ts'

// One binary, two jobs: `policy` is the root-side manifest editor, everything else
// is the server. Keeps the packaged sidecar a single artifact.
if (process.argv[2] === 'policy') {
  process.exit(await runPolicyCli(process.argv.slice(3)))
}

const port = Number(process.env.SBH_PORT ?? 0)
const backend = process.env.SBH_BACKEND ?? 'pi'
const cwd = process.env.SBH_CWD ?? process.cwd()

const core = await startCore({ port, backend, cwd })

process.stdout.write(`sbh core listening on ws://127.0.0.1:${core.port}/ws (backend: ${backend})\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void core.close().then(() => process.exit(0))
  })
}
