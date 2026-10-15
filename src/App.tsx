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
  markSuperseded,
  resolvePermission,
  toMessages,
  withUserMessage,
  type Transcript,
} from './ui/state/transcript.ts'
import { getLive, renderInto, setLive, type HostState, type RenderContext, type SessionSummary, type UiNode } from './ui/tree/render.ts'
import { DEFAULT_LAYOUT } from '../shared/layout.ts'
import type { Attachment } from '../shared/protocol.ts'

const DEFAULT_CORE_URL =
  (globalThis as { __SBH_CORE_URL__?: string }).__SBH_CORE_URL__ ??
  import.meta.env.VITE_CORE_URL ??
  'ws://127.0.0.1:8787/ws'

/**
 * Which UI surface this client is. The core serves a layout, theme and component
 * set per profile, so a phone does not inherit a desktop tree. Override with
 * `?profile=` (browser dev) or an injected `window.__SBH_PROFILE__` (a shell).
 */
const PROFILE =
  (typeof location !== 'undefined' ? new URLSearchParams(location.search).get('profile') : null) ??
  (globalThis as { __SBH_PROFILE__?: string }).__SBH_PROFILE__ ??
  'desktop'

/** Read a `{ value, options }` picker out of the state channel, or fall back. */
const asPicker = (
  value: unknown,
  fallback: { value: string; options: { value: string; label: string }[] }
): { value: string; options: { value: string; label: string }[] } => {
  if (typeof value !== 'object' || value === null) return fallback
  const candidate = value as { value?: unknown; options?: unknown }
  if (typeof candidate.value !== 'string' || !Array.isArray(candidate.options)) return fallback
  const options = candidate.options.filter(
    (option): option is { value: string; label: string } =>
      typeof option === 'object' &&
      option !== null &&
      typeof (option as { value?: unknown }).value === 'string' &&
      typeof (option as { label?: unknown }).label === 'string'
  )
  return { value: candidate.value, options }
}

export interface AppProps {
  coreUrl?: string
}

