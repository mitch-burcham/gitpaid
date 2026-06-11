import { useState, useCallback } from 'react'
import { useCrowd } from '../hooks/useCrowd'
import { buildProposal, signProposal } from '../lib/escrow'
import { CrowdEscrow } from '../lib/CrowdEscrow'
import { fanOut } from '../lib/messages'
import type { InviteMsg, SignatureMsg } from '../lib/protocol'
import type { DisplayableIdentity } from '../lib/identity'
import { AvatarChip } from './AvatarChip'
import { IdentityPicker } from './IdentityPicker'

interface Props {
  invite: InviteMsg
}

type RecipientMode = 'identity' | 'address'

function fmtSats (n: number): string {
  return new Intl.NumberFormat().format(n) + ' sats'
}

export function ProposeForm ({ invite }: Props) {
  const { ownKey, dispatchMessages } = useCrowd()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<RecipientMode>('identity')
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity[]>([])
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Same fee formula as buildProposal so the preview matches the actual amount
  const txSizeEstimate = 10 + 40 +
    CrowdEscrow.estimateMultisigUnlockLength(invite.threshold, invite.pubkeys.length) + 34
  const estimatedFee = Math.max(2, Math.ceil(txSizeEstimate / 1000))
  const sendSats = invite.satoshis - estimatedFee

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
      await fanOut(proposal, invite.controllers, ownKey)
      await fanOut(sigMsg, invite.controllers, ownKey)
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '8px 12px', background: 'var(--bg-raise)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--panel-border)' }}>
                    <AvatarChip identityKey={selectedIdentity[0].identityKey} size={24} showName />
                    <button
                      type="button"
                      onClick={() => setSelectedIdentity([])}
                      style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
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
            Sends ~<strong style={{ color: 'var(--text)' }}>{fmtSats(sendSats)}</strong> (full escrow minus network fee)
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
