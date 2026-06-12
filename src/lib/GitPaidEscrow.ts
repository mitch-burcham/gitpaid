/**
 * GitPaidEscrow — CrowdEscrow with an in-script issue binding (ADR-003).
 *
 * Locking script layout:
 *
 *   <PUSHDATA binding>  OP_DROP      ← issue binding, pushed then dropped
 *   OP_IF                             ← unchanged CrowdEscrow body follows
 *     OP_DUP OP_HASH160 <hash160(concat(pubkeys))> OP_EQUALVERIFY
 *     <threshold> OP_SWAP
 *     (<33> OP_SPLIT) × (total−1)
 *     <total> OP_CHECKMULTISIG
 *   OP_ELSE
 *     OP_DUP OP_HASH160 <hash160(refundPubKey)> OP_EQUALVERIFY OP_CHECKSIG
 *   OP_ENDIF
 *
 * Execution: the unlocking script's args sit below; the binding is pushed on
 * top and immediately dropped, then the IF-selector evaluates exactly as in
 * CrowdEscrow. Both spend paths, `CrowdEscrow.sighash` (full locking script
 * as subscript) and both unlock builders work unchanged — TC-007 (CRITICAL)
 * proves this.
 *
 * Differences from CrowdEscrow.lock:
 *   - total ≥ 1 is allowed (sponsor-only 1-of-1 is the product default, D9).
 *     A 1-of-1 script has zero OP_SPLITs; OP_CHECKMULTISIG with n=1 is valid.
 *   - CrowdEscrow.ts is intentionally NOT edited (ADR-002: upstream-mergeable;
 *     new engine code lands as new files). The body builder below mirrors the
 *     upstream writer; `gitPaidEscrowBodyMatchesCrowd` in the test suite pins
 *     byte parity for total ≥ 2 so drift from upstream is caught by CI.
 *
 * Admittance (tm_gitpaid) uses `parse` — full structural validation, never
 * prefix matching (SR-004). `parse` returns null on ANY deviation; it must
 * never throw on hostile input.
 */
import {
  LockingScript,
  OP,
  Hash,
  PublicKey,
} from '@bsv/sdk'
import { decodeBinding, encodeBinding, MAX_BINDING_BYTES, type IssueBinding } from './binding'

export interface ParsedGitPaidEscrow {
  binding: IssueBinding
  /** hash160 over the concatenated multisig pubkeys (hex). */
  pubkeysHash: string
  threshold: number
  total: number
  /** hash160 of the refund pubkey (hex). */
  refundPkh: string
}

function concatPubkeys (pubkeys: PublicKey[]): number[] {
  return pubkeys
    .map(p => p.toDER() as number[])
    .reduce((a, b) => a.concat(b), [] as number[])
}

/** Read a small number chunk written by LockingScript.writeNumber. */
function readNumberChunk (chunk: { op: number, data?: number[] }): number | null {
  if (chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16) return chunk.op - 0x50
  if (chunk.op === OP.OP_0) return 0
  // Larger numbers are minimally-encoded little-endian pushes
  if (chunk.data != null && chunk.data.length >= 1 && chunk.data.length <= 4) {
    let n = 0
    for (let i = chunk.data.length - 1; i >= 0; i--) {
      n = n * 256 + chunk.data[i]
    }
    return n
  }
  return null
}

