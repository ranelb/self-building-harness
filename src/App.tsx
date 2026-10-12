import { useEffect, useRef, useState } from 'preact/hooks'
import './ui/atoms/index.ts'
import './ui/host/components.ts'
import { httpBaseFromWsUrl, loadComponents, type LoadReport } from './ui/components/load.ts'
import { loadLayout } from './ui/layout/load.ts'
import { applyTheme, loadTheme } from './ui/theme/apply.ts'
import { connectStream, type Stream } from './ui/state/stream.ts'
import {
  applyEvent,
  empty,
  resolvePermission,
  withUserMessage,
  type Transcript,
} from './ui/state/transcript.ts'
import { getLive, renderInto, setLive, type HostState, type RenderContext, type UiNode } from './ui/tree/render.ts'
import { DEFAULT_LAYOUT } from '../shared/layout.ts'

const DEFAULT_CORE_URL = import.meta.env.VITE_CORE_URL ?? 'ws://127.0.0.1:8787/ws'

export interface AppProps {
  coreUrl?: string
}

export function App({ coreUrl = DEFAULT_CORE_URL }: AppProps) {
  const [transcript, setTranscript] = useState<Transcript>(empty)
  const [draft, setDraft] = useState('')
  const [components, setComponents] = useState<LoadReport | null>(null)
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [layout, setLayout] = useState<UiNode>(DEFAULT_LAYOUT)
  const host = useRef<HTMLDivElement>(null)
  const stream = useRef<Stream | null>(null)

  // One effect owns the connection, the initial loads and every refresh, so hot
  // reload and first paint go down exactly the same path.
  useEffect(() => {
    const baseUrl = httpBaseFromWsUrl(coreUrl)
    const connection = connectStream(coreUrl)
    stream.current = connection
    let cancelled = false

    const refreshComponents = () => {
      if (!baseUrl) return
      void loadComponents({ baseUrl }).then((report) => {
        if (!cancelled) setComponents(report)
      })
    }

    const refreshTheme = () => {
      if (!baseUrl) return
      // Variables live on the document root, so everything — including the body
      // background — follows a theme change with no re-render.
      void loadTheme(baseUrl).then((theme) => {
        if (!cancelled) setTokens(applyTheme(document.documentElement, theme))
      })
    }

    const refreshLayout = () => {
      if (!baseUrl) return
      void loadLayout(baseUrl).then((next) => {
        if (!cancelled) setLayout(next)
      })
    }

    connection.onEvent((event) => setTranscript((previous) => applyEvent(previous, event)))
    connection.onInvalidate((what) => {
      if (what === 'components') refreshComponents()
      else if (what === 'theme') refreshTheme()
      else refreshLayout()
    })

    refreshComponents()
    refreshTheme()
    refreshLayout()

    return () => {
      cancelled = true
      connection.close()
    }
  }, [coreUrl])

  const hostState: HostState = {
    messages: transcript.messages,
    status: transcript.status,
    error: transcript.error,
    draft,
    pendingPermission: transcript.pendingPermission,
    notices: components?.failed.map((failure) => `${failure.name} (${failure.error})`) ?? [],
    harness: { value: 'pi', options: [{ value: 'pi', label: 'Pi' }] },
    model: { value: 'default', options: [{ value: 'default', label: 'Default' }] },
  }

  const context: RenderContext = {
    tokens,
    host: hostState,
    bind: (el: Node, node: UiNode) => setLive(el, node, context),
    latest: (el: Node) => getLive(el),
    dispatch(action, payload) {
      const props = payload as { value?: unknown; requestId?: unknown } | undefined

      switch (action) {
        case 'prompt.draft':
          setDraft(String(props?.value ?? ''))
          return

        case 'prompt.send': {
          // Read the live input, not the last rendered state: at typing speed the
          // state can lag a keystroke, which silently truncated sent prompts.
          const live = host.current?.querySelector<HTMLInputElement>('input[data-atom="input"]')
          const text = (live?.value ?? draft).trim()
          if (!text) return
          setTranscript((previous) => withUserMessage(previous, text))
          stream.current?.send({ type: 'prompt', text })
          if (live) live.value = ''
          setDraft('')
          return
        }

        case 'permission.allow':
        case 'permission.deny': {
          const requestId = String(props?.requestId ?? '')
          if (!requestId) return
          stream.current?.send({
            type: 'permission',
            requestId,
            decision: action === 'permission.allow' ? 'allow' : 'deny',
          })
          setTranscript((previous) => resolvePermission(previous, requestId))
          return
        }

        case 'ui.revert': {
          const base = httpBaseFromWsUrl(coreUrl)
          if (!base) return
          // The core reverts and then broadcasts an invalidate, so the refresh
          // path is the same one hot reload already uses.
          void fetch(`${base}/revert`, { method: 'POST' })
          return
        }

        default:
          return
      }
    },
  }

  // Reconcile rather than rebuild. Component instances (and therefore focus,
  // caret, scroll position and any future canvas state) survive an update; the
  // layout stays the single source of truth for *what* is rendered.
  useEffect(() => {
    const element = host.current
    if (!element) return
    renderInto(element, layout, context)
  })

  return <div data-sbh-root ref={host} />
}
