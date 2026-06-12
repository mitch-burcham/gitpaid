import type { BountyRecord, BountyStorage } from '../types.js'

const key = (txid: string, outputIndex: number): string => `${txid}.${outputIndex}`

/**
 * In-memory BountyStorage — used by tests and LARS local dev.
 * Production uses MongoStorage (same contract, same tests via the shared
 * conformance suite in GitPaidLookupService.test.ts).
 */
export class MemoryStorage implements BountyStorage {
  private readonly records = new Map<string, BountyRecord>()

  async store (record: BountyRecord): Promise<void> {
    this.records.set(key(record.txid, record.outputIndex), record)
  }

  async markSpent (txid: string, outputIndex: number): Promise<void> {
    const r = this.records.get(key(txid, outputIndex))
    if (r !== undefined) r.status = 'spent'
  }

  async evict (txid: string, outputIndex: number): Promise<void> {
    this.records.delete(key(txid, outputIndex))
  }

  async findByIssue (q: { repoId?: number, issueId?: number, slug?: string, issueNumber?: number }): Promise<BountyRecord[]> {
    return [...this.records.values()].filter(r => {
      if (r.status !== 'active') return false
      if (q.issueId !== undefined) return r.issueId === q.issueId
      if (q.repoId !== undefined && q.issueNumber !== undefined) {
        return r.repoId === q.repoId && r.issueNumber === q.issueNumber
      }
      if (q.slug !== undefined && q.issueNumber !== undefined) {
        return r.slug === q.slug && r.issueNumber === q.issueNumber
      }
      return false
    })
  }

  async findByRepo (q: { repoId?: number, slug?: string }): Promise<BountyRecord[]> {
    return [...this.records.values()].filter(r => {
      if (r.status !== 'active') return false
      if (q.repoId !== undefined) return r.repoId === q.repoId
      if (q.slug !== undefined) return r.slug === q.slug
      return false
    })
  }

  async findAllActive (): Promise<BountyRecord[]> {
    return [...this.records.values()].filter(r => r.status === 'active')
  }

  async allActiveOutpoints (): Promise<Array<{ txid: string, outputIndex: number }>> {
    return (await this.findAllActive()).map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
  }
}
