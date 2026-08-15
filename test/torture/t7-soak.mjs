/**
 * T7 -- soak and leak witness.
 *
 * CYCLES build-up / tear-down cycles. After EACH cycle the pool must return to
 * rest: used===0 and free===size. A second, independent witness (lite-leak)
 * tracks one external resource per cycle and must return to size 0, so a pool
 * bookkeeping leak and a JS-object leak cannot hide behind each other. Heap is
 * sampled ACROSS cycles only, after globalThis.gc(), never within a cycle --
 * intra-cycle churn is expected and must not be misread as growth.
 *
 * Held-value contract (lite-leak): neither the cleanup closure nor the tag may
 * close over the tracked target, or finalization is defeated and the witness
 * reports clean by construction. Here cleanup is a shared NOOP and the tag is
 * the cycle number -- both target-free.
 *
 * Control: OBJECTPOOL_TORTURE_BREAK=t7 leaks one tracked resource past the
 * cycle (skips its untrack), so tracker.size() cannot return to 0 and the run
 * exits non-zero.
 */

import { ObjectPool } from '../../ObjectPool.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { check, breaking } from './harness.mjs';

const CYCLES = 4096;
const N = 32; // objects built and torn down each cycle
const NOOP = function () {};

export function run() {
    const pool = new ObjectPool({ create: () => ({ v: 0 }), size: N, expand: false });
    const held = new Array(N);
    const tracker = createLeakTracker({ name: 'objectpool-soak' });

    // Sample heap only at cycle boundaries, after settling.
    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let c = 0; c < CYCLES; c++) {
        // Build up: drain the pool to capacity.
        for (let i = 0; i < N; i++) held[i] = pool.acquire();
        check(pool.used === N, () => `T7: cycle ${c} expected used=${N}, got ${pool.used}`);

        // Track one external resource for this cycle. cleanup/tag are target-free.
        const h = tracker.track({ cycle: c }, NOOP, c);

        // Tear down. Alternate explicit release and releaseAll so both drain
        // paths are soaked equally.
        if (c & 1) {
            for (let i = 0; i < N; i++) pool.release(held[i]);
        } else {
            pool.releaseAll();
        }

        // Control: leak this cycle's tracked resource (skip untrack), so
        // the witness cannot return to zero.
        if (!(breaking('t7') && c === CYCLES >> 1)) tracker.untrack(h);

        check(pool.used === 0, () => `T7: cycle ${c} used=${pool.used} after teardown (expected 0)`);
        check(pool.free === pool.size,
            () => `T7: cycle ${c} free=${pool.free} != size=${pool.size} after teardown`);
    }

    const leakSize = tracker.size();
    check(leakSize === 0, () => `T7: lite-leak tracker leaked ${leakSize} resources`);

    globalThis.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const grewKB = (heapAfter - heapBefore) / 1024;
    check(grewKB < 512, () => `T7: heap grew ${grewKB.toFixed(1)} KB over ${CYCLES} cycles`);

    return { leakSize, findings: 0, warnings: 0 };
}
