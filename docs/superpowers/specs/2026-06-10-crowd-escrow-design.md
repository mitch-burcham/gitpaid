# Crowd — N-of-M Escrow on BSV — Design

Date: 2026-06-10
Status: approved (autonomous /goal mode — decisions made per directive)

## Purpose

Frontend app ("Crowd") that lets a user escrow BSV into an on-chain N-of-M
multisig contract with a cancel path, assign controllers by identity lookup,
then coordinate spending via shared links where controllers add signatures
(or veto) until threshold is met and the transaction broadcasts.

## Constraints

- Browser-only frontend. No custom backend. BRC-100 wallet (`@bsv/sdk`
  `WalletClient`) for all key operations; MessageBox
  (`https://gmb.bsvblockchain.tech`, box name `crowd`) as the only
  store-and-forward channel; URL fragment carries bootstrap data for links.
- `@bsv/sdk` ^2.1, `@bsv/message-box-client` ^2.1, React 19 + Vite + TS.
- Futuristic visual design, beautiful on mobile and desktop.

## Locking script — `CrowdEscrow` template

Based on P2MSKH (ts-templates) wrapped in a branch with a cancel path:

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

Unlocking scripts:

- Multisig path: `OP_0 <sig1> … <sigN> <concat(pubkeys)> OP_1`
- Cancel path: `<sig> <refundPubKey> OP_0`

Sighash: `SIGHASH_ALL | SIGHASH_FORKID`, subscript = full locking script.

### Key derivation

- Controller pubkeys: originator calls
  `wallet.getPublicKey({ protocolID: [1, 'multi sig brc29'], keyID, counterparty: controllerIdentityKey })`
  per controller (P2MSKH convention). `keyID` = random base64 nonce per
  escrow. Controllers later sign with
  `wallet.createSignature({ protocolID: [1, 'multi sig brc29'], keyID, counterparty: originatorIdentityKey, hashToDirectlySign })`
  (BRC-42 symmetry). The originator is always included as one of the M
  controllers (counterparty `'self'`).
- Refund key: BRC-29 style pay-to-self —
  `wallet.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${prefix} ${suffix}`, counterparty: 'self' })`
  with random prefix/suffix stored in the escrow record. Cancel spend signs
  with the same derivation; the cancel transaction's outputs go back to the
  originator's wallet (wallet change — no explicit outputs needed).

## Identity

`IdentityClient` (`@bsv/sdk`) — `resolveByAttributes` for typeahead search,
`resolveByIdentityKey` for displaying known keys (name, avatarURL, badge).
Controllers are stored as identity public keys.

## Coordination protocol — MessageBox `crowd` box

All messages are JSON bodies (auto-encrypted per recipient by the client),
sent to every involved party (originator + all controllers), fan-out per
recipient. Types (`CrowdMessage`, discriminated on `type`):

- `invite` — escrow created. `{ escrowId, outpoint, beef (hex), satoshis, threshold, keyID, originator, controllers: PubKeyHex[], pubkeys: PubKeyHex[], refundPkh (hex), createdAt }`. escrowId = funding `txid.vout`.
- `proposal` — spend draft. `{ escrowId, proposalId, rawTx (hex, unsigned), outputs: [{satoshis, lockingScript, note}], proposer, createdAt }`. proposalId = sha256(rawTx).
- `signature` — `{ escrowId, proposalId, signer, sigHex (checksig format incl. sighash byte) }`.
- `veto` — `{ escrowId, proposalId, vetoer, reason? }`. Any veto kills the proposal (UI consensus, not script-enforced).
- `finalized` — `{ escrowId, proposalId, txid }`.
- `cancelled` — `{ escrowId, txid }`.

Clients event-source state from inbox messages: `listMessages({ messageBox: 'crowd' })`
on load + `listenForLiveMessages` for live updates; processed messages are
persisted to localStorage (keyed by own identity key) and acknowledged
(server deletes them).

Share link: `/#/e/<escrowId>?d=<base64url(invite payload)>` — anyone with the
link + a wallet can view; only listed controllers can sign. Proposal links:
`/#/p/<escrowId>/<proposalId>` (data comes from holder's inbox/local store; if
absent show "waiting for proposal message" state).

