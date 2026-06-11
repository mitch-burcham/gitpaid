import { useState } from 'react'
import { encodeInvite } from '../lib/protocol'
import type { InviteMsg } from '../lib/protocol'

interface Props {
  invite: InviteMsg
}

export function ShareLink ({ invite }: Props) {
  const [copied, setCopied] = useState(false)

  const url = `${location.origin}${location.pathname}#/e/${invite.escrowId}?d=${encodeInvite(invite)}`

  function handleCopy () {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      // fallback: select the text
    })
  }

  function handleShare () {
    navigator.share({ title: 'Crowd escrow', url }).catch(() => {})
  }

  return (
    <div
      className="panel"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 16px',
        flexWrap: 'wrap',
      }}
    >
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: 12,
          color: 'var(--text-dim)',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {url}
      </span>

      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleCopy}
          style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>

        {typeof navigator.share === 'function' && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleShare}
            style={{ minHeight: 36, padding: '0 14px', fontSize: 13 }}
            aria-label="Share link"
          >
            Share
          </button>
        )}
      </div>
    </div>
  )
}
