/**
 * Issue-binding codec (ADR-003 / TR-007).
 *
 * The binding is the data committed inside a GitPaidEscrow locking script
 * (PUSHDATA <binding> OP_DROP prefix) that welds an escrow output to a
 * specific GitHub issue. It carries GitHub's immutable numeric IDs (which
 * survive repo renames and issue transfers) alongside the display slug,
 * plus the funder's identity key.
 *
 * Wire format (version 1), all integers little-endian:
 *
 *   offset  size  field
 *   ------  ----  -----------------------------------------
 *   0       1     version (0x01)
 *   1       8     repoId   — GitHub numeric repository ID (u64)
 *   9       8     issueId  — GitHub numeric issue ID (u64)
 *   17      4     issueNumber — display number within the repo (u32)
 *   21      33    funderIdentityKey — compressed secp256k1 pubkey
 *   54      1     slugLength (u8, ≤ MAX_SLUG_BYTES)
 *   55      n     slug — UTF-8 "owner/repo" (display only; IDs are canonical)
 *
 * The version byte reserves space for future fields (e.g. TODO-002 funder
 * GitHub-handle attestation) without re-indexing existing escrows.
 *
 * encode throws on invalid input (caller bug); decode returns null on any
 * malformation (network input — never throw).
 */
import { Utils } from '@bsv/sdk'

export const BINDING_VERSION = 1
export const MAX_SLUG_BYTES = 100
const FIXED_LEN = 1 + 8 + 8 + 4 + 33 + 1
export const MAX_BINDING_BYTES = FIXED_LEN + MAX_SLUG_BYTES

export interface IssueBinding {
  version: number
  /** GitHub numeric repository ID — immutable across renames. */
  repoId: number
  /** GitHub numeric issue ID — immutable across transfers. */
  issueId: number
  /** Display issue number within the repo (mutable on transfer). */
  issueNumber: number
  /** Funder's compressed identity pubkey, 33 bytes hex. */
  funderIdentityKey: string
  /** Display slug "owner/repo" (mutable — IDs are canonical). */
  slug: string
}

// 2^53 - 1: GitHub IDs are far below; reject anything we can't represent
// exactly in a JS number.
const MAX_SAFE = Number.MAX_SAFE_INTEGER

function writeU32 (out: number[], n: number): void {
  out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
}

function writeU64 (out: number[], n: number): void {
  const lo = n % 0x100000000
  const hi = Math.floor(n / 0x100000000)
  writeU32(out, lo)
  writeU32(out, hi)
}

function readU32 (bytes: number[], offset: number): number {
  // >>> 0 keeps the result unsigned
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>> 0
  )
}

function readU64 (bytes: number[], offset: number): number {
  const lo = readU32(bytes, offset)
  const hi = readU32(bytes, offset + 4)
  return hi * 0x100000000 + lo
}

function isValidNonNegInt (n: number, max: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= max
}

export function encodeBinding (b: IssueBinding): number[] {
  if (b.version !== BINDING_VERSION) {
    throw new Error(`encodeBinding: unsupported version ${b.version}`)
  }
  if (!isValidNonNegInt(b.repoId, MAX_SAFE) || !isValidNonNegInt(b.issueId, MAX_SAFE)) {
    throw new Error('encodeBinding: repoId/issueId must be non-negative safe integers')
  }
  if (!isValidNonNegInt(b.issueNumber, 0xffffffff)) {
    throw new Error('encodeBinding: issueNumber must fit in u32')
  }
  const funder = Utils.toArray(b.funderIdentityKey, 'hex')
  if (funder.length !== 33) {
    throw new Error('encodeBinding: funderIdentityKey must be a 33-byte compressed pubkey')
  }
  const slugBytes = Utils.toArray(b.slug, 'utf8')
  if (slugBytes.length === 0 || slugBytes.length > MAX_SLUG_BYTES) {
    throw new Error(`encodeBinding: slug must be 1..${MAX_SLUG_BYTES} UTF-8 bytes`)
  }

  const out: number[] = [BINDING_VERSION]
  writeU64(out, b.repoId)
  writeU64(out, b.issueId)
  writeU32(out, b.issueNumber)
  out.push(...funder)
  out.push(slugBytes.length)
  out.push(...slugBytes)
  return out
}

export function decodeBinding (bytes: number[]): IssueBinding | null {
  try {
    if (!Array.isArray(bytes)) return null
    if (bytes.length < FIXED_LEN + 1 || bytes.length > MAX_BINDING_BYTES) return null
    if (bytes[0] !== BINDING_VERSION) return null

    const repoId = readU64(bytes, 1)
    const issueId = readU64(bytes, 9)
    const issueNumber = readU32(bytes, 17)
    if (repoId > MAX_SAFE || issueId > MAX_SAFE) return null

    const funder = bytes.slice(21, 54)
    if (funder.length !== 33) return null
    // Compressed pubkeys start with 0x02 or 0x03
    if (funder[0] !== 0x02 && funder[0] !== 0x03) return null

    const slugLength = bytes[54]
    if (slugLength === 0 || slugLength > MAX_SLUG_BYTES) return null
    if (bytes.length !== FIXED_LEN + slugLength) return null

    const slug = Utils.toUTF8(bytes.slice(55, 55 + slugLength))

    return {
      version: BINDING_VERSION,
      repoId,
      issueId,
      issueNumber,
      funderIdentityKey: Utils.toHex(funder),
      slug,
    }
  } catch {
    return null
  }
}
