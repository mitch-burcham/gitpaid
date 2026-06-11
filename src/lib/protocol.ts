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

/**
 * Encode an InviteMsg as a URL-safe base64 string (no padding) so it can be
 * embedded in a query parameter.  We encode the JSON as UTF-8 bytes then
 * base64-encode, replacing the standard `+/=` characters with `-_` and
 * stripping padding so the string never needs percent-encoding.
 */
export function encodeInvite (i: InviteMsg): string {
  const json = JSON.stringify(i)
  // Encode the UTF-8 bytes via encodeURIComponent → unescape trick so that
  // multi-byte characters are handled correctly by btoa.
  const b64 = btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_m, p1: string) =>
    String.fromCharCode(parseInt(p1, 16))
  ))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode a URL-safe base64 string back to an InviteMsg.
 * Returns undefined on any error, or if the decoded value is not a valid
 * CrowdMessage with type === 'invite'.
 */
export function decodeInvite (s: string): InviteMsg | undefined {
  try {
    // Restore standard base64 characters and add back padding.
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '==='.slice((b64.length + 3) % 4 || 0)
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    const parsed: unknown = JSON.parse(json)
    if (!isCrowdMessage(parsed) || parsed.type !== 'invite') return undefined
    return parsed
  } catch {
    return undefined
  }
}
