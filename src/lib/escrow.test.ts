import { describe, it, expect } from 'vitest'
import {
  PrivateKey, Transaction, P2PKH, UnlockingScript,
  BigNumber, ECDSA, TransactionSignature, Utils,
} from '@bsv/sdk'
import { CrowdEscrow, SIGHASH_SCOPE } from './CrowdEscrow'
import { escrowLockingScript, proposalTx, verifySignature, readyToFinalize } from './escrow'
import type { InviteMsg, ProposalMsg } from './protocol'
import type { EscrowState, ProposalState } from './store'

// ---------------------------------------------------------------------------
// Fixtures — 3 local controller keys, threshold 2, 1 refund key
// ---------------------------------------------------------------------------
const controllerKeys = [
  PrivateKey.fromRandom(),
  PrivateKey.fromRandom(),
  PrivateKey.fromRandom(),
]
const refundKey = PrivateKey.fromRandom()
const controllerPubs = controllerKeys.map(k => k.toPublicKey())
const refundPub = refundKey.toPublicKey()
const THRESHOLD = 2
const SATOSHIS = 1000

// Build the locking script
const lock = CrowdEscrow.lock(controllerPubs, THRESHOLD, refundPub)

// Build a funding transaction: one output, 1000 sats, using our lock script
const fundingTx = new Transaction()
fundingTx.addOutput({ lockingScript: lock, satoshis: SATOSHIS })

// Serialize to AtomicBEEF for the invite. A raw tx has no sourceTransactions so
// toBEEF would fail (no merkle path either). Use toHexAtomicBEEF which wraps the
// lone tx. We store as the beef field and parse back with fromAtomicBEEF.
// Note: toAtomicBEEF on a tx with no inputs/merklePath should work since it only
// needs to include the tx bytes. Let's use toAtomicBEEF(true) to allow partial.
const fundingBeef = Utils.toHex(fundingTx.toAtomicBEEF(true))
const fundingTxid = fundingTx.id('hex')

// Minimal InviteMsg fixture (pure functions don't need wallet-derived keys)
const invite: InviteMsg = {
  type: 'invite',
  escrowId: `${fundingTxid}.0`,
  beef: fundingBeef,
  satoshis: SATOSHIS,
  threshold: THRESHOLD,
  keyID: 'testKeyID',
  originator: controllerPubs[0].toString(),
  controllers: controllerPubs.map(p => p.toString()),
  pubkeys: controllerPubs.map(p => p.toString()),
  refundPkh: Utils.toHex(controllerPubs[0].toDER() as number[]), // dummy
  name: 'Test Escrow',
  createdAt: Date.now(),
}

// Build a proposal transaction (mirrors buildProposal logic)
const recipientKey = PrivateKey.fromRandom().toPublicKey()
const proposalTxObj = new Transaction()
proposalTxObj.addInput({
  sourceTransaction: fundingTx,
  sourceOutputIndex: 0,
  unlockingScript: new UnlockingScript(), // placeholder
  sequence: 0xffffffff,
})
proposalTxObj.addOutput({
  lockingScript: new P2PKH().lock(recipientKey.toAddress()),
  satoshis: 900,
})
const proposalRawTx = proposalTxObj.toHex()
const proposalId = proposalTxObj.id('hex')

const proposal: ProposalMsg = {
  type: 'proposal',
  escrowId: invite.escrowId,
  proposalId,
  rawTx: proposalRawTx,
  note: 'Pay recipient',
  proposer: invite.originator,
  createdAt: Date.now(),
}

// Helper: sign the sighash with a local private key and return checksig hex
function makeSignature (privKey: PrivateKey, inv: InviteMsg, prop: ProposalMsg): string {
  const tx = proposalTx(inv, prop)
  const lockScript = escrowLockingScript(inv)
  const hashBytes = CrowdEscrow.sighash(tx, 0, lockScript, inv.satoshis)
  const bn = new BigNumber(hashBytes)
  const sig = ECDSA.sign(bn, privKey, true)
  const txSig = new TransactionSignature(sig.r, sig.s, SIGHASH_SCOPE)
  return Utils.toHex(txSig.toChecksigFormat())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('escrowLockingScript', () => {
  it('returns the same locking script used in the funding tx', () => {
    const result = escrowLockingScript(invite)
    expect(result.toHex()).toBe(lock.toHex())
  })
})

describe('proposalTx', () => {
  it('reconstructs tx with the same id as proposalId', () => {
    const tx = proposalTx(invite, proposal)
    expect(tx.id('hex')).toBe(proposalId)
  })

  it('attaches sourceTransaction to input 0', () => {
    const tx = proposalTx(invite, proposal)
    expect(tx.inputs[0].sourceTransaction).toBeDefined()
    expect(tx.inputs[0].sourceTransaction!.id('hex')).toBe(fundingTxid)
  })
})

describe('verifySignature', () => {
  it('returns true for a genuine sig from controller 1', () => {
    const sigHex = makeSignature(controllerKeys[1], invite, proposal)
    const signer = invite.controllers[1]
    expect(verifySignature(invite, proposal, signer, sigHex)).toBe(true)
  })

  it('returns false when a valid sigHex is attributed to the wrong signer', () => {
    const sigHex = makeSignature(controllerKeys[1], invite, proposal)
    // Attribute to controller 0 — wrong key
    const wrongSigner = invite.controllers[0]
    expect(verifySignature(invite, proposal, wrongSigner, sigHex)).toBe(false)
  })

  it('returns false for a corrupted sigHex', () => {
    const sigHex = makeSignature(controllerKeys[0], invite, proposal)
    // Flip a byte in the middle
    const corrupted = sigHex.slice(0, 10) + 'ff' + sigHex.slice(12)
    const signer = invite.controllers[0]
    expect(verifySignature(invite, proposal, signer, corrupted)).toBe(false)
  })

  it('returns false for an unknown signer key', () => {
    const sigHex = makeSignature(controllerKeys[0], invite, proposal)
    const unknown = PrivateKey.fromRandom().toPublicKey().toString()
    expect(verifySignature(invite, proposal, unknown, sigHex)).toBe(false)
  })
})

describe('readyToFinalize', () => {
  function makeProposalState (signerIndices: number[]): ProposalState {
    const signatures: Record<string, string> = {}
    for (const i of signerIndices) {
      const signer = invite.controllers[i]
      signatures[signer] = makeSignature(controllerKeys[i], invite, proposal)
    }
    return {
      proposal,
      signatures,
      vetoes: {},
      status: 'open',
    }
  }

  function makeEscrowState (signerIndices: number[]): EscrowState {
    return {
      invite,
      status: 'active',
      proposals: {
        [proposalId]: makeProposalState(signerIndices),
      },
    }
  }

  it('returns false with only 1 valid signature (threshold is 2)', () => {
    const es = makeEscrowState([0])
    expect(readyToFinalize(invite, es, proposalId)).toBe(false)
  })

  it('returns true with 2 valid signatures (meets threshold)', () => {
    const es = makeEscrowState([0, 2])
    expect(readyToFinalize(invite, es, proposalId)).toBe(true)
  })

  it('returns false when proposal does not exist in state', () => {
    const es = makeEscrowState([0, 2])
    expect(readyToFinalize(invite, es, 'nonexistent-id')).toBe(false)
  })
})
