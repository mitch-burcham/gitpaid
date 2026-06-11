import { Link } from 'react-router-dom'
import type { EscrowState } from '../lib/store'
import { AvatarChip } from './AvatarChip'
import { SigRing } from './SigRing'

interface Props {
  id: string
  es: EscrowState
}

function statusPillClass (status: EscrowState['status']): string {
  switch (status) {
    case 'active':    return 'pill pill-active'
    case 'spent':     return 'pill pill-spent'
    case 'cancelled': return 'pill pill-cancelled'
  }
}

export function EscrowCard ({ id, es }: Props) {
  const { invite, status, proposals } = es
  const controllers = invite.controllers
  const threshold = invite.threshold
  const proposalCount = Object.keys(proposals).length

  // Count max signatures across open proposals for the ring
  const maxSigs = proposalCount > 0
    ? Math.max(...Object.values(proposals).map(p => Object.keys(p.signatures).length))
    : 0

  const satsFormatted = new Intl.NumberFormat().format(invite.satoshis)

  return (
    <Link
      to={`/e/${id}`}
      className="panel escrow-card"
      style={{ display: 'block' }}
    >
      {/* Header row: name + status pill */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, lineHeight: 1.3 }}>
          {invite.name}
        </h3>
        <span className={statusPillClass(status)}>{status}</span>
      </div>

      {/* Sats + SigRing */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <span
          className="grad-text"
          style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700 }}
        >
          {satsFormatted} sats
        </span>
        <SigRing count={maxSigs} threshold={threshold} size={56} />
      </div>

      {/* Avatar stack */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap' }}>
        {controllers.slice(0, 5).map((key, idx) => (
          <span
            key={key}
            style={{ marginLeft: idx === 0 ? 0 : -8, zIndex: controllers.length - idx, position: 'relative' }}
          >
            <AvatarChip identityKey={key} size={28} showName={false} />
          </span>
        ))}
        {controllers.length > 5 && (
          <span style={{ marginLeft: 4, fontSize: 12, color: 'var(--text-dim)', fontWeight: 600 }}>
            +{controllers.length - 5}
          </span>
        )}
        <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-dim)' }}>
          {threshold}-of-{controllers.length}
        </span>
      </div>

      {/* Proposal count */}
      {proposalCount > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim)' }}>
          {proposalCount} proposal{proposalCount !== 1 ? 's' : ''}
        </div>
      )}
    </Link>
  )
}
