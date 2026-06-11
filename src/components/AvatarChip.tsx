import { memo, useEffect, useState } from 'react'
import { resolveKey, placeholderName } from '../lib/identity'
import type { DisplayableIdentity } from '../lib/identity'

interface Props {
  identityKey: string
  size?: number
  showName?: boolean
  suffix?: string
}

function keyHue (key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0xffffffff
  }
  return Math.abs(hash) % 360
}

function AvatarChipInner ({ identityKey, size = 32, showName = true, suffix }: Props) {
  const [loading, setLoading] = useState(true)
  const [identity, setIdentity] = useState<DisplayableIdentity | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    resolveKey(identityKey)
      .then(result => {
        if (!cancelled) {
          setIdentity(result)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [identityKey])

  const hue = keyHue(identityKey)

  const circleStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  }

  const wrapStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    verticalAlign: 'middle',
  }

  const nameStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    lineHeight: 1.3,
  }

  const nameTextStyle: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text)',
  }

  const suffixStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--text-dim)',
    fontStyle: 'italic',
  }

  if (loading) {
    return (
      <span style={wrapStyle}>
        <span
          className="shimmer"
          style={{ ...circleStyle }}
        />
        {showName && (
          <span className="shimmer" style={{ width: 72, height: 12, borderRadius: 4, display: 'inline-block' }} />
        )}
      </span>
    )
  }

  // Resolved name or deterministic placeholder — never show raw key
  const displayName = (identity?.name != null && identity.name !== '') ? identity.name : placeholderName(identityKey)
  const avatarURL = identity?.avatarURL

  let avatar: React.ReactNode
  if (avatarURL != null && avatarURL !== '') {
    avatar = (
      <img
        src={avatarURL}
        alt={displayName}
        style={{ ...circleStyle, objectFit: 'cover' }}
      />
    )
  } else {
    const initial = displayName[0]?.toUpperCase() ?? '?'
    avatar = (
      <span
        title={identityKey}
        style={{
          ...circleStyle,
          background: `linear-gradient(135deg, hsl(${hue},80%,60%), hsl(${(hue + 60) % 360},80%,50%))`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size * 0.4,
          fontWeight: 700,
          color: '#fff',
          fontFamily: 'var(--font-display)',
        }}
      >
        {initial}
      </span>
    )
  }

  return (
    <span style={wrapStyle}>
      {avatar}
      {showName && (
        <span style={nameStyle}>
          <span style={nameTextStyle}>{displayName}</span>
          {suffix != null && suffix !== '' && (
            <span style={suffixStyle}>{suffix}</span>
          )}
        </span>
      )}
    </span>
  )
}

export const AvatarChip = memo(AvatarChipInner)
