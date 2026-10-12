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
  value: string
}

const INPUT_SELECTOR = 'input[data-atom="input"]'

export function captureInputFocus(root: ParentNode): FocusState | null {
  const document = root.ownerDocument
  const active = document?.activeElement as HTMLInputElement | null
  if (!active || active.dataset.atom !== 'input') return null
  return { caret: active.selectionStart ?? active.value.length, value: active.value }
}

export function restoreInputFocus(root: ParentNode, state: FocusState | null): void {
  if (!state) return
  const input = root.querySelector<HTMLInputElement>(INPUT_SELECTOR)
  if (!input) return
  // The live DOM value wins over whatever the last render put there: at typing
  // speed a keystroke can land while the rebuild is in flight, and the rendered
  // value would otherwise clobber it and drop characters.
  if (input.value !== state.value) input.value = state.value
  input.focus()
  const position = Math.min(state.caret, input.value.length)
  input.setSelectionRange(position, position)
}
