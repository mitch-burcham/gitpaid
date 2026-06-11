import { useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useCrowd } from '../hooks/useCrowd'
import { decodeInvite } from '../lib/protocol'

export function EscrowDetail () {
  const { escrowId = '', proposalId } = useParams<{ escrowId: string; proposalId?: string }>()
  const [searchParams] = useSearchParams()
  const { state, dispatchMessages } = useCrowd()

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

  return (
    <div className="page">
      <header className="page-header">
        <h1>{invite.name}</h1>
        <span className={`escrow-status status-${status}`}>{status}</span>
      </header>

      <div className="panel">
        <p><strong>Satoshis:</strong> {invite.satoshis.toLocaleString()}</p>
        <p><strong>Threshold:</strong> {invite.threshold} of {invite.controllers.length}</p>
        <p><strong>Escrow ID:</strong> <code>{escrowId}</code></p>
        {proposalId != null && (
          <p><strong>Focused proposal:</strong> <code>{proposalId}</code></p>
        )}
      </div>

      <div className="panel">
        <h2>Proposals</h2>
        <p>Proposal list — coming in Task 10.</p>
      </div>
    </div>
  )
}
