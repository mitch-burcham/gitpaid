/**
 * Storage contract for ls_gitpaid (DR-002).
 *
 * One record per admitted escrow output. `protection` mirrors the badge
 * semantics decided at P1-5: `revocable` (1-of-1 — sponsor holds both spend
 * paths) vs `protected` (N ≥ 2). Status vocabulary per the dispute-path
 * posture: records are `active` until the output is spent (release OR
 * cancel — distinguishing the two requires the spending tx, which arrives
 * via client submission or the reconciliation sweep).
 */
export interface BountyRecord {
  txid: string
  outputIndex: number
  satoshis: number
  /** GitHub immutable numeric IDs (canonical) + display fields. */
  repoId: number
  issueId: number
  issueNumber: number
  slug: string
  funderIdentityKey: string
  threshold: number
  total: number
  protection: 'revocable' | 'protected'
  status: 'active' | 'spent'
  admittedAt: number
}

export interface BountyStorage {
  store: (record: BountyRecord) => Promise<void>
  markSpent: (txid: string, outputIndex: number) => Promise<void>
  evict: (txid: string, outputIndex: number) => Promise<void>
  findByIssue: (q: { repoId?: number, issueId?: number, slug?: string, issueNumber?: number }) => Promise<BountyRecord[]>
  findByRepo: (q: { repoId?: number, slug?: string }) => Promise<BountyRecord[]>
  findAllActive: () => Promise<BountyRecord[]>
  /** All active records — used by the reconciliation sweep (OR-004). */
  allActiveOutpoints: () => Promise<Array<{ txid: string, outputIndex: number }>>
}
