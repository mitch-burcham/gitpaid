import { MessageBoxClient } from '@bsv/message-box-client'
import { wallet } from './wallet'
import { CROWD_BOX, MESSAGEBOX_HOST, type CrowdMessage } from './protocol'
import { isCrowdMessage } from './protocol'

export const mbx = new MessageBoxClient({ walletClient: wallet, host: MESSAGEBOX_HOST })

/**
 * Fan a message out to every party except self.
 * All sends settle; returns identity keys that FAILED.
 */
export async function fanOut (
  msg: CrowdMessage,
  recipients: string[],
  ownKey: string,
): Promise<string[]> {
  // Remove self and dedupe
  const targets = [...new Set(recipients.filter(r => r !== ownKey))]

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

/**
 * Drain inbox: list, parse, filter via isCrowdMessage, ack only successfully
 * parsed message ids, return parsed messages sorted by created_at ascending.
 */
export async function drainInbox (): Promise<CrowdMessage[]> {
  const messages = await mbx.listMessages({ messageBox: CROWD_BOX })

  const parsed: Array<{ id: string; created_at: string; msg: CrowdMessage }> = []

  for (const m of messages) {
    try {
      const body = parseBody(m.body)
      if (isCrowdMessage(body)) {
        parsed.push({ id: m.messageId, created_at: m.created_at, msg: body })
      }
    } catch {
      // skip unparseable
    }
  }

  if (parsed.length > 0) {
    try {
      await mbx.acknowledgeMessage({ messageIds: parsed.map(p => p.id) })
    } catch {
      // ack failure shouldn't lose the returned messages
    }
  }

  return parsed
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map(p => p.msg)
}

/**
 * Live updates: websocket listen on CROWD_BOX.
 * Parsed CrowdMessages go to onMessage; each is ack'd on arrival.
 * Returns an async cleanup function.
 */
export async function listenLive (
  onMessage: (m: CrowdMessage) => void,
): Promise<() => Promise<void>> {
  await mbx.listenForLiveMessages({
    messageBox: CROWD_BOX,
    onMessage: (m) => {
      try {
        const body = parseBody(m.body)
        if (isCrowdMessage(body)) {
          onMessage(body)
          mbx.acknowledgeMessage({ messageIds: [m.messageId] }).catch(() => {})
        }
      } catch {
        // skip
      }
    },
  })

  return async (): Promise<void> => {
    await mbx.leaveRoom(CROWD_BOX)
  }
}
