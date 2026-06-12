import { describe, it, expect } from 'vitest'
import { PrivateKey, Utils } from '@bsv/sdk'
import {
  encodeBinding, decodeBinding, BINDING_VERSION, MAX_SLUG_BYTES, MAX_BINDING_BYTES,
  type IssueBinding,
} from './binding'

const funderKey = PrivateKey.fromRandom().toPublicKey().toString()

function fixture (overrides: Partial<IssueBinding> = {}): IssueBinding {
  return {
    version: BINDING_VERSION,
    repoId: 123456789,
    issueId: 9876543210, // > u32 to exercise the u64 path
    issueNumber: 42,
    funderIdentityKey: funderKey,
    slug: 'mitch-burcham/gitpaid',
    ...overrides,
  }
}

describe('binding codec (TC-008)', () => {
  it('encode → decode round-trips all fields', () => {
    const b = fixture()
    const decoded = decodeBinding(encodeBinding(b))
    expect(decoded).toEqual(b)
  })

  it('round-trips unicode slugs', () => {
    const b = fixture({ slug: 'mitch/プロジェクト-🚀' })
    const decoded = decodeBinding(encodeBinding(b))
    expect(decoded?.slug).toBe('mitch/プロジェクト-🚀')
  })

  it('round-trips u64 IDs above 2^32', () => {
    const b = fixture({ repoId: 2 ** 40 + 7, issueId: 2 ** 52 + 1 })
    const decoded = decodeBinding(encodeBinding(b))
    expect(decoded?.repoId).toBe(2 ** 40 + 7)
    expect(decoded?.issueId).toBe(2 ** 52 + 1)
  })

  it('encode throws on oversized slug', () => {
    const b = fixture({ slug: 'a'.repeat(MAX_SLUG_BYTES + 1) })
    expect(() => encodeBinding(b)).toThrow(/slug/)
  })

  it('encode throws on empty slug, bad pubkey, non-integer ids, oversized issueNumber', () => {
    expect(() => encodeBinding(fixture({ slug: '' }))).toThrow(/slug/)
    expect(() => encodeBinding(fixture({ funderIdentityKey: 'deadbeef' }))).toThrow(/33-byte/)
    expect(() => encodeBinding(fixture({ repoId: 1.5 }))).toThrow(/safe integers/)
    expect(() => encodeBinding(fixture({ repoId: -1 }))).toThrow(/safe integers/)
    expect(() => encodeBinding(fixture({ issueNumber: 2 ** 32 }))).toThrow(/u32/)
    expect(() => encodeBinding(fixture({ version: 2 }))).toThrow(/version/)
  })

  // decode handles hostile input: null, never throw
  it('decode returns null on truncated bytes', () => {
    const bytes = encodeBinding(fixture())
    for (const cut of [0, 1, 10, 54, bytes.length - 1]) {
      expect(decodeBinding(bytes.slice(0, cut))).toBeNull()
    }
  })

  it('decode returns null on wrong version byte', () => {
    const bytes = encodeBinding(fixture())
    bytes[0] = 2
    expect(decodeBinding(bytes)).toBeNull()
  })

  it('decode returns null on slug length mismatch (trailing garbage)', () => {
    const bytes = encodeBinding(fixture())
    expect(decodeBinding([...bytes, 0x00])).toBeNull()
  })

  it('decode returns null on invalid pubkey prefix', () => {
    const bytes = encodeBinding(fixture())
    bytes[21] = 0x04 // uncompressed prefix — not allowed
    expect(decodeBinding(bytes)).toBeNull()
  })

  it('decode returns null on garbage and empty input, never throws', () => {
    expect(decodeBinding([])).toBeNull()
    expect(decodeBinding(Utils.toArray('00'.repeat(MAX_BINDING_BYTES + 10), 'hex'))).toBeNull()
    expect(decodeBinding([1, 2, 3])).toBeNull()
  })
})
