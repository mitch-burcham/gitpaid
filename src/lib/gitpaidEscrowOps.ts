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
  Utils,
  Random,
  Hash,
  type WalletInterface,
} from '@bsv/sdk'
import type { InviteMsg } from './protocol'
import { MULTISIG_PROTOCOL, BRC29_PROTOCOL } from './protocol'
import {
  buildProposal,
  signProposal,
  finalizeProposal,
  type BuildProposalParams,
} from './escrow'
import type { EscrowState } from './store'
import { CrowdEscrow } from './CrowdEscrow'
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
 * Release a 1-of-1 bounty to a claimant (FR-021/FR-022): the sponsor is the
 * sole controller, so propose → self-sign → finalize completes in one call.
 * Multi-controller escrows release through the normal Crowd coordination
 * flow (proposals + N signatures over MessageBox).
 */
export async function releaseSoloBounty (
  invite: GitPaidInvite,
  recipientIdentityKey: string,
  note = 'GitPaid bounty release',
): Promise<{ txid: string, rawTxBeef: string }> {
  if (invite.threshold !== 1 || invite.controllers.length !== 1) {
    throw new Error(
      'releaseSoloBounty only handles 1-of-1 escrows — multi-controller release goes through proposal coordination',
    )
  }

  const proposalParams: BuildProposalParams = { invite, note, recipientIdentityKey }
  const proposal = await buildProposal(proposalParams)
  const sigHex = await signProposal(invite, proposal)

  // Minimal EscrowState carrying just this proposal + our signature, shaped
  // for finalizeProposal's verification pass.
  const es = {
    proposals: {
      [proposal.proposalId]: {
        proposal,
        signatures: { [invite.originator]: sigHex },
        vetoes: {},
      },
    },
  } as unknown as EscrowState

  const txid = await finalizeProposal(invite, es, proposal.proposalId)
  return { txid, rawTxBeef: invite.beef }
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
