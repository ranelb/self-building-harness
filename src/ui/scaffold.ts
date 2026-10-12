/**
 * The scaffold template: the empty box, written as literal tree data.
 *
 * This is deliberately the first template rather than hardcoded UI — the agent
 * that later authors its own chrome can copy this file, and every element here
 * is replaceable. Only the permission *gate* (the decision) is native; this is
 * its presentation.
 */
import type { UiNode } from './tree/render.ts'
import type { Transcript } from './state/transcript.ts'

export interface ScaffoldOptions {
  draft?: string
  harness?: string
  model?: string
}

export function scaffoldTree(transcript: Transcript, options: ScaffoldOptions = {}): UiNode {
  const { draft = '', harness = 'pi', model = 'default' } = options

  const messages: UiNode[] = transcript.messages.map((message) => ({
    type: 'markdown',
    props: { value: message.role === 'user' ? `**you:** ${message.text}` : message.text },
  }))

  if (transcript.error) {
    messages.push({ type: 'text', props: { value: `error: ${transcript.error}` } })
  }

  const permission: UiNode[] = transcript.pendingPermission.map((pending) => ({
    type: 'column',
    children: [
      { type: 'text', props: { value: `Permission requested: ${pending.title}` } },
      {
        type: 'button',
        props: { label: 'Allow', action: 'permission.allow', payload: { requestId: pending.requestId } },
      },
      {
        type: 'button',
        props: { label: 'Deny', action: 'permission.deny', payload: { requestId: pending.requestId } },
      },
    ],
  }))

  return {
    type: 'column',
    props: { grow: true },
    children: [
      {
        type: 'row',
        children: [
          {
            type: 'select',
            props: {
              action: 'harness.change',
              value: harness,
              options: [{ value: 'pi', label: 'Pi' }],
            },
          },
          {
            type: 'select',
            props: {
              action: 'model.change',
              value: model,
              options: [{ value: 'default', label: 'Default' }],
            },
          },
        ],
      },
      { type: 'scroll', props: { grow: true }, children: messages },
      { type: 'column', children: permission },
      {
        type: 'row',
        children: [
          {
            type: 'input',
            props: { value: draft, placeholder: 'Message', action: 'prompt.draft', grow: true },
          },
          { type: 'button', props: { label: 'Send', action: 'prompt.send' } },
        ],
      },
    ],
  }
}
