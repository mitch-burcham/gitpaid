/**
 * GitPaid agent client core (TR-009, FR-019).
 *
 * One shared core wrapped by both the CLI and the MCP server. Three layers:
 *
 *   1. Pure parsing — overlay lookup answers → BountyInfo, via the SAME
 *      GitPaidEscrow.parse the node used at admittance. The agent re-derives
 *      sats / revocable-vs-protected / binding from the script itself: no
 *      trust in node-side metadata.
 *   2. Discovery — wallet-LESS overlay queries (zero-sats hunting, BR-007).
 *   3. Claims — MessageBox 'claim' messages to the funder, fanned out to
 *      self for a durable record (Crowd's inbox-as-source-of-truth model).
 *
 * Wallet access is a standard BRC-100 WalletClient pointed at the
 * bsv-wallet-cli daemon, :3322 (ADR-004) — injected, never constructed here,
 * so tests run hermetically.
 *
 * SECURITY (SR-008): slug, note and prUrl fields originate from untrusted
 * sources (on-chain bindings anyone can write, claim messages anyone can
 * send). BountyInfo keeps them under `untrusted` so every consumer (CLI
 * formatting, MCP delimiting) handles them deliberately.
 */
import { Transaction, Utils } from '@bsv/sdk'
import { GitPaidEscrow } from '@engine/GitPaidEscrow'

export const GITPAID_BOX = 'gitpaid'
export const LS_GITPAID = 'ls_gitpaid'
export const DEFAULT_WALLET_URL = 'http://localhost:3322'

export interface BountyInfo {
  /** txid.vout of the escrow output. */
  escrowId: string
  satoshis: number
  threshold: number
  total: number
  /** 1-of-1 = revocable (sponsor holds both paths); N≥2 = protected. */
  protection: 'revocable' | 'protected'
  /** Immutable GitHub IDs — canonical. */
  repoId: number
  issueId: number
  issueNumber: number
  funderIdentityKey: string
  /** Attacker-controllable display fields — delimit before showing to a model. */
  untrusted: {
    slug: string
  }
}

export interface ClaimMsg {
  type: 'claim'
  escrowId: string
  /** Snapshot for status display without a re-query. */
  issueId: number
  issueNumber: number
  satoshis: number
  prUrl: string
  note: string
  claimantIdentityKey: string
  createdAt: number
}

export type GitPaidQuery =
  | { type: 'findByIssue', repoId?: number, issueId?: number, slug?: string, issueNumber?: number }
  | { type: 'findByRepo', repoId?: number, slug?: string }
  | { type: 'findAllActive' }

interface LookupOutputs {
  type: string
  outputs?: Array<{ beef: number[], outputIndex: number }>
}

/** Pure: decode one overlay output into a BountyInfo (null if not GitPaid). */
export function parseBountyOutput (beef: number[], outputIndex: number): BountyInfo | null {
  try {
    const tx = Transaction.fromBEEF(beef)
    const output = tx.outputs[outputIndex]
    if (output === undefined) return null
    const parsed = GitPaidEscrow.parse(output.lockingScript)
    if (parsed === null) return null
    return {
      escrowId: `${tx.id('hex')}.${outputIndex}`,
      satoshis: output.satoshis ?? 0,
      threshold: parsed.threshold,
      total: parsed.total,
      protection: parsed.total >= 2 ? 'protected' : 'revocable',
      repoId: parsed.binding.repoId,
      issueId: parsed.binding.issueId,
      issueNumber: parsed.binding.issueNumber,
      funderIdentityKey: parsed.binding.funderIdentityKey,
      untrusted: { slug: parsed.binding.slug },
    }
  } catch {
    return null
  }
}

