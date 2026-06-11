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
export interface CrowdState { escrows: Record<string, EscrowState> }

export const emptyState: CrowdState = Object.freeze({ escrows: Object.freeze({}) }) as CrowdState

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

const STORAGE_PREFIX = 'crowd:'

export function loadState (ownKey: string): CrowdState {
  if (typeof localStorage === 'undefined') return emptyState
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${ownKey}`)
    if (raw === null) return emptyState
    return JSON.parse(raw) as CrowdState
  } catch {
    return emptyState
  }
}

export function saveState (ownKey: string, s: CrowdState): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(`${STORAGE_PREFIX}${ownKey}`, JSON.stringify(s))
}

export function applyAndSave (ownKey: string, s: CrowdState, msgs: CrowdMessage[]): CrowdState {
  const next = msgs.reduce(reduce, s)
  saveState(ownKey, next)
  return next
}