## Flows

1. **Create escrow**: search & pick M controllers (self auto-included) →
   set threshold N, amount sats → `createAction` with one `CrowdEscrow`
   output, `basket: 'crowd escrow'`, `customInstructions` =
   `{keyID, pubkeys, controllers, threshold, refund: {prefix, suffix}}`,
   `randomizeOutputs: false` → send `invite` to each controller → show share
   link + escrow card.
2. **Propose transfer**: any party. Pick recipient — identity lookup → BRC-29
   derived P2PKH (with random prefix/suffix included in proposal output note
   so recipient can internalize) or raw address fallback. Build unsigned tx
   (sdk `Transaction`: input = escrow outpoint w/ sourceTransaction from BEEF;
   outputs = recipient minus fee via `tx.fee()`). Proposer adds own signature
   immediately. Fan out `proposal` + own `signature`.
3. **Sign / veto**: party opens link or inbox → renders decoded outputs,
   progress ring (k of N) → Sign: compute sighash from rawTx + locking
   script + satoshis, `createSignature`, fan out. Veto: fan out veto.
4. **Finalize**: whichever client observes ≥N valid signatures (verify each
   sig against derived pubkeys locally before counting) assembles unlocking
   script in pubkey order, attaches, broadcasts via SDK ARC/WoC broadcaster,
   fans out `finalized`. Guard: only the proposer auto-finalizes (others get
   a "Finalize" button) to reduce double-broadcast races (double-spend of
   same input is harmless — one wins).
5. **Cancel**: originator only. `createAction` with escrow input
   (`inputBEEF`, `unlockingScriptLength` for cancel path ≈ 110 bytes,
   `signAndProcess: false`) → compute sighash on the signable tx →
   `createSignature` with refund derivation → `signAction` with cancel
   unlocking script. Funds return as wallet change. Fan out `cancelled`.

## Architecture

```
src/
  lib/
    CrowdEscrow.ts    # ScriptTemplate: lock, unlockMultisig, unlockCancel, estimateLength, sighash helper
    escrow.ts         # createEscrow, buildProposal, signProposal, verifySignature, finalize, cancelEscrow
    messages.ts       # MessageBoxClient wrapper: 'crowd' box, send fan-out, listen, type guards
    store.ts          # event-sourced reducer over CrowdMessage + localStorage persistence
    identity.ts       # IdentityClient wrappers + cache
    wallet.ts         # singleton WalletClient, getOwnKey
  hooks/              # useWallet, useCrowdStore (context), useIdentitySearch
  pages/              # Dashboard, CreateEscrow, EscrowDetail, ProposalView
  components/         # IdentityPicker, AvatarChip, SigProgressRing, EscrowCard, OutputList, ShareLink
  theme.css           # design tokens
```

Each lib unit is pure-ish and testable without React. Script template gets
unit tests (vitest) covering lock/unlock both paths with local keys
(`PrivateKey`/Spend engine from sdk) — script must evaluate under
`Spend` interpreter for both branches.

## Error handling

- No wallet substrate → full-screen "connect wallet" gate (`waitForAuthentication`).
- MessageBox unreachable → banner, retry with backoff; state still renders from localStorage.
- Invalid/duplicate signatures ignored (verified against expected derived pubkeys).
- Vetoed or finalized proposals locked in UI; spent escrow detected when finalize/cancel message seen.

## Visual direction

Dark "mission control" futurism: near-black blue background, glass panels,
single cyan→violet gradient accent, Space Grotesk display + Inter body,
signature progress ring as hero element, large touch targets, bottom action
bar on mobile / side panel on desktop. Hand-rolled CSS with custom
properties; no UI framework.

## Testing

- vitest unit tests: CrowdEscrow script (both spend paths via sdk `Spend`),
  store reducer (message event-sourcing), signature verify.
- Wallet/MessageBox interactions mocked at interface level.
- Manual end-to-end with real wallet out of scope for CI.
