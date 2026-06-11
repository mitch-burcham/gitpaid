import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  emptyState,
  reduce,
  loadState,
  saveState,
  applyAndSave,
  type EscrowState,
} from './store'
import type { InviteMsg, ProposalMsg, SignatureMsg, VetoMsg, FinalizedMsg, CancelledMsg } from './protocol'
import { isCrowdMessage } from './protocol'

// Polyfill localStorage for Node (vitest runs in node by default)
if (typeof localStorage === 'undefined') {
  const store = new Map<string, string>()
  ;(globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

// --- fixture helpers ---

const CONTROLLERS: [string, string, string] = [
  'aabbcc0101',
  'aabbcc0202',
  'aabbcc0303',
]
const PUBKEYS: [string, string, string] = [
  'ddeeFF0101',
  'ddeeFF0202',
  'ddeeFF0303',
]

function makeInvite (overrides: Partial<InviteMsg> = {}): InviteMsg {
  return {
    type: 'invite',
    escrowId: 'deadbeef.0',
    beef: 'beefbeef',
    satoshis: 100000,
    threshold: 2,
    keyID: 'key1',
    originator: CONTROLLERS[0],
    controllers: [...CONTROLLERS],
    pubkeys: [...PUBKEYS],
    refundPkh: 'aabbccdd',
    name: 'Test Escrow',
    createdAt: 1000,
    ...overrides,
  }
}

function makeProposal (overrides: Partial<ProposalMsg> = {}): ProposalMsg {
  return {
    type: 'proposal',
    escrowId: 'deadbeef.0',
    proposalId: 'prop001',
    rawTx: 'rawtx001',
    note: 'pay bob',
    proposer: CONTROLLERS[0],
    createdAt: 2000,
    ...overrides,
  }
}

function makeSig (signer: string, overrides: Partial<SignatureMsg> = {}): SignatureMsg {
  return {
    type: 'signature',
    escrowId: 'deadbeef.0',
    proposalId: 'prop001',
    signer,
    sigHex: `sig_${signer}`,
    ...overrides,
  }
}

function makeVeto (vetoer: string, overrides: Partial<VetoMsg> = {}): VetoMsg {
  return {
    type: 'veto',
    escrowId: 'deadbeef.0',
    proposalId: 'prop001',
    vetoer,
    ...overrides,
  }
}

function makeFinalized (overrides: Partial<FinalizedMsg> = {}): FinalizedMsg {
  return {
    type: 'finalized',
    escrowId: 'deadbeef.0',
    proposalId: 'prop001',
    txid: 'finaltxid001',
    ...overrides,
  }
}

function makeCancelled (overrides: Partial<CancelledMsg> = {}): CancelledMsg {
  return {
    type: 'cancelled',
    escrowId: 'deadbeef.0',
    txid: 'canceltxid001',
    ...overrides,
  }
}

// --- tests ---

describe('reduce: invite', () => {
  it('creates escrow keyed by escrowId', () => {
    const state = reduce(emptyState, makeInvite())
    expect(state.escrows['deadbeef.0']).toBeDefined()
    const escrow: EscrowState = state.escrows['deadbeef.0']
    expect(escrow.status).toBe('active')
    expect(escrow.invite.name).toBe('Test Escrow')
    expect(escrow.proposals).toEqual({})
  })

  it('is idempotent — duplicate invite does not overwrite existing escrow state', () => {
    const s1 = reduce(emptyState, makeInvite())
    // add a proposal so we can detect if the escrow was reset
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeInvite())
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s3))
  })
})

describe('reduce: proposal', () => {
  it('adds proposal with status open and empty signatures/vetoes', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const p = s2.escrows['deadbeef.0'].proposals['prop001']
    expect(p).toBeDefined()
    expect(p.status).toBe('open')
    expect(p.signatures).toEqual({})
    expect(p.vetoes).toEqual({})
  })

  it('ignores proposal for unknown escrow', () => {
    const s = reduce(emptyState, makeProposal())
    expect(s).toBe(emptyState)
  })

  it('ignores proposal when escrow status is not active', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeCancelled())
    const s3 = reduce(s2, makeProposal())
    expect(s3.escrows['deadbeef.0'].proposals['prop001']).toBeUndefined()
  })

  it('ignores duplicate proposalId (idempotent)', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeSig(CONTROLLERS[0]))
    const s4 = reduce(s3, makeProposal()) // duplicate — should be ignored
    expect(JSON.stringify(s3)).toBe(JSON.stringify(s4))
  })
})

