/**
 * Shared styling for the built-in controls.
 *
 * Every value is a `var(--sbh-…)` reference, never a literal: the built-ins then
 * follow the theme for free, and an agent-authored component has a worked example
 * of the right way to do it.
 */

const base = (el: HTMLElement): void => {
  el.style.border = '1px solid var(--sbh-color-border)'
  el.style.borderRadius = 'var(--sbh-radius-md)'
  el.style.padding = 'var(--sbh-space-sm) var(--sbh-space-md)'
  el.style.fontFamily = 'var(--sbh-font-sans)'
  el.style.fontSize = 'var(--sbh-font-size)'
  el.style.color = 'var(--sbh-color-text)'
  el.style.outlineColor = 'var(--sbh-color-accent)'
}

/** Buttons and selects: raised against the surface. */
export function controlStyle(el: HTMLElement): void {
  base(el)
  el.style.background = 'var(--sbh-color-surface-alt)'
  el.style.cursor = 'pointer'
}

/** Text fields: recessed into the surface. */
export function fieldStyle(el: HTMLElement): void {
  base(el)
  el.style.background = 'var(--sbh-color-surface)'
}
