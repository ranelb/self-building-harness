/**
 * Debounced file watching.
 *
 * An editor writes a file in several events; without debouncing a single save
 * would trigger several reloads, and a component that is mid-write would be
 * imported in a broken state.
 */
import { watch } from 'node:fs'

export interface Watcher {
  close(): void
}

export function watchPaths(
  paths: string[],
  onChange: (changedPath: string) => void,
  debounceMs = 150
): Watcher {
  const watchers: Array<{ close(): void }> = []
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  for (const path of paths) {
    try {
      watchers.push(
        watch(path, (_event, filename) => {
          const key = filename === null ? path : String(filename)
          const existing = timers.get(key)
          if (existing) clearTimeout(existing)
          timers.set(
            key,
            setTimeout(() => {
              timers.delete(key)
              onChange(key)
            }, debounceMs)
          )
        })
      )
    } catch {
      // A path that does not exist yet is not an error; it may be created later.
    }
  }

  return {
    close() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const watcher of watchers) watcher.close()
    },
  }
}
