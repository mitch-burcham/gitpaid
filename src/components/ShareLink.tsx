import { useRef, useState } from 'react'
import { encodeInvite } from '../lib/protocol'
import type { InviteMsg } from '../lib/protocol'

interface Props {
  invite: InviteMsg
}

export function ShareLink ({ invite }: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const urlRef = useRef<HTMLSpanElement>(null)

  const url = `${location.origin}${location.pathname}#/e/${invite.escrowId}?d=${encodeInvite(invite)}`

  function execCommandFallback (): boolean {
    try {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }

  function handleCopy () {
    const doResult = (success: boolean) => {
      setCopyState(success ? 'copied' : 'failed')
      setTimeout(() => setCopyState('idle'), 2000)
    }

    if (typeof navigator.clipboard !== 'undefined') {
      navigator.clipboard.writeText(url).then(() => {
        doResult(true)
      }).catch(() => {
        doResult(execCommandFallback())
      })
    } else {
      doResult(execCommandFallback())
    }
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
        ref={urlRef}
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
          {copyState === 'copied' ? 'Copied ✓' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
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
