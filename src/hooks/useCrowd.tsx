import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { applyMessages, emptyState, removeCancelledEscrows, type CrowdState } from '../lib/store'
import { type CrowdMessage } from '../lib/protocol'
import { getOwnIdentityKey } from '../lib/wallet'
import { readInbox, ackMessages, listenLive, type InboxItem } from '../lib/messages'

interface CrowdContextValue {
  ready: boolean
  ownKey: string
  state: CrowdState
  mbxError?: string
  dispatchMessages: (msgs: CrowdMessage[]) => void
  removeCancelledEscrows: () => void
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

  // relay messageIds per escrow, so clearing a finished escrow can garbage
  // collect (acknowledge = delete) its messages from the relay.
  const messageIdsRef = useRef(new Map<string, string[]>())

  // Keep cleanup fn from listenLive so we can call it on unmount.
  const cleanupRef = useRef<(() => Promise<void>) | null>(null)
  // Polling fallback when the relay doesn't support websockets.
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const trackIds = useCallback((items: InboxItem[]) => {
    for (const { msg, messageId } of items) {
      const ids = messageIdsRef.current.get(msg.escrowId) ?? []
      if (!ids.includes(messageId)) ids.push(messageId)
      messageIdsRef.current.set(msg.escrowId, ids)
    }
  }, [])

  // Full rebuild from the relay — MessageBox is the source of truth.
  const rebuild = useCallback(async () => {
    const items = await readInbox()
    messageIdsRef.current = new Map()
    trackIds(items)
    setState(applyMessages(emptyState, items.map(i => i.msg)))
  }, [trackIds])

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

      // Step 2: rebuild state from the inbox (best-effort).
      try {
        if (!cancelled) {
          await rebuild()
          setMbxError(undefined)
        }
      } catch (e) {
        if (!cancelled) {
          setMbxError(e instanceof Error ? e.message : String(e))
        }
      }

      // Step 3: mark ready regardless of inbox outcome.
      if (!cancelled) setReady(true)

      // Step 4: open live subscription; if the relay has no websocket
      // support, silently fall back to polling the inbox over HTTP.
      try {
        const cleanup = await listenLive((item) => {
          trackIds([item])
          setState(s => applyMessages(s, [item.msg]))
        })
        if (cancelled) {
          await cleanup()
        } else {
          cleanupRef.current = cleanup
        }
      } catch {
        if (!cancelled && pollTimerRef.current == null) {
          pollTimerRef.current = setInterval(() => {
            rebuild()
              .then(() => setMbxError(undefined))
              .catch(() => {}) // transient poll failures keep the last state
          }, 15_000)
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
      if (pollTimerRef.current != null) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [rebuild, trackIds])

  // Local echo for messages we just sent. Durability comes from the fan-out
  // including ourselves — the copy in our own box is re-read on next load.
  const dispatchMessages = useCallback((msgs: CrowdMessage[]) => {
    setState(s => applyMessages(s, msgs))
  }, [])

  // Clear cancelled escrows: garbage-collect their messages from the relay,
  // then drop them from state.
  const removeCancelledEscrowsFn = useCallback(() => {
    setState(s => {
      const cancelledIds = Object.entries(s.escrows)
        .filter(([, es]) => es.status === 'cancelled')
        .map(([id]) => id)
      const messageIds = cancelledIds.flatMap(id => messageIdsRef.current.get(id) ?? [])
      ackMessages(messageIds).catch(() => {})
      for (const id of cancelledIds) messageIdsRef.current.delete(id)
      return removeCancelledEscrows(s)
    })
  }, [])

  const refresh = useCallback(async () => {
    try {
      await rebuild()
      setMbxError(undefined)
    } catch (e) {
      setMbxError(e instanceof Error ? e.message : String(e))
    }
  }, [rebuild])

  const value: CrowdContextValue = {
    ready,
    ownKey,
    state,
    mbxError,
    dispatchMessages,
    removeCancelledEscrows: removeCancelledEscrowsFn,
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