describe('reduce: signature', () => {
  it('accumulates signatures from two different controllers', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeSig(CONTROLLERS[0]))
    const s4 = reduce(s3, makeSig(CONTROLLERS[1]))
    const sigs = s4.escrows['deadbeef.0'].proposals['prop001'].signatures
    expect(sigs[CONTROLLERS[0]]).toBe(`sig_${CONTROLLERS[0]}`)
    expect(sigs[CONTROLLERS[1]]).toBe(`sig_${CONTROLLERS[1]}`)
  })

  it('ignores signature from a key not in controllers', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeSig('notacontroller'))
    expect(s3.escrows['deadbeef.0'].proposals['prop001'].signatures).toEqual({})
  })

  it('ignores signature on a vetoed proposal', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeVeto(CONTROLLERS[2]))
    const s4 = reduce(s3, makeSig(CONTROLLERS[0]))
    expect(s4.escrows['deadbeef.0'].proposals['prop001'].signatures).toEqual({})
  })

  it('duplicate signature from same signer overwrites (idempotent)', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeSig(CONTROLLERS[0]))
    const s4 = reduce(s3, makeSig(CONTROLLERS[0])) // same signer again
    const sigs = s4.escrows['deadbeef.0'].proposals['prop001'].signatures
    expect(Object.keys(sigs)).toHaveLength(1)
  })

  it('ignores signature for unknown proposal', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeSig(CONTROLLERS[0]))
    // no proposals exist yet — should silently return same state
    expect(s2.escrows['deadbeef.0'].proposals).toEqual({})
  })
})

describe('reduce: veto', () => {
  it('sets proposal status to vetoed and records reason', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeVeto(CONTROLLERS[2], { reason: 'bad deal' }))
    const p = s3.escrows['deadbeef.0'].proposals['prop001']
    expect(p.status).toBe('vetoed')
    expect(p.vetoes[CONTROLLERS[2]]).toBe('bad deal')
  })

  it('records empty string when reason is undefined', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeVeto(CONTROLLERS[2]))
    expect(s3.escrows['deadbeef.0'].proposals['prop001'].vetoes[CONTROLLERS[2]]).toBe('')
  })

  it('ignores veto from a key not in controllers', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeVeto('notacontroller'))
    expect(s3.escrows['deadbeef.0'].proposals['prop001'].status).toBe('open')
  })
})

describe('reduce: finalized', () => {
  it('marks proposal finalized, sets txids, marks escrow spent', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeFinalized())
    const escrow = s3.escrows['deadbeef.0']
    const p = escrow.proposals['prop001']
    expect(p.status).toBe('finalized')
    expect(p.txid).toBe('finaltxid001')
    expect(escrow.status).toBe('spent')
    expect(escrow.spentTxid).toBe('finaltxid001')
  })

  it('applies finalized even if proposal was previously vetoed (chain wins)', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeVeto(CONTROLLERS[0]))
    const s4 = reduce(s3, makeFinalized())
    expect(s4.escrows['deadbeef.0'].proposals['prop001'].status).toBe('finalized')
    expect(s4.escrows['deadbeef.0'].status).toBe('spent')
  })

  it('ignores finalized for unknown escrow', () => {
    const s = reduce(emptyState, makeFinalized())
    expect(s).toBe(emptyState)
  })

  it('ignores finalized for unknown proposal', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeFinalized())
    // no proposals — escrow should still be active
    expect(s2.escrows['deadbeef.0'].status).toBe('active')
  })
})

describe('reduce: cancelled', () => {
  it('marks escrow cancelled with spentTxid', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeCancelled())
    const escrow = s2.escrows['deadbeef.0']
    expect(escrow.status).toBe('cancelled')
    expect(escrow.spentTxid).toBe('canceltxid001')
  })

  it('ignores cancelled for unknown escrow', () => {
    const s = reduce(emptyState, makeCancelled())
    expect(s).toBe(emptyState)
  })
})

