import { IdentityClient } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'
import { wallet } from './wallet'

export type { DisplayableIdentity }

const identityClient = new IdentityClient(wallet)

const SEARCH_ATTRIBUTE_KEYS = ['any', 'name', 'firstName', 'lastName', 'userName', 'email'] as const

/**
 * Search for identities matching a query string across several attribute keys.
 * Fires 'any' first; the rest run in parallel. Per-key errors are swallowed.
 * Results are deduped by identityKey.
 */
export async function searchIdentities (query: string): Promise<DisplayableIdentity[]> {
  // Try 'any' first — most likely to cover everything
  let anyResults: DisplayableIdentity[] = []
  try {
    anyResults = await identityClient.resolveByAttributes({ attributes: { any: query } })
  } catch {
    // swallow
  }

  // Fire the remaining attribute keys in parallel
  const restKeys = SEARCH_ATTRIBUTE_KEYS.slice(1) // name, firstName, lastName, userName, email
  const settled = await Promise.allSettled(
    restKeys.map(k => identityClient.resolveByAttributes({ attributes: { [k]: query } }))
  )

  const all: DisplayableIdentity[] = [...anyResults]
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      all.push(...result.value)
    }
  }

  // Dedupe by identityKey
  const seen = new Set<string>()
  return all.filter(id => {
    if (seen.has(id.identityKey)) return false
    seen.add(id.identityKey)
    return true
  })
}

/** Resolved identity cache. Misses are cached as null so unknown keys don't re-query on every render. */
const resolvedCache = new Map<string, DisplayableIdentity | null>()
/** In-flight promise cache to avoid duplicate concurrent lookups. */
const inFlightCache = new Map<string, Promise<DisplayableIdentity | undefined>>()

/**
 * Resolve a single identity key to a DisplayableIdentity.
 * Results and in-flight promises are cached to avoid duplicate lookups.
 * Returns undefined on error or if no result is found.
 */
export async function resolveKey (identityKey: string): Promise<DisplayableIdentity | undefined> {
  const cached = resolvedCache.get(identityKey)
  if (cached !== undefined) return cached ?? undefined

  const inFlight = inFlightCache.get(identityKey)
  if (inFlight !== undefined) return inFlight

  const promise = (async (): Promise<DisplayableIdentity | undefined> => {
    try {
      const results = await identityClient.resolveByIdentityKey({ identityKey })
      const found = results[0]
      resolvedCache.set(identityKey, found ?? null)
      return found
    } catch {
      return undefined
    } finally {
      inFlightCache.delete(identityKey)
    }
  })()

  inFlightCache.set(identityKey, promise)
  return promise
}
