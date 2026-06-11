import { useId } from 'react'

interface Props {
  count: number
  threshold: number
  size?: number
}

export function SigRing ({ count, threshold, size = 72 }: Props) {
  // SVG gradient ids resolve document-wide; a shared id breaks with many rings
  const gradId = useId()
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 6
  const circumference = 2 * Math.PI * r
  const progress = Math.min(count / Math.max(threshold, 1), 1)
  const strokeDashoffset = circumference * (1 - progress)
  const complete = count >= threshold

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label={`${count} of ${threshold} signatures`}
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38E0FF" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>

      {/* Track circle */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        stroke={complete ? 'rgba(61, 240, 168, 0.25)' : 'rgba(148, 184, 255, 0.14)'}
        strokeWidth={4}
        fill="none"
      />

      {/* Progress arc */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        stroke={complete ? '#3DF0A8' : `url(#${gradId})`}
        strokeWidth={4}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        style={{
          transform: 'rotate(-90deg)',
          transformOrigin: `${cx}px ${cy}px`,
          transition: 'stroke-dashoffset 0.5s ease',
        }}
      />

      {/* Center text */}
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: size * 0.22,
          fontWeight: 700,
          fill: complete ? '#3DF0A8' : '#E8EEFB',
        }}
      >
        {count}/{threshold}
      </text>
    </svg>
  )
}
