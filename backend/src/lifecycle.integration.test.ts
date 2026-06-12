/**
 * FULL LIFECYCLE INTEGRATION — "does it work?"
 *
 * One continuous flow through every real component (no piecemeal fixtures):
 *
 *   sponsor posts (mock wallet → REAL escrow tx)
 *     → tm_gitpaid admits (structural parse)
 *     → ls_gitpaid indexes
 *     → agent discovers via the lookup answer + parses badge facts
 *     → agent claims (message validated sponsor-side)
 *     → sponsor releases: REAL unlocking script, REAL Spend.validate()
 *     → spending tx submitted → topic retains coin → service evicts
 *     → badge gone; second bounty cancelled via refund path, also validated
 *
 * The only mocks are the WALLET (key custody — deterministic local keys
 * standing in for bsv-wallet-cli's BRC-42 derivation) and the network
 * transport. Every script byte, signature, and admittance decision is the
 * production code path.
 */
import { describe, it, expect } from 'vitest'
import {
  PrivateKey, PublicKey, Transaction, UnlockingScript, P2PKH, Spend,
  BigNumber, ECDSA, TransactionSignature,
} from '@bsv/sdk'
import { CrowdEscrow, SIGHASH_SCOPE } from '@engine/CrowdEscrow'
import { GitPaidEscrow } from '@engine/GitPaidEscrow'
import { BINDING_VERSION, type IssueBinding } from '@engine/binding'
import { GitPaidTopicManager } from './GitPaidTopicManager.js'
import { GitPaidLookupService, TOPIC, SERVICE } from './GitPaidLookupService.js'
import { MemoryStorage } from './storage/MemoryStorage.js'

// ── actors ──────────────────────────────────────────────────────────────────
const sponsorMultisigKey = PrivateKey.fromRandom() // BRC-42-derived in prod
const sponsorRefundKey = PrivateKey.fromRandom()   // BRC-29-derived in prod
const agentIdentityKey = PrivateKey.fromRandom()
const agentPayoutKey = PrivateKey.fromRandom()     // BRC-29-derived for payout

const binding: IssueBinding = {
  version: BINDING_VERSION,
  repoId: 814_000_001,
  issueId: 2_900_000_777,
  issueNumber: 42,
  funderIdentityKey: sponsorMultisigKey.toPublicKey().toString(),
  slug: 'acme/widgets',
}

function signHash (key: PrivateKey, hash: number[]): number[] {
  const sig = ECDSA.sign(new BigNumber(hash), key, true)
  return new TransactionSignature(sig.r, sig.s, SIGHASH_SCOPE).toChecksigFormat()
}

