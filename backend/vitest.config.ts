import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('../src/lib', import.meta.url)),
    },
  },
})
