// Browser stand-in for node:crypto. @bsv/sdk probes for the native module to
// use fast hashing when available; an empty export makes the probe fail
// cleanly so the SDK takes its pure-JS path without Vite's externalized-module
// proxy warning on every property access.
export default undefined