export function App({ coreUrl = DEFAULT_CORE_URL }: AppProps) {
  const [transcript, setTranscript] = useState<Transcript>(empty)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [components, setComponents] = useState<LoadReport | null>(null)
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [layout, setLayout] = useState<UiNode>(DEFAULT_LAYOUT)
  const [data, setData] = useState<Record<string, unknown>>({})
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const host = useRef<HTMLDivElement>(null)
  const stream = useRef<Stream | null>(null)
  /** The user item being edited, if the next send should branch for it. */
  const pendingEdit = useRef<string | null>(null)

  // One effect owns the connection, the initial loads and every refresh, so hot
  // reload and first paint go down exactly the same path.
  useEffect(() => {
    const baseUrl = httpBaseFromWsUrl(coreUrl)
    const connection = connectStream(coreUrl, PROFILE)
    stream.current = connection
    let cancelled = false

    const refreshComponents = () => {
      if (!baseUrl) return
      void loadComponents({ baseUrl, profile: PROFILE }).then((report) => {
        if (!cancelled) setComponents(report)
      })
    }

    const refreshTheme = () => {
      if (!baseUrl) return
      // Variables live on the document root, so everything — including the body
      // background — follows a theme change with no re-render.
      void loadTheme(baseUrl, PROFILE).then((theme) => {
        if (!cancelled) setTokens(applyTheme(document.documentElement, theme))
      })
    }

    const refreshLayout = () => {
      if (!baseUrl) return
      void loadLayout(baseUrl, PROFILE).then((next) => {
        if (!cancelled) setLayout(next)
      })
    }

    const refreshSessions = () => {
      if (!baseUrl) return
      void fetch(`${baseUrl}/sessions`)
        .then((response) => (response.ok ? response.json() : { sessions: [] }))
        .then((body: { sessions?: SessionSummary[] }) => {
          if (!cancelled) setSessions(body.sessions ?? [])
        })
        .catch(() => {
          // A missing session store is not a failure state; the sidebar stays empty.
        })
    }

    connection.onEvent((event) => {
      if (event.type === 'usage') {
        // Context usage is state, not transcript.
        setData((previous) => ({
          ...previous,
          usage: {
            used: event.used,
            size: event.size,
            ...(event.cost === undefined ? {} : { cost: event.cost }),
          },
        }))
        return
      }
      if (event.type === 'permission.resolved') {
        // A manifest decision is not a question; keep the last few for the notices
        // surface so a deny is visible without reading the audit log.
        setData((previous) => {
          const policy = Array.isArray(previous.policy) ? (previous.policy as unknown[]) : []
          return { ...previous, policy: [event, ...policy].slice(0, 20) }
        })
        return
      }
      if (event.type === 'session.reset') setAttachments([])
      setTranscript((previous) => applyEvent(previous, event))
    })
    connection.onState((key, value) => {
      if (key === 'capabilities' && typeof value === 'object' && value !== null) {
        // The core publishes capabilities on the state channel; the transcript
        // owns them (fork gating and the composer's attacher read from there).
        const caps = value as Partial<Record<'image' | 'audio' | 'embeddedContext' | 'fork', unknown>>
        setTranscript((previous) =>
          applyEvent(previous, {
            type: 'capabilities',
            image: caps.image === true,
            audio: caps.audio === true,
            embeddedContext: caps.embeddedContext === true,
            fork: caps.fork === true,
          })
        )
        return
      }
      setData((previous) => ({ ...previous, [key]: value }))
    })
    connection.onInvalidate((what) => {
      if (what === 'components') refreshComponents()
      else if (what === 'theme') refreshTheme()
      else refreshLayout()
    })

    refreshComponents()
    refreshTheme()
    refreshLayout()
    refreshSessions()

    return () => {
      cancelled = true
      connection.close()
    }
  }, [coreUrl])

  const hostState: HostState = {
    messages: toMessages(transcript),
    items: transcript.items,
    changedFiles: transcript.changedFiles,
    commands: transcript.commands,
    draftAttachments: attachments,
    capabilities: transcript.capabilities,
    status: transcript.status,
    error: transcript.error,
    draft,
    pendingPermission: transcript.pendingPermission,
    notices: components?.failed.map((failure) => `${failure.name} (${failure.error})`) ?? [],
    harness: asPicker(data.harness, { value: 'pi', options: [{ value: 'pi', label: 'Pi' }] }),
    model: asPicker(data.model, { value: '', options: [] }),
    sessions,
    data,
  }

  const context: RenderContext = {
    tokens,
    host: hostState,
    bind: (el: Node, node: UiNode) => setLive(el, node, context),
    latest: (el: Node) => getLive(el),
    dispatch(action, payload) {
      const props = payload as
        | { value?: unknown; requestId?: unknown; id?: unknown; attachment?: Attachment; index?: unknown }
        | undefined

      switch (action) {
        case 'prompt.draft':
          setDraft(String(props?.value ?? ''))
          return

        case 'attachment.add': {
          const attachment = props?.attachment
          if (attachment) setAttachments((previous) => [...previous, attachment])
          return
        }

        case 'attachment.remove': {
          const index = Number(props?.index)
          setAttachments((previous) => previous.filter((_, at) => at !== index))
          return
        }

        case 'turn.cancel':
          stream.current?.send({ type: 'cancel' })
          return

        case 'session.new':
          pendingEdit.current = null
          stream.current?.send({ type: 'session.new' })
          return

        case 'message.edit': {
          const id = String(props?.id ?? '')
          const item = transcript.items.find((entry) => entry.kind === 'user' && entry.id === id)
          if (!item || item.kind !== 'user') return
          // Prefill and dim the original; a true branch needs a backend fork point.
          setDraft(item.text)
          setTranscript((previous) => markSuperseded(previous, id))
          pendingEdit.current = id
          const input = host.current?.querySelector<HTMLInputElement>('input[data-atom="input"]')
          if (input) {
            // Set it directly: `update` deliberately never overwrites a focused
            // input, and we focus it here.
            input.value = item.text
            input.focus()
          }
          return
        }

        case 'prompt.send': {
          // Read the live input, not the last rendered state: at typing speed the
          // state can lag a keystroke, which silently truncated sent prompts.
          const live = host.current?.querySelector<HTMLInputElement>('input[data-atom="input"]')
          const text = (live?.value ?? draft).trim()
          const outgoing = attachments
          if (!text && outgoing.length === 0) return
          // An edit becomes a real branch only when the backend forks and the
          // edit is the last user turn; otherwise it is a resend (dimmed above).
          const editing = pendingEdit.current
          pendingEdit.current = null
          if (editing && transcript.capabilities.fork) {
            const lastUser = [...transcript.items].reverse().find((entry) => entry.kind === 'user')
            if (lastUser?.id === editing) stream.current?.send({ type: 'session.fork' })
          }
          setTranscript((previous) => withUserMessage(previous, text, outgoing))
          stream.current?.send({
            type: 'prompt',
            text,
            ...(outgoing.length > 0 ? { attachments: outgoing } : {}),
          })
          if (live) live.value = ''
          setDraft('')
          setAttachments([])
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

        case 'harness.change': {
          // The core reconnects the ACP session with the new backend.
          stream.current?.send({ type: 'backend', id: String(props?.value ?? '') })
          return
        }

        case 'model.change': {
          stream.current?.send({ type: 'model', id: String(props?.value ?? '') })
          return
        }

        case 'session.open': {
          const id = String(props?.id ?? '')
          if (!id) return
          // Resuming replaces what is on screen: clear it, then let the agent's
          // replayed events rebuild the conversation. The agent is now attached to
          // this session, so the next message continues it rather than starting one.
          setTranscript(empty())
          const session = sessions.find((s) => s.id === id)
          stream.current?.send({ type: 'session.resume', id, cwd: session?.cwd ?? '' })
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
