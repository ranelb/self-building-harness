/**
 * The phone server — a companion process, not the core.
 *
 * The core stays loopback (it spawns agents and answers permissions; it has no
 * business on a network). A phone cannot reach loopback and cannot be served the
 * app's static bundle by the core anyway, so this does exactly two things: serve
 * the built client, and reverse-proxy the core's HTTP routes and WebSocket to it.
 *
 * It binds loopback by default. How you reach it — Tailscale Serve, a reverse
 * proxy, an ssh tunnel — is your business; SBH names no transport, the same way it
 * names no elevator. Front it with something that terminates TLS and the client
 * gets a secure context (which a PWA needs for a service worker).
 *
 * It has no endpoints of its own beyond static files and the proxy, so it cannot
 * widen the capability boundary: there is nothing here to grant, and the manifest
 * is edited by a root-side CLI, not over HTTP.
 *
 * `sbh-core phone` (the package installs `sbh-phone`); in a checkout, `npm run phone`.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { readCorePort } from './runtime.ts'

export interface PhoneServerOptions {
  /** The core's WebSocket URL. Unset: discover the running core's port. */
  coreUrl?: string
  /** Where to bind. Defaults to loopback — put a TLS proxy in front for a phone. */
  host?: string
  /** 0 picks a free port. */
  port?: number
  /** The built client to serve, relative to the package root unless absolute. */
  distDir?: string
  /** The surface the phone declares. */
  profile?: string
}

export interface PhoneServer {
  host: string
  port: number
  close(): Promise<void>
}

/** Paths the core owns. Everything else is a static file. */
const CORE_ROUTES = ['/health', '/theme', '/layout', '/components', '/sessions', '/files', '/history', '/revert', '/backends']

const isCoreRoute = (pathname: string): boolean =>
  CORE_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const contentType = (path: string): string => CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

/** Inject the surface and the (same-origin) core URL before the app's own scripts. */
export function injectGlobals(html: string, profile: string): string {
  const script =
    `<script>window.__SBH_PROFILE__=${JSON.stringify(profile)};` +
    `window.__SBH_CORE_URL__=(location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/ws";</script>`
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

export async function startPhoneServer(options: PhoneServerOptions = {}): Promise<PhoneServer> {
  const configuredCore = options.coreUrl ?? process.env.SBH_CORE_URL ?? null
  const host = options.host ?? process.env.SBH_PHONE_HOST ?? '127.0.0.1'
  const profile = options.profile ?? process.env.SBH_PHONE_PROFILE ?? 'phone'

  const here = (import.meta as ImportMeta & { dirname?: string }).dirname
  const root = here ? resolve(here, '..') : process.cwd()
  const distRoot = resolve(options.distDir ?? process.env.SBH_PHONE_DIST ?? `${root}/dist-phone`)

  /** The core to proxy to: a fixed URL, or whatever the running core advertises. */
  const resolveCore = async (): Promise<{ host: string; port: number; wsUrl: string }> => {
    if (configuredCore) {
      const url = new URL(configuredCore)
      const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80))
      return { host: url.hostname, port, wsUrl: configuredCore }
    }
    const port = await readCorePort()
    if (!port) throw new Error('no core')
    return { host: '127.0.0.1', port, wsUrl: `ws://127.0.0.1:${port}/ws` }
  }

  /** A path with no file extension is an app route, not an asset. */
  const textFallback = (pathname: string): boolean => extname(pathname) === ''

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    // Resolve inside the dist root; a `..` that escapes is not a file.
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const target = resolve(distRoot, `.${relative}`)
    const inside = target === distRoot || target.startsWith(distRoot + sep)
    const acceptsHtml = (req.headers.accept ?? '').includes('text/html')

    let path = inside ? target : ''
    let body: Buffer | null = null
    try {
      if (path) body = await readFile(path)
    } catch {
      body = null
    }

    // An unresolved path that looks like an app route, with an HTML Accept.
    if (body === null) {
      if (textFallback(pathname)) {
        try {
          body = await readFile(resolve(distRoot, 'index.html'))
          path = resolve(distRoot, 'index.html')
        } catch {
          /* fall through */
        }
      }
      if (body === null || !acceptsHtml) {
        res.writeHead(404)
        res.end('not found')
        return
      }
    }

    const isHtml = extname(path) === '.html'
    res.writeHead(200, { 'content-type': contentType(path) })
    res.end(isHtml ? injectGlobals(body.toString('utf8'), profile) : body)
  }

  const proxyHttp = (req: IncomingMessage, res: ServerResponse): void => {
    void resolveCore()
      .then((core) => {
        const headers = { ...req.headers, host: `${core.host}:${core.port}` }
        // Server-to-server: never forward the browser's Origin, or the core's origin
        // guard would (correctly) refuse the phone's.
        delete headers.origin
        const upstream = httpRequest(
          { host: core.host, port: core.port, path: req.url ?? '/', method: req.method, headers },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers)
            response.pipe(res)
          }
        )
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
          res.end('core unreachable')
        })
        req.pipe(upstream)
      })
      .catch(() => {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('no core running')
      })
  }

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (isCoreRoute(pathname)) proxyHttp(req, res)
    else void serveStatic(req, res, pathname)
  })

  // The client opens one socket to the phone server's origin; bridge it to the core.
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/ws') {
      socket.destroy()
      return
    }
    void resolveCore()
      .then((core) => {
        const upstream = new WebSocket(core.wsUrl)
        upstream.on('open', () => {
          wss.handleUpgrade(req, socket, head, (client) => {
            const shutdown = (): void => {
              try {
                client.close()
              } catch {
                /* already closing */
              }
              try {
                upstream.close()
              } catch {
                /* already closing */
              }
            }
            client.on('message', (data, binary) => {
              if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
            })
            upstream.on('message', (data, binary) => {
              if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
            })
            client.on('close', shutdown)
            client.on('error', shutdown)
            upstream.on('close', shutdown)
            upstream.on('error', shutdown)
          })
        })
        upstream.on('error', () => socket.destroy())
      })
      .catch(() => socket.destroy())
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? Number(process.env.SBH_PHONE_PORT ?? 8788), host, () => resolveListen())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    host,
    port,
    async close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.closeAllConnections?.()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

/** Start the phone server and keep the process alive until a signal arrives. */
export async function runPhoneServer(): Promise<void> {
  const server = await startPhoneServer()
  const core = process.env.SBH_CORE_URL ?? 'the running core (discovered)'
  process.stdout.write(
    `sbh phone server listening on http://${server.host}:${server.port}/ ` +
      `(core: ${core}, profile: ${process.env.SBH_PHONE_PROFILE ?? 'phone'})\n`
  )
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void server.close().then(() => process.exit(0))
    })
  }
}
