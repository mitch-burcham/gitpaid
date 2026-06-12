import type { LookupService, LookupFormula, OutputAdmittedByTopic, OutputSpent, LookupServiceMetaData } from '@bsv/overlay'
import type { LookupQuestion } from '@bsv/sdk'
import { GitPaidEscrow } from '@engine/GitPaidEscrow'
import type { BountyRecord, BountyStorage } from './types.js'

export const TOPIC = 'tm_gitpaid'
export const SERVICE = 'ls_gitpaid'

export type GitPaidQuery =
  | { type: 'findByIssue', repoId?: number, issueId?: number, slug?: string, issueNumber?: number }
  | { type: 'findByRepo', repoId?: number, slug?: string }
  | { type: 'findAllActive' }

/**
 * ls_gitpaid — answers bounty-discovery questions (FR-012/FR-017).
 *
 * Records mirror the badge semantics (DR-002): clients receive the outputs
 * via the standard overlay answer (BEEF) and re-derive sats + revocable/
 * protected from the locking script with the SAME shared GitPaidEscrow.parse
 * the node used at admittance — no trust in node-side metadata required.
 *
 * Eviction (D10): spends arrive either via client submission of the spending
 * tx (outputSpent) or via the hourly reconciliation sweep (reconcile.ts).
 */
export class GitPaidLookupService implements LookupService {
  readonly admissionMode = 'locking-script' as const
  readonly spendNotificationMode = 'none' as const

  constructor (public readonly storage: BountyStorage) {}

  async outputAdmittedByTopic (payload: OutputAdmittedByTopic): Promise<void> {
    if (payload.mode !== 'locking-script') return
    if (payload.topic !== TOPIC) return

    const parsed = GitPaidEscrow.parse(payload.lockingScript)
    if (parsed === null) return // TM admitted it, but never trust blindly

    const record: BountyRecord = {
      txid: payload.txid,
      outputIndex: payload.outputIndex,
      satoshis: payload.satoshis,
      repoId: parsed.binding.repoId,
      issueId: parsed.binding.issueId,
      issueNumber: parsed.binding.issueNumber,
      slug: parsed.binding.slug,
      funderIdentityKey: parsed.binding.funderIdentityKey,
      threshold: parsed.threshold,
      total: parsed.total,
      protection: parsed.total >= 2 ? 'protected' : 'revocable',
      status: 'active',
      admittedAt: Date.now(),
    }
    await this.storage.store(record)
  }

  async outputSpent (payload: OutputSpent): Promise<void> {
    if (payload.topic !== TOPIC) return
    await this.storage.markSpent(payload.txid, payload.outputIndex)
  }

  async outputEvicted (txid: string, outputIndex: number): Promise<void> {
    await this.storage.evict(txid, outputIndex)
  }

  async lookup (question: LookupQuestion): Promise<LookupFormula> {
    if (question.service !== SERVICE) {
      throw new Error(`Unsupported lookup service: ${question.service}`)
    }
    const q = question.query as GitPaidQuery
    if (q === null || typeof q !== 'object' || typeof q.type !== 'string') {
      throw new Error('ls_gitpaid: query must be an object with a type field')
    }

    let records: BountyRecord[]
    switch (q.type) {
      case 'findByIssue':
        records = await this.storage.findByIssue(q)
        break
      case 'findByRepo':
        records = await this.storage.findByRepo(q)
        break
      case 'findAllActive':
        records = await this.storage.findAllActive()
        break
      default:
        throw new Error(`ls_gitpaid: unknown query type ${(q as { type: string }).type}`)
    }

    return records.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
  }

  async getDocumentation (): Promise<string> {
    return `# GitPaid Lookup Service (ls_gitpaid)

Query active GitHub-issue bounty escrows.

Query shapes:
- { type: 'findByIssue', issueId } — canonical (immutable GitHub issue ID)
- { type: 'findByIssue', repoId, issueNumber } — by repo ID + display number
- { type: 'findByIssue', slug, issueNumber } — display fallback
- { type: 'findByRepo', repoId } or { slug } — all active bounties in a repo
  (badge the issue list with ONE query)
- { type: 'findAllActive' } — global active list

Answers are standard overlay output lists; parse each locking script with
the GitPaidEscrow codec to recover sats, threshold/total, revocable vs
protected, and the issue binding — the same validation the node performed.`
  }

  async getMetaData (): Promise<LookupServiceMetaData> {
    return {
      name: 'GitPaid Lookup Service',
      shortDescription: 'Discover GitHub issue bounties by issue, repo, or globally',
      version: '0.1.0',
      informationURL: 'https://github.com/mitch-burcham/gitpaid',
    }
  }
}
