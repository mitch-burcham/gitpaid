import {
  Transaction,
  LockingScript,
  UnlockingScript,
  PublicKey,
  Signature,
  BigNumber,
  ECDSA,
  Utils,
  Random,
  Hash,
  P2PKH,
  ARC,
} from '@bsv/sdk'
import type { InviteMsg, ProposalMsg } from './protocol'
import { MULTISIG_PROTOCOL, BRC29_PROTOCOL } from './protocol'
import type { EscrowState } from './store'
import { CrowdEscrow } from './CrowdEscrow'
import { wallet, getOwnIdentityKey } from './wallet'

// ---------------------------------------------------------------------------
// Public parameter interfaces
// ---------------------------------------------------------------------------

export interface CreateEscrowParams {
  name: string
  satoshis: number
  threshold: number
  controllerIdentityKeys: string[]  // EXCLUDING self; self is prepended inside
}

export interface BuildProposalParams {
  invite: InviteMsg
  note: string
  recipientIdentityKey?: string   // BRC-29 derive when set
  recipientAddress?: string       // raw P2PKH fallback
}

// ---------------------------------------------------------------------------
// Pure helpers — no wallet required
// ---------------------------------------------------------------------------

/**
 * Reconstruct the proposal Transaction with sourceTransaction attached. Pure.
 */
export function proposalTx (invite: InviteMsg, proposal: ProposalMsg): Transaction {
  const fundingTx = Transaction.fromAtomicBEEF(Utils.toArray(invite.beef, 'hex'))
  const tx = Transaction.fromHex(proposal.rawTx)
  tx.inputs[0].sourceTransaction = fundingTx
  return tx
}

/**
 * Return the locking script from the funding transaction's escrow output. Pure.
 */
export function escrowLockingScript (invite: InviteMsg): LockingScript {
  const fundingTx = Transaction.fromAtomicBEEF(Utils.toArray(invite.beef, 'hex'))
  const vout = Number(invite.escrowId.split('.')[1])
  return fundingTx.outputs[vout].lockingScript as LockingScript
}

/**
 * Pure: verify sigHex against the controller's derived pubkey for this proposal.
 * sigHex is in checksig format (DER + sighash flag byte appended).
 */
export function verifySignature (
  invite: InviteMsg,
  proposal: ProposalMsg,
  signer: string,
  sigHex: string,
): boolean {
  try {
    const idx = invite.controllers.indexOf(signer)
    if (idx === -1) return false

    const bytes = Utils.toArray(sigHex, 'hex')
    // Strip the last byte (sighash flag) to get DER-encoded sig
    const der = bytes.slice(0, bytes.length - 1)
    const sig = Signature.fromDER(der)

    const tx = proposalTx(invite, proposal)
    const lockScript = escrowLockingScript(invite)
    const hash = CrowdEscrow.sighash(tx, 0, lockScript, invite.satoshis)

    const pubKey = PublicKey.fromString(invite.pubkeys[idx])
    // ECDSA.verify expects (BigNumber, Signature, Point) — PublicKey extends Point
    return ECDSA.verify(new BigNumber(hash), sig, pubKey)
  } catch {
    return false
  }
}

/**
 * Pure: true when ≥ threshold verified signatures are present for the proposal.
 */
export function readyToFinalize (
  invite: InviteMsg,
  es: EscrowState,
  proposalId: string,
): boolean {
  const ps = es.proposals[proposalId]
  if (ps === undefined) return false

  let count = 0
  for (const [signer, sigHex] of Object.entries(ps.signatures)) {
    if (verifySignature(invite, ps.proposal, signer, sigHex)) {
      count++
    }
  }
  return count >= invite.threshold
}

// ---------------------------------------------------------------------------
// Wallet-dependent functions (not unit-tested; must compile)
// ---------------------------------------------------------------------------

/**
 * Create a new N-of-M multisig escrow funded from the wallet.
 */
