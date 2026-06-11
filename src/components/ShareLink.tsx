import { useState } from 'react'
import { encodeInvite } from '../lib/protocol'
import type { InviteMsg } from '../lib/protocol'

interface Props {
  invite: InviteMsg
}

export function ShareLink ({ invite }: Props) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const url = `${location.origin}${location.pathname}#/e/${invite.escrowId}?d=${encodeInvite(invite)}`
  const canShare = typeof navigator.share === 'function'

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

  const copyLabel =
    copyState === 'copied' ? 'Copied ✓' :
    copyState === 'failed' ? 'Copy failed' :
    'Copy invite link'

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      {canShare ? (
        <>
          <button
            type="button"
            className="btn"
            onClick={handleShare}
            style={{ minHeight: 44, padding: '0 20px', fontSize: 14 }}
          >
            Share invite
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleCopy}
            style={{ minHeight: 44, padding: '0 16px', fontSize: 13 }}
          >
            {copyLabel}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={handleCopy}
          style={{ minHeight: 44, padding: '0 20px', fontSize: 14 }}
        >
          {copyLabel}
        </button>
      )}
    </div>
  )
}
