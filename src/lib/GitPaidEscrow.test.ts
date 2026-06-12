import { describe, it, expect } from 'vitest'
import {
  PrivateKey, Transaction, LockingScript, UnlockingScript,
  BigNumber, ECDSA, TransactionSignature, Spend, P2PKH,
} from '@bsv/sdk'
import { CrowdEscrow, SIGHASH_SCOPE, SIGHASH_SCOPE_SINGLE_ACP } from './CrowdEscrow'
import { GitPaidEscrow } from './GitPaidEscrow'
import { BINDING_VERSION, encodeBinding, type IssueBinding } from './binding'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const controllerKeys = [
  PrivateKey.fromRandom(),
  PrivateKey.fromRandom(),
  PrivateKey.fromRandom(),
]
const refundKey = PrivateKey.fromRandom()
const controllerPubs = controllerKeys.map(k => k.toPublicKey())
const refundPub = refundKey.toPublicKey()

const binding: IssueBinding = {
  version: BINDING_VERSION,
  repoId: 998877,
  issueId: 5566778899,
  issueNumber: 7,
  funderIdentityKey: controllerPubs[0].toString(),
  slug: 'mitch-burcham/gitpaid',
}

function signHash (privKey: PrivateKey, hashBytes: number[], scope = SIGHASH_SCOPE): number[] {
  const bn = new BigNumber(hashBytes)
  const sig = ECDSA.sign(bn, privKey, true)
  const txSig = new TransactionSignature(sig.r, sig.s, scope)
  return txSig.toChecksigFormat()
}

/** Build funding + spend tx pair for a given lock. */
function buildTxs (lock: LockingScript): { fundingTx: Transaction, spendTx: Transaction } {
  const fundingTx = new Transaction()
  fundingTx.addOutput({ lockingScript: lock, satoshis: 1000 })

  const spendTx = new Transaction()
  spendTx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })
  spendTx.addOutput({
    lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()),
    satoshis: 900,
  })
  return { fundingTx, spendTx }
}

