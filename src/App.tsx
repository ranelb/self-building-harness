import { useEffect, useRef, useState } from 'preact/hooks'
import './ui/atoms/index.ts'
import { httpBaseFromWsUrl, loadComponents, type LoadReport } from './ui/components/load.ts'
import { applyTheme, loadTheme } from './ui/theme/apply.ts'
import { scaffoldTree } from './ui/scaffold.ts'
import { connectStream, type Stream } from './ui/state/stream.ts'
import {
  applyEvent,
  empty,
  resolvePermission,
  withUserMessage,
  type Transcript,
} from './ui/state/transcript.ts'
import { getLive, renderInto, setLive, type RenderContext, type UiNode } from './ui/tree/render.ts'

const DEFAULT_CORE_URL = import.meta.env.VITE_CORE_URL ?? 'ws://127.0.0.1:8787/ws'

export interface AppProps {
  coreUrl?: string
}

export function App({ coreUrl = DEFAULT_CORE_URL }: AppProps) {
  const [transcript, setTranscript] = useState<Transcript>(empty)
  const [draft, setDraft] = useState('')
  const [components, setComponents] = useState<LoadReport | null>(null)
  const [tokens, setTokens] = useState<Record<string, string>>({})
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

    connection.onEvent((event) => setTranscript((previous) => applyEvent(previous, event)))
    connection.onInvalidate((what) => (what === 'components' ? refreshComponents() : refreshTheme()))

    refreshComponents()
    refreshTheme()

    return () => {
      cancelled = true
      connection.close()
    }
  }, [coreUrl])

  const context: RenderContext = {
    tokens,
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

        default:
          return
      }
    },
  }

  // Reconcile rather than rebuild. Component instances (and therefore focus,
  // caret, scroll position and any future canvas state) survive an update; the
  // tree stays the single source of truth for *what* is rendered.
  useEffect(() => {
    const element = host.current
    if (!element) return
    const notices = components?.failed.map((failure) => `${failure.name} (${failure.error})`) ?? []
    renderInto(element, scaffoldTree(transcript, { draft, notices }), context)
  })

  return <div data-sbh-root ref={host} />
}