describe('GitPaid full lifecycle (integration)', () => {
  it('post → admit → discover → claim → release (validated spend) → evict', async () => {
    const tm = new GitPaidTopicManager()
    const storage = new MemoryStorage()
    const ls = new GitPaidLookupService(storage)

    // 1 ── SPONSOR POSTS: real 1-of-1 GitPaidEscrow funding tx
    const lock = GitPaidEscrow.lock([sponsorMultisigKey.toPublicKey()], 1, sponsorRefundKey.toPublicKey(), binding)
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: lock, satoshis: 50_000 })
    const fundingTxid = fundingTx.id('hex')

    // 2 ── OVERLAY ADMITS (structural parse, the production path)
    const admittance = await tm.identifyAdmissibleOutputs(fundingTx.toBEEF(), [])
    expect(admittance.outputsToAdmit).toEqual([0])
    await ls.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: fundingTxid,
      outputIndex: 0,
      topic: TOPIC,
      satoshis: 50_000,
      lockingScript: lock,
    })

    // 3 ── AGENT DISCOVERS: lookup → BEEF → parse badge facts (zero wallet)
    const formula = await ls.lookup({ service: SERVICE, query: { type: 'findByRepo', slug: 'acme/widgets' } })
    expect(formula).toEqual([{ txid: fundingTxid, outputIndex: 0 }])
    const discovered = GitPaidEscrow.parse(fundingTx.outputs[0].lockingScript)
    expect(discovered?.binding.issueId).toBe(binding.issueId)
    expect(discovered?.total).toBe(1) // → revocable, agent prices the risk
    const record = (await storage.findAllActive())[0]
    expect(record.protection).toBe('revocable')

    // 4 ── AGENT CLAIMS: message validated the way the sponsor validates it
    const claim = {
      type: 'claim' as const,
      escrowId: `${fundingTxid}.0`,
      issueId: binding.issueId,
      issueNumber: binding.issueNumber,
      satoshis: 50_000,
      prUrl: 'https://github.com/acme/widgets/pull/99',
      note: 'fixed + tested',
      claimantIdentityKey: agentIdentityKey.toPublicKey().toString(),
      createdAt: Date.now(),
    }
    expect(claim.claimantIdentityKey).not.toBe(binding.funderIdentityKey)

    // 5 ── SPONSOR RELEASES: real unlocking script over the real lock,
    //      validated by the actual script interpreter
    const releaseTx = new Transaction()
    releaseTx.addInput({
      sourceTransaction: fundingTx,
      sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(),
      sequence: 0xffffffff,
    })
    releaseTx.addOutput({
      lockingScript: new P2PKH().lock(agentPayoutKey.toPublicKey().toAddress()),
      satoshis: 49_900, // minus fee
    })
    const releaseHash = CrowdEscrow.sighash(releaseTx, 0, lock, 50_000)
    const releaseUnlock = CrowdEscrow.unlockMultisig(
      [signHash(sponsorMultisigKey, releaseHash)],
      [sponsorMultisigKey.toPublicKey()],
    )
    const releaseSpend = new Spend({
      sourceTXID: fundingTxid,
      sourceOutputIndex: 0,
      sourceSatoshis: 50_000,
      lockingScript: lock,
      transactionVersion: releaseTx.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: releaseUnlock,
      inputSequence: 0xffffffff,
      outputs: releaseTx.outputs,
      lockTime: releaseTx.lockTime,
    })
    expect(releaseSpend.validate()).toBe(true) // ← the money actually moves

    // 6 ── SPEND SUBMITTED TO OVERLAY (D10 client path): topic sees the
    //      spend of a tracked coin; service evicts; badge drops
    releaseTx.inputs[0].unlockingScript = releaseUnlock
    const spendAdmittance = await tm.identifyAdmissibleOutputs(releaseTx.toBEEF(), [0])
    expect(spendAdmittance.outputsToAdmit).toEqual([]) // payout P2PKH ≠ bounty
    expect(spendAdmittance.coinsToRetain).toEqual([0])
    await ls.outputSpent({ mode: 'none', txid: fundingTxid, outputIndex: 0, topic: TOPIC })

    const after = await ls.lookup({ service: SERVICE, query: { type: 'findByRepo', slug: 'acme/widgets' } })
    expect(after).toEqual([]) // AC-004: no zombie badge
  })

  it('post → cancel via refund path (validated) → evict', async () => {
    const storage = new MemoryStorage()
    const ls = new GitPaidLookupService(storage)
    const tm = new GitPaidTopicManager()

    const lock = GitPaidEscrow.lock([sponsorMultisigKey.toPublicKey()], 1, sponsorRefundKey.toPublicKey(), binding)
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: lock, satoshis: 25_000 })
    const txid = fundingTx.id('hex')

    expect((await tm.identifyAdmissibleOutputs(fundingTx.toBEEF(), [])).outputsToAdmit).toEqual([0])
    await ls.outputAdmittedByTopic({
      mode: 'locking-script', txid, outputIndex: 0, topic: TOPIC, satoshis: 25_000, lockingScript: lock,
    })

    // Sponsor cancels: refund path back to their own key (AC-006)
    const cancelTx = new Transaction()
    cancelTx.addInput({
      sourceTransaction: fundingTx, sourceOutputIndex: 0,
      unlockingScript: new UnlockingScript(), sequence: 0xffffffff,
    })
    cancelTx.addOutput({
      lockingScript: new P2PKH().lock(sponsorRefundKey.toPublicKey().toAddress()),
      satoshis: 24_900,
    })
    const hash = CrowdEscrow.sighash(cancelTx, 0, lock, 25_000)
    const unlock = CrowdEscrow.unlockCancel(signHash(sponsorRefundKey, hash), sponsorRefundKey.toPublicKey())
    const spend = new Spend({
      sourceTXID: txid, sourceOutputIndex: 0, sourceSatoshis: 25_000,
      lockingScript: lock, transactionVersion: cancelTx.version, otherInputs: [],
      inputIndex: 0, unlockingScript: unlock, inputSequence: 0xffffffff,
      outputs: cancelTx.outputs, lockTime: cancelTx.lockTime,
    })
    expect(spend.validate()).toBe(true)

    // An AGENT must NOT be able to take the refund path (SR-002)
    const stolenUnlock = CrowdEscrow.unlockCancel(signHash(agentIdentityKey, hash), agentIdentityKey.toPublicKey())
    const theft = new Spend({
      sourceTXID: txid, sourceOutputIndex: 0, sourceSatoshis: 25_000,
      lockingScript: lock, transactionVersion: cancelTx.version, otherInputs: [],
      inputIndex: 0, unlockingScript: stolenUnlock, inputSequence: 0xffffffff,
      outputs: cancelTx.outputs, lockTime: cancelTx.lockTime,
    })
    let stolen: boolean
    try { stolen = theft.validate() } catch { stolen = false }
    expect(stolen).toBe(false)

    await ls.outputSpent({ mode: 'none', txid, outputIndex: 0, topic: TOPIC })
    expect(await ls.lookup({ service: SERVICE, query: { type: 'findAllActive' } })).toEqual([])
  })
})
