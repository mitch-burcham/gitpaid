import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { applyAndSave, emptyState, loadState, type CrowdState } from '../lib/store'
import { type CrowdMessage } from '../lib/protocol'
import { getOwnIdentityKey } from '../lib/wallet'
import { drainInbox, listenLive } from '../lib/messages'

interface CrowdContextValue {
  ready: boolean
  ownKey: string
  state: CrowdState
  mbxError?: string
  dispatchMessages: (msgs: CrowdMessage[]) => void
  refresh: () => Promise<void>
}

const CrowdContext = createContext<CrowdContextValue | null>(null)

export function CrowdProvider ({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [ownKey, setOwnKey] = useState('')
  const [state, setState] = useState<CrowdState>(emptyState)
  const [mbxError, setMbxError] = useState<string | undefined>(undefined)

  // Keep ownKey in a ref so callbacks always see the latest value without
  // becoming stale closures.
  const ownKeyRef = useRef('')

  // Keep cleanup fn from listenLive so we can call it on unmount.
  const cleanupRef = useRef<(() => Promise<void>) | null>(null)

  // Re-runs on every mount (StrictMode remounts included) so the live
  // subscription is always re-established; the cancelled flag plus an
  // idempotent reducer make a double init harmless.
  useEffect(() => {
    let cancelled = false

    async function init (): Promise<void> {
      // Step 1: authenticate + resolve identity key.
      const key = await getOwnIdentityKey()
      if (cancelled) return
      ownKeyRef.current = key
      setOwnKey(key)

      // Step 2: load persisted state.
      const persisted = loadState(key)
      if (cancelled) return
      setState(persisted)

      // Step 3: drain inbox (best-effort).
      try {
        const msgs = await drainInbox()
        if (!cancelled) {
          setState(s => applyAndSave(ownKeyRef.current, s, msgs))
          setMbxError(undefined)
        }
      } catch (e) {
        if (!cancelled) {
          setMbxError(e instanceof Error ? e.message : String(e))
        }
      }

      // Step 4: mark ready regardless of inbox outcome.
      if (!cancelled) setReady(true)

      // Step 5: open live subscription.
      try {
        const cleanup = await listenLive((m) => {
          setState(s => applyAndSave(ownKeyRef.current, s, [m]))
        })
        if (cancelled) {
          await cleanup()
        } else {
          cleanupRef.current = cleanup
        }
      } catch (e) {
        if (!cancelled) {
          setMbxError(e instanceof Error ? e.message : String(e))
        }
      }
    }

    init().catch((e: unknown) => {
      if (!cancelled) {
        setMbxError(e instanceof Error ? e.message : String(e))
        setReady(true)
      }
    })

    return () => {
      cancelled = true
      if (cleanupRef.current != null) {
        cleanupRef.current().catch(() => {})
        cleanupRef.current = null
      }
    }
  }, [])

  const dispatchMessages = useCallback((msgs: CrowdMessage[]) => {
    setState(s => applyAndSave(ownKeyRef.current, s, msgs))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const msgs = await drainInbox()
      setState(s => applyAndSave(ownKeyRef.current, s, msgs))
      setMbxError(undefined)
    } catch (e) {
      setMbxError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const value: CrowdContextValue = {
    ready,
    ownKey,
    state,
    mbxError,
    dispatchMessages,
    refresh,
  }

  return (
    <CrowdContext.Provider value={value}>
      {children}
    </CrowdContext.Provider>
  )
}

export function useCrowd (): CrowdContextValue {
  const ctx = useContext(CrowdContext)
  if (ctx === null) {
    throw new Error('useCrowd must be used within a CrowdProvider')
  }
  return ctx
}
