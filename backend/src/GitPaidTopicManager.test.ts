import { describe, it, expect } from 'vitest'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { GitPaidEscrow } from '@engine/GitPaidEscrow'
import { CrowdEscrow } from '@engine/CrowdEscrow'
import { BINDING_VERSION, type IssueBinding } from '@engine/binding'
import { GitPaidTopicManager, DEFAULT_MIN_SATOSHIS } from './GitPaidTopicManager.js'

const keys = [PrivateKey.fromRandom(), PrivateKey.fromRandom()]
const pubs = keys.map(k => k.toPublicKey())
const refundPub = PrivateKey.fromRandom().toPublicKey()

const binding: IssueBinding = {
  version: BINDING_VERSION,
  repoId: 42,
  issueId: 4242,
  issueNumber: 1,
  funderIdentityKey: pubs[0].toString(),
  slug: 'acme/widgets',
}

function txWithOutputs (outputs: Array<{ lockingScript: ReturnType<typeof GitPaidEscrow.lock>, satoshis: number }>): number[] {
  const tx = new Transaction()
  for (const o of outputs) tx.addOutput(o)
  return tx.toBEEF()
}

describe('GitPaidTopicManager (TC-009)', () => {
  it('admits a valid GitPaidEscrow output', async () => {
    const tm = new GitPaidTopicManager()
    const beef = txWithOutputs([
      { lockingScript: GitPaidEscrow.lock(pubs, 2, refundPub, binding), satoshis: 5000 },
    ])
    const result = await tm.identifyAdmissibleOutputs(beef, [])
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('admits the 1-of-1 default shape', async () => {
    const tm = new GitPaidTopicManager()
    const beef = txWithOutputs([
      { lockingScript: GitPaidEscrow.lock([pubs[0]], 1, refundPub, binding), satoshis: 5000 },
    ])
    const result = await tm.identifyAdmissibleOutputs(beef, [])
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('admits only conforming outputs in a mixed tx, at correct indices', async () => {
    const tm = new GitPaidTopicManager()
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()), satoshis: 5000 })
    tx.addOutput({ lockingScript: GitPaidEscrow.lock(pubs, 2, refundPub, binding), satoshis: 5000 })
    tx.addOutput({ lockingScript: CrowdEscrow.lock(pubs, 2, refundPub), satoshis: 5000 }) // plain Crowd: no binding
    const result = await tm.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([1])
  })

  it('rejects plain CrowdEscrow outputs (no binding prefix)', async () => {
    const tm = new GitPaidTopicManager()
    const beef = txWithOutputs([
      { lockingScript: CrowdEscrow.lock(pubs, 2, refundPub), satoshis: 5000 },
    ])
    const result = await tm.identifyAdmissibleOutputs(beef, [])
    expect(result.outputsToAdmit).toEqual([])
    expect(tm.rejectedOutputs).toBe(1)
  })

  it('rejects dust below the min-satoshis floor (SR-007)', async () => {
    const tm = new GitPaidTopicManager()
    const beef = txWithOutputs([
      { lockingScript: GitPaidEscrow.lock(pubs, 2, refundPub, binding), satoshis: DEFAULT_MIN_SATOSHIS - 1 },
    ])
    const result = await tm.identifyAdmissibleOutputs(beef, [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('min-satoshis floor is configurable', async () => {
    const tm = new GitPaidTopicManager(10)
    const beef = txWithOutputs([
      { lockingScript: GitPaidEscrow.lock(pubs, 2, refundPub, binding), satoshis: 10 },
    ])
    const result = await tm.identifyAdmissibleOutputs(beef, [])
    expect(result.outputsToAdmit).toEqual([0])
  })

  it('hostile garbage BEEF admits nothing and never throws', async () => {
    const tm = new GitPaidTopicManager()
    const result = await tm.identifyAdmissibleOutputs([0xde, 0xad, 0xbe, 0xef], [7])
    expect(result.outputsToAdmit).toEqual([])
    expect(result.coinsToRetain).toEqual([7]) // previous coins retained
  })

  it('retains previous coins so spends propagate to the lookup service', async () => {
    const tm = new GitPaidTopicManager()
    const beef = txWithOutputs([
      { lockingScript: GitPaidEscrow.lock(pubs, 2, refundPub, binding), satoshis: 5000 },
    ])
    const result = await tm.identifyAdmissibleOutputs(beef, [0, 3])
    expect(result.coinsToRetain).toEqual([0, 3])
  })
})