function validateSpend (
  lock: LockingScript,
  fundingTx: Transaction,
  spendTx: Transaction,
  unlock: UnlockingScript,
): boolean {
  const spend = new Spend({
    sourceTXID: fundingTx.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: 1000,
    lockingScript: lock,
    transactionVersion: spendTx.version,
    otherInputs: [],
    inputIndex: 0,
    unlockingScript: unlock,
    inputSequence: 0xffffffff,
    outputs: spendTx.outputs,
    lockTime: spendTx.lockTime,
  })
  try {
    return spend.validate()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// TC-006 — lock → parse round-trip + rejection of non-conforming scripts
// ---------------------------------------------------------------------------

describe('GitPaidEscrow template (TC-006)', () => {
  it('lock → parse round-trips 2-of-3', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const parsed = GitPaidEscrow.parse(lock)
    expect(parsed).not.toBeNull()
    expect(parsed?.binding).toEqual(binding)
    expect(parsed?.threshold).toBe(2)
    expect(parsed?.total).toBe(3)
  })

  it('lock → parse round-trips 1-of-1 (product default, D9)', () => {
    const lock = GitPaidEscrow.lock([controllerPubs[0]], 1, refundPub, binding)
    const parsed = GitPaidEscrow.parse(lock)
    expect(parsed).not.toBeNull()
    expect(parsed?.threshold).toBe(1)
    expect(parsed?.total).toBe(1)
    expect(parsed?.binding.slug).toBe(binding.slug)
  })

  it('lock → parse round-trips 10-of-10 (upper bound)', () => {
    const tenKeys = Array.from({ length: 10 }, () => PrivateKey.fromRandom().toPublicKey())
    const lock = GitPaidEscrow.lock(tenKeys, 10, refundPub, binding)
    const parsed = GitPaidEscrow.parse(lock)
    expect(parsed?.threshold).toBe(10)
    expect(parsed?.total).toBe(10)
  })

  it('lock rejects 0 and >10 pubkeys, threshold out of range', () => {
    expect(() => GitPaidEscrow.lock([], 1, refundPub, binding)).toThrow(/between 1 and 10/)
    const eleven = Array.from({ length: 11 }, () => PrivateKey.fromRandom().toPublicKey())
    expect(() => GitPaidEscrow.lock(eleven, 5, refundPub, binding)).toThrow(/between 1 and 10/)
    expect(() => GitPaidEscrow.lock(controllerPubs, 4, refundPub, binding)).toThrow(/threshold/)
    expect(() => GitPaidEscrow.lock(controllerPubs, 0, refundPub, binding)).toThrow(/threshold/)
  })

  it('body after the binding prefix is byte-identical to CrowdEscrow.lock (n ≥ 2 parity pin)', () => {
    // ADR-002 guard: if upstream CrowdEscrow.lock changes, this catches drift.
    const gp = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const crowd = CrowdEscrow.lock(controllerPubs, 2, refundPub)
    // Strip the first two chunks (binding push + OP_DROP)
    const body = new LockingScript(gp.chunks.slice(2))
    expect(body.toHex()).toBe(crowd.toHex())
  })

  // ── parse rejections (SR-004: structural, silent) ──
  it('parse rejects a plain CrowdEscrow script (no binding prefix)', () => {
    const crowd = CrowdEscrow.lock(controllerPubs, 2, refundPub)
    expect(GitPaidEscrow.parse(crowd)).toBeNull()
  })

  it('parse rejects P2PKH, empty, and garbage scripts without throwing', () => {
    const p2pkh = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress())
    expect(GitPaidEscrow.parse(p2pkh)).toBeNull()
    expect(GitPaidEscrow.parse(new LockingScript())).toBeNull()
    expect(GitPaidEscrow.parse(LockingScript.fromHex('006a0464656164'))).toBeNull()
  })

  it('parse rejects a script whose binding bytes do not decode', () => {
    // Valid shape, but binding push is garbage
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const chunks = [...lock.chunks]
    chunks[0] = { op: chunks[0].op, data: [0x99, 0x98, 0x97] } // junk push
    expect(GitPaidEscrow.parse(new LockingScript(chunks))).toBeNull()
  })

  it('parse rejects a truncated script (missing ENDIF)', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const truncated = new LockingScript(lock.chunks.slice(0, -1))
    expect(GitPaidEscrow.parse(truncated)).toBeNull()
  })

  it('parse rejects trailing opcodes appended after ENDIF', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const extended = new LockingScript([...lock.chunks, { op: 0x51 }]) // OP_1 appended
    expect(GitPaidEscrow.parse(extended)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TC-007 — CRITICAL regression: all spend paths remain valid over the
// extended script (binding prefix must not affect spendability)
// ---------------------------------------------------------------------------

describe('GitPaidEscrow spend paths (TC-007 — CRITICAL)', () => {
  it('multisig path validates 2-of-3 over the extended script', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const { fundingTx, spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000)
    const sig0 = signHash(controllerKeys[0], hash)
    const sig2 = signHash(controllerKeys[2], hash)
    const unlock = CrowdEscrow.unlockMultisig([sig0, sig2], controllerPubs)
    expect(validateSpend(lock, fundingTx, spendTx, unlock)).toBe(true)
  })

  it('cancel path validates with the refund key over the extended script', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const { fundingTx, spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000)
    const sig = signHash(refundKey, hash)
    const unlock = CrowdEscrow.unlockCancel(sig, refundPub)
    expect(validateSpend(lock, fundingTx, spendTx, unlock)).toBe(true)
  })

  it('1-of-1 multisig path validates (default bounty shape)', () => {
    const lock = GitPaidEscrow.lock([controllerPubs[0]], 1, refundPub, binding)
    const { fundingTx, spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000)
    const sig = signHash(controllerKeys[0], hash)
    const unlock = CrowdEscrow.unlockMultisig([sig], [controllerPubs[0]])
    expect(validateSpend(lock, fundingTx, spendTx, unlock)).toBe(true)
  })

  it('1-of-1 cancel path validates', () => {
    const lock = GitPaidEscrow.lock([controllerPubs[0]], 1, refundPub, binding)
    const { fundingTx, spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000)
    const sig = signHash(refundKey, hash)
    const unlock = CrowdEscrow.unlockCancel(sig, refundPub)
    expect(validateSpend(lock, fundingTx, spendTx, unlock)).toBe(true)
  })

  it('multisig path validates under SIGHASH_SINGLE|ANYONECANPAY (finalize flow scope)', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const { fundingTx, spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000, SIGHASH_SCOPE_SINGLE_ACP)
    const sig0 = signHash(controllerKeys[0], hash, SIGHASH_SCOPE_SINGLE_ACP)
    const sig1 = signHash(controllerKeys[1], hash, SIGHASH_SCOPE_SINGLE_ACP)
    const unlock = CrowdEscrow.unlockMultisig([sig0, sig1], controllerPubs)
    expect(validateSpend(lock, fundingTx, spendTx, unlock)).toBe(true)
  })

  it('multisig path fails with wrong-order sigs over the extended script', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const { fundingTx, spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000)
    const sig0 = signHash(controllerKeys[0], hash)
    const sig2 = signHash(controllerKeys[2], hash)
    const unlock = CrowdEscrow.unlockMultisig([sig2, sig0], controllerPubs)
    expect(validateSpend(lock, fundingTx, spendTx, unlock)).toBe(false)
  })

  it('cancel path fails with a non-refund key over the extended script', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const { fundingTx, spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000)
    const wrongSig = signHash(controllerKeys[1], hash)
    const unlock = CrowdEscrow.unlockCancel(wrongSig, controllerPubs[1])
    expect(validateSpend(lock, fundingTx, spendTx, unlock)).toBe(false)
  })

  it('sighash differs between plain Crowd and GitPaid scripts (binding is committed)', () => {
    // The binding prefix is part of the signed subscript: a signature over the
    // plain Crowd script must NOT validate the GitPaid script and vice versa.
    const gpLock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const crowdLock = CrowdEscrow.lock(controllerPubs, 2, refundPub)
    const { fundingTx, spendTx } = buildTxs(gpLock)
    const crowdHash = CrowdEscrow.sighash(spendTx, 0, crowdLock, 1000)
    const gpHash = CrowdEscrow.sighash(spendTx, 0, gpLock, 1000)
    expect(crowdHash).not.toEqual(gpHash)

    // Sigs over the WRONG subscript fail validation
    const sig0 = signHash(controllerKeys[0], crowdHash)
    const sig1 = signHash(controllerKeys[1], crowdHash)
    const unlock = CrowdEscrow.unlockMultisig([sig0, sig1], controllerPubs)
    expect(validateSpend(gpLock, fundingTx, spendTx, unlock)).toBe(false)
  })

  it('different bindings yield different scripts for identical keys (no aliasing)', () => {
    const lockA = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const lockB = GitPaidEscrow.lock(controllerPubs, 2, refundPub, { ...binding, issueId: binding.issueId + 1 })
    expect(lockA.toHex()).not.toBe(lockB.toHex())
    // But both parse, and bodies are identical
    expect(GitPaidEscrow.parse(lockA)?.binding.issueId).toBe(binding.issueId)
    expect(GitPaidEscrow.parse(lockB)?.binding.issueId).toBe(binding.issueId + 1)
  })

  it('estimateCancelUnlockLength still covers the cancel unlock for GitPaid scripts', () => {
    // cancelEscrow passes this estimate to the wallet; the binding prefix
    // lives in the LOCKING script, so the unlock size must be unchanged.
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    const { spendTx } = buildTxs(lock)
    const hash = CrowdEscrow.sighash(spendTx, 0, lock, 1000)
    const sig = signHash(refundKey, hash)
    const unlock = CrowdEscrow.unlockCancel(sig, refundPub)
    expect(unlock.toBinary().length).toBeLessThanOrEqual(CrowdEscrow.estimateCancelUnlockLength())
  })
})

// Sanity: encodeBinding output used by lock matches what parse extracts
describe('binding ↔ script integration', () => {
  it('the exact encoded bytes round-trip through the script chunk', () => {
    const lock = GitPaidEscrow.lock(controllerPubs, 2, refundPub, binding)
    expect(lock.chunks[0].data).toEqual(encodeBinding(binding))
  })
})
