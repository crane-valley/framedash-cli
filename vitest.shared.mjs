// A shared cap avoids divergent worker counts across packages. Turbo runs several suites
// together, so Vitest's per-package CPU defaults oversubscribe the runner and make timing
// assertions flaky. Limiting Turbo concurrency alone still lets each package spawn a full
// CPU-sized pool.
//
// Local runs need the same bound because developer machines also share CPUs with other work.
// This file must remain in Turbo's test inputs or changing the cap would replay results cached
// under the old bound.

import { availableParallelism } from "node:os";

/**
 * 5 keeps the whole suite near the runner's core count without starving apps/web, which holds
 * ~78% of the repo's test files and is the critical path. apps/ingest and apps/consumer are not
 * covered by this constant: they run on @cloudflare/vitest-pool-workers, which has no numeric
 * worker bound to set -- see the workers-pool note below for the lever they use instead.
 *
 * Clamped rather than hardcoded, because a numeric maxWorkers is NOT capped by the available
 * CPUs. On a 2-core machine vitest's own default would be 1 and a bare 5 would RAISE the worker
 * count -- the opposite of the point -- so a small laptop or a small CI container would be made
 * worse by this file. The clamp only ever lowers the default, never raises it.
 */
export const MAX_TEST_WORKERS = Math.max(1, Math.min(5, availableParallelism() - 1));

/**
 * minThreads otherwise inherits maxThreads, so the small packages (plans-config and api-client
 * have two test files each) pay full worker startup for workers they never use. Tinypool grows
 * the pool on demand as files queue, so 1 costs nothing on the packages that do need the
 * ceiling.
 */
export const MIN_TEST_WORKERS = 1;

// The Cloudflare pool ignores Vitest's thread cap. Its default starts a separate runtime per
// file, so concurrent framework imports can starve even fully mocked tests. apps/ingest uses
// singleWorker to avoid that startup contention while preserving per-test storage reset and
// per-file module/mock isolation.
//
// isolatedStorage: false still leaves parallel isolates competing for module loads and loses
// storage isolation. Raising testTimeout would hide starvation and make a real hang harder to
// distinguish.
//
// Shared-runtime execution counts accumulate across files, but the configured percentage
// reporters only care whether a line ran. Count-based coverage reporters would need this
// limitation reconsidered.
