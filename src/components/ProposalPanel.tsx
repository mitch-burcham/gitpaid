import { useEffect, useMemo, useRef, useState } from 'react'
import { useCrowd } from '../hooks/useCrowd'
import { signProposal, verifySignature, finalizeProposal } from '../lib/escrow'
import { fanOut } from '../lib/messages'
import type { EscrowState, ProposalState } from '../lib/store'
import type { InviteMsg, SignatureMsg, VetoMsg, FinalizedMsg } from '../lib/protocol'
import { AvatarChip } from './AvatarChip'
import { SigRing } from './SigRing'
import { OutputList } from './OutputList'

interface Props {
  invite: InviteMsg
  es: EscrowState
  ps: ProposalState
  highlighted?: boolean
}

function relativeTime (ts: number): string {
  const diff = (Date.now() - ts) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

export function ProposalPanel ({ invite, es, ps, highlighted = false }: Props) {
  const { ownKey, dispatchMessages } = useCrowd()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const autoFinalizeGuard = useRef(false)
  // Synchronous re-entrancy guard: React state alone can't stop a double-click
  // or the auto-finalize effect racing a manual action.
  const busyRef = useRef(false)

  // Inline veto expansion state
  const [vetoExpanded, setVetoExpanded] = useState(false)
  const [vetoReason, setVetoReason] = useState('')

  const { proposal } = ps
  const escrowId = invite.escrowId
  const proposalId = proposal.proposalId
  const isActive = es.status === 'active'
  const isController = invite.controllers.includes(ownKey)
  const isOpen = ps.status === 'open'

  // Scroll into view on mount if highlighted
  useEffect(() => {
    if (highlighted && panelRef.current != null) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [highlighted])

  // Verify each signature once per signatures change — sighash computation is
  // expensive, so both the ring count and the status rows read this map.
  const verifiedMap = useMemo(() => {
    const map: Record<string, boolean> = {}
    for (const [signer, sigHex] of Object.entries(ps.signatures)) {
      map[signer] = verifySignature(invite, proposal, signer, sigHex)
    }
    return map
  }, [ps.signatures, invite, proposal])

  const verifiedCount = useMemo(
    () => Object.values(verifiedMap).filter(Boolean).length,
    [verifiedMap],
  )

  const ready = verifiedCount >= invite.threshold
  const hasMySig = ownKey in ps.signatures
  const hasMyVeto = ownKey in ps.vetoes

  // Auto-finalize: any controller triggers this once threshold is reached
  useEffect(() => {
    if (
      !autoFinalizeGuard.current &&
      !busyRef.current &&
      isOpen &&
      isActive &&
      isController &&
      ready
    ) {
      autoFinalizeGuard.current = true
      void handleFinalize()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, isOpen, isActive, isController])

  async function handleSign () {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const sigHex = await signProposal(invite, proposal)
      const sigMsg: SignatureMsg = {
        type: 'signature',
        escrowId,
        proposalId,
        signer: ownKey,
        sigHex,
      }
      await fanOut(sigMsg, invite.controllers)
      dispatchMessages([sigMsg])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function handleVetoConfirm () {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const msg: VetoMsg = {
        type: 'veto',
        escrowId,
        proposalId,
        vetoer: ownKey,
        reason: vetoReason.trim() || undefined,
      }
      await fanOut(msg, invite.controllers)
      dispatchMessages([msg])
      setVetoExpanded(false)
      setVetoReason('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function handleFinalize () {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const txid = await finalizeProposal(invite, es, proposalId)
      const msg: FinalizedMsg = { type: 'finalized', escrowId, proposalId, txid }
      await fanOut(msg, invite.controllers)
      dispatchMessages([msg])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Guard stays set: auto-finalize is attempted once; on failure the
      // manual "Finalize & broadcast" button remains as the retry path,
      // avoiding a broadcast retry loop on every re-render.
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const panelStyle: React.CSSProperties = {
    outline: highlighted ? '2px solid var(--accent)' : 'none',
    outlineOffset: 2,
    transition: 'outline 0.2s',
  }

  return (
    <div ref={panelRef} className="panel" style={panelStyle}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <AvatarChip identityKey={proposal.proposer} size={28} showName />
        <div style={{ flex: 1 }}>
          {proposal.note !== '' && (
            <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 500 }}>{proposal.note}</p>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{relativeTime(proposal.createdAt)}</span>
        </div>
        {/* Sig ring */}
        <SigRing count={verifiedCount} threshold={invite.threshold} size={52} />
      </div>

      {/* Outputs */}
      <div style={{ marginBottom: 16 }}>
        <OutputList proposal={proposal} invite={invite} />
      </div>

      <span className="section-label">Controller responses</span>
      <div className="controller-status-list" style={{ marginBottom: 16 }}>
        {invite.controllers.map(ctrl => {
          const verified = verifiedMap[ctrl] === true
          const vetoReasonVal = ps.vetoes[ctrl]

          let statusNode: React.ReactNode
          let rowClass = 'controller-status-row'
          if (verified) {
            statusNode = <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ok)' }}>Signed</span>
            rowClass += ' controller-status-row--signed'
          } else if (vetoReasonVal != null) {
            statusNode = (
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)' }}>
                Vetoed{vetoReasonVal !== '' ? ` · ${vetoReasonVal}` : ''}
              </span>
            )
            rowClass += ' controller-status-row--vetoed'
          } else {
            statusNode = <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Awaiting</span>
          }

          return (
            <div key={ctrl} className={rowClass}>
              <AvatarChip identityKey={ctrl} size={26} showName suffix={ctrl === ownKey ? '(you)' : undefined} embedded />
              {statusNode}
            </div>
          )
        })}
      </div>

      {/* Status banners */}
      {ps.status === 'vetoed' && (
        <div style={{ background: 'rgba(255,92,122,0.06)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', color: 'var(--danger)', fontSize: 14, marginBottom: 12 }}>
          Vetoed
        </div>
      )}
      {ps.status === 'finalized' && ps.txid != null && (
        <div style={{ background: 'rgba(61,240,168,0.06)', border: '1px solid var(--ok)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', color: 'var(--ok)', fontSize: 14, marginBottom: 12 }}>
          Sent ✓ —{' '}
          <a
            href={`https://whatsonchain.com/tx/${ps.txid}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--ok)', textDecoration: 'underline' }}
          >
            View transaction ↗
          </a>
        </div>
      )}

      {/* Error banner */}
      {error != null && (
        <div style={{ background: 'rgba(255,92,122,0.06)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', color: 'var(--danger)', fontSize: 14, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Actions */}
      {isOpen && isActive && isController && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!hasMySig && !hasMyVeto && !vetoExpanded && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <button
                type="button"
                className="btn"
                onClick={() => { void handleSign() }}
                disabled={busy}
                style={{ flex: 1, minWidth: 120 }}
              >
                {busy ? 'Signing…' : 'Sign'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setVetoExpanded(true)}
                disabled={busy}
                style={{ flex: 1, minWidth: 120 }}
              >
                Veto
              </button>
            </div>
          )}

          {/* Inline veto expansion (progressive disclosure) */}
          {vetoExpanded && !hasMySig && !hasMyVeto && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                padding: '14px 16px',
                background: 'rgba(255,92,122,0.04)',
                border: '1px solid rgba(255,92,122,0.3)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <input
                className="input"
                placeholder="Reason (optional)"
                value={vetoReason}
                onChange={e => setVetoReason(e.target.value)}
                disabled={busy}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => { void handleVetoConfirm() }}
                  disabled={busy}
                  style={{ flex: 1 }}
                >
                  {busy ? 'Vetoing…' : 'Confirm veto'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setVetoExpanded(false); setVetoReason('') }}
                  disabled={busy}
                  style={{ flex: 1 }}
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {ready && !busy && (
            <button
              type="button"
              className="btn"
              onClick={() => { void handleFinalize() }}
              disabled={busy}
              style={{ width: '100%', marginTop: hasMySig || hasMyVeto ? 0 : 4, background: 'linear-gradient(135deg, var(--ok), var(--accent))' }}
            >
              Finalize &amp; broadcast
            </button>
          )}
          {busy && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-dim)', fontSize: 13 }}>
              <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
              Working…
            </div>
          )}
        </div>
      )}
    </div>
  )
}
