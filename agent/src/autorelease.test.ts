import { describe, it, expect, vi } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { parsePrUrl, checkPrMerged, runAutoreleaseOnce } from './autorelease.js'
import { buildSponsorState } from './sponsor.js'

const sponsor = PrivateKey.fromRandom().toPublicKey().toString()
const claimant = PrivateKey.fromRandom().toPublicKey().toString()

function ghFetch (status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch
}

describe('parsePrUrl (TC-019)', () => {
  it('parses canonical PR URLs', () => {
    expect(parsePrUrl('https://github.com/acme/widgets/pull/42')).toEqual({ owner: 'acme', repo: 'widgets', number: 42 })
    expect(parsePrUrl('https://github.com/acme/widgets/pull/42/')).toEqual({ owner: 'acme', repo: 'widgets', number: 42 })
  })

  it('rejects everything else (untrusted input — SR-008 adjacent)', () => {
    expect(parsePrUrl('https://evil.com/acme/widgets/pull/42')).toBeNull()
    expect(parsePrUrl('https://github.com/acme/widgets/issues/42')).toBeNull()
    expect(parsePrUrl('https://github.com/acme/widgets/pull/42/files')).toBeNull()
    expect(parsePrUrl('not a url')).toBeNull()
    expect(parsePrUrl('javascript:alert(1)')).toBeNull()
  })
})

describe('checkPrMerged (TC-019, TR-010)', () => {
  const pr = { owner: 'acme', repo: 'widgets', number: 7 }

  it('204 → merged, 404 → unmerged, 403/429 → backoff', async () => {
    expect(await checkPrMerged(pr, undefined, ghFetch(204))).toBe('merged')
    expect(await checkPrMerged(pr, undefined, ghFetch(404))).toBe('unmerged')
    expect(await checkPrMerged(pr, undefined, ghFetch(403))).toBe('backoff')
    expect(await checkPrMerged(pr, undefined, ghFetch(429))).toBe('backoff')
  })

  it('sends the PAT as a Bearer header when provided, none otherwise', async () => {
    const fetchFn = ghFetch(204)
    await checkPrMerged(pr, 'ghp_token', fetchFn)
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_token')

    const noTokenFetch = ghFetch(204)
    await checkPrMerged(pr, undefined, noTokenFetch)
    const [, init2] = (noTokenFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect((init2.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('unexpected statuses throw loudly', async () => {
    await expect(checkPrMerged(pr, undefined, ghFetch(500))).rejects.toThrow(/500/)
  })
})

describe('runAutoreleaseOnce (TC-019, FR-022/AC-011)', () => {
  const base = {
    escrowId: 'aa.0',
    claimantIdentityKey: claimant,
    prUrl: 'https://github.com/acme/widgets/pull/1',
    threshold: 1,
    controllers: 1,
  }

  it('releases when the PR is merged, with the claimant as recipient', async () => {
    const release = vi.fn(async () => ({ txid: 'feed'.repeat(16) }))
    const results = await runAutoreleaseOnce({ pending: [base], fetchFn: ghFetch(204), release })
    expect(results[0].outcome).toBe('released')
    expect(release).toHaveBeenCalledWith('aa.0', claimant)
  })

  it('does not release unmerged PRs', async () => {
    const release = vi.fn()
    const results = await runAutoreleaseOnce({ pending: [base], fetchFn: ghFetch(404), release })
    expect(results[0].outcome).toBe('unmerged')
    expect(release).not.toHaveBeenCalled()
  })

  it('backs off on rate limits without releasing or throwing', async () => {
    const release = vi.fn()
    const results = await runAutoreleaseOnce({ pending: [base], fetchFn: ghFetch(429), release })
    expect(results[0].outcome).toBe('backoff')
    expect(release).not.toHaveBeenCalled()
  })

  it('skips multi-controller escrows (unattended signing is 1-of-1 only)', async () => {
    const release = vi.fn()
    const results = await runAutoreleaseOnce({
      pending: [{ ...base, threshold: 2, controllers: 3 }],
      fetchFn: ghFetch(204),
      release,
    })
    expect(results[0].outcome).toBe('skipped-multisig')
    expect(release).not.toHaveBeenCalled()
  })

  it('skips non-GitHub PR URLs and release errors never abort the tick', async () => {
    const release = vi.fn(async () => { throw new Error('wallet offline') })
    const results = await runAutoreleaseOnce({
      pending: [
        { ...base, prUrl: 'https://evil.com/x/pull/1' },
        base,
        { ...base, escrowId: 'bb.0' },
      ],
      fetchFn: ghFetch(204),
      release,
    })
    expect(results.map(r => r.outcome)).toEqual(['skipped-bad-pr', 'error', 'error'])
  })
})

describe('buildSponsorState (SR-006-adjacent sender validation)', () => {
  const invite = {
    type: 'invite', escrowId: 'aa.0', beef: '00', satoshis: 5000, threshold: 1,
    keyID: 'k', originator: sponsor, controllers: [sponsor], pubkeys: ['p'],
    refundPkh: 'r', name: 'acme/widgets#1', createdAt: 1,
    binding: { version: 1, repoId: 1, issueId: 1, issueNumber: 1, funderIdentityKey: sponsor, slug: 'acme/widgets' },
  }
  const claim = {
    type: 'claim', escrowId: 'aa.0', issueId: 1, issueNumber: 1, satoshis: 5000,
    prUrl: 'https://github.com/acme/widgets/pull/1', note: '', claimantIdentityKey: claimant, createdAt: 2,
  }
  const accept = { type: 'accept', escrowId: 'aa.0', claimantIdentityKey: claimant, prUrl: claim.prUrl, createdAt: 3 }

  it('trusts invites/accepts only from self; claims only from their claimant', () => {
    const state = buildSponsorState([
      { body: JSON.stringify(invite), sender: sponsor },
      { body: JSON.stringify(claim), sender: claimant },
      { body: JSON.stringify(accept), sender: sponsor },
      // FORGERIES — wrong senders, must all be dropped:
      { body: JSON.stringify({ ...invite, escrowId: 'forged.0' }), sender: claimant },
      { body: JSON.stringify({ ...accept, escrowId: 'forged.0' }), sender: claimant },
      { body: JSON.stringify({ ...claim, claimantIdentityKey: 'someone-else' }), sender: claimant },
      { body: 'garbage {{', sender: sponsor },
    ], sponsor)

    expect([...state.invites.keys()]).toEqual(['aa.0'])
    expect([...state.accepts.keys()]).toEqual(['aa.0'])
    expect(state.claims).toHaveLength(1)
    expect(state.claims[0].claimantIdentityKey).toBe(claimant)
  })

  it('latest accept per escrow wins', () => {
    const later = { ...accept, claimantIdentityKey: 'newer-claimant', createdAt: 9 }
    const state = buildSponsorState([
      { body: JSON.stringify(accept), sender: sponsor },
      { body: JSON.stringify(later), sender: sponsor },
    ], sponsor)
    expect(state.accepts.get('aa.0')?.claimantIdentityKey).toBe('newer-claimant')
  })
})