export async function createEscrow (p: CreateEscrowParams): Promise<InviteMsg> {
  const ownKey = await getOwnIdentityKey()

  // Derive nonce keyID
  const keyID = Utils.toBase64(Random(16))

  // Build controllers list: self first, then others, deduplicated
  const controllersRaw = [ownKey, ...p.controllerIdentityKeys]
  const controllers = [...new Set(controllersRaw)]

  // Derive a multisig pubkey for each controller
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
  const pubKeyObjects = pubkeys.map(p => PublicKey.fromString(p))

  // Derive BRC-29 refund key
  const prefix = Utils.toBase64(Random(16))
  const suffix = Utils.toBase64(Random(16))
  const refundResult = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${prefix} ${suffix}`,
    counterparty: 'self',
  })
  const refundPub = PublicKey.fromString(refundResult.publicKey)
  const refundPkh = Utils.toHex(Hash.hash160(refundPub.toDER() as number[]))

  // Build the locking script
  const lock = CrowdEscrow.lock(pubKeyObjects, p.threshold, refundPub)

  // Create the funding action
  const result = await wallet.createAction({
    description: 'Create crowd escrow',
    outputs: [
      {
        lockingScript: lock.toHex(),
        satoshis: p.satoshis,
        outputDescription: 'Crowd escrow',
        basket: 'crowd escrow',
        customInstructions: JSON.stringify({
          keyID,
          refund: { prefix, suffix },
          controllers,
          threshold: p.threshold,
        }),
      },
    ],
    options: { randomizeOutputs: false },
  })

  if (result.tx == null) {
    throw new Error('Wallet did not return the transaction BEEF for the escrow')
  }
  const fundingTx = Transaction.fromAtomicBEEF(result.tx)
  const txid = result.txid ?? fundingTx.id('hex')
  const beef = Utils.toHex(result.tx)

  // Don't assume the escrow landed at vout 0 — find the output whose locking
  // script matches, in case the wallet reorders outputs despite randomizeOutputs.
  const lockHex = lock.toHex()
  const vout = fundingTx.outputs.findIndex(o => o.lockingScript.toHex() === lockHex)
  if (vout === -1) {
    throw new Error('Escrow output not found in the wallet-built transaction')
  }

  const escrowId = `${txid}.${vout}`

  return {
    type: 'invite',
    escrowId,
    beef,
    satoshis: p.satoshis,
    threshold: p.threshold,
    keyID,
    originator: ownKey,
    controllers,
    pubkeys,
    refundPkh,
    name: p.name,
    createdAt: Date.now(),
  }
}

/**
 * Build a spending proposal from an existing escrow invite.
 */
export async function buildProposal (p: BuildProposalParams): Promise<ProposalMsg> {
  const { invite, note } = p
  const ownKey = await getOwnIdentityKey()

  const fundingTx = Transaction.fromAtomicBEEF(Utils.toArray(invite.beef, 'hex'))
  const vout = Number(invite.escrowId.split('.')[1])

  // Estimate fee
  const txSizeEstimate =
    10 + 40 +
    CrowdEscrow.estimateMultisigUnlockLength(invite.threshold, invite.pubkeys.length) +
    34
  const fee = Math.max(2, Math.ceil(txSizeEstimate / 1000))
  const outputSatoshis = invite.satoshis - fee

  // Build the proposal tx
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: fundingTx,
    sourceOutputIndex: vout,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  })

  let recipient: ProposalMsg['recipient']

  if (p.recipientIdentityKey !== undefined) {
    // BRC-29 payment derivation
    const derivationPrefix = Utils.toBase64(Random(16))
    const derivationSuffix = Utils.toBase64(Random(16))
    const derivedResult = await wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL,
      keyID: `${derivationPrefix} ${derivationSuffix}`,
      counterparty: p.recipientIdentityKey,
    })
    const derivedPub = PublicKey.fromString(derivedResult.publicKey)
    tx.addOutput({
      lockingScript: new P2PKH().lock(derivedPub.toAddress()),
      satoshis: outputSatoshis,
    })
    recipient = {
      identityKey: p.recipientIdentityKey,
      derivationPrefix,
      derivationSuffix,
    }
  } else if (p.recipientAddress !== undefined) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(p.recipientAddress),
      satoshis: outputSatoshis,
    })
  } else {
    throw new Error('buildProposal: must provide recipientIdentityKey or recipientAddress')
  }

  const proposalId = tx.id('hex')
  const rawTx = tx.toHex()

  return {
    type: 'proposal',
    escrowId: invite.escrowId,
    proposalId,
    rawTx,
    note,
    proposer: ownKey,
    ...(recipient !== undefined ? { recipient } : {}),
    createdAt: Date.now(),
  }
}

/**
 * Sign the proposal sighash with our BRC-42 multisig key and return checksig hex.
 */
export async function signProposal (invite: InviteMsg, proposal: ProposalMsg): Promise<string> {
  const ownKey = await getOwnIdentityKey()
  const tx = proposalTx(invite, proposal)
  const lockScript = escrowLockingScript(invite)
  const hash = CrowdEscrow.sighash(tx, 0, lockScript, invite.satoshis)

  const sigResult = await wallet.createSignature({
    hashToDirectlySign: hash,
    protocolID: MULTISIG_PROTOCOL,
    keyID: invite.keyID,
    // BRC-42 symmetry: originator derived each controller with counterparty=controller,
    // so controller signs with counterparty=originator, originator uses 'self'.
    counterparty: ownKey === invite.originator ? 'self' : invite.originator,
  })

  return Utils.toHex(CrowdEscrow.toChecksigFormat(sigResult.signature))
}

/**
 * Assemble verified sigs in pubkey order, attach unlocking script, broadcast.
 * Returns the transaction id.
 */
export async function finalizeProposal (
  invite: InviteMsg,
  es: EscrowState,
  proposalId: string,
): Promise<string> {
  const ps = es.proposals[proposalId]
  if (ps === undefined) throw new Error('Proposal not found')

  // Collect verified signatures in pubkey order, up to threshold
  const orderedSigs: number[][] = []
  for (const controller of invite.controllers) {
    if (orderedSigs.length >= invite.threshold) break
    const sigHex = ps.signatures[controller]
    if (sigHex === undefined) continue
    if (verifySignature(invite, ps.proposal, controller, sigHex)) {
      orderedSigs.push(Utils.toArray(sigHex, 'hex'))
    }
  }

  if (orderedSigs.length < invite.threshold) {
    throw new Error('Not enough verified signatures to finalize')
  }

  const pubKeyObjects = invite.pubkeys.map(p => PublicKey.fromString(p))
  const unlockScript = CrowdEscrow.unlockMultisig(orderedSigs, pubKeyObjects)

  const tx = proposalTx(invite, ps.proposal)
  tx.inputs[0].unlockingScript = unlockScript

  const result = await tx.broadcast(new ARC('https://arc.taal.com'))
  if (result.status === 'error') {
    throw new Error(result.description)
  }
  return tx.id('hex')
}

/**
 * Originator cancel via wallet createAction/signAction. Returns txid.
 */
export async function cancelEscrow (invite: InviteMsg): Promise<string> {
  // Find the escrow output in our wallet to retrieve refund nonces
  const listResult = await wallet.listOutputs({
    basket: 'crowd escrow',
    includeCustomInstructions: true,
    limit: 1000,
  })

  const output = listResult.outputs.find(o => o.outpoint === invite.escrowId)
  if (output === undefined) {
    throw new Error('Only the escrow creator can cancel: escrow output not found in wallet')
  }

  const instructions = JSON.parse(output.customInstructions ?? '{}') as {
    keyID: string
    refund: { prefix: string; suffix: string }
    controllers: string[]
    threshold: number
  }
  const { prefix, suffix } = instructions.refund

  // Re-derive refund pubkey
  const refundResult = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL,
    keyID: `${prefix} ${suffix}`,
    counterparty: 'self',
  })
  const refundPub = PublicKey.fromString(refundResult.publicKey)

  // Create action (no outputs — wallet claims remainder as change)
  const createResult = await wallet.createAction({
    description: 'Cancel crowd escrow',
    inputBEEF: Utils.toArray(invite.beef, 'hex'),
    inputs: [
      {
        outpoint: invite.escrowId,
        inputDescription: 'Escrow being cancelled',
        unlockingScriptLength: CrowdEscrow.estimateCancelUnlockLength(),
      },
    ],
    options: { signAndProcess: false, randomizeOutputs: false },
  })

  const { signableTransaction } = createResult
  if (signableTransaction === undefined) {
    throw new Error('cancelEscrow: expected signableTransaction from createAction')
  }

  // Parse the signable tx to find the input index for our escrow UTXO
  const parsedTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
  const escrowTxid = invite.escrowId.split('.')[0]
  const escrowVout = Number(invite.escrowId.split('.')[1])

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
    throw new Error('cancelEscrow: could not locate escrow input in signable tx')
  }

  const lockScript = escrowLockingScript(invite)
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
