/**
 * The phone server — a companion process, not the core.
 *
 * The core stays loopback (it spawns agents and answers permissions; it has no
 * business on a network). A phone cannot reach loopback and cannot be served the
 * app's static bundle by the core anyway, so this small server does exactly two
 * things: serve the built client, and reverse-proxy the core's HTTP routes and
 * WebSocket to it.
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
 * Run:  node --experimental-strip-types core/phone-server.ts
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

export interface PhoneServerOptions {
  /** The core's WebSocket URL; its HTTP host/port are derived from it. */
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
  port: number
  close(): Promise<void>
}

/** Paths the core owns. Everything else is a static file. */
const CORE_ROUTES = ['/health', '/theme', '/layout', '/components', '/sessions', '/history', '/revert', '/backends']

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
  const coreUrl = new URL(options.coreUrl ?? process.env.SBH_CORE_URL ?? 'ws://127.0.0.1:8787/ws')
  const coreHost = coreUrl.hostname
  const corePort = Number(coreUrl.port || (coreUrl.protocol === 'wss:' ? 443 : 80))
  const host = options.host ?? process.env.SBH_PHONE_HOST ?? '127.0.0.1'
  const profile = options.profile ?? process.env.SBH_PHONE_PROFILE ?? 'phone'

  const here = (import.meta as ImportMeta & { dirname?: string }).dirname
  const root = here ? resolve(here, '..') : process.cwd()
  const distRoot = resolve(options.distDir ?? process.env.SBH_PHONE_DIST ?? `${root}/dist-phone`)

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

    // Unresolved path or a miss with an HTML Accept: the app's entry.
    if (body === null) {
      if (textFallback(pathname)) {
        try {
          body = await readFile(resolve(distRoot, 'index.html'))
          path = resolve(distRoot, 'index.html')
        } catch {
          /* fall through to 404 */
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
    const headers = { ...req.headers, host: `${coreHost}:${corePort}` }
    // Server-to-server: never forward the browser's Origin, or the core's origin
    // guard would (correctly) refuse the phone's.
    delete headers.origin
    const upstream = httpRequest(
      { host: coreHost, port: corePort, path: req.url ?? '/', method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('core unreachable')
    })
    req.pipe(upstream)
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
    const upstream = new WebSocket(coreUrl)
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

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? Number(process.env.SBH_PHONE_PORT ?? 8788), host, () => resolveListen())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    async close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.closeAllConnections?.()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntrypoint) {
  const server = await startPhoneServer()
  process.stdout.write(
    `sbh phone server listening on http://127.0.0.1:${server.port}/ (core: ${process.env.SBH_CORE_URL ?? 'ws://127.0.0.1:8787/ws'}, profile: ${process.env.SBH_PHONE_PROFILE ?? 'phone'})\n`
  )
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void server.close().then(() => process.exit(0))
    })
  }
}
