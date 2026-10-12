/**
 * Focus/caret preservation across a tree rebuild.
 *
 * The renderer replaces children wholesale, so a focused input is destroyed on
 * every state change — which swallowed all but the first typed character in the
 * browser until this existed. A diffing renderer is M2 work.
 *
 * Extracted from `App` so the behaviour is unit-testable without Preact's
 * effect timing (which does not reproduce the bug under happy-dom).
 */

export interface FocusState {
  caret: number
}

const INPUT_SELECTOR = 'input[data-atom="input"]'

export function captureInputFocus(root: ParentNode): FocusState | null {
  const document = root.ownerDocument
  const active = document?.activeElement as HTMLInputElement | null
  if (!active || active.dataset.atom !== 'input') return null
  return { caret: active.selectionStart ?? active.value.length }
}

export function restoreInputFocus(root: ParentNode, state: FocusState | null): void {
  if (!state) return
  const input = root.querySelector<HTMLInputElement>(INPUT_SELECTOR)
  if (!input) return
  input.focus()
  const position = Math.min(state.caret, input.value.length)
  input.setSelectionRange(position, position)
}
