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
  //
  // Rebuilding the tree replaces the focused input, which would swallow the rest
  // of a typed word, so focus and caret are restored across the rebuild. A real
  // diffing renderer is M2 work; this is the honest M1 cost of rebuilding.
  useEffect(() => {
    const element = host.current
    if (!element) return

    const active = document.activeElement as HTMLInputElement | null
    const restore =
      active && active.dataset.atom === 'input'
        ? { caret: active.selectionStart ?? active.value.length }
        : null

    element.replaceChildren()
    element.appendChild(renderTree(scaffoldTree(transcript, { draft }), context))

    if (restore) {
      const next = element.querySelector<HTMLInputElement>('input[data-atom="input"]')
      if (next) {
        next.focus()
        const position = Math.min(restore.caret, next.value.length)
        next.setSelectionRange(position, position)
      }
    }
  })

  return <div data-sbh-root ref={host} />
}
