/**
 * GitPaid overlay node — local/dev entry (ADR-001).
 *
 * OverlayExpress wiring: tm_gitpaid + ls_gitpaid (Mongo storage), GASP sync
 * and SHIP/SLAP advertisement disabled for the local node (single-node v1,
 * BRK-002 accepted). Engine storage on better-sqlite3; lookup storage in
 * Mongo (docker: gitpaid-mongo).
 *
 *   GITPAID_OVERLAY_PORT   (default 8080)
 *   GITPAID_MONGO_URL      (default mongodb://localhost:27017/gitpaid)
 *   GITPAID_SERVER_KEY     (hex private key; generated if absent — local dev)
 *
 * Run: npx tsx src/server.ts   (from backend/)
 */
import OverlayExpress from '@bsv/overlay-express'
import { PrivateKey } from '@bsv/sdk'
import { GitPaidTopicManager } from './GitPaidTopicManager.js'
import { GitPaidLookupService, TOPIC, SERVICE } from './GitPaidLookupService.js'
import { MongoStorage } from './storage/MongoStorage.js'
import { reconcileSpentOutputs, wocSpentChecker } from './reconcile.js'

const PORT = Number(process.env.GITPAID_OVERLAY_PORT ?? 8080)
const MONGO_URL = process.env.GITPAID_MONGO_URL ?? 'mongodb://localhost:27017/gitpaid'
const SERVER_KEY = process.env.GITPAID_SERVER_KEY ?? PrivateKey.fromRandom().toHex()

async function main (): Promise<void> {
  const server = new OverlayExpress('gitpaid-local', SERVER_KEY, `localhost:${PORT}`)

  server.configurePort(PORT)
  server.configureNetwork('main')
  server.configureEnableGASPSync(false)
  server.configureEngineParams({
    syncConfiguration: { [TOPIC]: false },
    suppressDefaultSyncAdvertisements: true,
  })

  // overlay-express engine migrations are MySQL-flavored (sqlite fails on
  // migration 2) — local dev runs the gitpaid-mysql docker container.
  await server.configureKnex(process.env.GITPAID_KNEX_URL ?? 'mysql://root:overlay@localhost:3306/overlay')
  await server.configureMongo(MONGO_URL)

  server.configureTopicManager(TOPIC, new GitPaidTopicManager())

  let lookupService: GitPaidLookupService | undefined
  server.configureLookupServiceWithMongo(SERVICE, (db) => {
    // overlay-express bundles its own mongodb; the Db type is structurally
    // identical but nominally distinct from our mongodb dep.
    lookupService = new GitPaidLookupService(new MongoStorage(db as unknown as import('mongodb').Db))
    return lookupService
  })

  await server.configureEngine(false)
  await server.start()
  console.log(`gitpaid overlay listening on :${PORT}  (topic ${TOPIC}, service ${SERVICE})`)

  // OR-004: hourly chain-side spent reconciliation
  setInterval(() => {
    if (lookupService !== undefined) {
      reconcileSpentOutputs(lookupService.storage, wocSpentChecker())
        .then(r => { if (r.markedSpent > 0 || r.errors > 0) console.log('reconcile sweep:', r) })
        .catch(() => {})
    }
  }, 60 * 60 * 1000)
}

main().catch((err: unknown) => {
  console.error('overlay failed to start:', err)
  process.exit(1)
})
