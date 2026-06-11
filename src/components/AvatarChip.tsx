import { memo, useEffect, useState } from 'react'
import { resolveKey } from '../lib/identity'
import type { DisplayableIdentity } from '../lib/identity'

interface Props {
  identityKey: string
  size?: number
  showName?: boolean
}

function keyHue (key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0xffffffff
  }
  return Math.abs(hash) % 360
}

function AvatarChipInner ({ identityKey, size = 32, showName = true }: Props) {
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

  const abbrev = `${identityKey.slice(0, 6)}…${identityKey.slice(-4)}`
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
    flexDirection: 'column',
    lineHeight: 1.3,
  }

  const nameTextStyle: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--text)',
  }

  const keyTextStyle: React.CSSProperties = {
    fontSize: 11,
    color: 'var(--text-dim)',
  }

  if (loading) {
    return (
      <span style={wrapStyle}>
        <span
          className="shimmer"
          style={{ ...circleStyle }}
        />
        {showName && (
          <span style={nameStyle}>
            <span className="shimmer" style={{ width: 60, height: 12, borderRadius: 4, display: 'inline-block' }} />
          </span>
        )}
      </span>
    )
  }

  const avatarURL = identity?.avatarURL
  const name = identity?.name

  let avatar: React.ReactNode
  if (avatarURL != null && avatarURL !== '') {
    avatar = (
      <img
        src={avatarURL}
        alt={name ?? abbrev}
        style={{ ...circleStyle, objectFit: 'cover' }}
      />
    )
  } else {
    const initial = name ? name[0].toUpperCase() : identityKey[2]?.toUpperCase() ?? '?'
    avatar = (
      <span
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
          {name != null && <span style={nameTextStyle}>{name}</span>}
          <span style={keyTextStyle}>{abbrev}</span>
        </span>
      )}
    </span>
  )
}

export const AvatarChip = memo(AvatarChipInner)
