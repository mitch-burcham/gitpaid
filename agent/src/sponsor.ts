/**
 * Sponsor-side state (FR-021/FR-022) — rebuilt from the sponsor's own
 * gitpaid box, Crowd-style: invites we posted, claims we received, accepts
 * we recorded. No local persistence.
 */
import type { GitPaidInvite } from '@engine/gitpaidEscrowOps'
import { isClaimMsg, type ClaimMsg } from './core.js'

export interface AcceptMsg {
  type: 'accept'
  escrowId: string
  claimantIdentityKey: string
  prUrl: string
  createdAt: number
}

export function isAcceptMsg (v: unknown): v is AcceptMsg {
  if (v === null || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (
    m.type === 'accept' &&
    typeof m.escrowId === 'string' &&
    typeof m.claimantIdentityKey === 'string' &&
    typeof m.prUrl === 'string'
  )
}

export function isGitPaidInvite (v: unknown): v is GitPaidInvite {
  if (v === null || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (
    m.type === 'invite' &&
    typeof m.escrowId === 'string' &&
    typeof m.beef === 'string' &&
    typeof m.threshold === 'number' &&
    Array.isArray(m.controllers) &&
    m.binding !== null && typeof m.binding === 'object'
  )
}

export interface SponsorState {
  /** escrowId → invite (our posted bounties). */
  invites: Map<string, GitPaidInvite>
  /** Claims received, newest first. */
  claims: ClaimMsg[]
  /** escrowId → accepted claim (latest accept wins). */
  accepts: Map<string, AcceptMsg>
}

/**
 * SR-006-adjacent: invites and accepts are trusted only from OUR OWN
 * messages (`sender === ownIdentityKey` — the self-copy is the durable
 * record). Claims are inherently third-party; their sender must match the
 * claimed identity key, or anyone could claim payouts to someone else's
 * key and bury real claims.
 */
export function buildSponsorState (
  messages: Array<{ body: string | Record<string, unknown>, sender: string }>,
  ownIdentityKey: string,
): SponsorState {
  const state: SponsorState = { invites: new Map(), claims: [], accepts: new Map() }

  for (const m of messages) {
    const body = typeof m.body === 'string' ? safeParse(m.body) : m.body
    if (body === null) continue

    if (isGitPaidInvite(body) && m.sender === ownIdentityKey) {
      state.invites.set(body.escrowId, body)
    } else if (isAcceptMsg(body) && m.sender === ownIdentityKey) {
      const existing = state.accepts.get(body.escrowId)
      if (existing === undefined || body.createdAt > existing.createdAt) {
        state.accepts.set(body.escrowId, body)
      }
    } else if (isClaimMsg(body) && m.sender === body.claimantIdentityKey) {
      state.claims.push(body)
    }
  }

  state.claims.sort((a, b) => b.createdAt - a.createdAt)
  return state
}

function safeParse (raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
