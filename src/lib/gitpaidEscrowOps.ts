/**
 * GitPaid escrow operations (TR-008/TR-011, FR-011/FR-017/FR-021).
 *
 * Thin duplicated wrappers around the Crowd engine flow (P1-7, ADR-002):
 * GitPaid traffic gets its OWN basket and OWN MessageBox box so it never
 * commingles with a user's personal Crowd escrows — engine constants are
 * never parameterized in-place, engine files are never edited.
 *
 * What differs from `escrow.ts`:
 *   - GitPaidEscrow.lock (in-script issue binding, 1-of-1 capable) instead
 *     of CrowdEscrow.lock
 *   - basket GITPAID_BASKET instead of 'crowd escrow' (cancel looks up the
 *     SAME constant — TC-016 pins this coupling)
 *   - creations AND spends are submitted to the overlay (D10): create →
 *     tm_gitpaid admits; finalize/cancel → tm_gitpaid evicts
 *
 * What is reused verbatim from the engine: BRC-42/29 derivation parameters,
 * proposal building, signing, signature verification, finalize and the
 * sighash machinery — a GitPaidInvite is a valid InviteMsg, so every
 * downstream engine function accepts it unchanged.
 */
import {
  Transaction,
  PublicKey,
  UnlockingScript,
  P2PKH,
  Utils,
  Random,
  Hash,
  type WalletInterface,
} from '@bsv/sdk'
import { STANDARD_PAYMENT_MESSAGEBOX } from '@bsv/message-box-client'
import type { InviteMsg, ProposalMsg } from './protocol'
import { MULTISIG_PROTOCOL, BRC29_PROTOCOL } from './protocol'
import {
  verifySignature,
  proposalTx,
  escrowInputIndex,
  escrowLockingScript,
} from './escrow'
import { CrowdEscrow, SIGHASH_SCOPE_SINGLE_ACP } from './CrowdEscrow'
import { GitPaidEscrow } from './GitPaidEscrow'
import type { IssueBinding } from './binding'
import { wallet as defaultWallet } from './wallet'

export const GITPAID_BASKET = 'gitpaid escrow'
export const GITPAID_BOX = 'gitpaid'
export const TM_GITPAID = 'tm_gitpaid'

/** An InviteMsg carrying its issue binding — valid input to every engine fn. */
export interface GitPaidInvite extends InviteMsg {
  binding: IssueBinding
}

export interface CreateGitPaidEscrowParams {
  satoshis: number
  threshold: number
  /** EXCLUDING self; sponsor-only default = []. */
  controllerIdentityKeys: string[]
  binding: IssueBinding
}

/**
 * Create + fund a GitPaid bounty escrow (FR-011/FR-014).
 * Mirrors `createEscrow` (escrow.ts) with the GitPaid template + basket.
 */
export async function createGitPaidEscrow (
  p: CreateGitPaidEscrowParams,
  wallet: WalletInterface = defaultWallet,
): Promise<GitPaidInvite> {
  const ownKeyResult = await wallet.getPublicKey({ identityKey: true })
  const ownKey = ownKeyResult.publicKey

  const keyID = Utils.toBase64(Random(16))
  const controllers = [...new Set([ownKey, ...p.controllerIdentityKeys])]

  const pubkeyResults = await Promise.all(
    controllers.map(identityKey =>
      wallet.getPublicKey({
        protocolID: MULTISIG_PROTOCOL,
        keyID,
        counterparty: identityKey === ownKey ? 'self' : identityKey,
      }),
    ),
  )
  const pubkeys = pubkeyResults.map(r => r.publicKey)
  const pubKeyObjects = pubkeys.map(pk => PublicKey.fromString(pk))

  const prefix = Utils.toBase64(Random(16))
  const suffix = Utils.toBase64(Random(16))
  const refundResult = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${prefix} ${suffix}`,
    counterparty: 'self',
  })
  const refundPub = PublicKey.fromString(refundResult.publicKey)
  const refundPkh = Utils.toHex(Hash.hash160(refundPub.toDER() as number[]))

  const lock = GitPaidEscrow.lock(pubKeyObjects, p.threshold, refundPub, p.binding)

  const result = await wallet.createAction({
    description: 'Post GitPaid bounty',
    outputs: [
      {
        lockingScript: lock.toHex(),
        satoshis: p.satoshis,
        outputDescription: 'GitPaid bounty escrow',
        basket: GITPAID_BASKET,
        customInstructions: JSON.stringify({
          keyID,
          refund: { prefix, suffix },
          controllers,
          threshold: p.threshold,
          binding: p.binding,
        }),
      },
    ],
    options: { randomizeOutputs: false },
  })

  if (result.tx == null) {
    throw new Error('Wallet did not return the transaction BEEF for the bounty escrow')
  }
  const fundingTx = Transaction.fromAtomicBEEF(result.tx)
  const txid = result.txid ?? fundingTx.id('hex')
  const lockHex = lock.toHex()
  const vout = fundingTx.outputs.findIndex(o => o.lockingScript.toHex() === lockHex)
  if (vout === -1) {
    throw new Error('Bounty escrow output not found in the wallet-built transaction')
  }

  return {
    type: 'invite',
    escrowId: `${txid}.${vout}`,
    beef: Utils.toHex(result.tx),
    satoshis: p.satoshis,
    threshold: p.threshold,
    keyID,
    originator: ownKey,
    controllers,
    pubkeys,
    refundPkh,
    name: `${p.binding.slug}#${p.binding.issueNumber}`,
    createdAt: Date.now(),
    binding: p.binding,
  }
}

