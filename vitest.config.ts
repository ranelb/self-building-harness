import preact from '@preact/preset-vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [preact()],
  test: {
    // Node by default: only the frontend tests need a DOM, and they opt in with
    // a `// @vitest-environment happy-dom` docblock. happy-dom's fetch enforces
    // same-origin and would block core tests from reaching their own server.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'core/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
