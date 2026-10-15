/**
 * Core entrypoint. One binary, three jobs:
 *
 *   sbh-core                 the server (spawned by the window)
 *   sbh-core policy …        the root-side capability manifest CLI
 *   sbh-core phone           the companion phone server
 *
 * Binds loopback only; the agent channel behind this has a shell.
 */
import { startCore } from './server.ts'
import { runPolicyCli } from './policy.ts'
import { runPhoneServer } from './phone-server.ts'
import { clearCoreInfo, writeCoreInfo } from './runtime.ts'

const command = process.argv[2]

if (command === 'policy') {
  process.exit(await runPolicyCli(process.argv.slice(3)))
} else if (command === 'phone') {
  // Serves the phone client and proxies this machine's core; never returns.
  await runPhoneServer()
} else {
  const port = Number(process.env.SBH_PORT ?? 0)
  const backend = process.env.SBH_BACKEND ?? 'pi'
  const cwd = process.env.SBH_CWD ?? process.cwd()

  const core = await startCore({ port, backend, cwd })
  await writeCoreInfo({ port: core.port, backend })

  process.stdout.write(`sbh core listening on ws://127.0.0.1:${core.port}/ws (backend: ${backend})\n`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void clearCoreInfo().then(() => core.close()).then(() => process.exit(0))
    })
  }
}
