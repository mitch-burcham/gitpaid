import { MessageBoxClient } from '@bsv/message-box-client'
import { wallet } from './wallet'
import { CROWD_BOX, MESSAGEBOX_HOST, type CrowdMessage } from './protocol'
import { isCrowdMessage } from './protocol'

export const mbx = new MessageBoxClient({ walletClient: wallet, host: MESSAGEBOX_HOST })

/**
 * Fan a message out to every party INCLUDING self — the copy in our own box
 * is the durable record of our own actions (no local persistence).
 * All sends settle; returns identity keys that FAILED.
 */
export async function fanOut (
  msg: CrowdMessage,
  recipients: string[],
): Promise<string[]> {
  const targets = [...new Set(recipients)]

  const results = await Promise.allSettled(
    targets.map(recipient =>
      mbx.sendMessage({ recipient, messageBox: CROWD_BOX, body: msg })
    )
  )

  const failed: string[] = []
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      failed.push(targets[i])
    }
  }
  return failed
}

/**
 * Parse a PeerMessage body into a plain object, guarding against JSON strings.
 */
function parseBody (raw: string | Record<string, unknown>): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  }
  return raw
}

export interface InboxItem {
  msg: CrowdMessage
  messageId: string
}

/**
 * Read the inbox WITHOUT acknowledging: MessageBox is the source of truth, so
 * messages stay on the relay and state is rebuilt from them on every load.
 * Returns parsed items sorted by created_at ascending, with messageIds kept
 * for later garbage collection via ackMessages.
 */
export async function readInbox (): Promise<InboxItem[]> {
  const messages = await mbx.listMessages({ messageBox: CROWD_BOX })

  const parsed: Array<{ item: InboxItem; created_at: string }> = []

  for (const m of messages) {
    try {
      const body = parseBody(m.body)
      if (isCrowdMessage(body)) {
        parsed.push({ item: { msg: body, messageId: m.messageId }, created_at: m.created_at })
      }
    } catch {
      // skip unparseable
    }
  }

  return parsed
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map(p => p.item)
}

/**
 * Garbage collection: acknowledging DELETES messages from the relay. Only
 * call for escrows in a terminal state the user has chosen to clear.
 */
export async function ackMessages (messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return
  await mbx.acknowledgeMessage({ messageIds })
}

/**
 * Live updates: websocket listen on CROWD_BOX.
 * Parsed CrowdMessages go to onMessage; messages are NOT acknowledged (the
 * relay copy is the durable record). Returns an async cleanup function.
 */
export async function listenLive (
  onMessage: (item: InboxItem) => void,
): Promise<() => Promise<void>> {
  try {
    await mbx.listenForLiveMessages({
      messageBox: CROWD_BOX,
      onMessage: (m) => {
        try {
          const body = parseBody(m.body)
          if (isCrowdMessage(body)) {
            onMessage({ msg: body, messageId: m.messageId })
          }
        } catch {
          // skip
        }
      },
    })
  } catch (e) {
    // The underlying socket.io manager retries forever by default; if the
    // host doesn't support websockets that means an endless reconnect loop.
    // Tear the socket down so callers can fall back to polling.
    await mbx.disconnectWebSocket().catch(() => {})
    throw e
  }

  return async (): Promise<void> => {
    await mbx.leaveRoom(CROWD_BOX)
    await mbx.disconnectWebSocket().catch(() => {})
  }
}
