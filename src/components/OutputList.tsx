import { useMemo } from 'react'
import { Transaction, Utils } from '@bsv/sdk'
import type { InviteMsg, ProposalMsg } from '../lib/protocol'
import { AvatarChip } from './AvatarChip'

interface Props {
  proposal: ProposalMsg
  invite: InviteMsg
}

function decodeP2PKHAddress (hex: string): string | null {
  try {
    // P2PKH: OP_DUP(76) OP_HASH160(a9) <20b> OP_EQUALVERIFY(88) OP_CHECKSIG(ac)
    const bytes = Utils.toArray(hex, 'hex')
    if (
      bytes.length === 25 &&
      bytes[0] === 0x76 &&
      bytes[1] === 0xa9 &&
      bytes[2] === 0x14 &&
      bytes[23] === 0x88 &&
      bytes[24] === 0xac
    ) {
      const pubKeyHash = bytes.slice(3, 23)
      return Utils.toBase58Check(pubKeyHash, [0])
    }
    return null
  } catch {
    return null
  }
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
        const scriptHex = out.lockingScript?.toHex() ?? ''
        let destination: React.ReactNode

        if (proposal.recipient != null && i === 0) {
          destination = (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <AvatarChip identityKey={proposal.recipient.identityKey} size={24} showName />
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>(derived key)</span>
            </span>
          )
        } else {
          const addr = decodeP2PKHAddress(scriptHex)
          if (addr != null) {
            destination = (
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                {addr}
              </span>
            )
          } else {
            destination = (
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                {scriptHex.length > 40 ? scriptHex.slice(0, 40) + '…' : scriptHex}
              </span>
            )
          }
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
