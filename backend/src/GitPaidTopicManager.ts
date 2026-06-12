import type { TopicManager } from '@bsv/overlay'
import { Transaction, type AdmittanceInstructions } from '@bsv/sdk'
import { GitPaidEscrow } from '@engine/GitPaidEscrow'

/** SR-007: dust-spam floor. Node-configurable via constructor. */
export const DEFAULT_MIN_SATOSHIS = 1000

/**
 * tm_gitpaid — admits GitPaidEscrow outputs (SR-004).
 *
 * Admittance is a full STRUCTURAL parse of the locking script via
 * GitPaidEscrow.parse — never a prefix match (the gitpaidv3 bug). An output
 * is admitted iff:
 *   1. the script parses as the exact GitPaidEscrow template, AND
 *   2. the binding decodes (version, IDs, funder key, slug), AND
 *   3. satoshis ≥ minSatoshis (SR-007).
 *
 * Rejections are SILENT per-output (no log spam on hostile txs — eng review
 * code-quality finding 2); a counter is kept for observability.
 */
export class GitPaidTopicManager implements TopicManager {
  rejectedOutputs = 0

  constructor (private readonly minSatoshis: number = DEFAULT_MIN_SATOSHIS) {}

  async identifyAdmissibleOutputs (
    beef: number[],
    previousCoins: number[],
  ): Promise<AdmittanceInstructions> {
    const outputsToAdmit: number[] = []

    try {
      const tx = Transaction.fromBEEF(beef)
      for (const [index, output] of tx.outputs.entries()) {
        const parsed = GitPaidEscrow.parse(output.lockingScript)
        if (parsed === null) {
          this.rejectedOutputs++
          continue
        }
        if ((output.satoshis ?? 0) < this.minSatoshis) {
          this.rejectedOutputs++
          continue
        }
        outputsToAdmit.push(index)
      }
    } catch {
      // Malformed BEEF: admit nothing, retain previous coins. Never throw —
      // a hostile submission must not take the topic down.
    }

    return {
      outputsToAdmit,
      coinsToRetain: previousCoins,
    }
  }

  async getDocumentation (): Promise<string> {
    return `# GitPaid Topic Manager (tm_gitpaid)

Admits GitPaidEscrow outputs: an N-of-M CrowdEscrow script prefixed with a
PUSHDATA(issue binding) OP_DROP commitment welding the escrow to a specific
GitHub issue (immutable numeric repo/issue IDs + display slug + funder key).

Admittance rules:
1. Locking script structurally parses as the GitPaidEscrow template
   (binding prefix + IF multisig / ELSE refund-P2PKH / ENDIF).
2. The binding payload decodes under the versioned codec.
3. Output value >= ${this.minSatoshis} satoshis (dust-spam floor).

Spends of admitted outputs (release or cancel) evict the escrow from
discovery. Submit spending transactions to this topic to trigger eviction;
a chain-side reconciliation sweep covers out-of-band spends.`
  }

  async getMetaData (): Promise<{ name: string, shortDescription: string, version?: string, informationURL?: string }> {
    return {
      name: 'GitPaid Topic Manager',
      shortDescription: 'GitHub issue bounties as non-custodial BSV escrows',
      version: '0.1.0',
      informationURL: 'https://github.com/mitch-burcham/gitpaid',
    }
  }
}