/** Pure: decode a whole lookup answer; non-conforming outputs are dropped. */
export function parseBountyAnswer (answer: LookupOutputs): BountyInfo[] {
  if (answer?.type !== 'output-list' || !Array.isArray(answer.outputs)) return []
  return answer.outputs
    .map(o => parseBountyOutput(o.beef, o.outputIndex))
    .filter((b): b is BountyInfo => b !== null)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Minimal wallet surface the core needs (subset of BRC-100). */
export interface AgentWallet {
  getPublicKey: (args: { identityKey: true }) => Promise<{ publicKey: string }>
}

/** Minimal MessageBox surface (subset of MessageBoxClient). */
export interface AgentMessageBox {
  sendMessage: (args: { recipient: string, messageBox: string, body: string | object }) => Promise<unknown>
  listMessages: (args: { messageBox: string }) => Promise<Array<{ body: string | Record<string, unknown>, sender: string }>>
}

export interface GitPaidAgentOptions {
  overlayUrl: string
  fetchFn?: typeof fetch
  wallet?: AgentWallet
  mbx?: AgentMessageBox
}

export class GitPaidAgentClient {
  private readonly overlayUrl: string
  private readonly fetchFn: typeof fetch
  private readonly wallet?: AgentWallet
  private readonly mbx?: AgentMessageBox

  constructor (opts: GitPaidAgentOptions) {
    this.overlayUrl = opts.overlayUrl.replace(/\/$/, '')
    this.fetchFn = opts.fetchFn ?? fetch
    this.wallet = opts.wallet
    this.mbx = opts.mbx
  }

  /** Wallet-less discovery (BR-007). */
  async lookup (query: GitPaidQuery): Promise<BountyInfo[]> {
    const res = await this.fetchFn(`${this.overlayUrl}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: LS_GITPAID, query }),
    })
    if (!res.ok) {
      throw new Error(`overlay lookup failed: HTTP ${res.status}`)
    }
    const answer = await res.json() as LookupOutputs
    return parseBountyAnswer(answer)
  }

  async listByRepo (q: { repoId?: number, slug?: string }): Promise<BountyInfo[]> {
    return await this.lookup({ type: 'findByRepo', ...q })
  }

  async listByIssue (q: { repoId?: number, issueId?: number, slug?: string, issueNumber?: number }): Promise<BountyInfo[]> {
    return await this.lookup({ type: 'findByIssue', ...q })
  }

  async listAllActive (): Promise<BountyInfo[]> {
    return await this.lookup({ type: 'findAllActive' })
  }

  /**
   * Claim a bounty (FR-016): {identityKey, prUrl, note} → funder's gitpaid
   * box, fanned to self for the durable record. Requires wallet + relay.
   */
  async claim (bounty: BountyInfo, prUrl: string, note = ''): Promise<ClaimMsg> {
    if (this.wallet === undefined || this.mbx === undefined) {
      throw new Error('claim requires a wallet and MessageBox — run `gitpaid init` first')
    }
    const { publicKey } = await this.wallet.getPublicKey({ identityKey: true })
    const claim: ClaimMsg = {
      type: 'claim',
      escrowId: bounty.escrowId,
      issueId: bounty.issueId,
      issueNumber: bounty.issueNumber,
      satoshis: bounty.satoshis,
      prUrl,
      note,
      claimantIdentityKey: publicKey,
      createdAt: Date.now(),
    }
    const body = JSON.stringify(claim)
    // Funder first — if that send fails, the claim failed; the self-copy is
    // best-effort record-keeping.
    await this.mbx.sendMessage({ recipient: bounty.funderIdentityKey, messageBox: GITPAID_BOX, body })
    await this.mbx.sendMessage({ recipient: publicKey, messageBox: GITPAID_BOX, body }).catch(() => {})
    return claim
  }

  /**
   * Status of our own claims: rebuilt from our gitpaid box (inbox as source
   * of truth), enriched with whether the escrow is still active on the
   * overlay. `spent` means released OR cancelled — the spend tx, not the
   * relay, knows which; the wallet's payment inbox settles it.
   */
  async status (): Promise<Array<{ claim: ClaimMsg, escrow: 'active' | 'spent' | 'unknown' }>> {
    if (this.wallet === undefined || this.mbx === undefined) {
      throw new Error('status requires a wallet and MessageBox — run `gitpaid init` first')
    }
    const { publicKey } = await this.wallet.getPublicKey({ identityKey: true })
    const messages = await this.mbx.listMessages({ messageBox: GITPAID_BOX })

    const claims: ClaimMsg[] = []
    for (const m of messages) {
      const body = typeof m.body === 'string' ? safeParse(m.body) : m.body
      if (isClaimMsg(body) && body.claimantIdentityKey === publicKey) {
        claims.push(body)
      }
    }

    const results: Array<{ claim: ClaimMsg, escrow: 'active' | 'spent' | 'unknown' }> = []
    for (const claim of claims) {
      let escrow: 'active' | 'spent' | 'unknown' = 'unknown'
      try {
        const active = await this.listByIssue({ issueId: claim.issueId })
        escrow = active.some(b => b.escrowId === claim.escrowId) ? 'active' : 'spent'
      } catch {
        // overlay unreachable: report unknown, never break status (AC-003 spirit)
      }
      results.push({ claim, escrow })
    }
    return results
  }
}

function safeParse (raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function isClaimMsg (v: unknown): v is ClaimMsg {
  if (v === null || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (
    m.type === 'claim' &&
    typeof m.escrowId === 'string' &&
    typeof m.issueId === 'number' &&
    typeof m.prUrl === 'string' &&
    typeof m.claimantIdentityKey === 'string'
  )
}

/** Hex helper kept for CLI display parity with the engine. */
export const toHex = Utils.toHex
