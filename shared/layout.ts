/**
 * The default layout: the empty box, as a tree an agent can replace.
 *
 * Note there is no binding language here. Anything dynamic is a *host component*
 * (`transcript`, `composer`, `permission`, …) that reads `ctx.host` — so the
 * layout stays plain static structure, and an agent changes what is on screen by
 * editing this file rather than by learning an expression syntax.
 */
import type { UiNode } from './ui.ts'

export const DEFAULT_LAYOUT: UiNode = {
  type: 'row',
  props: { grow: true, align: 'stretch' },
  children: [
    { type: 'sessions', props: { width: '240px' } },
    {
      type: 'column',
      props: { grow: true },
      children: [
        { type: 'notices' },
        { type: 'row', children: [{ type: 'harnessPicker' }, { type: 'modelPicker' }] },
        { type: 'transcript', props: { grow: true } },
        { type: 'changedFiles' },
        { type: 'permission' },
        { type: 'composer' },
      ],
    },
  ],
}
