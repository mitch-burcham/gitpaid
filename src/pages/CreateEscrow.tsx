import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCrowd } from '../hooks/useCrowd'
import { createEscrow } from '../lib/escrow'
import { fanOut } from '../lib/messages'
import type { DisplayableIdentity } from '../lib/identity'
import type { InviteMsg } from '../lib/protocol'
import { AvatarChip } from '../components/AvatarChip'
import { IdentityPicker } from '../components/IdentityPicker'
import { ShareLink } from '../components/ShareLink'

const DUST_FLOOR = 500

function formatSats (n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return new Intl.NumberFormat().format(n) + ' sats'
}

export function CreateEscrow () {
  const { ownKey, dispatchMessages } = useCrowd()

  const [name, setName] = useState('')
  const [satoshisInput, setSatoshisInput] = useState('')
  const [others, setOthers] = useState<DisplayableIdentity[]>([])
  const [threshold, setThreshold] = useState(1) // will track M automatically
  const prevMRef = useRef(1) // tracks the M value from the last controllers change
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{
    invite: InviteMsg
    failedRecipients: string[]
  } | null>(null)
  const [retrying, setRetrying] = useState(false)

  // M = 1 (self) + others
  const M = 1 + others.length
  // Default threshold tracks M; user can lower
  // Clamp threshold to valid range whenever M changes
  const clampedThreshold = Math.max(1, Math.min(threshold, M))

  const satoshis = parseInt(satoshisInput, 10)
  const satoshisValid = Number.isFinite(satoshis) && satoshis >= DUST_FLOOR
  const nameValid = name.trim().length > 0
  // CrowdEscrow.lock supports at most 10 pubkeys (self + 9 others)
  const controllersValid = others.length >= 1 && M <= 10
  const canSubmit = nameValid && satoshisValid && controllersValid && !busy
  const tooManyControllers = M > 10

  const showDustHint = satoshisInput !== '' && !satoshisValid

  function adjustThreshold (delta: number) {
    setThreshold(t => Math.max(1, Math.min(t + delta, M)))
  }

  // Keep threshold synced when M changes.
  // If user hadn't deliberately lowered threshold below M, track M upward.
  function handleOthersChange (sel: DisplayableIdentity[]) {
    const prevM = prevMRef.current
    const newM = 1 + sel.length
    prevMRef.current = newM
    setOthers(sel)
    setThreshold(t => {
      // If threshold was tracking M (equalled prev M), keep tracking the new M
      if (t === prevM) return newM
      // Otherwise just clamp to valid range
      return Math.max(1, Math.min(t, newM))
    })
  }

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const invite = await createEscrow({
        name: name.trim(),
        satoshis,
        threshold: clampedThreshold,
        controllerIdentityKeys: others.map(o => o.identityKey),
      })
      const failedRecipients = await fanOut(invite, invite.controllers, ownKey)
      dispatchMessages([invite])
      setSuccess({ invite, failedRecipients })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [canSubmit, name, satoshis, clampedThreshold, others, ownKey, dispatchMessages])

  async function handleRetry () {
    if (success === null) return
    setRetrying(true)
    try {
      const stillFailed = await fanOut(success.invite, success.failedRecipients, ownKey)
      setSuccess(prev => prev !== null ? { ...prev, failedRecipients: stillFailed } : prev)
    } catch {
      // swallow — failures remain shown
    } finally {
      setRetrying(false)
    }
  }

  // ─── Success view ────────────────────────────────────────────
  if (success !== null) {
    const { invite, failedRecipients } = success
    return (
      <div className="page" style={{ maxWidth: 600 }}>
        {/* Success hero */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              background: 'rgba(61,240,168,0.1)',
              border: '2px solid var(--ok)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 36,
              margin: '0 auto 20px',
            }}
          >
            ✓
          </div>
          <h1
            className="grad-text"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 32,
              fontWeight: 700,
              margin: 0,
            }}
          >
            Escrow locked
          </h1>
          <p style={{ color: 'var(--text-dim)', marginTop: 8, marginBottom: 0 }}>
            {invite.name} · {formatSats(invite.satoshis)}
          </p>
        </div>

        {/* Share link */}
        <div style={{ marginBottom: 16 }}>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '0 0 8px' }}>
            Share this link with controllers so they can join
          </p>
          <ShareLink invite={invite} />
        </div>

        {/* Failed recipients warning */}
        {failedRecipients.length > 0 && (
          <div
            className="panel"
            style={{
              marginBottom: 16,
              borderColor: 'var(--danger)',
              background: 'rgba(255,92,122,0.06)',
            }}
          >
            <p style={{ margin: '0 0 10px', color: 'var(--danger)', fontWeight: 600, fontSize: 14 }}>
              Could not deliver to {failedRecipients.length} controller{failedRecipients.length !== 1 ? 's' : ''}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {failedRecipients.map(k => (
                <AvatarChip key={k} identityKey={k} size={24} showName />
              ))}
            </div>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => { void handleRetry() }}
              disabled={retrying}
              style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
            >
              {retrying ? 'Retrying…' : 'Retry delivery'}
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Link
            to={`/e/${invite.escrowId}`}
            className="btn"
            style={{ flex: 1, minWidth: 140 }}
          >
            View escrow
          </Link>
          <Link
            to="/"
            className="btn btn-ghost"
            style={{ flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    )
  }

  // ─── Form view ───────────────────────────────────────────────
  const summaryPanel = (
    <div className="panel" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 16px', fontFamily: 'var(--font-display)', fontSize: 15, color: 'var(--text-dim)' }}>
        Summary
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
        <div>
          <span style={{ color: 'var(--text-dim)' }}>Name </span>
          <span>{name.trim() || <em style={{ color: 'var(--text-dim)' }}>—</em>}</span>
        </div>
        <div>
          <span style={{ color: 'var(--text-dim)' }}>Amount </span>
          <span>{satoshisValid ? formatSats(satoshis) : <em style={{ color: 'var(--text-dim)' }}>—</em>}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ color: 'var(--text-dim)', marginRight: 4 }}>Controllers </span>
          {ownKey !== '' && <AvatarChip identityKey={ownKey} size={22} showName={false} />}
          {others.map(o => (
            <AvatarChip key={o.identityKey} identityKey={o.identityKey} size={22} showName={false} />
          ))}
        </div>
        <div style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Any{' '}
          <strong style={{ color: 'var(--text)' }}>{clampedThreshold} of {M}</strong>{' '}
          controllers can move these funds
        </div>
      </div>
    </div>
  )

  return (
    <div className="page">
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 28,
          fontWeight: 700,
          margin: '0 0 28px',
        }}
      >
        New escrow
      </h1>

      <div className="create-escrow-layout">
        {/* ── Left / main column ─────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Error banner */}
          {error !== null && (
            <div
              className="panel"
              style={{
                borderColor: 'var(--danger)',
                background: 'rgba(255,92,122,0.06)',
                color: 'var(--danger)',
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}

          {/* 1. Name */}
          <div>
            <label style={labelStyle} htmlFor="escrow-name">Name</label>
            <input
              id="escrow-name"
              className="input"
              placeholder="What's this escrow for?"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          {/* 2. Amount */}
          <div>
            <label style={labelStyle} htmlFor="escrow-amount">Amount (satoshis)</label>
            <input
              id="escrow-amount"
              className="input"
              inputMode="numeric"
              placeholder="e.g. 100000"
              value={satoshisInput}
              onChange={e => setSatoshisInput(e.target.value.replace(/\D/g, ''))}
            />
            {satoshisValid && (
              <p style={hintStyle}>{formatSats(satoshis)}</p>
            )}
            {showDustHint && (
              <p style={{ ...hintStyle, color: 'var(--danger)' }}>
                Minimum amount is {DUST_FLOOR} sats (dust-safe floor)
              </p>
            )}
          </div>

          {/* 3. Controllers */}
          <div>
            <label style={labelStyle}>Controllers</label>

            {/* Self chip — locked, no remove */}
            {ownKey !== '' && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--bg-raise)',
                  border: '1px solid var(--panel-border)',
                  borderRadius: 999,
                  padding: '4px 10px 4px 6px',
                  marginBottom: 10,
                }}
              >
                <AvatarChip identityKey={ownKey} size={24} showName />
                <span style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>(you)</span>
              </div>
            )}

            <IdentityPicker
              selected={others}
              onChange={handleOthersChange}
              excludeKeys={ownKey !== '' ? [ownKey] : []}
            />

            {!controllersValid && (
              <p style={{ ...hintStyle, color: tooManyControllers ? 'var(--danger)' : 'var(--text-dim)' }}>
                {tooManyControllers
                  ? 'A maximum of 10 controllers (including you) is supported'
                  : 'Add at least one other controller'}
              </p>
            )}
          </div>

          {/* 4. Threshold stepper */}
          {M > 1 && (
            <div>
              <label style={labelStyle}>Threshold (required signers)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => adjustThreshold(-1)}
                  disabled={clampedThreshold <= 1}
                  style={{ width: 44, height: 44, padding: 0, fontSize: 22, flexShrink: 0 }}
                  aria-label="Decrease threshold"
                >
                  −
                </button>
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 32,
                    fontWeight: 700,
                    minWidth: 36,
                    textAlign: 'center',
                  }}
                >
                  {clampedThreshold}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => adjustThreshold(1)}
                  disabled={clampedThreshold >= M}
                  style={{ width: 44, height: 44, padding: 0, fontSize: 22, flexShrink: 0 }}
                  aria-label="Increase threshold"
                >
                  +
                </button>
                <span style={{ color: 'var(--text-dim)', fontSize: 14, flex: 1 }}>
                  of <strong style={{ color: 'var(--text)' }}>{M}</strong>
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Any{' '}
                <strong style={{ color: 'var(--text)' }}>{clampedThreshold} of {M}</strong>{' '}
                controllers can move these funds
              </p>
            </div>
          )}

          {/* Summary panel — mobile / narrow layout */}
          <div className="create-escrow-summary-inline">
            {summaryPanel}
          </div>

          {/* Submit */}
          <button
            type="button"
            className="btn"
            onClick={() => { void handleSubmit() }}
            disabled={!canSubmit}
            style={{ width: '100%', minHeight: 52, fontSize: 16 }}
          >
            {busy ? 'Locking funds…' : 'Lock funds'}
          </button>
        </div>

        {/* ── Right / summary column (desktop only) ──────────── */}
        <div className="create-escrow-summary-desktop">
          <div style={{ position: 'sticky', top: 24 }}>
            {summaryPanel}
          </div>
        </div>
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text-dim)',
  marginBottom: 8,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const hintStyle: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 13,
  color: 'var(--text-dim)',
}
