import type * as CleanupPlan from '../../src/CleanupPlan.js'
import type * as Mir from '../../src/Mir.js'

/**
 * Cleanup of the owners each `Execution.park` instance keeps across `Intrinsic.relinquish`. The
 * registration guard is the only owner live there, so each entry is that instance's guard cleanup.
 */
export const relinquishedReleases = (
  module: Mir.Module,
): ReadonlyArray<ReadonlyArray<CleanupPlan.CleanupPlan>> =>
  module.functions.flatMap((fn) =>
    (fn.suspension?.regions ?? []).flatMap((region) =>
      region._tag === 'RunSuspendableEffectRegion' &&
      region.operation._tag === 'ExecutionRelinquish'
        ? [(region.relay.state?.failure.releases ?? []).map((release) => release.cleanup)]
        : [],
    ),
  )
