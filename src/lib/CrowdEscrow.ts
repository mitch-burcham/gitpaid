import {
  LockingScript,
  UnlockingScript,
  OP,
  Hash,
  PublicKey,
  TransactionSignature,
  Signature,
  Transaction,
} from '@bsv/sdk'

function concatPubkeys (pubkeys: PublicKey[]): number[] {
  return pubkeys
    .map(p => p.toDER() as number[])
    .reduce((a, b) => a.concat(b), [] as number[])
}

export const SIGHASH_SCOPE =
  TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

export class CrowdEscrow {
  /**
   * Locking script: IF n-of-m multisig over hash160(concat pubkeys) ELSE p2pkh(refund key) ENDIF
   *
   * Stack layout when the IF-branch unlocking script executes:
   *   bottom → OP_0, <sig_0>, ..., <sig_{m-1}>, <concat_pubkeys>, OP_1 ← top
   *
   * The IF-branch:
   *   1. DUP / HASH160 / <hash> / EQUALVERIFY  — authenticate the concatenated pubkeys blob
   *   2. <threshold> SWAP                       — bring threshold below the blob
   *   3. (total-1) × (<33> OP_SPLIT)            — split blob into individual 33-byte pubkeys
   *   4. <total> OP_CHECKMULTISIG
   *
   * After the splits the stack is (bottom→top):
   *   OP_0, sig_{m-1}, …, sig_0, threshold, pub_0, pub_1, …, pub_{n-1}, n
   * OP_CHECKMULTISIG reads pubkeys at ikey=2…n+1 (top-indexed) and sigs at
   * isig=n+2…n+m+1, which maps to pub_{n-1}…pub_0 and sig_{m-1}…sig_0.
   * Sigs must therefore be pushed in pubkey order (sig for pub_i before sig for pub_j
   * when i < j), so that the top-down iteration of CHECKMULTISIG matches correctly.
   */
  static lock (
    pubkeys: PublicKey[],
    threshold: number,
    refundPubKey: PublicKey,
  ): LockingScript {
    const total = pubkeys.length
    if (threshold < 1 || threshold > total) {
      throw new Error('threshold must be between 1 and the number of pubkeys')
    }
    if (total < 2 || total > 10) {
      throw new Error('between 2 and 10 pubkeys required')
    }

    const hash = Hash.hash160(concatPubkeys(pubkeys))
    const refundPkh = Hash.hash160(refundPubKey.toDER() as number[])

    const s = new LockingScript()

    // IF branch: multisig over authenticated pubkey blob
    s.writeOpCode(OP.OP_IF)

    // Verify the concatenated-pubkeys blob is the one we committed to
    s.writeOpCode(OP.OP_DUP)
    s.writeOpCode(OP.OP_HASH160)
    s.writeBin(hash)
    s.writeOpCode(OP.OP_EQUALVERIFY)

    // Bring threshold below the pubkey blob so SPLIT can consume the blob
    s.writeNumber(threshold)
    s.writeOpCode(OP.OP_SWAP)

    // Split the blob into individual 33-byte compressed public keys
    for (let i = 0; i < total - 1; i++) {
      s.writeNumber(33)
      s.writeOpCode(OP.OP_SPLIT)
    }

    // Run the actual multisig check
    s.writeNumber(total)
    s.writeOpCode(OP.OP_CHECKMULTISIG)

    // ELSE branch: standard P2PKH refund path
    s.writeOpCode(OP.OP_ELSE)
    s.writeOpCode(OP.OP_DUP)
    s.writeOpCode(OP.OP_HASH160)
    s.writeBin(refundPkh)
    s.writeOpCode(OP.OP_EQUALVERIFY)
    s.writeOpCode(OP.OP_CHECKSIG)

    s.writeOpCode(OP.OP_ENDIF)

    return s
  }

  /**
   * Multisig-branch unlocking script.
   *
   * `sigs` must be in the same relative order as their corresponding pubkeys
   * in the `pubkeys` array (i.e. the sig for pubkeys[i] comes before the sig
   * for pubkeys[j] when i < j).  Only provide sigs for the threshold subset
   * you are using — all three pubkeys are always provided in the blob.
   */
  static unlockMultisig (
    sigs: number[][],
    pubkeys: PublicKey[],
  ): UnlockingScript {
    const u = new UnlockingScript()
    u.writeOpCode(OP.OP_0)
    for (const sig of sigs) {
      u.writeBin(sig)
    }
    u.writeBin(concatPubkeys(pubkeys))
    u.writeOpCode(OP.OP_1) // select the IF (multisig) branch
    return u
  }

  /** Cancel-branch unlocking script (ELSE / refund path). */
  static unlockCancel (
    sig: number[],
    refundPubKey: PublicKey,
  ): UnlockingScript {
    const u = new UnlockingScript()
    u.writeBin(sig)
    u.writeBin(refundPubKey.toDER() as number[])
    u.writeOpCode(OP.OP_0) // select the ELSE (refund) branch
    return u
  }

  /**
   * Computes the BIP-143 sighash (double-SHA256 of preimage) for input
   * `inputIndex` of `tx`.  The returned bytes can be signed directly with
   * ECDSA.sign() — no further hashing is required.
   */
  static sighash (
    tx: Transaction,
    inputIndex: number,
    lockingScript: LockingScript,
    sourceSatoshis: number,
  ): number[] {
    const input = tx.inputs[inputIndex]
    const sourceTXID =
      input.sourceTXID ?? (input.sourceTransaction?.id('hex') as string | undefined)
    if (sourceTXID == null) {
      throw new Error('input needs sourceTXID or sourceTransaction')
    }

    const preimage = TransactionSignature.format({
      sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
      inputIndex,
      outputs: tx.outputs,
      inputSequence: input.sequence ?? 0xffffffff,
      subscript: lockingScript,
      lockTime: tx.lockTime,
      scope: SIGHASH_SCOPE,
    })

    return Hash.hash256(preimage)
  }

  /** Converts a raw DER signature to checksig format (appends the sighash byte). */
  static toChecksigFormat (derSig: number[]): number[] {
    const s = Signature.fromDER(derSig)
    const txSig = new TransactionSignature(s.r, s.s, SIGHASH_SCOPE)
    return txSig.toChecksigFormat()
  }

  static estimateMultisigUnlockLength (threshold: number, total: number): number {
    return 4 + threshold * 74 + (total * 33 + 3)
  }

  static estimateCancelUnlockLength (): number {
    return 110
  }
}
