import { describe, it, expect, vi } from 'vitest'
import { PrivateKey, Transaction, type WalletInterface } from '@bsv/sdk'
import { GitPaidEscrow } from './GitPaidEscrow'
import { BINDING_VERSION, type IssueBinding } from './binding'
import { CROWD_BOX } from './protocol'
import {
  createGitPaidEscrow, cancelGitPaidEscrow, submitToOverlay,
  GITPAID_BASKET, GITPAID_BOX, TM_GITPAID,
} from './gitpaidEscrowOps'

const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
const otherIdentity = PrivateKey.fromRandom().toPublicKey().toString()

const binding: IssueBinding = {
  version: BINDING_VERSION,
  repoId: 12,
  issueId: 3456,
  issueNumber: 8,
  funderIdentityKey: identityKey,
  slug: 'acme/widgets',
}

/**
 * Mock wallet: deterministic derived keys, createAction echoes a real tx
 * containing the requested outputs (what a BRC-100 wallet does, minus
 * funding inputs), and every call is recorded for coupling assertions.
 */
function mockWallet (): { wallet: WalletInterface, calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { getPublicKey: [], createAction: [], listOutputs: [] }
  const derived = new Map<string, string>()

  const wallet = {
    getPublicKey: async (args: Record<string, unknown>) => {
      calls.getPublicKey.push(args)
      if (args.identityKey === true) return { publicKey: identityKey }
      const cacheKey = JSON.stringify(args)
      if (!derived.has(cacheKey)) {
        derived.set(cacheKey, PrivateKey.fromRandom().toPublicKey().toString())
      }
      return { publicKey: derived.get(cacheKey) }
    },
    createAction: async (args: { outputs?: Array<{ lockingScript: string, satoshis: number }> }) => {
      calls.createAction.push(args)
      const tx = new Transaction()
      for (const o of args.outputs ?? []) {
        tx.addOutput({
          lockingScript: (await import('@bsv/sdk')).LockingScript.fromHex(o.lockingScript),
          satoshis: o.satoshis,
        })
      }
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    },
    listOutputs: async (args: unknown) => {
      calls.listOutputs.push(args)
      return { totalOutputs: 0, outputs: [] }
    },
  } as unknown as WalletInterface

  return { wallet, calls }
}

describe('gitpaidEscrowOps (TC-016)', () => {
  it('box and basket are isolated from Crowd (P1-7)', () => {
    expect(GITPAID_BOX).not.toBe(CROWD_BOX)
    expect(GITPAID_BASKET).not.toBe('crowd escrow')
  })

  it('createGitPaidEscrow funds a parseable GitPaidEscrow output in the GITPAID_BASKET', async () => {
    const { wallet, calls } = mockWallet()
    const invite = await createGitPaidEscrow(
      { satoshis: 5000, threshold: 1, controllerIdentityKeys: [], binding },
      wallet,
    )

    // Basket coupling — the create side
    const action = calls.createAction[0] as { outputs: Array<{ basket: string, lockingScript: string, customInstructions: string }> }
    expect(action.outputs[0].basket).toBe(GITPAID_BASKET)

    // The locking script is a structurally valid 1-of-1 GitPaidEscrow with our binding
    const { LockingScript } = await import('@bsv/sdk')
    const parsed = GitPaidEscrow.parse(LockingScript.fromHex(action.outputs[0].lockingScript))
    expect(parsed).not.toBeNull()
    expect(parsed?.threshold).toBe(1)
    expect(parsed?.total).toBe(1)
    expect(parsed?.binding).toEqual(binding)

    // customInstructions carry everything cancel needs
    const ci = JSON.parse(action.outputs[0].customInstructions) as Record<string, unknown>
    expect(ci).toHaveProperty('keyID')
    expect(ci).toHaveProperty('refund')
    expect(ci.binding).toEqual(binding)

    // Invite is a valid InviteMsg shape (engine functions accept it)
    expect(invite.type).toBe('invite')
    expect(invite.escrowId.endsWith('.0')).toBe(true)
    expect(invite.controllers).toEqual([identityKey])
    expect(invite.pubkeys).toHaveLength(1)
    expect(invite.name).toBe('acme/widgets#8')
    expect(invite.binding).toEqual(binding)
  })

  it('builds N-of-M with deduped controllers (self always included once)', async () => {
    const { wallet } = mockWallet()
    const invite = await createGitPaidEscrow(
      { satoshis: 5000, threshold: 2, controllerIdentityKeys: [otherIdentity, identityKey], binding },
      wallet,
    )
    expect(invite.controllers).toEqual([identityKey, otherIdentity])
    expect(invite.threshold).toBe(2)
    expect(invite.pubkeys).toHaveLength(2)
  })

  it('cancelGitPaidEscrow looks up the SAME basket constant (coupling pin)', async () => {
    const { wallet, calls } = mockWallet()
    const invite = await createGitPaidEscrow(
      { satoshis: 5000, threshold: 1, controllerIdentityKeys: [], binding },
      wallet,
    )
    // Empty wallet → must throw the sponsor-only error, AFTER querying
    // exactly the GitPaid basket
    await expect(cancelGitPaidEscrow(invite, wallet)).rejects.toThrow(/sponsor/)
    const listArgs = calls.listOutputs[0] as { basket: string }
    expect(listArgs.basket).toBe(GITPAID_BASKET)
  })

  it('submitToOverlay posts BEEF to /submit with the tm_gitpaid topic header', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await submitToOverlay('http://overlay.test/', [1, 2, 3], fetchFn)
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://overlay.test/submit')
    const headers = init.headers as Record<string, string>
    expect(JSON.parse(headers['x-topics'])).toEqual([TM_GITPAID])
    expect(headers['Content-Type']).toBe('application/octet-stream')
  })

  it('submitToOverlay throws loudly on overlay errors', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(submitToOverlay('http://overlay.test', [1], fetchFn)).rejects.toThrow(/500/)
  })
})
