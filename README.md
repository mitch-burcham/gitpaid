# Crowd — N-of-M Escrow on BSV

Crowd is a browser-only React app that lets anyone lock BSV into an on-chain N-of-M multisig escrow, assign a group of controllers by identity, and coordinate the release (or cancellation) entirely through encrypted peer-to-peer messages — no custom backend required. The originator picks M controllers, sets a threshold N, funds the escrow from their BRC-100 wallet, and shares a link. Each controller can propose a recipient, sign or veto proposals, and the escrow broadcasts automatically once N valid signatures are collected. The originator can unilaterally cancel at any time, recovering funds back to their own wallet.

---

## How it works

### Locking script

The escrow output uses a custom `CrowdEscrow` script template with two spending paths:

```
OP_IF
  OP_DUP OP_HASH160 <hash160(concat(pubkeys))> OP_EQUALVERIFY
  <threshold> OP_SWAP
  (<33> OP_SPLIT) × (total−1)
  <total> OP_CHECKMULTISIG
OP_ELSE
  OP_DUP OP_HASH160 <hash160(refundPubKey)> OP_EQUALVERIFY OP_CHECKSIG
OP_ENDIF
```

**Multisig path** (`OP_1` selector): authenticates the concatenated-pubkeys blob against a committed hash, splits it into individual 33-byte compressed keys, then runs `OP_CHECKMULTISIG`. Unlocking: `OP_0 <sig_0> … <sig_{N-1}> <concat(pubkeys)> OP_1`.

**Cancel path** (`OP_0` selector): standard P2PKH check against the originator's derived refund key. Unlocking: `<sig> <refundPubKey> OP_0`.

Sighash: `SIGHASH_ALL | SIGHASH_FORKID`, subscript = full locking script.

### Key derivation

**Multisig keys (BRC-42):** when creating an escrow, the originator calls `wallet.getPublicKey({ protocolID: [1, 'multi sig brc29'], keyID, counterparty: controllerIdentityKey })` for each controller, using a random base64 `keyID` nonce generated per escrow. The originator's own key uses `counterparty: 'self'`. Controllers later sign with `wallet.createSignature({ protocolID: [1, 'multi sig brc29'], keyID, counterparty: originatorIdentityKey, hashToDirectlySign })`, exploiting BRC-42 symmetry so both sides derive the same shared key.

**Refund key (BRC-29):** `wallet.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: \`${prefix} ${suffix}\`, counterparty: 'self' })` where `prefix` and `suffix` are random base64 nonces stored in the wallet's `customInstructions` for the escrow output (basket `crowd escrow`). The cancel spend re-derives the same key; funds return as wallet change.

### Coordination via MessageBox

All messages are JSON (auto-encrypted per recipient by `@bsv/message-box-client`), sent fan-out to every participant (originator + all controllers). The host is `https://gmb.bsvblockchain.tech`, box name `crowd`.

| Message type  | Purpose |
|---------------|---------|
| `invite`      | Escrow created — carries `escrowId` (`txid.vout`), AtomicBEEF of the funding tx, `satoshis`, `threshold`, `keyID`, controller identity keys, derived multisig pubkeys, and the refund PKH. |
| `proposal`    | Spend draft — carries the unsigned spending transaction (`rawTx` hex), proposed outputs with notes, and optional BRC-29 derivation info for the recipient. |
| `signature`   | A single controller's checksig-format ECDSA signature over the proposal sighash. |
| `veto`        | Any controller rejects the proposal (optional reason). UI removes the proposal; no script effect. |
| `finalized`   | Broadcast succeeded — carries the resulting `txid`. |
| `cancelled`   | Originator cancelled the escrow via the refund path — carries the `txid`. |

Clients load state on startup via `listMessages({ messageBox: 'crowd' })` and stay live with `listenForLiveMessages`. Acknowledged messages are persisted to `localStorage` keyed by the user's own identity key.

### Share links

Invite link: `/#/e/<escrowId>?d=<base64url(invite payload)>` — anyone with the link and a wallet can view the escrow; only listed controllers can sign. The payload embeds the funding transaction's BEEF, so links for transactions with deep unconfirmed ancestry can grow to several KB and may exceed URL limits in some contexts (messengers, QR codes); controllers always also receive the invite via MessageBox, so the link is a convenience, not the only channel.

Proposal link: `/#/e/<escrowId>/p/<proposalId>` — data is resolved from the holder's inbox or local store.

---

## Running

```bash
npm i
npm run dev
```

A [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md)-compatible wallet must be running locally (e.g. [Metanet Desktop](https://metanet.io/)). The app connects to it automatically; a full-screen gate appears until the wallet is reachable.

Run the test suite:

```bash
npm test
```

---

## Security notes

- **Veto is cooperative, not script-enforced.** Any controller can broadcast a finalize transaction even after a veto message — the veto is a UI-level consensus signal only. The script only enforces that N valid signatures are present.
- **Finalize races are benign.** If multiple clients observe the threshold simultaneously and each broadcasts, they are all spending the same UTXO: only one will be accepted by the network. The first confirmed broadcast wins; the rest are double-spend failures.
- **The refund path is originator-only.** The cancel unlocking script requires a signature from the BRC-29 key derived to `counterparty: 'self'` with nonces stored only in the originator's wallet. No other party can produce a valid cancel signature.
- **Signatures are verified client-side before counting.** `verifySignature` in `escrow.ts` checks each incoming `signature` message against the expected BRC-42 derived public key before including it in the threshold count. Invalid or mis-attributed signatures are silently ignored.

---

## Project structure

```
src/
  lib/
    CrowdEscrow.ts    # ScriptTemplate: lock, unlockMultisig, unlockCancel, sighash helper
    escrow.ts         # createEscrow, buildProposal, signProposal, verifySignature, finalizeProposal, cancelEscrow
    protocol.ts       # CrowdMessage types, type guards, invite encode/decode, protocol constants
    store.ts          # Event-sourced reducer over CrowdMessage; localStorage persistence
    messages.ts       # MessageBoxClient wrapper: 'crowd' box, fan-out send, live listener
    identity.ts       # IdentityClient wrappers + cache
    wallet.ts         # Singleton WalletClient, getOwnIdentityKey
  hooks/
    useCrowd.tsx      # Context provider + hook wiring store, wallet, and messagebox together
  pages/
    Dashboard.tsx     # List of active escrows
    CreateEscrow.tsx  # New-escrow form: identity picker, threshold, amount
    EscrowDetail.tsx  # Escrow view: proposals, signature progress, cancel button
  components/
    IdentityPicker.tsx    # Typeahead identity search
    AvatarChip.tsx        # Avatar + name badge for an identity key
    SigRing.tsx           # Circular progress ring showing k-of-N signatures collected
    EscrowCard.tsx        # Summary card for Dashboard
    OutputList.tsx        # Decoded proposal outputs display
    ProposalPanel.tsx     # Proposal detail with sign / veto / finalize actions
    ProposeForm.tsx       # Form to build a new spending proposal
    ShareLink.tsx         # Copyable share link for invites
    WalletGate.tsx        # Full-screen wallet connection guard
  theme.css               # Design tokens and global styles
```
