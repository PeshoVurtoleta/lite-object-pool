/**
 * T0 -- metamorphic laws.
 *
 * The invariants that must hold for any sequence of operations. Two are
 * CONJOINED here on purpose:
 *
 *   1. `used + free === size`  -- holds in v1.0.2 and MUST keep holding.
 *   2. `size <= maxSize`       -- FAILS in v1.0.2 (OP-02: maxSize is not a cap;
 *      `_totalCreated = size` and the prealloc loop run `size` times regardless).
 *      Recorded as a todo() with the {size:10,maxSize:4} reproduction; P1 fixes
 *      it and turns the todo into a check().
 *
 * Plus the round-trip / idempotence / distinctness / iteration laws. This tier
 * changes NO behaviour; it only makes the truth of v1.0.2 falsifiable.
 *
 * Control: OBJECTPOOL_TORTURE_BREAK=t0 corrupts the distinctness law so the
 * run must exit non-zero -- proof the law can fail.
 */

import { ObjectPool } from '../../ObjectPool.js';
import { check, conserved, todo, breaking } from './harness.mjs';

export function run() {
    // --- Law 1: used + free === size across an operation sequence ------------
    const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 16, expand: false });
    check(conserved(pool), () => `T0: conservation violated at rest (${pool.used}+${pool.free} != ${pool.size})`);

    const held = [];
    for (let i = 0; i < 16; i++) {
        held.push(pool.acquire());
        check(conserved(pool), () => `T0: conservation violated mid-acquire i=${i}`);
    }
    check(pool.used === 16 && pool.free === 0,
        () => `T0: full pool wrong counts used=${pool.used} free=${pool.free}`);

    // --- Law: every acquired object is distinct ------------------------------
    const seen = new Set();
    for (let i = 0; i < held.length; i++) seen.add(held[i]);
    // Control: fabricate a duplicate so the distinctness law must fail.
    if (breaking('t0')) { seen.delete(held[0]); held[0] = held[1]; seen.add(held[0]); }
    check(seen.size === held.length,
        () => `T0: acquired objects not distinct (${seen.size} unique of ${held.length})`);

    // --- Law: forEachActive visits exactly `used` objects, each once ---------
    const visited = new Set();
    let visits = 0;
    pool.forEachActive((o) => { visits++; visited.add(o); });
    check(visits === pool.used,
        () => `T0: forEachActive made ${visits} visits, used=${pool.used}`);
    check(visited.size === pool.used,
        () => `T0: forEachActive revisited an object (${visited.size} unique, used=${pool.used})`);

    // --- Law: acquire/release round-trips to prior counts --------------------
    const usedBefore = pool.used;
    const freeBefore = pool.free;
    const obj = held.pop();
    const ok = pool.release(obj);
    check(ok === true, () => `T0: release of a live object returned ${ok}`);
    check(pool.used === usedBefore - 1 && pool.free === freeBefore + 1,
        () => `T0: release counts wrong used=${pool.used} free=${pool.free}`);
    const re = pool.acquire();
    check(re === obj, () => `T0: LIFO re-acquire did not return the just-released object`);
    check(pool.used === usedBefore && pool.free === freeBefore,
        () => `T0: round-trip did not restore counts used=${pool.used} free=${pool.free}`);
    held.push(re);

    // --- Law: double release is a no-op the second time ----------------------
    const dbl = held.pop();
    check(pool.release(dbl) === true, () => `T0: first release of live object failed`);
    const freeAfterFirst = pool.free;
    check(pool.release(dbl) === false, () => `T0: second (double) release returned true`);
    check(pool.free === freeAfterFirst, () => `T0: double release grew free ${freeAfterFirst} -> ${pool.free}`);

    // --- Law: releaseAll is idempotent and leaves used === 0 -----------------
    pool.releaseAll();
    check(pool.used === 0, () => `T0: releaseAll left used=${pool.used}`);
    const freeAfterAll = pool.free;
    pool.releaseAll(); // idempotent
    check(pool.used === 0 && pool.free === freeAfterAll,
        () => `T0: releaseAll not idempotent (free ${freeAfterAll} -> ${pool.free})`);
    check(conserved(pool), () => `T0: conservation violated after releaseAll`);

    // --- Law 2 (CONJOINED): size <= maxSize. FAILS today (OP-02). ------------
    // maxSize is not a cap: {size:10,maxSize:4} preallocates 10 and reports
    // size 10. Record the measured breach; do NOT fail the run (P1 fixes it).
    const capped = new ObjectPool({ create: () => ({}), size: 10, maxSize: 4 });
    if (capped.size > 4) {
        todo('OP-02', `size <= maxSize breached: {size:10,maxSize:4} -> pool.size=${capped.size} ` +
            `(maxSize is not a cap; ObjectPool.js:36/:40). Fixed in P1.`);
    } else {
        check(capped.size <= 4, () => `T0: {size:10,maxSize:4} gave size ${capped.size} (>4)`);
    }
}
