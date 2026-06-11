import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useCrowd } from '../hooks/useCrowd'
import { decodeInvite } from '../lib/protocol'
import type { CancelledMsg } from '../lib/protocol'
import { cancelEscrow } from '../lib/escrow'
import { fanOut } from '../lib/messages'
import { AvatarChip } from '../components/AvatarChip'
import { ShareLink } from '../components/ShareLink'
import { ProposeForm } from '../components/ProposeForm'
import { ProposalPanel } from '../components/ProposalPanel'

function fmtSats (n: number): string {
  return new Intl.NumberFormat().format(n) + ' sats'
}

export function EscrowDetail () {
  const { escrowId = '', proposalId } = useParams<{ escrowId: string; proposalId?: string }>()
  const [searchParams] = useSearchParams()
  const { ownKey, state, dispatchMessages } = useCrowd()

  // Inject invite from share link once, guarded against double-run.
  const inviteInjected = useRef(false)
  useEffect(() => {
    if (inviteInjected.current) return
    const d = searchParams.get('d')
    if (d == null) return
    const invite = decodeInvite(d)
    if (invite == null || invite.escrowId !== escrowId) return
    inviteInjected.current = true
    dispatchMessages([invite])
  }, [escrowId, searchParams, dispatchMessages])

  // Two-tap cancel confirm state
  const [cancelArmed, setCancelArmed] = useState(false)
  const cancelResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // Synchronous guard — a double-click reads stale cancelBusy state
  const cancelBusyRef = useRef(false)

  const escrow = state.escrows[escrowId]

  if (escrow == null) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Escrow not found</h1>
        </header>
        <div className="panel">
          <p>Open the share link from the creator to bootstrap this escrow.</p>
        </div>
      </div>
    )
  }

  const { invite, status } = escrow

  async function handleCancel () {
    if (!cancelArmed) {
      setCancelArmed(true)
      if (cancelResetRef.current != null) clearTimeout(cancelResetRef.current)
      cancelResetRef.current = setTimeout(() => setCancelArmed(false), 3000)
      return
    }
    // Second tap
    if (cancelBusyRef.current) return
    cancelBusyRef.current = true
    if (cancelResetRef.current != null) {
      clearTimeout(cancelResetRef.current)
      cancelResetRef.current = null
    }
    setCancelArmed(false)
    setCancelBusy(true)
    setCancelError(null)
    try {
      const txid = await cancelEscrow(invite)
      const msg: CancelledMsg = { type: 'cancelled', escrowId, txid }
      await fanOut(msg, invite.controllers, ownKey)
      dispatchMessages([msg])
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e))
    } finally {
      cancelBusyRef.current = false
      setCancelBusy(false)
    }
  }

  const isOriginator = ownKey === invite.originator
  const isActive = status === 'active'

  // Sort proposals newest first
  const sortedProposals = Object.values(escrow.proposals).sort(
    (a, b) => b.proposal.createdAt - a.proposal.createdAt,
  )

  const hasProposals = sortedProposals.length > 0

  const pillClass =
    status === 'active' ? 'pill pill-active' :
    status === 'cancelled' ? 'pill pill-cancelled' :
    'pill pill-spent'

  return (
    <div className="page">
      {/* Page header with wordmark home link */}
      <header style={{ display: 'flex', alignItems: 'center', marginBottom: 24 }}>
        <Link
          to="/"
          className="grad-text"
          style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, lineHeight: 1, textDecoration: 'none' }}
        >
          Crowd
        </Link>
      </header>

      {/* Hero panel */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 28,
                fontWeight: 700,
                margin: '0 0 6px',
              }}
            >
              {invite.name}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <span className="grad-text" style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700 }}>
                {fmtSats(invite.satoshis)}
              </span>
              <span className={pillClass}>{status}</span>
            </div>

            {/* Spent / cancelled transaction link */}
            {escrow.spentTxid != null && (
              <div style={{ marginBottom: 10 }}>
                <a
                  href={`https://whatsonchain.com/tx/${escrow.spentTxid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, color: 'var(--text-dim)', textDecoration: 'underline' }}
                >
                  View transaction ↗
                </a>
              </div>
            )}

            {/* N-of-M rule */}
            <p style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--text-dim)' }}>
              Requires{' '}
              <strong style={{ color: 'var(--text)' }}>{invite.threshold} of {invite.controllers.length}</strong>{' '}
              controllers to sign
            </p>

            {/* Controller avatar row */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {invite.controllers.map(ctrl => (
                <AvatarChip
                  key={ctrl}
                  identityKey={ctrl}
                  size={28}
                  showName
                />
              ))}
            </div>
          </div>
        </div>

        {/* Share link — inline, no collapsible wrapper */}
        {isActive && (
          <div style={{ marginTop: 18 }}>
            <ShareLink invite={invite} />
          </div>
        )}

        {/* Cancel escrow (originator only, active only) */}
        {isOriginator && isActive && (
          <div style={{ marginTop: 18 }}>
            {cancelError != null && (
              <div style={{ background: 'rgba(255,92,122,0.06)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', color: 'var(--danger)', fontSize: 14, marginBottom: 10 }}>
                {cancelError}
              </div>
            )}
            <button
              type="button"
              className="btn btn-danger"
              disabled={cancelBusy}
              onClick={() => { void handleCancel() }}
              style={{ minHeight: 40, padding: '0 16px', fontSize: 13 }}
            >
              {cancelBusy
                ? 'Cancelling…'
                : cancelArmed
                  ? 'Tap again to return funds'
                  : 'Cancel escrow'}
            </button>
          </div>
        )}
      </div>

      {/* New transfer section — auto-expanded when no proposals exist */}
      {isActive && (
        <div style={{ marginBottom: 24 }}>
          <ProposeForm invite={invite} defaultOpen={!hasProposals} />
        </div>
      )}

      {/* Proposals list */}
      {hasProposals && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, margin: 0 }}>
            Proposals
          </h2>
          {sortedProposals.map(ps => (
            <ProposalPanel
              key={ps.proposal.proposalId}
              invite={invite}
              es={escrow}
              ps={ps}
              highlighted={proposalId === ps.proposal.proposalId}
            />
          ))}
        </div>
      )}

      {!hasProposals && !isActive && (
        <div className="panel" style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
          No proposals.
        </div>
      )}
    </div>
  )
}
