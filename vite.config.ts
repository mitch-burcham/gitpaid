/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @bsv/sdk probes node:crypto for native hashing; without this alias the
      // probe resolves to Vite's externalized-module proxy, which logs a
      // console warning on every hash call. The shim makes the probe fail
      // cleanly so the SDK uses its pure-JS implementations.
      'node:crypto': fileURLToPath(new URL('./src/shims/node-crypto.ts', import.meta.url)),
    },
  },
  test: {
    passWithNoTests: true,
  },
})
