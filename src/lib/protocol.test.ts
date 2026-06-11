import { describe, it, expect } from 'vitest'
import { encodeInvite, decodeInvite, type InviteMsg } from './protocol'

const invite: InviteMsg = {
  type: 'invite',
  escrowId: 'ab'.repeat(32) + '.0',
  beef: 'deadbeef',
  satoshis: 1000,
  threshold: 2,
  keyID: 'a2V5aWQ=',
  originator: '02' + '11'.repeat(32),
  controllers: ['02' + '11'.repeat(32), '03' + '22'.repeat(32)],
  pubkeys: ['02' + '33'.repeat(32), '03' + '44'.repeat(32)],
  refundPkh: 'ff'.repeat(20),
  name: 'Trip fund — café 北京 🚀',
  createdAt: 1765000000000,
}

describe('encodeInvite / decodeInvite', () => {
  it('round-trips an invite including unicode name', () => {
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite)
  })

  it('produces URL-safe output that survives a URL round-trip', () => {
    const encoded = encodeInvite(invite)
    expect(encoded).not.toMatch(/[+/=]/)
    const url = new URL(`https://x.test/#/e/${invite.escrowId}?d=${encoded}`)
    const fromUrl = new URLSearchParams(url.hash.split('?')[1]).get('d')
    expect(decodeInvite(fromUrl ?? '')).toEqual(invite)
  })

  it('returns undefined for malformed base64, non-JSON, and non-invite payloads', () => {
    expect(decodeInvite('!!!not-base64!!!')).toBeUndefined()
    expect(decodeInvite(btoa('not json').replace(/=/g, ''))).toBeUndefined()
    expect(decodeInvite(btoa(JSON.stringify({ type: 'veto' })).replace(/=/g, ''))).toBeUndefined()
    expect(decodeInvite('')).toBeUndefined()
  })
})
