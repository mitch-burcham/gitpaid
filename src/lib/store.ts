import type { CrowdMessage, InviteMsg, ProposalMsg, PubKeyHex } from './protocol'

export interface ProposalState {
  proposal: ProposalMsg
  signatures: Record<PubKeyHex, string>   // signer -> sigHex
  vetoes: Record<PubKeyHex, string>       // vetoer -> reason ('' if none)
  status: 'open' | 'vetoed' | 'finalized'
  txid?: string
}
export interface EscrowState {
  invite: InviteMsg
  status: 'active' | 'spent' | 'cancelled'
  spentTxid?: string
  proposals: Record<string, ProposalState>
}
export interface CrowdState {
  escrows: Record<string, EscrowState>
  /** Orphan messages (e.g. a proposal whose invite hasn't arrived yet — the
   * relay deletes acknowledged messages, so they must be retained locally
   * until their parent shows up). */
  pending: CrowdMessage[]
}

export const emptyState: CrowdState = Object.freeze({
  escrows: Object.freeze({}),
  pending: Object.freeze([] as CrowdMessage[]),
}) as CrowdState

export function reduce (state: CrowdState, msg: CrowdMessage): CrowdState {
  switch (msg.type) {
    case 'invite': {
      if (state.escrows[msg.escrowId] !== undefined) return state
      return {
        ...state,
        escrows: {
          ...state.escrows,
          [msg.escrowId]: {
            invite: msg,
            status: 'active',
            proposals: {},
          },
        },
      }
    }

    case 'proposal': {
      const escrow = state.escrows[msg.escrowId]
      if (escrow === undefined) return state
      if (escrow.status !== 'active') return state
      if (escrow.proposals[msg.proposalId] !== undefined) return state
      return {
        ...state,
        escrows: {
          ...state.escrows,
          [msg.escrowId]: {
            ...escrow,
            proposals: {
              ...escrow.proposals,
              [msg.proposalId]: {
                proposal: msg,
                signatures: {},
                vetoes: {},
                status: 'open',
              },
            },
          },
        },
      }
    }

    case 'signature': {
      const escrow = state.escrows[msg.escrowId]
      if (escrow === undefined) return state
      const proposal = escrow.proposals[msg.proposalId]
      if (proposal === undefined) return state
      if (proposal.status !== 'open') return state
      if (!escrow.invite.controllers.includes(msg.signer)) return state
      return {
        ...state,
        escrows: {
          ...state.escrows,
          [msg.escrowId]: {
            ...escrow,
            proposals: {
              ...escrow.proposals,
              [msg.proposalId]: {
                ...proposal,
                signatures: {
                  ...proposal.signatures,
                  [msg.signer]: msg.sigHex,
                },
              },
            },
          },
        },
      }
    }

    case 'veto': {
      const escrow = state.escrows[msg.escrowId]
      if (escrow === undefined) return state
      const proposal = escrow.proposals[msg.proposalId]
      if (proposal === undefined) return state
      if (proposal.status !== 'open') return state
      if (!escrow.invite.controllers.includes(msg.vetoer)) return state
      return {
        ...state,
        escrows: {
          ...state.escrows,
          [msg.escrowId]: {
            ...escrow,
            proposals: {
              ...escrow.proposals,
              [msg.proposalId]: {
                ...proposal,
                status: 'vetoed',
                vetoes: {
                  ...proposal.vetoes,
                  [msg.vetoer]: msg.reason ?? '',
                },
              },
            },
          },
        },
      }
    }

    case 'finalized': {
      const escrow = state.escrows[msg.escrowId]
      if (escrow === undefined) return state
      const proposal = escrow.proposals[msg.proposalId]
      if (proposal === undefined) return state
      return {
        ...state,
        escrows: {
          ...state.escrows,
          [msg.escrowId]: {
            ...escrow,
            status: 'spent',
            spentTxid: msg.txid,
            proposals: {
              ...escrow.proposals,
              [msg.proposalId]: {
                ...proposal,
                status: 'finalized',
                txid: msg.txid,
              },
            },
          },
        },
      }
    }

    case 'cancelled': {
      const escrow = state.escrows[msg.escrowId]
      if (escrow === undefined) return state
      return {
        ...state,
        escrows: {
          ...state.escrows,
          [msg.escrowId]: {
            ...escrow,
            status: 'cancelled',
            spentTxid: msg.txid,
          },
        },
      }
    }
  }
}

const MAX_PENDING = 200

/** True when the message can't apply yet because its parent (escrow or
 * proposal) is unknown — worth retaining. False for messages that are
 * invalid, duplicate, or already applied against current state. */
function isOrphan (state: CrowdState, msg: CrowdMessage): boolean {
  switch (msg.type) {
    case 'invite':
      return false
    case 'proposal':
    case 'cancelled':
      return state.escrows[msg.escrowId] === undefined
    case 'signature':
    case 'veto':
    case 'finalized': {
      const escrow = state.escrows[msg.escrowId]
      if (escrow === undefined) return true
      return escrow.proposals[msg.proposalId] === undefined
    }
  }
}

/**
 * Pure: fold messages into state, retrying until a fixed point so
 * out-of-order delivery (signature before proposal before invite) still
 * converges. Messages that can't apply yet but reference an unknown parent
 * are kept in `state.pending` (deduped, capped) for future batches. No
 * persistence — MessageBox is the source of truth and state is rebuilt from
 * the inbox on every load.
 */
export function applyMessages (s: CrowdState, msgs: CrowdMessage[]): CrowdState {
  let queue: CrowdMessage[] = [...s.pending, ...msgs]
  let state: CrowdState = { escrows: s.escrows, pending: [] }

  let progress = true
  while (progress) {
    progress = false
    const remaining: CrowdMessage[] = []
    for (const m of queue) {
      const next = reduce(state, m)
      if (next !== state) {
        state = next
        progress = true
      } else if (isOrphan(state, m)) {
        remaining.push(m)
      }
      // else: duplicate or invalid — drop permanently
    }
    queue = remaining
  }

  const seen = new Set<string>()
  const pending = queue.filter(m => {
    const key = JSON.stringify(m)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(-MAX_PENDING)

  return { escrows: state.escrows, pending }
}

/** Pure: remove all escrows with status `cancelled` from state. */
export function removeCancelledEscrows (state: CrowdState): CrowdState {
  const escrows = Object.fromEntries(
    Object.entries(state.escrows).filter(([, es]) => es.status !== 'cancelled'),
  )
  if (Object.keys(escrows).length === Object.keys(state.escrows).length) return state
  return { ...state, escrows }
}
