/**
 * Loading the layout from the core.
 *
 * A layout that is missing, unreachable or not a tree falls back to the default
 * rather than leaving an empty window — the same safe-mode rule as components.
 */
import { DEFAULT_LAYOUT } from '../../../shared/layout.ts'
import { isValidLayout, type UiNode } from '../../../shared/ui.ts'

export async function loadLayout(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<UiNode> {
  try {
    const response = await fetchImpl(`${baseUrl}/layout`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed: unknown = await response.json()
    return isValidLayout(parsed) ? parsed : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}