export class GitPaidEscrow {
  /**
   * Build the locking script. Mirrors CrowdEscrow.lock with the binding
   * prefix prepended and the pubkey-count floor relaxed to 1 (D9/ADR-003).
   */
  static lock (
    pubkeys: PublicKey[],
    threshold: number,
    refundPubKey: PublicKey,
    binding: IssueBinding,
  ): LockingScript {
    const total = pubkeys.length
    if (total < 1 || total > 10) {
      throw new Error('between 1 and 10 pubkeys required')
    }
    if (threshold < 1 || threshold > total) {
      throw new Error('threshold must be between 1 and the number of pubkeys')
    }

    const bindingBytes = encodeBinding(binding)
    const hash = Hash.hash160(concatPubkeys(pubkeys))
    const refundPkh = Hash.hash160(refundPubKey.toDER() as number[])

    const s = new LockingScript()

    // Binding prefix: pushed, then dropped — never executes as conditions
    s.writeBin(bindingBytes)
    s.writeOpCode(OP.OP_DROP)

    // ── unchanged CrowdEscrow body (see CrowdEscrow.lock) ──
    s.writeOpCode(OP.OP_IF)

    s.writeOpCode(OP.OP_DUP)
    s.writeOpCode(OP.OP_HASH160)
    s.writeBin(hash)
    s.writeOpCode(OP.OP_EQUALVERIFY)

    s.writeNumber(threshold)
    s.writeOpCode(OP.OP_SWAP)

    for (let i = 0; i < total - 1; i++) {
      s.writeNumber(33)
      s.writeOpCode(OP.OP_SPLIT)
    }

    s.writeNumber(total)
    s.writeOpCode(OP.OP_CHECKMULTISIG)

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
   * Structural parse for admittance (SR-004). Returns null on any deviation
   * from the exact GitPaidEscrow template — never throws on hostile input.
   */
  static parse (script: LockingScript): ParsedGitPaidEscrow | null {
    try {
      const c = script.chunks
      // Fixed chunks: binding, DROP, IF, DUP, HASH160, <hash>, EQUALVERIFY,
      // <threshold>, SWAP, [33, SPLIT]×k, <total>, CHECKMULTISIG,
      // ELSE, DUP, HASH160, <refundPkh>, EQUALVERIFY, CHECKSIG, ENDIF
      // k = total−1, so the minimum (1-of-1, k=0) is exactly 18 chunks.
      const MIN_CHUNKS = 18
      if (c.length < MIN_CHUNKS) return null

      // [0] binding push
      const bindingData = c[0].data
      if (bindingData == null || bindingData.length === 0 || bindingData.length > MAX_BINDING_BYTES) return null
      const binding = decodeBinding(bindingData)
      if (binding === null) return null

      // [1..4] DROP IF DUP HASH160
      if (c[1].op !== OP.OP_DROP) return null
      if (c[2].op !== OP.OP_IF) return null
      if (c[3].op !== OP.OP_DUP) return null
      if (c[4].op !== OP.OP_HASH160) return null

      // [5] pubkeys hash (20 bytes)
      if (c[5].data == null || c[5].data.length !== 20) return null
      const pubkeysHash = c[5].data

      // [6] EQUALVERIFY, [7] threshold, [8] SWAP
      if (c[6].op !== OP.OP_EQUALVERIFY) return null
      const threshold = readNumberChunk(c[7])
      if (threshold === null || threshold < 1) return null
      if (c[8].op !== OP.OP_SWAP) return null

      // [9..] (33 SPLIT) pairs
      let i = 9
      let splits = 0
      while (i + 1 < c.length && readNumberChunk(c[i]) === 33 && c[i + 1].op === OP.OP_SPLIT) {
        splits++
        i += 2
        if (splits > 9) return null
      }

      // [i] total, [i+1] CHECKMULTISIG — exactly 9 chunks must remain
      if (c.length !== i + 9) return null
      const total = readNumberChunk(c[i])
      if (total === null) return null
      if (total !== splits + 1) return null
      if (total < 1 || total > 10 || threshold > total) return null
      if (c[i + 1].op !== OP.OP_CHECKMULTISIG) return null

      // [i+2..] ELSE DUP HASH160 <pkh> EQUALVERIFY CHECKSIG ENDIF
      if (c[i + 2].op !== OP.OP_ELSE) return null
      if (c[i + 3].op !== OP.OP_DUP) return null
      if (c[i + 4].op !== OP.OP_HASH160) return null
      const refundPkh = c[i + 5].data
      if (refundPkh == null || refundPkh.length !== 20) return null
      if (c[i + 6].op !== OP.OP_EQUALVERIFY) return null
      if (c[i + 7].op !== OP.OP_CHECKSIG) return null
      if (c[i + 8].op !== OP.OP_ENDIF) return null

      return {
        binding,
        pubkeysHash: toHex(pubkeysHash),
        threshold,
        total,
        refundPkh: toHex(refundPkh),
      }
    } catch {
      return null
    }
  }
}

function toHex (bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}
