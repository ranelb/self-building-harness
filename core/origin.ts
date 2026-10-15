/**
 * The origin guard.
 *
 * The core binds loopback and has a shell behind it: anything that can reach the
 * port can drive the agent. Loopback keeps the network out, but a web page open
 * in the user's own browser is already inside. The browser sends `Origin` on
 * every cross-origin request and on the WebSocket upgrade, so the guard can tell
 * the app from a stranger.
 *
 * A request with no `Origin` is a non-browser client (the test suite, curl, a
 * CLI). Browsers always send one, so its absence is not a bypass.
 */

/**
 * Dev and packaged origins the app legitimately loads from. The Vite ports are
 * listed for both spellings of loopback, because `localhost` and `127.0.0.1` are
 * distinct origins to the browser even though they are the same interface.
 * Tauri v2 serves the webview from a custom scheme on Linux and `http(s)://tauri.localhost`
 * elsewhere.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://127.0.0.1:5199',
  'http://localhost:5199',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]

/** Exact-string match: no wildcards, no partial origins, no suffix games. */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin)
}

/**
 * `options.allowedOrigins` wins outright when supplied. Otherwise the defaults
 * stand and `SBH_ALLOWED_ORIGINS` (comma-separated) extends them, so a client on
 * an unusual port is one env var away and the default is never silently dropped.
 */
export function resolveAllowedOrigins(
  option?: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (option) return [...option]
  const extra = (env.SBH_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])]
}
