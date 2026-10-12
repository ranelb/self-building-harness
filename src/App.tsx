import { useEffect, useRef, useState } from 'preact/hooks'
import './ui/atoms/index.ts'
import { scaffoldTree } from './ui/scaffold.ts'
import { connectStream, type Stream } from './ui/state/stream.ts'
import {
  applyEvent,
  empty,
  resolvePermission,
  withUserMessage,
  type Transcript,
} from './ui/state/transcript.ts'
import { renderTree, type RenderContext } from './ui/tree/render.ts'

const DEFAULT_CORE_URL = import.meta.env.VITE_CORE_URL ?? 'ws://127.0.0.1:8787/ws'

export interface AppProps {
  coreUrl?: string
}

export function App({ coreUrl = DEFAULT_CORE_URL }: AppProps) {
  const [transcript, setTranscript] = useState<Transcript>(empty)
  const [draft, setDraft] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const stream = useRef<Stream | null>(null)

  useEffect(() => {
    const connection = connectStream(coreUrl)
    connection.onEvent((event) => setTranscript((previous) => applyEvent(previous, event)))
    stream.current = connection
    return () => connection.close()
  }, [coreUrl])

  const context: RenderContext = {
    tokens: {},
    dispatch(action, payload) {
      const props = payload as { value?: unknown; requestId?: unknown } | undefined

      switch (action) {
        case 'prompt.draft':
          setDraft(String(props?.value ?? ''))
          return

        case 'prompt.send': {
          const text = draft.trim()
          if (!text) return
          setTranscript((previous) => withUserMessage(previous, text))
          stream.current?.send({ type: 'prompt', text })
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

  // Re-render the tree whenever state changes. The tree is data, so "render" is
  // just replacing children; there is no second source of truth in the DOM.
  useEffect(() => {
    const element = host.current
    if (!element) return
    element.replaceChildren()
    element.appendChild(renderTree(scaffoldTree(transcript, { draft }), context))
  })

  return <div data-sbh-root ref={host} />
}
