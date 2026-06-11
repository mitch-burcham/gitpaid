# Crowd — N-of-M Escrow App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser app to escrow BSV in an N-of-M multisig contract with an originator cancel path, controllers assigned by identity lookup, signatures coordinated over MessageBox until threshold, then broadcast.

**Architecture:** Pure frontend (Vite + React 19 + TS). All keys via BRC-100 `WalletClient`. Custom `CrowdEscrow` script template (P2MSKH multisig branch + refund P2PKH branch). Coordination is event-sourced from a `crowd` MessageBox (`https://gmb.bsvblockchain.tech`), persisted in localStorage. Spec: `docs/superpowers/specs/2026-06-10-crowd-escrow-design.md` — read it first.

**Tech Stack:** `@bsv/sdk` ^2.1.4, `@bsv/message-box-client` ^2.1.2, `react-router-dom` ^7 (HashRouter), vitest. Hand-rolled CSS (no UI framework).

**Conventions for all tasks:**
- TDD where a unit is pure (lib/). Run `npm test` (vitest run) before each commit.
- Commit after each task: `git add -A && git commit -m "<type>: <summary>"`.
- TypeScript strict. No `any` unless interfacing with untyped JSON (then narrow via type guards).
- IMPORTANT: verify SDK API shapes against `node_modules/@bsv/sdk/dist/types/` if anything in this plan doesn't compile — the plan was written against @bsv/sdk 2.1.4.

---

### Task 1: Scaffold project

**Files:** Create Vite project in repo root (`/Users/personal/git/experimental/crowd`), `vite.config.ts`, `package.json`, `tsconfig*`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/theme.css`.

- [ ] **Step 1:** Scaffold in-place: `npm create vite@latest . -- --template react-ts` (the dir already contains `docs/` and `.git` — if the scaffolder refuses, scaffold to a temp dir and move files in, preserving `docs/`).
- [ ] **Step 2:** `npm i @bsv/sdk@^2.1.4 @bsv/message-box-client@^2.1.2 react-router-dom@^7` and `npm i -D vitest`.
- [ ] **Step 3:** Add `"test": "vitest run"` script. Create `src/theme.css` with design tokens (see Task 8 for the full token set — create the file now with the `:root` block from Task 8 Step 1 so early components can reference variables) and import it in `src/main.tsx`.
- [ ] **Step 4:** `index.html`: title "Crowd — shared escrow", `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, Google Fonts link for `Space Grotesk:wght@500;700` and `Inter:wght@400;500;600`.
- [ ] **Step 5:** Verify `npm run build` passes and `npm test` runs (no tests yet → configure vitest `passWithNoTests: true` in vite.config.ts `test` block).
- [ ] **Step 6:** Commit `chore: scaffold vite react-ts app with bsv deps`.

---

### Task 2: `CrowdEscrow` script template + tests

**Files:**
- Create: `src/lib/CrowdEscrow.ts`
- Test: `src/lib/CrowdEscrow.test.ts`

