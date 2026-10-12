/**
 * Loads agent-authored components from the core and registers them.
 *
 * Failure is never fatal: a component that cannot be fetched, imported, or does
 * not match the contract is reported and skipped, and the built-ins keep working.
 * That is the safe mode — the app is always usable with its own components.
 */
import { registerComponent, type Component } from '../tree/render.ts'

export interface LoadFailure {
  name: string
  error: string
}

export interface LoadReport {
  loaded: string[]
  failed: LoadFailure[]
}

export interface LoadOptions {
  /** Core HTTP base, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string
  fetchImpl?: typeof fetch
  importImpl?: (url: string) => Promise<unknown>
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

export async function loadComponents(options: LoadOptions): Promise<LoadReport> {
  const doFetch = options.fetchImpl ?? fetch
  const doImport =
    options.importImpl ?? ((url: string) => import(/* @vite-ignore */ url))

  const report: LoadReport = { loaded: [], failed: [] }

  let names: string[] = []
  try {
    const response = await doFetch(`${options.baseUrl}/components`)
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
      const module = (await doImport(`${options.baseUrl}/components/${name}.js`)) as {
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

  return report
}
