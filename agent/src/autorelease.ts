/**
 * `gitpaid autorelease` — sponsor-side daemon (FR-022, TR-010, D14).
 *
 * Watches accepted claims; when the linked PR merges, releases the escrow
 * via the sponsor's own LOCAL wallet. Never runs in a browser extension
 * background (extensions die with the browser); never holds server-side
 * keys — this is the unattended path of D14, on the sponsor's machine.
 *
 * GitHub access (TR-010): fine-grained PAT (repo:read) via env var only,
 * passed in by the CLI — never stored by gitpaid. Merge state comes from
 * the REST API, never the DOM. 403/429 → backoff (skip this round); the
 * next tick retries.
 */
export interface PrRef {
  owner: string
  repo: string
  number: number
}

/** Parse a GitHub PR URL. Returns null for anything else (untrusted input). */
export function parsePrUrl (url: string): PrRef | null {
  try {
    const u = new URL(url)
    if (u.hostname !== 'github.com') return null
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/)
    if (m === null) return null
    return { owner: m[1], repo: m[2], number: Number(m[3]) }
  } catch {
    return null
  }
}

export type MergeState = 'merged' | 'unmerged' | 'backoff'

/** GET /repos/{o}/{r}/pulls/{n}/merge → 204 merged, 404 not merged. */
export async function checkPrMerged (
  pr: PrRef,
  ghToken: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<MergeState> {
  const res = await fetchFn(
    `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(ghToken !== undefined ? { Authorization: `Bearer ${ghToken}` } : {}),
      },
    },
  )
  if (res.status === 204) return 'merged'
  if (res.status === 404) return 'unmerged'
  if (res.status === 403 || res.status === 429) return 'backoff'
  throw new Error(`GitHub merge check failed: HTTP ${res.status}`)
}

export interface AutoreleaseDeps {
  /** Accepted claims joined with their invites (from buildSponsorState). */
  pending: Array<{
    escrowId: string
    claimantIdentityKey: string
    prUrl: string
    threshold: number
    controllers: number
  }>
  ghToken?: string
  fetchFn?: typeof fetch
  /** Performs the actual release (releaseSoloBounty wired by the CLI). */
  release: (escrowId: string, claimantIdentityKey: string) => Promise<{ txid: string }>
}

export interface AutoreleaseResult {
  escrowId: string
  outcome: 'released' | 'unmerged' | 'backoff' | 'skipped-multisig' | 'skipped-bad-pr' | 'error'
  detail?: string
}

/** One tick of the daemon. Pure orchestration — everything injected. */
export async function runAutoreleaseOnce (deps: AutoreleaseDeps): Promise<AutoreleaseResult[]> {
  const fetchFn = deps.fetchFn ?? fetch
  const results: AutoreleaseResult[] = []

  for (const item of deps.pending) {
    // Unattended signing is only safe where the sponsor alone controls
    // release; multi-controller escrows need the coordination flow.
    if (item.threshold !== 1 || item.controllers !== 1) {
      results.push({ escrowId: item.escrowId, outcome: 'skipped-multisig' })
      continue
    }
    const pr = parsePrUrl(item.prUrl)
    if (pr === null) {
      results.push({ escrowId: item.escrowId, outcome: 'skipped-bad-pr' })
      continue
    }
    try {
      const state = await checkPrMerged(pr, deps.ghToken, fetchFn)
      if (state === 'backoff') {
        results.push({ escrowId: item.escrowId, outcome: 'backoff' })
        continue
      }
      if (state === 'unmerged') {
        results.push({ escrowId: item.escrowId, outcome: 'unmerged' })
        continue
      }
      const { txid } = await deps.release(item.escrowId, item.claimantIdentityKey)
      results.push({ escrowId: item.escrowId, outcome: 'released', detail: txid })
    } catch (err) {
      results.push({
        escrowId: item.escrowId,
        outcome: 'error',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}
