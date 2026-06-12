import { describe, it, expect, vi } from 'vitest'
import { PrivateKey, Transaction, Utils, ECDSA, BigNumber, type WalletInterface } from '@bsv/sdk'
import { GitPaidEscrow } from './GitPaidEscrow'
import { BINDING_VERSION, type IssueBinding } from './binding'
import { CROWD_BOX } from './protocol'
import {
  createGitPaidEscrow, cancelGitPaidEscrow, submitToOverlay, releaseSoloBounty,
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

describe('releaseSoloBounty (regression: live system test 2026-06-12)', () => {
  // The bug this guards: the original release delegated to the engine's
  // signProposal, which binds to the @engine/wallet SINGLETON (:3321) — not
  // the injected GitPaid wallet (:3322). Create derived keys from one wallet,
  // sign with another → signature never verified. Plus bsv-wallet-cli won't
  // credit a foreign escrow input, so we broadcast directly.

  it('signs with the INJECTED wallet and broadcasts a self-funded spend', async () => {
    // A real local keypair so the signature genuinely verifies.
    const multisigKey = PrivateKey.fromRandom()
    const recipientKey = PrivateKey.fromRandom().toPublicKey().toString()

    let broadcastTx: Transaction | undefined
    const wallet = {
      getPublicKey: async (args: Record<string, unknown>) => {
        if (args.identityKey === true) return { publicKey: identityKey }
        // multisig derivation (counterparty 'self') → our real key;
        // recipient BRC-29 derivation → any key
        if (Array.isArray(args.protocolID) && args.protocolID[1] === 'multi sig brc29') {
          return { publicKey: multisigKey.toPublicKey().toString() }
        }
        return { publicKey: PrivateKey.fromRandom().toPublicKey().toString() }
      },
      createSignature: async (args: { hashToDirectlySign: number[] }) => {
        // Sign the hash DIRECTLY with the multisig key (what bsv-wallet-cli does)
        const sig = ECDSA.sign(new BigNumber(args.hashToDirectlySign), multisigKey, true)
        return { signature: sig.toDER() as number[] }
      },
    } as unknown as WalletInterface

    // A funded GitPaidEscrow whose multisig pubkey IS our signing key
    const lock = GitPaidEscrow.lock([multisigKey.toPublicKey()], 1, PrivateKey.fromRandom().toPublicKey(), binding)
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: lock, satoshis: 5000 })
    const invite = {
      type: 'invite' as const, escrowId: `${fundingTx.id('hex')}.0`,
      beef: Utils.toHex(fundingTx.toAtomicBEEF()), satoshis: 5000, threshold: 1,
      keyID: 'k', originator: identityKey, controllers: [identityKey],
      pubkeys: [multisigKey.toPublicKey().toString()], refundPkh: '', name: 'n', createdAt: 1, binding,
    }

    // Capture the broadcast instead of hitting the network
    const origBroadcast = Transaction.prototype.broadcast
    Transaction.prototype.broadcast = (async function (this: Transaction) {
      broadcastTx = this
      return { status: 'success', txid: this.id('hex'), message: 'ok' }
    }) as typeof Transaction.prototype.broadcast
    try {
      let notified: { amount: unknown } | undefined
      const { txid } = await releaseSoloBounty(invite, recipientKey, {
        wallet,
        feeSats: 50,
        notifyPayment: async ({ body }) => { notified = JSON.parse(body) },
      })
      expect(txid).toHaveLength(64)
      // self-funded: 1 input (escrow), 1 output (payout = 5000 − 50)
      expect(broadcastTx?.inputs).toHaveLength(1)
      expect(broadcastTx?.outputs).toHaveLength(1)
      expect(broadcastTx?.outputs[0].satoshis).toBe(4950)
      // the escrow input carries a real unlocking script (signature attached)
      expect(broadcastTx?.inputs[0].unlockingScript?.toHex().length).toBeGreaterThan(0)
      // recipient gets a payment-token notification for `gitpaid receive`
      expect(notified?.amount).toBe(4950)
    } finally {
      Transaction.prototype.broadcast = origBroadcast
    }
  })

  it('rejects multi-controller escrows (1-of-1 only)', async () => {
    const invite = { type: 'invite' as const, escrowId: 'a.0', beef: '00', satoshis: 5000, threshold: 2,
      keyID: 'k', originator: identityKey, controllers: [identityKey, otherIdentity], pubkeys: ['p1', 'p2'],
      refundPkh: '', name: 'n', createdAt: 1, binding }
    await expect(releaseSoloBounty(invite, otherIdentity, { wallet: {} as WalletInterface }))
      .rejects.toThrow(/1-of-1/)
  })

  it('rejects a bounty too small to cover the fee', async () => {
    const multisigKey = PrivateKey.fromRandom()
    const wallet = {
      getPublicKey: async (a: Record<string, unknown>) => a.identityKey === true
        ? { publicKey: identityKey } : { publicKey: multisigKey.toPublicKey().toString() },
    } as unknown as WalletInterface
    const lock = GitPaidEscrow.lock([multisigKey.toPublicKey()], 1, PrivateKey.fromRandom().toPublicKey(), binding)
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: lock, satoshis: 30 })
    const invite = { type: 'invite' as const, escrowId: `${fundingTx.id('hex')}.0`,
      beef: Utils.toHex(fundingTx.toAtomicBEEF()), satoshis: 30, threshold: 1, keyID: 'k',
      originator: identityKey, controllers: [identityKey], pubkeys: [multisigKey.toPublicKey().toString()],
      refundPkh: '', name: 'n', createdAt: 1, binding }
    await expect(releaseSoloBounty(invite, otherIdentity, { wallet, feeSats: 50 }))
      .rejects.toThrow(/too small/)
  })
})
