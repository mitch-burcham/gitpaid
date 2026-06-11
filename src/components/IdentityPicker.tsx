import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { searchIdentities } from '../lib/identity'
import type { DisplayableIdentity } from '../lib/identity'
import { AvatarChip } from './AvatarChip'

interface Props {
  selected: DisplayableIdentity[]
  onChange: (sel: DisplayableIdentity[]) => void
  excludeKeys?: string[]
  single?: boolean
}

const KEY_RE = /^(02|03)[0-9a-fA-F]{64}$/

function isDirectKey (val: string): boolean {
  return KEY_RE.test(val.trim())
}

export function IdentityPicker ({ selected, onChange, excludeKeys = [], single = false }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DisplayableIdentity[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const excludeSet = new Set([
    ...excludeKeys,
    ...selected.map(s => s.identityKey),
  ])

  // Debounced search
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)

    const trimmed = query.trim()

    // Direct key entry — skip search
    if (isDirectKey(trimmed)) {
      setResults([])
      setSearching(false)
      setOpen(true)
      return
    }

    if (trimmed.length < 2) {
      setResults([])
      setSearching(false)
      setOpen(false)
      return
    }

    setSearching(true)
    setOpen(true)

    timerRef.current = setTimeout(async () => {
      try {
        const hits = await searchIdentities(trimmed)
        setResults(hits.filter(h => !excludeSet.has(h.identityKey)))
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  // Close on outside click
  useEffect(() => {
    function handlePointerDown (e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const addIdentity = useCallback((id: DisplayableIdentity) => {
    if (single) {
      onChange([id])
    } else {
      onChange([...selected, id])
    }
    setQuery('')
    setOpen(false)
    setResults([])
    inputRef.current?.focus()
  }, [single, selected, onChange])

  const addByKey = useCallback((key: string) => {
    const synth: DisplayableIdentity = {
      identityKey: key,
      name: '',
      avatarURL: '',
      abbreviatedKey: `${key.slice(0, 6)}…${key.slice(-4)}`,
      badgeIconURL: '',
      badgeLabel: '',
      badgeClickURL: '',
    }
    addIdentity(synth)
  }, [addIdentity])

  const removeIdentity = useCallback((key: string) => {
    onChange(selected.filter(s => s.identityKey !== key))
  }, [selected, onChange])

  function handleKeyDown (e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = query.trim()
      if (isDirectKey(trimmed) && !excludeSet.has(trimmed)) {
        addByKey(trimmed)
        return
      }
      if (results.length > 0) {
        addIdentity(results[0])
      }
    }
  }

  const trimmedQuery = query.trim()
  const showDirectAdd = isDirectKey(trimmedQuery) && !excludeSet.has(trimmedQuery)

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Search input */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          ref={inputRef}
          className="input"
          placeholder="Search identities…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => {
            if (query.trim().length >= 2 || isDirectKey(query.trim())) setOpen(true)
          }}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
          style={{ paddingRight: searching ? 40 : 14 }}
        />
        {searching && (
          <span
            className="spinner"
            style={{
              position: 'absolute',
              right: 12,
              width: 16,
              height: 16,
              borderWidth: 2,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div
          className="panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            right: 0,
            zIndex: 100,
            padding: 0,
            overflow: 'hidden',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {showDirectAdd && (
            <button
              type="button"
              className="ip-row"
              onClick={() => addByKey(trimmedQuery)}
              style={rowStyle}
            >
              <AvatarChip identityKey={trimmedQuery} size={28} showName={false} />
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-dim)' }}>
                Add key <span style={{ fontFamily: 'monospace', color: 'var(--text)', wordBreak: 'break-all' }}>
                  {trimmedQuery.slice(0, 12)}…{trimmedQuery.slice(-6)}
                </span>
              </span>
              <span style={addBadgeStyle}>Add</span>
            </button>
          )}

          {!showDirectAdd && results.length === 0 && !searching && (
            <div style={{ padding: '12px 16px', color: 'var(--text-dim)', fontSize: 13 }}>
              No matches — paste an identity key below
            </div>
          )}

          {results.map(id => (
            <button
              key={id.identityKey}
              type="button"
              onClick={() => addIdentity(id)}
              style={rowStyle}
            >
              <AvatarChip identityKey={id.identityKey} size={28} showName />
              <span style={addBadgeStyle}>Add</span>
            </button>
          ))}
        </div>
      )}

      {/* Selected chips (when not single mode) */}
      {!single && selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {selected.map(s => (
            <span
              key={s.identityKey}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--bg-raise)',
                border: '1px solid var(--panel-border)',
                borderRadius: 999,
                padding: '4px 8px 4px 6px',
              }}
            >
              <AvatarChip identityKey={s.identityKey} size={24} showName />
              <button
                type="button"
                onClick={() => removeIdentity(s.identityKey)}
                aria-label={`Remove ${s.name || s.identityKey}`}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  padding: '0 2px',
                  fontSize: 14,
                  lineHeight: 1,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px 16px',
  background: 'none',
  border: 'none',
  borderBottom: '1px solid var(--panel-border)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--text)',
}

const addBadgeStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--accent)',
  background: 'rgba(56,224,255,0.1)',
  border: '1px solid rgba(56,224,255,0.25)',
  borderRadius: 6,
  padding: '2px 8px',
  flexShrink: 0,
}
