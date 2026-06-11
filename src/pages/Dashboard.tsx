import { Link } from 'react-router-dom'
import { useCrowd } from '../hooks/useCrowd'

export function Dashboard () {
  const { state } = useCrowd()
  const escrows = Object.values(state.escrows)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Crowd</h1>
        <Link to="/new" className="btn">+ New escrow</Link>
      </header>

      {escrows.length === 0 ? (
        <p className="empty-state">No escrows yet. Create one or open a share link from the creator.</p>
      ) : (
        <ul className="escrow-list">
          {escrows.map(({ invite, status }) => (
            <li key={invite.escrowId} className="escrow-row">
              <Link to={`/e/${invite.escrowId}`} className="escrow-link">
                <span className="escrow-name">{invite.name}</span>
                <span className="escrow-sats">{invite.satoshis.toLocaleString()} sats</span>
                <span className={`escrow-status status-${status}`}>{status}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
