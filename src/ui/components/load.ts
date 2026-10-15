/**
 * Loads agent-authored components from the core and registers them.
 *
 * Failure is never fatal: a component that cannot be fetched, imported, or does
 * not match the contract is reported and skipped, and the built-ins keep working.
 * That is the safe mode — the app is always usable with its own components.
 */
import { registerComponent, unregisterComponent, type Component } from '../tree/render.ts'

export interface LoadFailure {
  name: string
  error: string
}

export interface LoadReport {
  loaded: string[]
  failed: LoadFailure[]
  /** Components that used to be registered and are gone from the directory. */
  removed: string[]
}

export interface LoadOptions {
  /** Core HTTP base, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string
  /** Which UI surface to load components for. Defaults to the base profile. */
  profile?: string
  fetchImpl?: typeof fetch
  importImpl?: (url: string) => Promise<unknown>
  /**
   * Cache-buster for module URLs.
   *
   * The browser caches ES modules by URL for the page's lifetime, ignoring
   * `cache-control`. Re-importing the same URL therefore returns the *old* module,
   * so editing an existing component appeared to do nothing — hot reload only ever
   * worked for brand-new files.
   */
  revision?: string
}

/** The core serves HTTP and WebSocket on the same loopback port. */
export function httpBaseFromWsUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    return `${url.protocol}//${url.host}`
  } catch {
    return ''
  }
}

const isComponent = (value: unknown): value is Component => {
  const candidate = value as Partial<Component> | null
  return (
    !!candidate &&
    typeof candidate.name === 'string' &&
    typeof candidate.create === 'function'
  )
}

/** Names registered by the previous load, so a deletion can be detected. */
let previouslyLoaded: string[] = []

export async function loadComponents(options: LoadOptions): Promise<LoadReport> {
  const doFetch = options.fetchImpl ?? fetch
  const doImport =
    options.importImpl ?? ((url: string) => import(/* @vite-ignore */ url))

  const report: LoadReport = { loaded: [], failed: [], removed: [] }
  const revision = options.revision ?? String(Date.now())
  const profile = encodeURIComponent(options.profile ?? 'desktop')

  let names: string[] = []
  try {
    const response = await doFetch(`${options.baseUrl}/components?profile=${profile}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { components?: unknown }
    names = Array.isArray(body?.components)
      ? body.components.filter((name): name is string => typeof name === 'string')
      : []
  } catch (err) {
    report.failed.push({ name: '(index)', error: (err as Error).message })
    return report
  }

  for (const name of names) {
    try {
      const module = (await doImport(
        `${options.baseUrl}/components/${name}.js?profile=${profile}&rev=${revision}`
      )) as {
        component?: unknown
        default?: unknown
      }
      const component = module?.component ?? module?.default
      if (!isComponent(component)) throw new Error('module does not export a valid component')
      registerComponent(component)
      report.loaded.push(component.name)
    } catch (err) {
      report.failed.push({ name, error: (err as Error).message })
    }
  }

  // A component whose file was deleted must stop resolving, or hot reload leaves
  // a ghost behind. A file that is merely broken is still present, so it stays.
  const present = new Set([...report.loaded, ...report.failed.map((failure) => failure.name)])
  for (const name of previouslyLoaded) {
    if (!present.has(name)) {
      unregisterComponent(name)
      report.removed.push(name)
    }
  }
  previouslyLoaded = [...report.loaded]

  return report
}
