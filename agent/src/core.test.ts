import { describe, it, expect, vi } from 'vitest'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { GitPaidEscrow } from '@engine/GitPaidEscrow'
import { BINDING_VERSION, type IssueBinding } from '@engine/binding'
import {
  parseBountyOutput, parseBountyAnswer, GitPaidAgentClient, isClaimMsg,
  GITPAID_BOX, type AgentWallet, type AgentMessageBox,
} from './core.js'

const sponsorKey = PrivateKey.fromRandom()
const sponsorPub = sponsorKey.toPublicKey()
const agentKey = PrivateKey.fromRandom()
const agentPub = agentKey.toPublicKey()
const refundPub = PrivateKey.fromRandom().toPublicKey()

const binding: IssueBinding = {
  version: BINDING_VERSION,
  repoId: 314,
  issueId: 27182,
  issueNumber: 9,
  funderIdentityKey: sponsorPub.toString(),
  slug: 'acme/widgets',
}

function bountyTx (total: 1 | 2 = 1, satoshis = 5000): Transaction {
  const pubs = total === 1 ? [sponsorPub] : [sponsorPub, agentPub]
  const tx = new Transaction()
  tx.addOutput({ lockingScript: GitPaidEscrow.lock(pubs, total === 1 ? 1 : 2, refundPub, binding), satoshis })
  return tx
}

function answerFor (...txs: Transaction[]): { type: string, outputs: Array<{ beef: number[], outputIndex: number }> } {
  return { type: 'output-list', outputs: txs.map(tx => ({ beef: tx.toBEEF(), outputIndex: 0 })) }
}

describe('parseBountyOutput / parseBountyAnswer (TC-017)', () => {
  it('decodes a bounty with badge semantics — sats, protection, binding', () => {
    const tx = bountyTx(1, 7777)
    const info = parseBountyOutput(tx.toBEEF(), 0)
    expect(info).not.toBeNull()
    expect(info?.escrowId).toBe(`${tx.id('hex')}.0`)
    expect(info?.satoshis).toBe(7777)
    expect(info?.protection).toBe('revocable')
    expect(info?.issueId).toBe(27182)
    expect(info?.untrusted.slug).toBe('acme/widgets')
  })

  it('marks N>=2 escrows protected', () => {
    const info = parseBountyOutput(bountyTx(2).toBEEF(), 0)
    expect(info?.protection).toBe('protected')
  })

  it('returns null for non-GitPaid outputs and garbage', () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(agentPub.toAddress()), satoshis: 100 })
    expect(parseBountyOutput(tx.toBEEF(), 0)).toBeNull()
    expect(parseBountyOutput(tx.toBEEF(), 5)).toBeNull() // out of range
    expect(parseBountyOutput([1, 2, 3], 0)).toBeNull() // garbage BEEF
  })

  it('parseBountyAnswer drops non-conforming outputs and tolerates junk answers', () => {
    const good = bountyTx()
    const bad = new Transaction()
    bad.addOutput({ lockingScript: new P2PKH().lock(agentPub.toAddress()), satoshis: 1 })
    const bounties = parseBountyAnswer(answerFor(good, bad))
    expect(bounties).toHaveLength(1)
    expect(parseBountyAnswer({ type: 'freeform' })).toEqual([])
    expect(parseBountyAnswer({ type: 'output-list' })).toEqual([])
  })
})

