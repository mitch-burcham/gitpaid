/**
 * GitPaid agent wallet — in-process @bsv/wallet-toolbox (ADR-005).
 *
 * The reference BSV wallet: embedded SQLite + monitor, exposes the standard
 * BRC-100 WalletInterface, and — critically — credits foreign inputs supplied
 * via inputBEEF, so Crowd's escrow-release createAction flow runs unchanged.
 * No external daemon (supersedes the bsv-wallet-cli :3322 hop, ADR-004).
 *
 * Identity continuity: initialized from a hex root key (GITPAID_ROOT_KEY, or
 * ~/.gitpaid-wallet/.env ROOT_KEY), so the identity key, address, and all
 * BRC-42/29 derivations match across the migration.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, type WalletInterface } from '@bsv/sdk'

export interface AgentWalletHandle {
  wallet: WalletInterface
  identityKey: string
  /** Stop background monitor tasks (call on clean shutdown). */
  shutdown: () => Promise<void>
}

function resolveRootKey (): string {
  const fromEnv = process.env.GITPAID_ROOT_KEY
  if (fromEnv !== undefined && /^[0-9a-fA-F]{64}$/.test(fromEnv.trim())) {
    return fromEnv.trim()
  }
  // Continuity with the existing wallet during migration.
  const envPath = process.env.GITPAID_ROOT_KEY_FILE ?? join(homedir(), '.gitpaid-wallet', '.env')
  try {
    const m = readFileSync(envPath, 'utf8').match(/ROOT_KEY=([0-9a-fA-F]{64})/)
    if (m !== null) return m[1]
  } catch { /* fall through */ }
  throw new Error('No root key: set GITPAID_ROOT_KEY (64 hex) or GITPAID_ROOT_KEY_FILE')
}

let cached: Promise<AgentWalletHandle> | undefined

export async function getAgentWallet (): Promise<AgentWalletHandle> {
  if (cached !== undefined) return await cached
  cached = (async () => {
    // Silence dotenv's import banner before wallet-toolbox loads it; lazy-
    // import keeps wallet-LESS commands (list/watch) free of the toolbox.
    process.env.DOTENV_CONFIG_QUIET = 'true'
    const { Setup } = await import('@bsv/wallet-toolbox')

    const rootHex = resolveRootKey()
    const identityKey = PrivateKey.fromHex(rootHex).toPublicKey().toString()
    const filePath = process.env.GITPAID_WALLET_DB ?? join(homedir(), '.gitpaid-wallet', 'gitpaid-toolbox.sqlite')

    const sw = await Setup.createWalletSQLite({
      env: {
        chain: 'main',
        identityKey,
        identityKey2: identityKey,
        filePath,
        taalApiKey: process.env.GITPAID_TAAL_API_KEY ?? '',
        devKeys: { [identityKey]: rootHex },
        mySQLConnection: '{}',
      },
      filePath,
      databaseName: 'gitpaid_agent_wallet',
    })

    // Background tasks: poll ARC for tx status + collect merkle proofs.
    sw.monitor.startTasks().catch(() => {})

    return {
      wallet: sw.wallet,
      identityKey: sw.identityKey,
      shutdown: async () => { sw.monitor.stopTasks() },
    }
  })()
  return await cached
}
