import { useState, useCallback } from 'react'
import { useCrowd } from '../hooks/useCrowd'
import { buildProposal, signProposal } from '../lib/escrow'
import { fanOut } from '../lib/messages'
import type { CrowdMessage, InviteMsg, SignatureMsg } from '../lib/protocol'
import type { DisplayableIdentity } from '../lib/identity'
import { AvatarChip } from './AvatarChip'
import { IdentityPicker } from './IdentityPicker'

interface Props {
  invite: InviteMsg
  defaultOpen?: boolean
}

type RecipientMode = 'identity' | 'address'

function fmtSats (n: number): string {
  return new Intl.NumberFormat().format(n) + ' sats'
}

export function ProposeForm ({ invite, defaultOpen = false }: Props) {
  const { ownKey, dispatchMessages } = useCrowd()
  const [open, setOpen] = useState(defaultOpen)
  const [mode, setMode] = useState<RecipientMode>('identity')
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity[]>([])
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Recipients whose proposal/signature delivery failed, plus the messages to
  // resend — without this, a relay hiccup silently leaves counterparties
  // unable to see the proposal at all.
  const [sendFailures, setSendFailures] = useState<{ recipients: string[], msgs: CrowdMessage[] } | null>(null)

  // Recipient gets the full escrow; the broadcasting wallet covers the fee
  const sendSats = invite.satoshis

  const recipientIdentityKey = mode === 'identity' ? selectedIdentity[0]?.identityKey : undefined
  const recipientAddress = mode === 'address' ? address.trim() : undefined
  const canSubmit =
    !busy &&
    note.trim().length > 0 &&
    (mode === 'identity' ? recipientIdentityKey != null : (recipientAddress ?? '').length > 0)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const proposal = await buildProposal({
        invite,
        note: note.trim(),
        recipientIdentityKey,
        recipientAddress,
      })
      const sigHex = await signProposal(invite, proposal)
      const sigMsg: SignatureMsg = {
        type: 'signature',
        escrowId: invite.escrowId,
        proposalId: proposal.proposalId,
        signer: ownKey,
        sigHex,
      }
      const failedProposal = await fanOut(proposal, invite.controllers)
      const failedSig = await fanOut(sigMsg, invite.controllers)
      const failed = [...new Set([...failedProposal, ...failedSig])]
      setSendFailures(failed.length > 0 ? { recipients: failed, msgs: [proposal, sigMsg] } : null)
      dispatchMessages([proposal, sigMsg])
      // Reset form
      setOpen(false)
      setNote('')
      setAddress('')
      setSelectedIdentity([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [canSubmit, invite, note, recipientIdentityKey, recipientAddress, ownKey, dispatchMessages])

  const handleRetrySend = useCallback(async () => {
    if (sendFailures == null || busy) return
    setBusy(true)
    try {
      const stillFailed = new Set<string>()
      for (const msg of sendFailures.msgs) {
        for (const r of await fanOut(msg, sendFailures.recipients)) stillFailed.add(r)
      }
      setSendFailures(stillFailed.size > 0
        ? { recipients: [...stillFailed], msgs: sendFailures.msgs }
        : null)
    } finally {
      setBusy(false)
    }
  }, [sendFailures, busy, ownKey])

  return (
    <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '16px 20px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text)',
          fontFamily: 'var(--font-display)',
          fontSize: 15,
          fontWeight: 600,
        }}
      >
        <span style={{ fontSize: 18 }}>{open ? '↙' : '↗'}</span>
        <span>New transfer</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 20 }}>
          {open ? '−' : '+'}
        </span>
      </button>

      {/* Delivery-failure banner: shown even when the form is collapsed,
          since submit collapses the form before delivery is confirmed */}
      {sendFailures != null && (
        <div style={{ margin: '0 20px 16px', background: 'rgba(255,92,122,0.06)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--danger)', flex: 1, minWidth: 180 }}>
            The proposal didn&apos;t reach {sendFailures.recipients.length === 1 ? 'one controller' : `${sendFailures.recipients.length} controllers`} — they won&apos;t see it until it&apos;s resent.
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {sendFailures.recipients.slice(0, 4).map(r => (
              <AvatarChip key={r} identityKey={r} size={22} showName={false} />
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
            onClick={() => { void handleRetrySend() }}
            disabled={busy}
          >
            {busy ? 'Resending…' : 'Resend'}
          </button>
        </div>
      )}

      {open && (
        <div style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Error banner */}
          {error != null && (
            <div style={{ background: 'rgba(255,92,122,0.06)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', color: 'var(--danger)', fontSize: 14 }}>
              {error}
            </div>
          )}

          {/* Recipient mode toggle */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
              Recipient
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setMode('identity')}
                style={{
                  minHeight: 36,
                  padding: '0 14px',
                  fontSize: 13,
                  background: mode === 'identity' ? 'rgba(56,224,255,0.1)' : 'transparent',
                  borderColor: mode === 'identity' ? 'var(--accent)' : 'var(--panel-border)',
                  color: mode === 'identity' ? 'var(--accent)' : 'var(--text)',
                }}
              >
                By identity
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setMode('address')}
                style={{
                  minHeight: 36,
                  padding: '0 14px',
                  fontSize: 13,
                  background: mode === 'address' ? 'rgba(56,224,255,0.1)' : 'transparent',
                  borderColor: mode === 'address' ? 'var(--accent)' : 'var(--panel-border)',
                  color: mode === 'address' ? 'var(--accent)' : 'var(--text)',
                }}
              >
                By address
              </button>
            </div>

            {mode === 'identity' ? (
              <div>
                {selectedIdentity.length > 0 && (
                  <div className="identity-chip identity-chip--actionable" style={{ marginBottom: 8 }}>
                    <AvatarChip identityKey={selectedIdentity[0].identityKey} size={28} showName showKey embedded />
                    <button
                      type="button"
                      className="identity-chip__remove"
                      onClick={() => setSelectedIdentity([])}
                      aria-label="Clear recipient"
                    >
                      ×
                    </button>
                  </div>
                )}
                {selectedIdentity.length === 0 && (
                  <IdentityPicker
                    selected={selectedIdentity}
                    onChange={setSelectedIdentity}
                    single
                  />
                )}
              </div>
            ) : (
              <input
                className="input"
                placeholder="Paste BSV address (e.g. 1Abc…)"
                value={address}
                onChange={e => setAddress(e.target.value)}
              />
            )}
          </div>

          {/* Note */}
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
              Note
            </label>
            <input
              className="input"
              placeholder="What's this transfer for?"
              value={note}
              onChange={e => setNote(e.target.value)}
            />
          </div>

          {/* Amount line */}
          <div style={{ fontSize: 14, color: 'var(--text-dim)', padding: '10px 0', borderTop: '1px solid var(--panel-border)' }}>
            Sends <strong style={{ color: 'var(--text)' }}>{fmtSats(sendSats)}</strong> (network fee paid by the broadcasting wallet)
          </div>

          {/* Submit */}
          <button
            type="button"
            className="btn"
            onClick={() => { void handleSubmit() }}
            disabled={!canSubmit}
            style={{ width: '100%', minHeight: 48, fontSize: 15 }}
          >
            {busy ? 'Creating…' : 'Create proposal & sign'}
          </button>
        </div>
      )}
    </div>
  )
}
