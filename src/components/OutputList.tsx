import { useMemo } from 'react'
import { Transaction } from '@bsv/sdk'
import type { InviteMsg, ProposalMsg } from '../lib/protocol'
import { AvatarChip } from './AvatarChip'

interface Props {
  proposal: ProposalMsg
  invite: InviteMsg
}

function fmtSats (n: number): string {
  return new Intl.NumberFormat().format(n) + ' sats'
}

export function OutputList ({ proposal, invite }: Props) {
  const { outputs, fee } = useMemo(() => {
    try {
      const tx = Transaction.fromHex(proposal.rawTx)
      const total = tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0)
      const computedFee = invite.satoshis - total
      return { outputs: tx.outputs, fee: computedFee }
    } catch {
      return { outputs: [], fee: 0 }
    }
  }, [proposal.rawTx, invite.satoshis])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {outputs.map((out, i) => {
        const sats = out.satoshis ?? 0
        let destination: React.ReactNode

        if (proposal.recipient != null && i === 0) {
          destination = (
            <AvatarChip identityKey={proposal.recipient.identityKey} size={24} showName />
          )
        } else {
          destination = (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--bg-raise)',
                border: '1px solid var(--panel-border)',
                borderRadius: 999,
                padding: '3px 10px 3px 8px',
                fontSize: 13,
                color: 'var(--text-dim)',
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--panel-border)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--text-dim)',
                  flexShrink: 0,
                }}
              >
                @
              </span>
              External address
            </span>
          )
        }

        return (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, fontSize: 14 }}>
            <span style={{ fontWeight: 600 }}>{fmtSats(sats)}</span>
            <span style={{ flex: 1, textAlign: 'right' }}>{destination}</span>
          </div>
        )
      })}

      {fee > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-dim)', borderTop: '1px solid var(--panel-border)', paddingTop: 6, marginTop: 2 }}>
          <span>Network fee</span>
          <span>{fmtSats(fee)}</span>
        </div>
      )}
    </div>
  )
}
