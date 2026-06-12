import type { BountyStorage } from './types.js'

/**
 * Chain-side spent-status reconciliation sweep (OR-004, D10).
 *
 * The overlay only evicts on spends it is SHOWN (client submissions). Spends
 * made from other clients (e.g. the Crowd web app) would leave zombie
 * badges — this sweep closes that hole: every active outpoint is checked
 * against a chain source (WoC/ARC — IFR-005) and marked spent on a hit.
 *
 * The chain source is injected so tests run hermetically and the prod wiring
 * picks WoC vs ARC by config. Failures on individual outpoints are
 * non-fatal: the sweep reports them and the next run retries (NFR-005
 * budget: ≤60 min staleness for out-of-band spends at an hourly cadence).
 */
export type SpentChecker = (txid: string, outputIndex: number) => Promise<boolean>

export interface SweepResult {
  checked: number
  markedSpent: number
  errors: number
}

export async function reconcileSpentOutputs (
  storage: BountyStorage,
  isSpent: SpentChecker,
): Promise<SweepResult> {
  const outpoints = await storage.allActiveOutpoints()
  const result: SweepResult = { checked: 0, markedSpent: 0, errors: 0 }

  for (const { txid, outputIndex } of outpoints) {
    result.checked++
    try {
      if (await isSpent(txid, outputIndex)) {
        await storage.markSpent(txid, outputIndex)
        result.markedSpent++
      }
    } catch {
      result.errors++ // retried next sweep; never aborts the run
    }
  }

  return result
}

/** WhatsOnChain spent-status checker (prod default for IFR-005). */
export function wocSpentChecker (network: 'main' | 'test' = 'main', fetchFn: typeof fetch = fetch): SpentChecker {
  return async (txid, outputIndex) => {
    const res = await fetchFn(
      `https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}/${outputIndex}/spent`,
    )
    if (res.status === 404) return false // unspent
    if (!res.ok) throw new Error(`WoC spent check failed: ${res.status}`)
    const body = await res.json() as { txid?: string }
    return typeof body?.txid === 'string' && body.txid.length === 64
  }
}
