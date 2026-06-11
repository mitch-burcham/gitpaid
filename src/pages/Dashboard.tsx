import { Link } from 'react-router-dom'
import { useCrowd } from '../hooks/useCrowd'
import { EscrowCard } from '../components/EscrowCard'
import { AvatarChip } from '../components/AvatarChip'

export function Dashboard () {
  const { state, ownKey } = useCrowd()
  const escrows = Object.entries(state.escrows)

  return (
    <div className="page">
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 }}>
        <span
          className="grad-text"
          style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 700, lineHeight: 1 }}
        >
          Crowd
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {ownKey !== '' && <AvatarChip identityKey={ownKey} size={32} showName={false} />}
          {escrows.length > 0 && (
            <Link to="/new" className="btn fab-hide-mobile">
              + New escrow
            </Link>
          )}
        </div>
      </header>

      {/* Content */}
      {escrows.length === 0 ? (
        /* Empty state */
        <div
          className="panel"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: '64px 32px',
            gap: 16,
          }}
        >
          <span style={{ fontSize: 48, lineHeight: 1 }}>🚀</span>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 24 }}>
            No escrows yet
          </h2>
          <p style={{ margin: 0, color: 'var(--text-dim)', maxWidth: 320, lineHeight: 1.6 }}>
            Create your first escrow to get started
          </p>
          <Link to="/new" className="btn" style={{ marginTop: 8 }}>
            + New escrow
          </Link>
        </div>
      ) : (
        /* Escrow grid */
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 16,
          }}
        >
          {escrows.map(([id, es]) => (
            <EscrowCard key={id} id={id} es={es} />
          ))}
        </div>
      )}

      {/* FAB — visible on mobile only when escrows exist */}
      {escrows.length > 0 && (
        <Link to="/new" className="fab" aria-label="New escrow">
          +
        </Link>
      )}
    </div>
  )
}
