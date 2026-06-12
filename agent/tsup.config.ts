import { defineConfig } from 'tsup'
import { fileURLToPath } from 'node:url'

/**
 * Bundles the CLI (and the MCP server it embeds) into dist/cli.js.
 *
 * The @engine alias points at ../src/lib (ADR-002: engine files never move,
 * never get published separately) — esbuild resolves it INTO the bundle, so
 * the published npm package is self-contained: engine code ships inside,
 * @bsv/* deps stay external (declared dependencies).
 */
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: 'esm',
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  esbuildOptions (options) {
    options.alias = {
      '@engine': fileURLToPath(new URL('../src/lib', import.meta.url)),
    }
  },
})