The template is P2MSKH (https://raw.githubusercontent.com/bsv-blockchain/ts-templates/refs/heads/master/src/P2MSKH.ts) wrapped in OP_IF/OP_ELSE/OP_ENDIF with a refund P2PKH branch. Implement exactly:

```ts
import {
  LockingScript, UnlockingScript, OP, Hash, PublicKey, TransactionSignature,
  Utils, Transaction
} from '@bsv/sdk'

function concatPubkeys (pubkeys: PublicKey[]): number[] {
  return pubkeys.map(p => p.toDER() as number[]).reduce((a, b) => a.concat(b), [])
}

export const SIGHASH_SCOPE =
  TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID

export class CrowdEscrow {
  /** Locking script: IF n-of-m multisig over hash160(concat pubkeys) ELSE p2pkh(refund key) ENDIF */
  static lock (pubkeys: PublicKey[], threshold: number, refundPubKey: PublicKey): LockingScript {
    const total = pubkeys.length
    if (threshold < 1 || threshold > total) throw new Error('threshold must be between 1 and the number of pubkeys')
    if (total < 2 || total > 10) throw new Error('between 2 and 10 pubkeys required')
    const hash = Hash.hash160(concatPubkeys(pubkeys))
    const refundPkh = Hash.hash160(refundPubKey.toDER() as number[])
    const s = new LockingScript()
    s.writeOpCode(OP.OP_IF)
      .writeOpCode(OP.OP_DUP).writeOpCode(OP.OP_HASH160)
      .writeBin(hash).writeOpCode(OP.OP_EQUALVERIFY)
      .writeNumber(threshold).writeOpCode(OP.OP_SWAP)
    for (let i = 0; i < total - 1; i++) s.writeNumber(33).writeOpCode(OP.OP_SPLIT)
    s.writeNumber(total).writeOpCode(OP.OP_CHECKMULTISIG)
      .writeOpCode(OP.OP_ELSE)
      .writeOpCode(OP.OP_DUP).writeOpCode(OP.OP_HASH160)
      .writeBin(refundPkh).writeOpCode(OP.OP_EQUALVERIFY).writeOpCode(OP.OP_CHECKSIG)
      .writeOpCode(OP.OP_ENDIF)
    return s
  }

  /**
   * Multisig-branch unlocking script.
   * sigs: checksig-format signatures (DER + sighash byte) ORDERED THE SAME AS
   * the pubkeys they correspond to (subset of `pubkeys`, same relative order).
   */
  static unlockMultisig (sigs: number[][], pubkeys: PublicKey[]): UnlockingScript {
    const u = new UnlockingScript()
    u.writeOpCode(OP.OP_0)
    for (const sig of sigs) u.writeBin(sig)
    u.writeBin(concatPubkeys(pubkeys))
    u.writeOpCode(OP.OP_1) // take the IF (multisig) branch
    return u
  }

  /** Cancel-branch unlocking script. */
  static unlockCancel (sig: number[], refundPubKey: PublicKey): UnlockingScript {
    const u = new UnlockingScript()
    u.writeBin(sig)
    u.writeBin(refundPubKey.toDER() as number[])
    u.writeOpCode(OP.OP_0) // take the ELSE (refund) branch
    return u
  }

  /** Sighash (double-SHA256 of BIP143-style preimage) for input `inputIndex` of `tx`. */
  static sighash (tx: Transaction, inputIndex: number, lockingScript: LockingScript, sourceSatoshis: number): number[] {
    const input = tx.inputs[inputIndex]
    const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    if (sourceTXID == null) throw new Error('input needs sourceTXID or sourceTransaction')
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
      scope: SIGHASH_SCOPE
    })
    return Hash.hash256(preimage)
  }

  /** DER signature bytes -> checksig format (appends sighash byte). */
  static toChecksigFormat (derSig: number[]): number[] {
    const { Signature } = Utils as any // if this import path is wrong, import Signature from '@bsv/sdk' top level
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
```

Note: `Signature` is a top-level export of `@bsv/sdk` (`import { Signature } from '@bsv/sdk'`) — use that, drop the `Utils as any` hack shown above.

- [ ] **Step 1:** Write failing tests in `src/lib/CrowdEscrow.test.ts`. Use local `PrivateKey.fromRandom()` keys (3 controllers, threshold 2, plus a refund key). Build a funding tx paying 1000 sats to `CrowdEscrow.lock(...)`, then a spending tx with one input (sourceTransaction = funding tx) and one P2PKH output of 900 sats. Tests:
  1. `lock()` produces a script whose hex contains OP_IF (0x63) first byte and OP_ENDIF (0x68) last byte.
  2. Multisig path validates: sign sighash with controllers 0 and 2 (`privKey.sign(...)` — sign the 32-byte sighash; use `ECDSA.sign(new BigNumber(sighash), privKey, true)` or `privKey.sign(preimageHash, undefined, true)`; check the sdk: the reliable route is `const sig = ECDSA.sign(new BigNumber(hash), key, true)` then `new TransactionSignature(sig.r, sig.s, SIGHASH_SCOPE).toChecksigFormat()`), assemble `unlockMultisig([sig0, sig2], pubkeys)` (order matters), attach to the input, then validate with the sdk `Spend` interpreter:
     ```ts
     import { Spend } from '@bsv/sdk'
     const spend = new Spend({
       sourceTXID: fundingTx.id('hex'), sourceOutputIndex: 0, sourceSatoshis: 1000,
       lockingScript: lock, transactionVersion: 1, otherInputs: [], inputIndex: 0,
       unlockingScript: unlock, inputSequence: 0xffffffff,
       outputs: spendTx.outputs, lockTime: 0
     })
     expect(spend.validate()).toBe(true)
     ```
     (Verify `Spend` constructor arg names against `node_modules/@bsv/sdk/dist/types/src/script/Spend.d.ts` and adjust.)
  3. Multisig path FAILS with only 1 signature (expect `spend.validate()` to throw or return false).
  4. Multisig path FAILS with sigs in wrong order (`[sig2, sig0]`).
  5. Cancel path validates with refund key signature via `unlockCancel`.
  6. Cancel path FAILS with a non-refund key signature.
- [ ] **Step 2:** Run `npm test` — expect FAIL (module not found).
- [ ] **Step 3:** Implement `src/lib/CrowdEscrow.ts` as above (fix the `Signature` import).
- [ ] **Step 4:** Run `npm test` — expect PASS. If `Spend.validate()` fails, debug script semantics before touching the test (the script is the contract; print `spend` error messages).
- [ ] **Step 5:** Commit `feat: CrowdEscrow script template with multisig + cancel paths`.

---

### Task 3: Message protocol types + store reducer

**Files:**
- Create: `src/lib/protocol.ts` (types + guards), `src/lib/store.ts` (reducer + persistence)
- Test: `src/lib/store.test.ts`

`src/lib/protocol.ts` — exact shapes:

```ts
export type PubKeyHex = string
export const CROWD_BOX = 'crowd'
export const MESSAGEBOX_HOST = 'https://gmb.bsvblockchain.tech'
export const MULTISIG_PROTOCOL: [1, string] = [1, 'multi sig brc29']
export const BRC29_PROTOCOL: [2, string] = [2, '3241645161d8']

export interface InviteMsg {
  type: 'invite'
  escrowId: string            // funding `${txid}.${vout}`
  beef: string                // funding tx AtomicBEEF, hex
  satoshis: number
  threshold: number
  keyID: string               // nonce for multisig derivation
  originator: PubKeyHex       // identity key
  controllers: PubKeyHex[]    // identity keys, originator included
  pubkeys: PubKeyHex[]        // derived multisig pubkeys, same order as controllers
  refundPkh: string           // hex hash160 of refund pubkey (display/audit only)
  name: string                // human label for the escrow
  createdAt: number
}
export interface ProposalMsg {
  type: 'proposal'
  escrowId: string
  proposalId: string          // unsigned tx id (hex)
  rawTx: string               // unsigned spending tx, hex
  note: string
  proposer: PubKeyHex
  recipient?: { identityKey: PubKeyHex, derivationPrefix: string, derivationSuffix: string }
  createdAt: number
}
export interface SignatureMsg {
  type: 'signature'
  escrowId: string
  proposalId: string
  signer: PubKeyHex           // identity key of signer
  sigHex: string              // checksig-format signature, hex
}
export interface VetoMsg { type: 'veto', escrowId: string, proposalId: string, vetoer: PubKeyHex, reason?: string }
export interface FinalizedMsg { type: 'finalized', escrowId: string, proposalId: string, txid: string }
export interface CancelledMsg { type: 'cancelled', escrowId: string, txid: string }
export type CrowdMessage = InviteMsg | ProposalMsg | SignatureMsg | VetoMsg | FinalizedMsg | CancelledMsg

export function isCrowdMessage (x: unknown): x is CrowdMessage {
  if (typeof x !== 'object' || x === null) return false
  const t = (x as { type?: unknown }).type
  return t === 'invite' || t === 'proposal' || t === 'signature' ||
         t === 'veto' || t === 'finalized' || t === 'cancelled'
}
```

`src/lib/store.ts`:

```ts
import { CrowdMessage, InviteMsg, PubKeyHex } from './protocol'

export interface ProposalState {
  proposal: import('./protocol').ProposalMsg
  signatures: Record<PubKeyHex, string>   // signer -> sigHex
  vetoes: Record<PubKeyHex, string>       // vetoer -> reason
  status: 'open' | 'vetoed' | 'finalized'
  txid?: string
}
export interface EscrowState {
  invite: InviteMsg
  status: 'active' | 'spent' | 'cancelled'
  spentTxid?: string
  proposals: Record<string, ProposalState>
}
export interface CrowdState { escrows: Record<string, EscrowState> }

export const emptyState: CrowdState = { escrows: {} }

/** Pure event-sourcing reducer. Unknown escrow/proposal refs are ignored
 * EXCEPT signatures/proposals arriving before their parents, which are also
 * just ignored — callers re-apply the full message log in timestamp order,
 * and invites always precede proposals from honest clients. Keep it simple. */
export function reduce (state: CrowdState, msg: CrowdMessage): CrowdState
export function loadState (ownKey: string): CrowdState        // localStorage `crowd:${ownKey}`
export function saveState (ownKey: string, s: CrowdState): void
export function applyAndSave (ownKey: string, s: CrowdState, msgs: CrowdMessage[]): CrowdState
```

Reducer rules: `invite` creates escrow if absent (idempotent). `proposal` adds open proposal if escrow exists & active. `signature` recorded only if proposal open and signer ∈ invite.controllers. `veto` → status `vetoed` if open, vetoer ∈ controllers. `finalized` → proposal `finalized` + escrow `spent`. `cancelled` → escrow `cancelled`. All transitions idempotent, never mutate input state (return new objects).

- [ ] **Step 1:** Write failing tests in `src/lib/store.test.ts`: invite creates escrow; duplicate invite idempotent; proposal then 2 signatures accumulate; signature from non-controller ignored; veto closes proposal; finalized marks escrow spent and proposal finalized; cancelled marks escrow cancelled; messages referencing unknown escrow ignored; reducer purity (input state object unchanged).
- [ ] **Step 2:** `npm test` — expect FAIL.
- [ ] **Step 3:** Implement `protocol.ts` and `store.ts` (localStorage helpers guarded with `typeof localStorage !== 'undefined'` so tests run in node).
- [ ] **Step 4:** `npm test` — expect PASS.
- [ ] **Step 5:** Commit `feat: crowd message protocol and event-sourced store`.

---### Task 4: Wallet, identity, and messagebox singletons

**Files:**
- Create: `src/lib/wallet.ts`, `src/lib/identity.ts`, `src/lib/messages.ts`

No unit tests (thin wrappers over network/wallet — tested via integration later). Must compile under strict TS.

`src/lib/wallet.ts`:
```ts
import { WalletClient } from '@bsv/sdk'
export const wallet = new WalletClient('auto', 'crowd.bsvb.app')
let ownKey: string | undefined
export async function getOwnIdentityKey (): Promise<string> {
  if (ownKey == null) {
    await wallet.waitForAuthentication()
    ownKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
  }
  return ownKey
}
```

`src/lib/identity.ts`: `IdentityClient` from `@bsv/sdk` constructed with `wallet`. Export `searchIdentities(query: string): Promise<DisplayableIdentity[]>` (resolveByAttributes over candidate attribute keys `['any', 'name', 'firstName', 'lastName', 'userName', 'email']` — call with `{ attributes: { [k]: query } }`, try `any` first; merge + dedupe on identityKey; swallow per-key errors) and `resolveKey(identityKey: string): Promise<DisplayableIdentity | undefined>` with an in-memory `Map` cache.

`src/lib/messages.ts`:
```ts
import { MessageBoxClient } from '@bsv/message-box-client'
import { wallet } from './wallet'
import { CROWD_BOX, MESSAGEBOX_HOST, CrowdMessage, isCrowdMessage } from './protocol'

export const mbx = new MessageBoxClient({ walletClient: wallet, host: MESSAGEBOX_HOST })

/** Fan a message out to every party except self. Resolves when all sends settle; returns failed recipients. */
export async function fanOut (msg: CrowdMessage, recipients: string[], ownKey: string): Promise<string[]>
/** Drain inbox: list, parse+filter via isCrowdMessage (body may be object or JSON string), ack ONLY successfully parsed ids, return messages sorted by created_at. */
export async function drainInbox (): Promise<CrowdMessage[]>
/** Live updates: joins websocket room for CROWD_BOX; onMessage receives parsed CrowdMessage; acks each. Returns cleanup fn. */
export async function listenLive (onMessage: (m: CrowdMessage) => void): Promise<() => void>
```
Implementation notes: `mbx.sendMessage({ recipient, messageBox: CROWD_BOX, body: msg })` (body auto-encrypted); `mbx.listMessages({ messageBox: CROWD_BOX })`; `mbx.acknowledgeMessage({ messageIds: [...] })`; `mbx.listenForLiveMessages({ messageBox: CROWD_BOX, onMessage })`; cleanup via `mbx.leaveRoom(CROWD_BOX)`. `PeerMessage.body` may arrive as JSON string — `typeof body === 'string' ? JSON.parse(body) : body` inside try/catch.

- [ ] **Step 1:** Implement all three files. `npx tsc --noEmit` (or `npm run build`) passes.
- [ ] **Step 2:** Commit `feat: wallet, identity, and messagebox service wrappers`.

---

### Task 5: Escrow operations (`src/lib/escrow.ts`) + tests for pure parts

**Files:**
- Create: `src/lib/escrow.ts`
- Test: `src/lib/escrow.test.ts`

Exports (signatures exact; bodies per notes below):

```ts
import { Transaction, PublicKey } from '@bsv/sdk'
import { InviteMsg, ProposalMsg } from './protocol'
import { EscrowState } from './store'

export interface CreateEscrowParams {
  name: string
  satoshis: number
  threshold: number
  controllerIdentityKeys: string[]  // EXCLUDING self; self is prepended inside
}
export async function createEscrow (p: CreateEscrowParams): Promise<InviteMsg>

export interface BuildProposalParams {
  invite: InviteMsg
  note: string
  recipientIdentityKey?: string   // BRC-29 derive when set
  recipientAddress?: string       // raw P2PKH fallback
}
export async function buildProposal (p: BuildProposalParams): Promise<ProposalMsg>

/** Recompute the sighash for the proposal tx and sign with our derived multisig key. */
export async function signProposal (invite: InviteMsg, proposal: ProposalMsg): Promise<string /* sigHex */>

/** Pure: verify sigHex against the controller's derived pubkey for this proposal. */
export function verifySignature (invite: InviteMsg, proposal: ProposalMsg, signer: string, sigHex: string): boolean

/** Pure: true when ≥ threshold verified signatures present. */
export function readyToFinalize (invite: InviteMsg, es: EscrowState, proposalId: string): boolean

/** Assemble unlocking script from verified sigs (pubkey order), attach, broadcast. Returns txid. */
export async function finalizeProposal (invite: InviteMsg, es: EscrowState, proposalId: string): Promise<string>

/** Originator cancel via wallet createAction/signAction. Returns txid. */
export async function cancelEscrow (invite: InviteMsg): Promise<string>

/** Reconstruct the proposal Transaction with sourceTransaction attached. Pure. */
export function proposalTx (invite: InviteMsg, proposal: ProposalMsg): Transaction
export function escrowLockingScript (invite: InviteMsg): import('@bsv/sdk').LockingScript
```

Implementation notes:
- `createEscrow`: `keyID` = 16 random bytes base64 (`Utils.toBase64(Random(16))` — sdk exports `Random`). Derive each controller pubkey: `wallet.getPublicKey({ protocolID: MULTISIG_PROTOCOL, keyID, counterparty: identityKey })`; self uses `counterparty: 'self'` and `forSelf: true` is NOT needed (we're deriving our own receive key — actually for self use `counterparty: 'self'`). Refund key: prefix/suffix = 16-byte base64 nonces, `wallet.getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: `${prefix} ${suffix}`, counterparty: 'self' })`. Lock with `CrowdEscrow.lock(pubkeys, threshold, refundPubKey)`. `wallet.createAction({ description: 'Create crowd escrow', outputs: [{ lockingScript: hex, satoshis, outputDescription: 'Crowd escrow', basket: 'crowd escrow', customInstructions: JSON.stringify({ keyID, refund: { prefix, suffix }, controllers, threshold }) }], options: { randomizeOutputs: false } })`. escrowId = `${txid}.0`. beef = `Utils.toHex(result.tx!)`.
- `buildProposal`: source tx via `Transaction.fromAtomicBEEF(Utils.toArray(invite.beef, 'hex'))`. Input: `{ sourceTransaction, sourceOutputIndex: vout, sequence: 0xffffffff }` with a placeholder `unlockingScriptTemplate`? No — leave input without unlocking script; serialize via `tx.toHex()`. Output: recipient script — if identityKey: derive `wallet.getPublicKey({ protocolID: BRC29_PROTOCOL, keyID: `${prefix} ${suffix}`, counterparty: recipientIdentityKey })`, P2PKH lock on that key; else `new P2PKH().lock(recipientAddress)`. Output satoshis = `invite.satoshis - fee` where `fee = Math.max(2, Math.ceil((txSizeEstimate) / 1000))`; txSizeEstimate = 10 + 40 + `CrowdEscrow.estimateMultisigUnlockLength(threshold, pubkeys.length)` + 34. proposalId = `tx.id('hex')` of the unsigned tx. Sign own part is done by caller via `signProposal`.
- `signProposal`: rebuild tx via `proposalTx`, sighash via `CrowdEscrow.sighash(tx, 0, escrowLockingScript(invite), invite.satoshis)`, then `wallet.createSignature({ hashToDirectlySign: sighash, protocolID: MULTISIG_PROTOCOL, keyID: invite.keyID, counterparty: invite.originator === ownKey ? 'self' : invite.originator })` — NOTE the BRC-42 symmetry: the originator derived controller keys with counterparty=controller, so each controller signs with counterparty=originator; the originator itself signs with counterparty='self'. Convert DER → checksig via `CrowdEscrow.toChecksigFormat`, return hex.
- `verifySignature`: parse checksig-format sig (last byte = sighash flags, rest DER): `Signature.fromDER(bytes.slice(0, -1))`, compute sighash, verify with `ECDSA.verify(new BigNumber(sighash), sig, PublicKey.fromString(invite.pubkeys[idx]))` where idx = `invite.controllers.indexOf(signer)`. Return false on any throw or unknown signer.
- `finalizeProposal`: collect verified sigs ordered by pubkey index, take first `threshold`, `CrowdEscrow.unlockMultisig`, set `tx.inputs[0].unlockingScript`, broadcast: `await tx.broadcast()` (sdk default broadcaster = ARC; if `broadcast()` requires an arg, use `new ARC('https://arc.taal.com')` — check `node_modules/@bsv/sdk/dist/types/src/transaction/Transaction.d.ts`). Return `tx.id('hex')`.
- `cancelEscrow`: re-derive refund pubkey from customInstructions… the invite doesn't carry refund prefix/suffix (they're private to originator). Get them from `wallet.listOutputs({ basket: 'crowd escrow', includeCustomInstructions: true })` matching outpoint == escrowId, parse customInstructions. Then `createAction({ description: 'Cancel crowd escrow', inputBEEF: Utils.toArray(invite.beef, 'hex'), inputs: [{ outpoint: invite.escrowId, inputDescription: 'Escrow being cancelled', unlockingScriptLength: CrowdEscrow.estimateCancelUnlockLength() }], options: { signAndProcess: false, randomizeOutputs: false } })`, parse `signableTransaction.tx` via `Transaction.fromAtomicBEEF`, sighash with escrow locking script + satoshis, `createSignature({ hashToDirectlySign, protocolID: BRC29_PROTOCOL, keyID: `${prefix} ${suffix}`, counterparty: 'self' })`, build `unlockCancel`, `signAction({ spends: { 0: { unlockingScript: hex } }, reference })`. No outputs → remainder returns to wallet as change/fee per wallet policy. Return txid.

- [ ] **Step 1:** Write failing tests in `src/lib/escrow.test.ts` for the PURE functions only, using locally-built fixtures (no WalletClient): construct an `InviteMsg` from 3 local `PrivateKey`s (pubkeys = their pubkeys directly — pure functions don't care how keys were derived), a funding tx built locally with `CrowdEscrow.lock`, and a proposal built by hand (mirror buildProposal's tx construction inline in the test). Tests: `proposalTx` round-trips rawTx and attaches sourceTransaction; `verifySignature` true for genuine local-key sig, false for wrong signer / corrupt sig; `readyToFinalize` false at 1 of 2 sigs, true at 2.
- [ ] **Step 2:** `npm test` — FAIL.
- [ ] **Step 3:** Implement `escrow.ts` fully (wallet-dependent functions too — they compile, tested manually later).
- [ ] **Step 4:** `npm test` — PASS. `npm run build` passes.
- [ ] **Step 5:** Commit `feat: escrow operations - create, propose, sign, verify, finalize, cancel`.

---

### Task 6: App state context + inbox sync hook

**Files:**
- Create: `src/hooks/useCrowd.tsx`

One React context providing: `{ ready, ownKey, state, dispatchMessages, refresh }`.

```tsx
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { CrowdState, emptyState, loadState, applyAndSave } from '../lib/store'
import { CrowdMessage } from '../lib/protocol'
import { getOwnIdentityKey } from '../lib/wallet'
import { drainInbox, listenLive } from '../lib/messages'
```

Behavior: on mount → `getOwnIdentityKey()` (gates on wallet auth) → `loadState(ownKey)` → `drainInbox()` → `applyAndSave` → set `ready`. Then `listenLive` pushing each message through `applyAndSave` + `setState`. `dispatchMessages(msgs: CrowdMessage[])` applies local echoes of messages we send ourselves (we are not a recipient of our own fan-out). Expose `refresh()` re-running drainInbox. Handle errors: keep `ready` true once wallet OK even if messagebox fails; expose `mbxError?: string`.

- [ ] **Step 1:** Implement; `npm run build` passes.
- [ ] **Step 2:** Commit `feat: crowd context with inbox sync and live updates`.

---

### Task 7: Router + page shells

**Files:**
- Modify: `src/App.tsx`, `src/main.tsx`
- Create: `src/pages/Dashboard.tsx`, `src/pages/CreateEscrow.tsx`, `src/pages/EscrowDetail.tsx`, `src/components/WalletGate.tsx`

Routes (HashRouter): `/` Dashboard, `/new` CreateEscrow, `/e/:escrowId` EscrowDetail (also handles `?d=<base64url invite>` bootstrap: decode, validate via `isCrowdMessage`, dispatch into store), `/e/:escrowId/p/:proposalId` EscrowDetail scrolled/focused on that proposal. `WalletGate` wraps everything: while `!ready` show full-screen connect state ("Waiting for your BSV wallet…" + spinner; mention installing a BRC-100 wallet).

base64url helpers in `src/lib/protocol.ts`: `encodeInvite(i: InviteMsg): string` / `decodeInvite(s: string): InviteMsg | undefined` (use `Utils.toBase64`/`toArray` from sdk or btoa with url-safe replacements; must survive URL round-trip).

- [ ] **Step 1:** Implement shells with minimal content (page titles + placeholder sections), wire context provider + router. `npm run build` passes.
- [ ] **Step 2:** Commit `feat: app routing, wallet gate, page shells`.

---

### Task 8: Visual system + Dashboard UI

**Files:**
- Modify: `src/theme.css`, `src/pages/Dashboard.tsx`
- Create: `src/components/EscrowCard.tsx`, `src/components/AvatarChip.tsx`, `src/components/SigRing.tsx`

- [ ] **Step 1:** Full token set in `src/theme.css`:

```css
:root {
  --bg: #060A14; --bg-raise: #0B1222; --panel: rgba(148, 184, 255, 0.06);
  --panel-border: rgba(148, 184, 255, 0.14); --text: #E8EEFB; --text-dim: #8C9AB8;
  --accent: #38E0FF; --accent-2: #8B5CF6; --danger: #FF5C7A; --ok: #3DF0A8;
  --grad: linear-gradient(135deg, var(--accent), var(--accent-2));
  --radius: 16px; --radius-sm: 10px;
  --font-display: 'Space Grotesk', sans-serif; --font-body: 'Inter', sans-serif;
  --shadow-glow: 0 0 24px rgba(56, 224, 255, 0.18);
}
```
Base styles: `body { background: var(--bg); color: var(--text); font-family: var(--font-body); }`, headings in `--font-display`. `.panel` = glass card (panel bg, 1px panel-border, backdrop-filter blur(12px), radius). `.btn` (gradient fill, dark text, 44px min height) / `.btn-ghost` / `.btn-danger`. Subtle fixed background: two radial-gradient glows (accent/accent-2 at 8% opacity) + a faint grid via repeating-linear-gradient. Respect `prefers-reduced-motion`.

- [ ] **Step 2:** Components: `AvatarChip` (avatarURL or gradient-initial fallback, name, abbreviated key, resolves via `resolveKey` with loading shimmer); `SigRing` (SVG circle progress: `k/N` center text, gradient stroke via `<linearGradient>`, animated `stroke-dashoffset`); `EscrowCard` (name, satoshis formatted with `Intl.NumberFormat`, controller avatar stack, status pill — active=accent, spent=dim, cancelled=danger, tap → detail).
- [ ] **Step 3:** Dashboard: header "Crowd" wordmark (display font, gradient text), own AvatarChip top-right, escrow card grid (`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`), empty state with big "+ New escrow" CTA, floating action button on mobile (`@media (max-width: 640px)` bottom-fixed). `npm run build` passes.
- [ ] **Step 4:** Commit `feat: visual system, dashboard with escrow cards`.

---

### Task 9: Create-escrow flow UI

**Files:**
- Modify: `src/pages/CreateEscrow.tsx`
- Create: `src/components/IdentityPicker.tsx`, `src/components/ShareLink.tsx`

- [ ] **Step 1:** `IdentityPicker`: search input (debounced 300ms) → `searchIdentities` → result rows (AvatarChip + add button); selected controllers as removable chips; also accepts a raw 66-char hex identity key paste ("Add by key"). Self shown as a locked first chip.
- [ ] **Step 2:** `CreateEscrow` page: steps in one scrollable form — name input, amount in sats (numeric, formatted preview), controller picker, threshold stepper (1..M, big − / + buttons, live sentence: "Any **2 of 3** controllers can move these funds"), confirm panel summarizing, primary button "Lock funds". On submit: `createEscrow` → `fanOut(invite, invite.controllers, ownKey)` → `dispatchMessages([invite])` → success screen with `ShareLink`.
- [ ] **Step 3:** `ShareLink`: renders `${location.origin}${location.pathname}#/e/${escrowId}?d=${encodeInvite(invite)}`, copy button (navigator.clipboard, "Copied ✓" feedback), native share via `navigator.share` when available.
- [ ] **Step 4:** Error surface: failed fan-out recipients shown in a warning banner with retry button. `npm run build` passes.
- [ ] **Step 5:** Commit `feat: create escrow flow with identity picker and share link`.

---

### Task 10: Escrow detail — propose, sign, veto, finalize, cancel UI

**Files:**
- Modify: `src/pages/EscrowDetail.tsx`
- Create: `src/components/ProposalPanel.tsx`, `src/components/OutputList.tsx`, `src/components/ProposeForm.tsx`

- [ ] **Step 1:** EscrowDetail layout: hero panel (escrow name, sats, status pill, SigRing showing threshold/M, controller avatar row, ShareLink for the invite); originator additionally sees "Cancel escrow" (btn-danger, two-tap confirm: button morphs to "Tap again to return funds"). Proposals list below, newest first; deep-link `p/:proposalId` highlights that panel.
- [ ] **Step 2:** `ProposeForm` (collapsible "New transfer" panel): recipient by identity search (IdentityPicker single-select mode) OR address paste toggle; note field; shows computed amount (escrow total − fee, read-only). Submit: `buildProposal` → `signProposal` (own sig immediately) → fan out proposal + own signature to all parties → dispatch local echoes.
- [ ] **Step 3:** `ProposalPanel`: note, proposer AvatarChip, `OutputList` (decoded outputs: address or "derived key for <AvatarChip>", sats), per-controller signature status row (✓ signed / awaiting / ✗ vetoed with reason), SigRing (verified count / threshold). Actions for own pending state: **Sign** (signProposal → fan out → echo) and **Veto** (reason prompt → fan out → echo). When `readyToFinalize`: proposer sees auto-finalize on arrival of threshold-th sig (effect in panel: if proposer===ownKey && ready && status open → finalize once, guard with useRef); others see "Finalize & broadcast" button. Finalize: `finalizeProposal` → fan out `finalized` → echo. Vetoed/finalized panels render locked with status banner.
- [ ] **Step 4:** Cancel action: `cancelEscrow` → fan out `cancelled` → echo → status updates.
- [ ] **Step 5:** Mobile polish pass on these screens: action buttons in a sticky bottom bar `@media (max-width: 640px)`, panels full-bleed with 12px gutters, no horizontal scroll at 360px width. `npm run build` passes; `npm test` all green.
- [ ] **Step 6:** Commit `feat: escrow detail with propose, sign, veto, finalize, cancel`.

---

### Task 11: Final verification + README

**Files:** Create: `README.md`

- [ ] **Step 1:** `npm test` all green; `npm run build` clean; `npx tsc --noEmit` clean.
- [ ] **Step 2:** `npm run preview` + check the app serves (curl the index, expect 200 and `<title>Crowd`).
- [ ] **Step 3:** README: what Crowd is, the script (locking diagram from spec), the message protocol table, how to run (`npm i && npm run dev`), wallet requirement (BRC-100 e.g. Metanet Desktop), MessageBox host config, security notes (veto is cooperative not consensus; finalize race is benign — same input, one tx wins).
- [ ] **Step 4:** Commit `docs: README` .
