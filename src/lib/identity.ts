import { IdentityClient } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'
import { wallet } from './wallet'

export type { DisplayableIdentity }

// ── Deterministic placeholder names ──────────────────────────────────────────
const ADJECTIVES = [
  'Amber', 'Azure', 'Brass', 'Cobalt', 'Coral', 'Crimson',
  'Dusk', 'Ember', 'Fawn', 'Flint', 'Frost', 'Golden',
  'Indigo', 'Ivory', 'Jade', 'Lapis', 'Lilac', 'Maple',
  'Onyx', 'Pearl', 'Sage', 'Slate', 'Teal', 'Umber',
]

const ANIMALS = [
  'Condor', 'Crane', 'Dingo', 'Falcon', 'Ferret', 'Finch',
  'Heron', 'Ibis', 'Kestrel', 'Lynx', 'Marten', 'Merlin',
  'Osprey', 'Otter', 'Puffin', 'Raven', 'Robin', 'Sable',
  'Shrike', 'Stoat', 'Swift', 'Weasel', 'Wren', 'Wolverine',
]

/**
 * Deterministic human-readable placeholder for an identity key, e.g. "Amber Falcon".
 * Same key always returns the same name; different keys produce different names.
 */
export function placeholderName (identityKey: string): string {
  // Use different slices of the key for the two words to reduce collisions
  let hashA = 0
  for (let i = 0; i < identityKey.length; i += 2) {
    hashA = (hashA * 31 + identityKey.charCodeAt(i)) & 0xffffffff
  }
  let hashB = 0
  for (let i = 1; i < identityKey.length; i += 2) {
    hashB = (hashB * 37 + identityKey.charCodeAt(i)) & 0xffffffff
  }
  const adj = ADJECTIVES[Math.abs(hashA) % ADJECTIVES.length]
  const animal = ANIMALS[Math.abs(hashB) % ANIMALS.length]
  return `${adj} ${animal}`
}

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
