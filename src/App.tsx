import { useEffect, useRef, useState } from 'preact/hooks'
import './ui/atoms/index.ts'
import { httpBaseFromWsUrl, loadComponents, type LoadReport } from './ui/components/load.ts'
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
  const host = useRef<HTMLDivElement>(null)
  const stream = useRef<Stream | null>(null)

  useEffect(() => {
    const connection = connectStream(coreUrl)
    connection.onEvent((event) => setTranscript((previous) => applyEvent(previous, event)))
    stream.current = connection
    return () => connection.close()
  }, [coreUrl])

  // Agent-authored components load once, then the state change re-renders so any
  // that published a component are usable. Failures are surfaced, not swallowed:
  // the built-ins keep working and the broken ones are named on screen.
  useEffect(() => {
    const baseUrl = httpBaseFromWsUrl(coreUrl)
    if (!baseUrl) return
    let cancelled = false
    void loadComponents({ baseUrl }).then((report) => {
      if (!cancelled) setComponents(report)
    })
    return () => {
      cancelled = true
    }
  }, [coreUrl])

  const context: RenderContext = {
    tokens: {},
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
