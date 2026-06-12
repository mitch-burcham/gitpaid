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
  LockingScript,
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
 * Release a 1-of-1 bounty to a claimant (FR-021/FR-022).
 *
 * This mirrors Crowd's `escrow.ts` finalizeProposal LINE-FOR-LINE — the
 * working professional flow: build a BRC-29 recipient output, sign the escrow
 * input (SIGHASH_SINGLE|ANYONECANPAY), then `wallet.createAction` with the
 * escrow input + recipient output. The wallet adds funding inputs (it pays the
 * network fee) and change, broadcasts, and returns the FINAL signed tx as
 * `result.tx`. The payment token carries THAT `result.tx` — never a re-
 * serialized object — so the recipient internalizes the exact broadcast tx.
 *
 * The ONLY change from Crowd: the wallet + relay are injected (Crowd's engine
 * binds a module singleton at :3321; GitPaid's wallet is bsv-wallet-cli at
 * :3322, ADR-004). Logic is otherwise identical.
 */
export async function releaseSoloBounty (
  invite: GitPaidInvite,
  recipientIdentityKey: string,
  opts: { wallet?: WalletInterface, note?: string, notifyPayment?: PaymentNotifier } = {},
): Promise<{ txid: string, spendBeef?: number[] }> {
  if (invite.threshold !== 1 || invite.controllers.length !== 1) {
    throw new Error(
      'releaseSoloBounty only handles 1-of-1 escrows — multi-controller release goes through proposal coordination',
    )
  }
  const wallet = opts.wallet ?? defaultWallet
  const ownKey = (await wallet.getPublicKey({ identityKey: true })).publicKey

  // ── buildProposal (escrow.ts): BRC-29 recipient output, full escrow amount ──
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const derived = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: recipientIdentityKey,
  })
  const recipientLock = new P2PKH().lock(PublicKey.fromString(derived.publicKey).toAddress())

  const fundingTx = Transaction.fromAtomicBEEF(Utils.toArray(invite.beef, 'hex'))
  const vout = Number(invite.escrowId.split('.')[1])
  const skeleton = new Transaction()
  skeleton.addInput({ sourceTransaction: fundingTx, sourceOutputIndex: vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  skeleton.addOutput({ lockingScript: recipientLock, satoshis: invite.satoshis })

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

  // ── signProposal (escrow.ts): SIGHASH_SINGLE|ANYONECANPAY over the escrow input ──
  const tx = proposalTx(invite, proposal)
  const lockScript = escrowLockingScript(invite)
  const hash = CrowdEscrow.sighash(tx, escrowInputIndex(invite, tx), lockScript, invite.satoshis, SIGHASH_SCOPE_SINGLE_ACP)
  const sigResult = await wallet.createSignature({
    hashToDirectlySign: hash,
    protocolID: MULTISIG_PROTOCOL,
    keyID: invite.keyID,
    counterparty: 'self', // 1-of-1: originator signs as self
  })
  const sigHex = Utils.toHex(CrowdEscrow.toChecksigFormat(sigResult.signature, SIGHASH_SCOPE_SINGLE_ACP))
  if (!verifySignature(invite, proposal, ownKey, sigHex)) {
    throw new Error('releaseSoloBounty: own signature failed verification — wallet/key mismatch')
  }

  // ── finalizeProposal (escrow.ts): createAction broadcasts; result.tx is the
  //    real signed BEEF the recipient internalizes. Wallet funds the fee + change. ──
  const unlockScript = CrowdEscrow.unlockMultisig([Utils.toArray(sigHex, 'hex')], invite.pubkeys.map(p => PublicKey.fromString(p)))
  const recipientOutput = tx.outputs[0]

  const result = await wallet.createAction({
    description: 'Release GitPaid bounty',
    inputBEEF: Utils.toArray(invite.beef, 'hex'),
    inputs: [{ outpoint: invite.escrowId, inputDescription: 'Bounty escrow release', unlockingScript: unlockScript.toHex(), sequenceNumber: 0xffffffff }],
    outputs: [{ lockingScript: (recipientOutput.lockingScript as LockingScript).toHex(), satoshis: recipientOutput.satoshis ?? invite.satoshis, outputDescription: 'Bounty payout' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  })

  const txid = result.txid ?? (result.tx != null ? Transaction.fromAtomicBEEF(result.tx).id('hex') : undefined)
  if (txid === undefined) throw new Error('releaseSoloBounty: wallet returned no txid for the release')

  // Payment token carries result.tx (the wallet's signed, broadcast BEEF) —
  // exactly as Crowd does — so the recipient internalizes the real tx.
  if (opts.notifyPayment !== undefined && result.tx != null) {
    await opts.notifyPayment({
      recipient: recipientIdentityKey,
      messageBox: STANDARD_PAYMENT_MESSAGEBOX,
      body: JSON.stringify({
        customInstructions: { derivationPrefix, derivationSuffix },
        transaction: result.tx,
        amount: invite.satoshis,
      }),
    }).catch(() => {})
  }

  return { txid, spendBeef: result.tx != null ? Array.from(result.tx) : undefined }
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
