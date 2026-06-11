import type { ReactNode } from 'react'
import { useCrowd } from '../hooks/useCrowd'

interface Props { children: ReactNode }

export function WalletGate ({ children }: Props) {
  const { ready, mbxError, refresh } = useCrowd()

  if (!ready) {
    return (
      <div className="wallet-gate-loading" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: '1rem' }}>
        <h1 style={{ margin: 0 }}>Crowd</h1>
        <div className="spinner" aria-label="Loading" />
        <p style={{ margin: 0 }}>Waiting for your BSV wallet…</p>
        <p style={{ margin: 0, opacity: 0.5, fontSize: '0.85em' }}>
          You need a BRC-100 wallet (e.g. Metanet Desktop) running to continue.
        </p>
      </div>
    )
  }

  return (
    <>
      {mbxError != null && (
        <div className="mbx-banner" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, padding: '0.5rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <span>Relay unreachable — showing cached state</span>
          <button className="btn" onClick={() => { void refresh() }}>Retry</button>
        </div>
      )}
      {children}
    </>
  )
}