/**
 * Submit a transaction to the GitPaid overlay topic (BRC-22). Used for
 * creations (admittance) AND spends (eviction) — D10.
 */
export async function submitToOverlay (
  overlayUrl: string,
  beef: number[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn(`${overlayUrl.replace(/\/$/, '')}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-topics': JSON.stringify([TM_GITPAID]),
    },
    body: new Uint8Array(beef),
  })
  if (!res.ok) {
    throw new Error(`overlay submit failed: HTTP ${res.status}`)
  }
}

/**
 * Optional payment-token sender so the recipient's wallet can internalize the
 * payout (Crowd's peer-pay pattern). The CLI passes a MessageBoxClient.sendMessage
 * bound to the recipient's STANDARD_PAYMENT_MESSAGEBOX. Kept as a callback so
 * this engine-layer file never constructs a relay client.
 */
export type PaymentNotifier = (args: { recipient: string, messageBox: string, body: string }) => Promise<unknown>

/**
 * Release a 1-of-1 bounty to a claimant (FR-021/FR-022): propose → self-sign
 * → broadcast in one call, against the INJECTED wallet.
 *
 * Why this doesn't delegate to the engine's buildProposal/signProposal/
 * finalizeProposal: those bind to the `@engine/wallet` module singleton
 * (`WalletClient('auto', …)`, Metanet-Desktop :3321). GitPaid's wallet is
 * bsv-wallet-cli on :3322 (ADR-004) — a DIFFERENT wallet, different keys.
 * The live system test caught the resulting signature mismatch. The pure
 * helpers (proposalTx / escrowInputIndex / escrowLockingScript /
 * verifySignature) take no wallet and ARE reused; only the three
 * wallet-touching steps are reimplemented here, wallet-injected.
 *
 * Multi-controller escrows release through the normal Crowd coordination flow
 * (proposals + N signatures over MessageBox).
 */
export async function releaseSoloBounty (
  invite: GitPaidInvite,
  recipientIdentityKey: string,
  opts: { wallet?: WalletInterface, note?: string, notifyPayment?: PaymentNotifier, feeSats?: number } = {},
): Promise<{ txid: string }> {
  if (invite.threshold !== 1 || invite.controllers.length !== 1) {
    throw new Error(
      'releaseSoloBounty only handles 1-of-1 escrows — multi-controller release goes through proposal coordination',
    )
  }
  const wallet = opts.wallet ?? defaultWallet
  const ownKey = (await wallet.getPublicKey({ identityKey: true })).publicKey

  // ── 1. Build the proposal skeleton: escrow input + BRC-29 recipient output ──
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const derived = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey,
  })
  const recipientLock = new P2PKH().lock(PublicKey.fromString(derived.publicKey).toAddress())

  // Fee comes out of the bounty (the escrow output self-funds the spend).
  // bsv-wallet-cli's createAction does not credit a foreign escrow input's
  // value toward outputs (the live system test proved this — it tried to
  // fund the full payout from the sponsor's own balance), so GitPaid builds,
  // signs, and broadcasts the release tx directly: escrow in → payout out,
  // payout = satoshis − fee, no wallet-funded inputs, no change.
  const feeSats = opts.feeSats ?? 50
  const payout = invite.satoshis - feeSats
  if (payout <= 0) throw new Error(`releaseSoloBounty: bounty ${invite.satoshis} sats too small to cover the ${feeSats}-sat fee`)

  const fundingTx = Transaction.fromAtomicBEEF(Utils.toArray(invite.beef, 'hex'))
  const vout = Number(invite.escrowId.split('.')[1])
  const skeleton = new Transaction()
  skeleton.addInput({ sourceTransaction: fundingTx, sourceOutputIndex: vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  skeleton.addOutput({ lockingScript: recipientLock, satoshis: payout })

  const proposal: ProposalMsg = {
    type: 'proposal',
    escrowId: invite.escrowId,
    proposalId: skeleton.id('hex'),
    rawTx: skeleton.toHex(),
    note: opts.note ?? 'GitPaid bounty release',
    proposer: ownKey,
    recipient: { identityKey: recipientIdentityKey, derivationPrefix, derivationSuffix },
    createdAt: Date.now(),
  }

  // ── 2. Sign the escrow input with our multisig key (INJECTED wallet) ──
  const tx = proposalTx(invite, proposal)
  const lockScript = escrowLockingScript(invite)
  const inputIdx = escrowInputIndex(invite, tx)
  const hash = CrowdEscrow.sighash(tx, inputIdx, lockScript, invite.satoshis, SIGHASH_SCOPE_SINGLE_ACP)
  const sigResult = await wallet.createSignature({
    hashToDirectlySign: hash,
    protocolID: MULTISIG_PROTOCOL,
    keyID: invite.keyID,
    counterparty: 'self', // 1-of-1: originator signs as self
  })
  const sigHex = Utils.toHex(CrowdEscrow.toChecksigFormat(sigResult.signature, SIGHASH_SCOPE_SINGLE_ACP))

  // Self-check before broadcast — the live test's lesson: prove it, don't assume.
  if (!verifySignature(invite, proposal, ownKey, sigHex)) {
    throw new Error('releaseSoloBounty: own signature failed verification — wallet/key mismatch')
  }

  // ── 3. Attach the unlock + broadcast directly (escrow self-funds) ──
  const pubKeyObjects = invite.pubkeys.map(p => PublicKey.fromString(p))
  tx.inputs[inputIdx].unlockingScript = CrowdEscrow.unlockMultisig([Utils.toArray(sigHex, 'hex')], pubKeyObjects)

  const bcast = await tx.broadcast()
  if (bcast.status === 'error') {
    throw new Error(`releaseSoloBounty: broadcast failed — ${bcast.description ?? bcast.code ?? 'unknown'}`)
  }
  const txid = bcast.txid ?? tx.id('hex')

  // ── 4. Notify the recipient's payment inbox so `gitpaid receive` lands it ──
  if (opts.notifyPayment !== undefined) {
    await opts.notifyPayment({
      recipient: recipientIdentityKey,
      messageBox: STANDARD_PAYMENT_MESSAGEBOX,
      body: JSON.stringify({
        customInstructions: { derivationPrefix, derivationSuffix },
        transaction: tx.toAtomicBEEF(),
        amount: payout,
      }),
    }).catch(() => {})
  }

  return { txid }
}

/**
 * Cancel a GitPaid bounty via the refund path. Mirrors `cancelEscrow`
 * (escrow.ts) against GITPAID_BASKET — the duplication exists because the
 * engine hardcodes its basket (P1-7); TC-016 pins both sides to the same
 * constant so they can never drift apart.
 */
export async function cancelGitPaidEscrow (
  invite: GitPaidInvite,
  wallet: WalletInterface = defaultWallet,
): Promise<string> {
  const listResult = await wallet.listOutputs({
    basket: GITPAID_BASKET,
    includeCustomInstructions: true,
    limit: 1000,
  })

  const output = listResult.outputs.find(o => o.outpoint === invite.escrowId)
  if (output === undefined) {
    throw new Error('Only the bounty sponsor can cancel: escrow output not found in wallet')
  }

  const instructions = JSON.parse(output.customInstructions ?? '{}') as {
    refund: { prefix: string, suffix: string }
  }
  const { prefix, suffix } = instructions.refund

  const refundResult = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${prefix} ${suffix}`,
    counterparty: 'self',
  })
  const refundPub = PublicKey.fromString(refundResult.publicKey)

  const createResult = await wallet.createAction({
    description: 'Cancel GitPaid bounty',
    inputBEEF: Utils.toArray(invite.beef, 'hex'),
    inputs: [
      {
        outpoint: invite.escrowId,
        inputDescription: 'Bounty escrow being cancelled',
        unlockingScriptLength: CrowdEscrow.estimateCancelUnlockLength(),
      },
    ],
    options: { signAndProcess: false, randomizeOutputs: false },
  })

  const { signableTransaction } = createResult
  if (signableTransaction === undefined) {
    throw new Error('cancelGitPaidEscrow: expected signableTransaction from createAction')
  }

  const parsedTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
  const [escrowTxid, voutStr] = invite.escrowId.split('.')
  const escrowVout = Number(voutStr)

  let inputIdx = -1
  for (let i = 0; i < parsedTx.inputs.length; i++) {
    const inp = parsedTx.inputs[i]
    const inTxid = inp.sourceTXID ?? inp.sourceTransaction?.id('hex')
    if (inTxid === escrowTxid && inp.sourceOutputIndex === escrowVout) {
      inputIdx = i
      break
    }
  }
  if (inputIdx === -1) {
    throw new Error('cancelGitPaidEscrow: could not locate escrow input in signable tx')
  }

  const fundingTx = Transaction.fromAtomicBEEF(Utils.toArray(invite.beef, 'hex'))
  const lockScript = fundingTx.outputs[escrowVout].lockingScript
  const hash = CrowdEscrow.sighash(parsedTx, inputIdx, lockScript, invite.satoshis)

  const sigResult = await wallet.createSignature({
    hashToDirectlySign: hash,
    protocolID: BRC29_PROTOCOL,
    keyID: `${prefix} ${suffix}`,
    counterparty: 'self',
  })

  const unlockScript = CrowdEscrow.unlockCancel(
    CrowdEscrow.toChecksigFormat(sigResult.signature),
    refundPub,
  )

  const signResult = await wallet.signAction({
    spends: {
      [inputIdx]: { unlockingScript: unlockScript.toHex() },
    },
    reference: signableTransaction.reference,
  })

  if (signResult.txid !== undefined) return signResult.txid
  const finalTx = Transaction.fromAtomicBEEF(signResult.tx!)
  return finalTx.id('hex')
}
