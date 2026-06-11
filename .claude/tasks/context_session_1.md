# Context: CrowdEscrow Task 2 — DONE

## Status
DONE — all 6 tests pass, committed.

## Commit
`8902461` on branch `feat/crowd-app`
Message: `feat: CrowdEscrow script template with multisig + cancel paths`

## Files Created
- `/Users/personal/git/experimental/crowd/src/lib/CrowdEscrow.ts` — implementation
- `/Users/personal/git/experimental/crowd/src/lib/CrowdEscrow.test.ts` — 6 vitest tests

## What Was Implemented

### CrowdEscrow.ts
Static class with:
- `lock(pubkeys, threshold, refundPubKey)` — produces an IF/ELSE locking script
- `unlockMultisig(sigs, pubkeys)` — multisig unlocking script (IF branch)
- `unlockCancel(sig, refundPubKey)` — cancel/refund unlocking script (ELSE branch)
- `sighash(tx, inputIndex, lockingScript, sourceSatoshis)` — BIP-143 sighash bytes
- `toChecksigFormat(derSig)` — converts DER sig to checksig format
- `estimateMultisigUnlockLength(threshold, total)` — size estimate
- `estimateCancelUnlockLength()` — size estimate
- `SIGHASH_SCOPE` export — `SIGHASH_ALL | SIGHASH_FORKID`

### Script Design
```
IF-branch (multisig):
  OP_IF
    OP_DUP OP_HASH160 <hash160(pub0||pub1||...||pubN)> OP_EQUALVERIFY
    <threshold> OP_SWAP
    [<33> OP_SPLIT] × (N-1)   // split blob into individual pubkeys
    <N> OP_CHECKMULTISIG
  OP_ELSE                     (cancel/refund path)
    OP_DUP OP_HASH160 <hash160(refundPub)> OP_EQUALVERIFY OP_CHECKSIG
  OP_ENDIF

Multisig unlocking: OP_0 <sig0> ... <sig_{m-1}> <pub0||...||pubN> OP_1
Cancel unlocking:   <sig> <refundPub> OP_0
```

### Key Design Notes
- Sigs in `unlockMultisig` must be in the same order as their pubkeys in the pubkey list.
  The Spend interpreter's CHECKMULTISIG reads sigs/pubkeys from the stack top-down.
  Pushing sigs in pubkey order (sig for lower-index pubkey first) places the sig for
  the highest-index pubkey closest to the top, which is what the algorithm expects.
- `TransactionSignature.format()` returns the raw preimage bytes (not yet hashed).
  The caller must call `Hash.hash256(preimage)` to get the 32-byte sighash.
- `ECDSA.sign(new BigNumber(hash), privKey, true)` signs the hash directly (no
  additional hashing); forceLowS=true is required for DER encoding compliance.

### Tests
All 6 tests verified with real `Spend.validate()` calls (no mocks):
1. lock() hex starts with 0x63 (OP_IF), ends with 0x68 (OP_ENDIF)
2. 2-of-3 multisig validates (sigs for keys 0 and 2 in correct order)
3. Multisig fails with only 1 signature
4. Multisig fails with sigs in wrong order [sig2, sig0]
5. Cancel path validates with the refund key
6. Cancel path fails with a non-refund key signature

## SDK API Details Verified
- `ECDSA.sign(msg: BigNumber, key: BigNumber, forceLowS?: boolean)` — PrivateKey extends BigNumber
- `Spend` constructor: `sourceSatoshis: number` (not BigNumber)
- `TransactionSignature.format()` returns `number[]` (preimage, not hash)
- `Hash.hash256(preimage)` for the final sighash
- `PublicKey.toDER()` returns `number[]` when called without args
- `Script.writeNumber()`, `writeBin()`, `writeOpCode()` — all verified to exist
- `OP.OP_SPLIT`, `OP.OP_IF`, `OP.OP_ELSE`, `OP.OP_ENDIF` — all available

## Next Tasks (from plan)
Task 3 is likely the frontend UI connecting to this contract.
