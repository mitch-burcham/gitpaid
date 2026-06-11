import { describe, it, expect } from 'vitest'
import {
  PrivateKey, Transaction, LockingScript, UnlockingScript,
  BigNumber, ECDSA, TransactionSignature, Spend, P2PKH
} from '@bsv/sdk'
import { CrowdEscrow, SIGHASH_SCOPE } from './CrowdEscrow'

// ---------------------------------------------------------------------------
// Fixtures — deterministic within each test run
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

// Helper: build a sighash BigNumber from the raw hash bytes
function signHash (privKey: PrivateKey, hashBytes: number[]): number[] {
  const bn = new BigNumber(hashBytes)
  const sig = ECDSA.sign(bn, privKey, true)
  const txSig = new TransactionSignature(sig.r, sig.s, SIGHASH_SCOPE)
  return txSig.toChecksigFormat()
}

// ---------------------------------------------------------------------------
// Build the funding transaction and the spend transaction
// ---------------------------------------------------------------------------
let lock: LockingScript
let fundingTx: Transaction
let spendTx: Transaction

function buildTransactions (): void {
  lock = CrowdEscrow.lock(controllerPubs, THRESHOLD, refundPub)

  // Funding tx — no inputs needed for an id()-able tx
  fundingTx = new Transaction()
  fundingTx.addOutput({ lockingScript: lock, satoshis: 1000 })

  // Spending tx referencing fundingTx
  spendTx = new Transaction()
  spendTx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(), // placeholder — Spend tests supply their own
    sequence: 0xffffffff,
  })
  // Output: 900 sats to any P2PKH address
  const outputKey = PrivateKey.fromRandom().toPublicKey()
  spendTx.addOutput({
    lockingScript: new P2PKH().lock(outputKey.toAddress()),
    satoshis: 900,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrowdEscrow', () => {
  // Build once for the whole suite
  buildTransactions()

  // 1. Lock script structure
  it('lock() produces a script starting with OP_IF (0x63) and ending with OP_ENDIF (0x68)', () => {
    const hex = lock.toHex()
    const bytes = lock.toBinary()
    expect(hex.startsWith('63')).toBe(true)
    expect(bytes[bytes.length - 1]).toBe(0x68)
  })

  // Helper: compute sighash for spendTx input 0
  function hashForSign (): number[] {
    return CrowdEscrow.sighash(spendTx, 0, lock, 1000)
  }

  // 2. Multisig path (sigs from controllers 0 and 2) validates
  it('multisig path validates with 2-of-3 sigs in pubkey order (indices 0 and 2)', () => {
    const hash = hashForSign()
    const sig0 = signHash(controllerKeys[0], hash)
    const sig2 = signHash(controllerKeys[2], hash)

    const unlock = CrowdEscrow.unlockMultisig([sig0, sig2], controllerPubs)

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

    expect(spend.validate()).toBe(true)
  })

  // 3. Multisig fails with only 1 signature
  it('multisig path fails with only 1 signature', () => {
    const hash = hashForSign()
    const sig0 = signHash(controllerKeys[0], hash)

    const unlock = CrowdEscrow.unlockMultisig([sig0], controllerPubs)

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

    let result: boolean
    try {
      result = spend.validate()
    } catch {
      result = false
    }
    expect(result).toBe(false)
  })

  // 4. Multisig fails with sigs in wrong order [sig2, sig0]
  it('multisig path fails with sigs in wrong order [sig2, sig0]', () => {
    const hash = hashForSign()
    const sig0 = signHash(controllerKeys[0], hash)
    const sig2 = signHash(controllerKeys[2], hash)

    // Sigs in wrong order relative to pubkey list
    const unlock = CrowdEscrow.unlockMultisig([sig2, sig0], controllerPubs)

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

    let result: boolean
    try {
      result = spend.validate()
    } catch {
      result = false
    }
    expect(result).toBe(false)
  })

  // 5. Cancel path validates with refund key
  it('cancel path validates with the refund key', () => {
    const hash = hashForSign()
    const sig = signHash(refundKey, hash)

    const unlock = CrowdEscrow.unlockCancel(sig, refundPub)

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

    expect(spend.validate()).toBe(true)
  })

  // 6. Cancel path fails with a non-refund key
  it('cancel path fails with a signature from a non-refund key', () => {
    const hash = hashForSign()
    // Sign with controller key 0 instead of refund key
    const wrongSig = signHash(controllerKeys[0], hash)

    const unlock = CrowdEscrow.unlockCancel(wrongSig, controllerPubs[0])

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

    let result: boolean
    try {
      result = spend.validate()
    } catch {
      result = false
    }
    expect(result).toBe(false)
  })
})
