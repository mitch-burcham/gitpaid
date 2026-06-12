import { describe, it, expect, beforeEach } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { GitPaidEscrow } from '@engine/GitPaidEscrow'
import { BINDING_VERSION, type IssueBinding } from '@engine/binding'
import { GitPaidLookupService, TOPIC, SERVICE } from './GitPaidLookupService.js'
import { MemoryStorage } from './storage/MemoryStorage.js'
import { reconcileSpentOutputs } from './reconcile.js'

const pubs = [PrivateKey.fromRandom().toPublicKey(), PrivateKey.fromRandom().toPublicKey()]
const refundPub = PrivateKey.fromRandom().toPublicKey()

function makeBinding (overrides: Partial<IssueBinding> = {}): IssueBinding {
  return {
    version: BINDING_VERSION,
    repoId: 100,
    issueId: 1001,
    issueNumber: 1,
    funderIdentityKey: pubs[0].toString(),
    slug: 'acme/widgets',
    ...overrides,
  }
}

let txCounter = 0
function admit (
  ls: GitPaidLookupService,
  binding: IssueBinding,
  opts: { satoshis?: number, total?: 1 | 2, topic?: string } = {},
): { txid: string, outputIndex: number } {
  const total = opts.total ?? 2
  const lockPubs = total === 1 ? [pubs[0]] : pubs
  const script = GitPaidEscrow.lock(lockPubs, total === 1 ? 1 : 2, refundPub, binding)
  const txid = (++txCounter).toString(16).padStart(64, '0')
  void ls.outputAdmittedByTopic({
    mode: 'locking-script',
    txid,
    outputIndex: 0,
    topic: opts.topic ?? TOPIC,
    satoshis: opts.satoshis ?? 5000,
    lockingScript: script,
  })
  return { txid, outputIndex: 0 }
}

describe('GitPaidLookupService (TC-010)', () => {
  let ls: GitPaidLookupService

  beforeEach(() => {
    ls = new GitPaidLookupService(new MemoryStorage())
  })

  it('findByIssue answers by immutable issueId', async () => {
    admit(ls, makeBinding({ issueId: 7777 }))
    admit(ls, makeBinding({ issueId: 8888 }))
    const formula = await ls.lookup({ service: SERVICE, query: { type: 'findByIssue', issueId: 7777 } })
    expect(formula).toHaveLength(1)
  })

  it('findByIssue answers by repoId + issueNumber and by slug + issueNumber', async () => {
    admit(ls, makeBinding({ repoId: 55, issueNumber: 3, slug: 'foo/bar' }))
    const byRepo = await ls.lookup({ service: SERVICE, query: { type: 'findByIssue', repoId: 55, issueNumber: 3 } })
    const bySlug = await ls.lookup({ service: SERVICE, query: { type: 'findByIssue', slug: 'foo/bar', issueNumber: 3 } })
    expect(byRepo).toHaveLength(1)
    expect(bySlug).toHaveLength(1)
  })

  it('findByRepo batches all active bounties in a repo (one query per issue list page)', async () => {
    admit(ls, makeBinding({ repoId: 9, issueNumber: 1 }))
    admit(ls, makeBinding({ repoId: 9, issueNumber: 2 }))
    admit(ls, makeBinding({ repoId: 10, issueNumber: 1 }))
    const formula = await ls.lookup({ service: SERVICE, query: { type: 'findByRepo', repoId: 9 } })
    expect(formula).toHaveLength(2)
  })

  it('findAllActive returns the global active list', async () => {
    admit(ls, makeBinding({ issueId: 1 }))
    admit(ls, makeBinding({ issueId: 2 }))
    const formula = await ls.lookup({ service: SERVICE, query: { type: 'findAllActive' } })
    expect(formula).toHaveLength(2)
  })

  it('stores protection semantics: 1-of-1 = revocable, N>=2 = protected (P1-5)', async () => {
    admit(ls, makeBinding({ issueId: 11 }), { total: 1 })
    admit(ls, makeBinding({ issueId: 22 }), { total: 2 })
    const records = await ls.storage.findAllActive()
    const r1 = records.find(r => r.issueId === 11)
    const r2 = records.find(r => r.issueId === 22)
    expect(r1?.protection).toBe('revocable')
    expect(r2?.protection).toBe('protected')
  })

  it('outputSpent evicts from active results (AC-004)', async () => {
    const { txid, outputIndex } = admit(ls, makeBinding({ issueId: 33 }))
    await ls.outputSpent({ mode: 'none', txid, outputIndex, topic: TOPIC })
    const formula = await ls.lookup({ service: SERVICE, query: { type: 'findByIssue', issueId: 33 } })
    expect(formula).toHaveLength(0)
  })

  it('outputEvicted permanently removes the record', async () => {
    const { txid, outputIndex } = admit(ls, makeBinding({ issueId: 44 }))
    await ls.outputEvicted(txid, outputIndex)
    const formula = await ls.lookup({ service: SERVICE, query: { type: 'findAllActive' } })
    expect(formula).toHaveLength(0)
  })

  it('ignores admissions for other topics', async () => {
    admit(ls, makeBinding({ issueId: 55 }), { topic: 'tm_other' })
    const formula = await ls.lookup({ service: SERVICE, query: { type: 'findAllActive' } })
    expect(formula).toHaveLength(0)
  })

  it('rejects unknown services and malformed queries loudly', async () => {
    await expect(ls.lookup({ service: 'ls_other', query: { type: 'findAllActive' } })).rejects.toThrow(/Unsupported/)
    await expect(ls.lookup({ service: SERVICE, query: null })).rejects.toThrow(/query/)
    await expect(ls.lookup({ service: SERVICE, query: { type: 'explode' } })).rejects.toThrow(/unknown query type/)
  })
})

describe('reconciliation sweep (TC-010 / OR-004)', () => {
  it('marks out-of-band spends and survives per-outpoint errors', async () => {
    const storage = new MemoryStorage()
    const ls = new GitPaidLookupService(storage)
    const a = admit(ls, makeBinding({ issueId: 100 }))
    const b = admit(ls, makeBinding({ issueId: 200 }))
    const c = admit(ls, makeBinding({ issueId: 300 }))

    const result = await reconcileSpentOutputs(storage, async (txid) => {
      if (txid === a.txid) return true            // spent out-of-band
      if (txid === b.txid) throw new Error('WoC 500') // flaky chain source
      return false                                 // c still unspent
    })

    expect(result).toEqual({ checked: 3, markedSpent: 1, errors: 1 })
    const active = await storage.findAllActive()
    expect(active.map(r => r.issueId).sort()).toEqual([200, 300])
    void c
  })

  it('sweep on empty storage is a no-op', async () => {
    const result = await reconcileSpentOutputs(new MemoryStorage(), async () => true)
    expect(result).toEqual({ checked: 0, markedSpent: 0, errors: 0 })
  })
})
