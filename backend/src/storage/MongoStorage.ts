import type { Db, Collection } from 'mongodb'
import type { BountyRecord, BountyStorage } from '../types.js'

/**
 * Mongo-backed BountyStorage for CARS deployments (LARS hydrates with mongo
 * per deployment-info.json). Same contract as MemoryStorage — the logic
 * tests in GitPaidLookupService.test.ts run against the memory impl; this
 * class is a thin query translation kept deliberately free of behavior.
 */
export class MongoStorage implements BountyStorage {
  private readonly col: Collection<BountyRecord>

  constructor (db: Db) {
    this.col = db.collection<BountyRecord>('gitpaid_bounties')
    void this.col.createIndex({ txid: 1, outputIndex: 1 }, { unique: true })
    void this.col.createIndex({ issueId: 1, status: 1 })
    void this.col.createIndex({ repoId: 1, status: 1 })
    void this.col.createIndex({ slug: 1, status: 1 })
  }

  async store (record: BountyRecord): Promise<void> {
    await this.col.updateOne(
      { txid: record.txid, outputIndex: record.outputIndex },
      { $set: record },
      { upsert: true },
    )
  }

  async markSpent (txid: string, outputIndex: number): Promise<void> {
    await this.col.updateOne({ txid, outputIndex }, { $set: { status: 'spent' } })
  }

  async evict (txid: string, outputIndex: number): Promise<void> {
    await this.col.deleteOne({ txid, outputIndex })
  }

  async findByIssue (q: { repoId?: number, issueId?: number, slug?: string, issueNumber?: number }): Promise<BountyRecord[]> {
    if (q.issueId !== undefined) {
      return await this.col.find({ status: 'active', issueId: q.issueId }).toArray()
    }
    if (q.repoId !== undefined && q.issueNumber !== undefined) {
      return await this.col.find({ status: 'active', repoId: q.repoId, issueNumber: q.issueNumber }).toArray()
    }
    if (q.slug !== undefined && q.issueNumber !== undefined) {
      return await this.col.find({ status: 'active', slug: q.slug, issueNumber: q.issueNumber }).toArray()
    }
    return []
  }

  async findByRepo (q: { repoId?: number, slug?: string }): Promise<BountyRecord[]> {
    if (q.repoId !== undefined) {
      return await this.col.find({ status: 'active', repoId: q.repoId }).toArray()
    }
    if (q.slug !== undefined) {
      return await this.col.find({ status: 'active', slug: q.slug }).toArray()
    }
    return []
  }

  async findAllActive (): Promise<BountyRecord[]> {
    return await this.col.find({ status: 'active' }).toArray()
  }

  async allActiveOutpoints (): Promise<Array<{ txid: string, outputIndex: number }>> {
    const docs = await this.col
      .find({ status: 'active' })
      .project<{ txid: string, outputIndex: number }>({ txid: 1, outputIndex: 1, _id: 0 })
      .toArray()
    return docs
  }
}