describe('purity', () => {
  it('reduce never mutates input state', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const before = JSON.stringify(s2)
    reduce(s2, makeSig(CONTROLLERS[0]))
    reduce(s2, makeVeto(CONTROLLERS[0]))
    reduce(s2, makeFinalized())
    const after = JSON.stringify(s2)
    expect(before).toBe(after)
  })
})

describe('localStorage helpers', () => {
  const OWN_KEY = 'testkey_abc'

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`crowd:${OWN_KEY}`)
    }
  })

  afterEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`crowd:${OWN_KEY}`)
    }
  })

  it('loadState returns emptyState when key is missing', () => {
    const s = loadState(OWN_KEY)
    expect(s).toEqual(emptyState)
  })

  it('saveState and loadState roundtrip', () => {
    const s1 = reduce(emptyState, makeInvite())
    saveState(OWN_KEY, s1)
    const loaded = loadState(OWN_KEY)
    expect(loaded).toEqual(s1)
  })

  it('loadState returns emptyState on corrupt JSON', () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`crowd:${OWN_KEY}`, 'not json {{{')
    }
    const s = loadState(OWN_KEY)
    expect(s).toEqual(emptyState)
  })
})

describe('applyAndSave', () => {
  const OWN_KEY = 'applykey_xyz'

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`crowd:${OWN_KEY}`)
    }
  })

  afterEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`crowd:${OWN_KEY}`)
    }
  })

  it('folds multiple messages in order and persists result', () => {
    const msgs = [
      makeInvite(),
      makeProposal(),
      makeSig(CONTROLLERS[0]),
      makeSig(CONTROLLERS[1]),
    ]
    const result = applyAndSave(OWN_KEY, emptyState, msgs)
    const sigs = result.escrows['deadbeef.0'].proposals['prop001'].signatures
    expect(sigs[CONTROLLERS[0]]).toBeDefined()
    expect(sigs[CONTROLLERS[1]]).toBeDefined()
    // verify it was saved
    const loaded = loadState(OWN_KEY)
    expect(loaded).toEqual(result)
  })

  it('returns current state unchanged when messages array is empty', () => {
    const s1 = reduce(emptyState, makeInvite())
    const result = applyAndSave(OWN_KEY, s1, [])
    expect(result).toEqual(s1)
  })
})

describe('reduce: cross-escrow isolation', () => {
  it('messages for escrow B do not affect escrow A', () => {
    const s1 = reduce(emptyState, makeInvite({ escrowId: 'aaa.0' }))
    const s2 = reduce(s1, makeInvite({ escrowId: 'bbb.0' }))
    const s3 = reduce(s2, makeProposal({ escrowId: 'bbb.0', proposalId: 'propB' }))
    expect(s3.escrows['aaa.0'].proposals).toEqual({})
    expect(s3.escrows['bbb.0'].proposals['propB']).toBeDefined()
  })
})

describe('reduce: signature on finalized proposal', () => {
  it('ignores a signature after finalization', () => {
    const s1 = reduce(emptyState, makeInvite())
    const s2 = reduce(s1, makeProposal())
    const s3 = reduce(s2, makeFinalized())
    const s4 = reduce(s3, makeSig(CONTROLLERS[1]))
    expect(s4).toBe(s3)
    expect(s4.escrows['deadbeef.0'].proposals['prop001'].signatures[CONTROLLERS[1]]).toBeUndefined()
  })
})

describe('isCrowdMessage', () => {
  it('rejects null, primitives, and unknown types', () => {
    expect(isCrowdMessage(null)).toBe(false)
    expect(isCrowdMessage(undefined)).toBe(false)
    expect(isCrowdMessage('invite')).toBe(false)
    expect(isCrowdMessage(42)).toBe(false)
    expect(isCrowdMessage({})).toBe(false)
    expect(isCrowdMessage({ type: 'unknown' })).toBe(false)
  })

  it('accepts every message variant', () => {
    for (const m of [makeInvite(), makeProposal(), makeSig(CONTROLLERS[0]), makeFinalized()]) {
      expect(isCrowdMessage(m)).toBe(true)
    }
    expect(isCrowdMessage({ type: 'veto' })).toBe(true)
    expect(isCrowdMessage({ type: 'cancelled' })).toBe(true)
  })
})
