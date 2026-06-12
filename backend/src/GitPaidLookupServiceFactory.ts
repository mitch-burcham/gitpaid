import type { Db } from 'mongodb'
import { GitPaidLookupService } from './GitPaidLookupService.js'
import { MongoStorage } from './storage/MongoStorage.js'

/**
 * LARS/CARS entry point (deployment-info.json: lookupServices.ls_gitpaid,
 * hydrateWith: mongo). Wires the Mongo-backed storage into the service.
 *
 * The hourly reconciliation sweep (OR-004) is started here so it lives with
 * the lookup node, not the clients.
 */
export default (db: Db): GitPaidLookupService => {
  const service = new GitPaidLookupService(new MongoStorage(db))

  // OR-004: hourly chain-side spent reconciliation (zombie-badge backstop).
  // Lazy import keeps test environments free of timer side effects.
  void (async () => {
    const { reconcileSpentOutputs, wocSpentChecker } = await import('./reconcile.js')
    const HOUR = 60 * 60 * 1000
    setInterval(() => {
      reconcileSpentOutputs(service.storage, wocSpentChecker()).catch(() => {
        // Non-fatal: next sweep retries (NFR-005 staleness budget ≤60 min)
      })
    }, HOUR)
  })()

  return service
}