describe('GitPaidAgentClient (TC-017)', () => {
  function mockFetch (answer: unknown, status = 200): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify(answer), { status })) as unknown as typeof fetch
  }

  it('discovery is wallet-less (BR-007): lookup works with no wallet/mbx', async () => {
    const client = new GitPaidAgentClient({ overlayUrl: 'http://overlay.test', fetchFn: mockFetch(answerFor(bountyTx())) })
    const bounties = await client.listAllActive()
    expect(bounties).toHaveLength(1)
  })

  it('lookup posts the right ls_gitpaid question', async () => {
    const fetchFn = mockFetch(answerFor())
    const client = new GitPaidAgentClient({ overlayUrl: 'http://overlay.test/', fetchFn })
    await client.listByRepo({ slug: 'acme/widgets' })
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://overlay.test/lookup')
    expect(JSON.parse(init.body as string)).toEqual({
      service: 'ls_gitpaid',
      query: { type: 'findByRepo', slug: 'acme/widgets' },
    })
  })

  it('lookup throws loudly on overlay HTTP errors', async () => {
    const client = new GitPaidAgentClient({ overlayUrl: 'http://overlay.test', fetchFn: mockFetch({}, 503) })
    await expect(client.listAllActive()).rejects.toThrow(/503/)
  })

  it('claim sends to funder then self, with identity + PR (FR-016/AC-007)', async () => {
    const sent: Array<{ recipient: string, messageBox: string, body: unknown }> = []
    const wallet: AgentWallet = { getPublicKey: async () => ({ publicKey: agentPub.toString() }) }
    const mbx: AgentMessageBox = {
      sendMessage: async (args) => { sent.push(args); return {} },
      listMessages: async () => [],
    }
    const client = new GitPaidAgentClient({ overlayUrl: 'http://o.test', fetchFn: mockFetch(answerFor(bountyTx())), wallet, mbx })
    const [bounty] = await client.listAllActive()

    const claim = await client.claim(bounty, 'https://github.com/acme/widgets/pull/12', 'fixed')

    expect(sent).toHaveLength(2)
    expect(sent[0].recipient).toBe(sponsorPub.toString())
    expect(sent[1].recipient).toBe(agentPub.toString())
    expect(sent[0].messageBox).toBe(GITPAID_BOX)
    expect(claim.claimantIdentityKey).toBe(agentPub.toString())
    expect(claim.escrowId).toBe(bounty.escrowId)
    expect(isClaimMsg(JSON.parse(sent[0].body as string))).toBe(true)
  })

  it('claim self-copy failure does not fail the claim', async () => {
    const wallet: AgentWallet = { getPublicKey: async () => ({ publicKey: agentPub.toString() }) }
    let calls = 0
    const mbx: AgentMessageBox = {
      sendMessage: async () => {
        calls++
        if (calls === 2) throw new Error('relay hiccup')
        return {}
      },
      listMessages: async () => [],
    }
    const client = new GitPaidAgentClient({ overlayUrl: 'http://o.test', fetchFn: mockFetch(answerFor(bountyTx())), wallet, mbx })
    const [bounty] = await client.listAllActive()
    await expect(client.claim(bounty, 'https://x/pr/1')).resolves.toBeTruthy()
  })

  it('claim without wallet fails with the init hint', async () => {
    const client = new GitPaidAgentClient({ overlayUrl: 'http://o.test', fetchFn: mockFetch(answerFor(bountyTx())) })
    const [bounty] = await client.listAllActive()
    await expect(client.claim(bounty, 'https://x/pr/1')).rejects.toThrow(/gitpaid init/)
  })

  it('status rebuilds own claims from the inbox and reports active/spent (incl. merged-unpaid input)', async () => {
    const tx = bountyTx()
    const escrowId = `${tx.id('hex')}.0`
    const myClaim = {
      type: 'claim', escrowId, issueId: 27182, issueNumber: 9, satoshis: 5000,
      prUrl: 'https://x/pr/1', note: '', claimantIdentityKey: agentPub.toString(), createdAt: 1,
    }
    const otherClaim = { ...myClaim, claimantIdentityKey: sponsorPub.toString() }
    const wallet: AgentWallet = { getPublicKey: async () => ({ publicKey: agentPub.toString() }) }
    const mbx: AgentMessageBox = {
      sendMessage: async () => ({}),
      listMessages: async () => [
        { body: JSON.stringify(myClaim), sender: agentPub.toString() },
        { body: JSON.stringify(otherClaim), sender: sponsorPub.toString() },
        { body: 'not json {{', sender: 'junk' },
      ],
    }

    // Escrow still active → 'active'
    const activeClient = new GitPaidAgentClient({ overlayUrl: 'http://o.test', fetchFn: mockFetch(answerFor(tx)), wallet, mbx })
    const active = await activeClient.status()
    expect(active).toHaveLength(1) // only OUR claim
    expect(active[0].escrow).toBe('active')

    // Escrow gone from overlay → 'spent' (paid or cancelled — merged-unpaid
    // enrichment happens in the CLI with the GitHub API)
    const spentClient = new GitPaidAgentClient({ overlayUrl: 'http://o.test', fetchFn: mockFetch(answerFor()), wallet, mbx })
    const spent = await spentClient.status()
    expect(spent[0].escrow).toBe('spent')
  })

  it('status reports unknown when the overlay is unreachable, never throws', async () => {
    const wallet: AgentWallet = { getPublicKey: async () => ({ publicKey: agentPub.toString() }) }
    const myClaim = {
      type: 'claim', escrowId: 'aa.0', issueId: 1, issueNumber: 1, satoshis: 1,
      prUrl: 'https://x', note: '', claimantIdentityKey: agentPub.toString(), createdAt: 1,
    }
    const mbx: AgentMessageBox = {
      sendMessage: async () => ({}),
      listMessages: async () => [{ body: JSON.stringify(myClaim), sender: agentPub.toString() }],
    }
    const failFetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const client = new GitPaidAgentClient({ overlayUrl: 'http://down.test', fetchFn: failFetch, wallet, mbx })
    const results = await client.status()
    expect(results[0].escrow).toBe('unknown')
  })
})
