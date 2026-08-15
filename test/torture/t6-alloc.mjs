/**
 * T6 -- the allocation gate.
 *
 * Two hot shapes, measured STRICTLY SEQUENTIALLY (lite-gc-profiler is
 * one-measurement-at-a-time):
 *
 *   (a) steady 1:1 churn at capacity on a preallocated pool
 *   (b) the spike: acquire-to-capacity + releaseAll
 *
 * OP-01: a fully preallocated pool allocates on every acquire() because the
 * `_out` Set rehashes as it grows. This is TRANSIENT garbage -- it is collected
 * by the Scavenger, so the deep-stabilized `checkNoGc` window (major/pause/
 * arrayBuffers) does NOT trip on it. That is exactly why P0 exposes OP-01 a
 * SECOND way: a gc-anchored `heapUsed` delta across a fresh drain, which
 * reproduces the roadmap's 66.1 B/acquire directly. Both shapes are recorded
 * via todo() with their measured numbers so P2 has a falsifiable before-figure;
 * the run does NOT fail on them (P0 fixes nothing).
 *
 * What DOES gate here: structural conservation (pool.size must not grow, and
 * used+free===size across the window) and -- via OBJECTPOOL_TORTURE_BREAK=1 --
 * a retained Float64Array injected into the hot body, whose ArrayBuffer backing
 * store trips maxArrayBuffersGrowth and forces the run non-zero. A gate that
 * cannot fail is decorative.
 */

import { ObjectPool } from '../../ObjectPool.js';
import { runOpsGate, check, die, ratchet, breaking, controlTripped } from './harness.mjs';

const CAP = 4096;         // power of two -> cheap index mask
const STEADY_OPS = 200000;
const STEADY_WARMUP = 2000;
const SPIKE_OPS = 200;
const SPIKE_WARMUP = 20;

/** Retained sink for the t6 control -- survives GC so arrayBuffers grows. */
const leak = [];

/** Per-acquire retained heap delta over a fresh drain of a preallocated pool.
 *  gc-anchored so only surviving growth is counted; reproduces OP-01. */
function drainBytesPerAcquire(n) {
    const pool = new ObjectPool({ create: () => ({ x: 0 }), size: n, expand: false });
    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) pool.acquire();
    const after = process.memoryUsage().heapUsed;
    return (after - before) / n;
}

export function run() {
    let allocBytesPerOp = 0;
    let gcMetrics = { major: 0, minor: 0, maxMs: 0 };

    // --- shape (a): steady 1:1 churn at capacity ----------------------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: CAP, expand: false });
        const held = new Array(CAP);
        for (let i = 0; i < CAP; i++) held[i] = pool.acquire();

        const sizeBefore = pool.size;
        const hot = (i) => {
            const idx = i & (CAP - 1);
            pool.release(held[idx]);
            held[idx] = pool.acquire();
            if (breaking('t6')) leak.push(new Float64Array(64)); // control: retained growth
        };

        const { report, summary } = runOpsGate(hot, { ops: STEADY_OPS, warmup: STEADY_WARMUP });

        // Structural assertions no heap gate makes for us.
        check(pool.size === sizeBefore,
            () => `T6: steady churn grew pool.size ${sizeBefore} -> ${pool.size}`);
        check(pool.used + pool.free === pool.size,
            () => `T6: steady churn broke conservation used=${pool.used} free=${pool.free} size=${pool.size}`);

        if (breaking('t6')) {
            // The injected Float64Arrays MUST trip the gate, and must trip it
            // as an unambiguous `fail`. Asserting `!report.ok` would accept an
            // `inconclusive` verdict as proof, which is not proof: the gate
            // would be reporting that it could not tell, and an allocating
            // control would count as tripped without ever being caught.
            if (!controlTripped(report)) {
                die('T6: control armed but verdict=' + report.verdict +
                    ' (expected "fail"); the alloc gate did not catch the injected ' +
                    'allocations, so it cannot be trusted to catch a real one');
            }
            die('T6: control tripped the alloc gate with verdict=fail (expected non-zero exit)');
        }

        if (!report.ok) {
            const g = summary.gc;
            die('T6 steady-churn gate rejected -- verdict=' + report.verdict +
                ' source=' + summary.source + ' major=' + g.major +
                ' maxMs=' + g.maxMs.toFixed(3) + ' abGrowth=' + summary.arrayBuffers.growthBytes);
        }
        gcMetrics = { major: summary.gc.major, minor: summary.gc.minor, maxMs: summary.gc.maxMs };
    }

    // --- shape (b): the spike -- acquire-to-capacity + releaseAll -----------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: CAP, expand: false });
        const sizeBefore = pool.size;
        const hot = () => {
            for (let j = 0; j < CAP; j++) pool.acquire();
            pool.releaseAll();
        };

        const { report, summary } = runOpsGate(hot, { ops: SPIKE_OPS, warmup: SPIKE_WARMUP });

        check(pool.size === sizeBefore,
            () => `T6: spike grew pool.size ${sizeBefore} -> ${pool.size}`);
        check(pool.used + pool.free === pool.size,
            () => `T6: spike broke conservation used=${pool.used} free=${pool.free} size=${pool.size}`);

        if (!report.ok) {
            const g = summary.gc;
            die('T6 spike gate rejected -- verdict=' + report.verdict +
                ' source=' + summary.source + ' major=' + g.major +
                ' maxMs=' + g.maxMs.toFixed(3) + ' abGrowth=' + summary.arrayBuffers.growthBytes);
        }
    }

    // --- OP-01 exposure: the raw per-acquire allocation the gate cannot see --
    //
    // WHY THE TWO WINDOWS ABOVE CANNOT CATCH THIS, and why this block is not
    // redundant with them. OP-01 is a Set REHASH cost: `_out` grows its hash
    // table as objects are checked out. Both gated windows above run on a pool
    // whose `_out` has ALREADY reached its working size -- the churn window
    // holds capacity steady, and the spike window's Set is re-grown into
    // buckets the first iteration already allocated. By the time the measured
    // window opens, the ramp-up this finding names cannot fire inside it.
    //
    // That is precisely the lite-arena AR-02 shape: a gate that names a hazard
    // and then measures a configuration where the hazard is structurally unable
    // to occur. So the before-figure comes from a gc-anchored drain of a POOL
    // THAT HAS NEVER BEEN DRAINED -- the only shape in which the rehash runs.
    //
    // And it is RATCHETED, not merely recorded. A bare todo() prints a number
    // and gates nothing, so a regression from 66 to 500 B/acquire would still
    // exit 0. The bug is known and unfixed; it is not allowed to get worse.
    {
        const perAcquire20k = drainBytesPerAcquire(20000);
        const perAcquire4k = drainBytesPerAcquire(CAP);
        allocBytesPerOp = perAcquire20k;

        // Ceilings sit ~20% above the figures measured on node v26.3.1/darwin,
        // which is loose enough to absorb allocator noise and version drift and
        // tight enough that a real regression trips. P2 replaces both calls
        // with a hard equality against 0.
        ratchet('OP-01a', perAcquire20k, 80,
            `preallocated 20000 pool: drain of 20000 acquires retained ` +
            `${perAcquire20k.toFixed(2)} B/acquire (roadmap: 66.1). _out Set rehash. Fixed in P2.`);
        ratchet('OP-01b', perAcquire4k, 55,
            `preallocated ${CAP} pool: drain retained ` +
            `${perAcquire4k.toFixed(2)} B/acquire. Same _out Set rehash. Fixed in P2.`);
    }

    return { allocBytesPerOp, gc: gcMetrics };
}
