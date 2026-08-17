/**
 * T5 -- differential fuzz against a brute-force oracle.
 *
 * The sparse-set rewrite (v2.0.0) must change NO answer except iteration order.
 * This tier proves it. A naive oracle -- the v1 design, a plain `Set` of active
 * objects plus an integer free count, which is correct and slow -- is driven
 * through the SAME 100k-op sequence as the real pool. After every op the two are
 * compared on:
 *
 *   - used, free, size
 *   - the SORTED SET of active object identities
 *
 * Iteration ORDER is deliberately NOT compared. That is Decision 2 (order became
 * unspecified with swap-remove), not an oversight -- comparing order here would
 * pin the very thing the rewrite is allowed to change.
 *
 * Fixed capacity (expand:false) so `size` is constant and the comparison isolates
 * the acquire / release / releaseAll / forEachActive state machine from the
 * chunked growth path (exercised in T3). The pool tags each object with a unique
 * id at create time; the oracle tracks the SAME objects the pool hands out, so
 * the two active-identity sets are directly comparable.
 *
 * THIRD LANE (v2.3.0): the frozen v1 fixture -- the ACTUAL Set-based 1.1.0 pool
 * at ../baseline/ObjectPool-1.1.0.js, the same file the bench (bench/torture.js)
 * drives -- runs the SAME op stream as a real ObjectPool alongside v2. It is
 * compared on used / free / size ONLY, never identity: v1's free-list (LIFO
 * stack) hands objects back in a different order than v2's cursor, so identities
 * legitimately diverge (D2) while the COUNTS must agree op-for-op. This is the
 * accounting cross-check the headline v1-vs-v2 bench rests on -- two divergent
 * "v1"s would make that comparison unfalsifiable, so bench and T5 both assert
 * they loaded this exact fixture (VERSION 1.1.0, the pinned repo path).
 *
 * On any divergence: print the seed and op index and a minimal replay line, then
 * exit non-zero. Control: OBJECTPOOL_TORTURE_BREAK is not wired here (T5 owns no
 * control; T9 owns the oracle-corruption control).
 */

import { ObjectPool } from '../../ObjectPool.js';
import { ObjectPool as ObjectPoolV1, VERSION as V1_VERSION } from '../baseline/ObjectPool-1.1.0.js';
import { check, die, makePrng, SEED } from './harness.mjs';

const CAP = 64;
const OPS = 100000;

export function run() {
    const rng = makePrng(SEED);

    // The frozen v1 fixture, asserted to be the exact file the bench drives.
    // bench/torture.js runs the identical VERSION + path check -- rename the
    // fixture and BOTH fail, which is what keeps the headline comparison honest.
    const V1_FIXTURE = new URL('../baseline/ObjectPool-1.1.0.js', import.meta.url).pathname;
    check(V1_VERSION === '1.1.0',
        () => `T5: v1 fixture VERSION is "${V1_VERSION}", expected "1.1.0" -- not the frozen Set-based baseline`);
    check(V1_FIXTURE.endsWith('/test/baseline/ObjectPool-1.1.0.js'),
        () => `T5: v1 fixture resolved to ${V1_FIXTURE}, not test/baseline/ObjectPool-1.1.0.js`);

    let nextId = 0;
    const pool = new ObjectPool({ create: () => ({ id: nextId++ }), size: CAP, expand: false });

    // Third lane: the real v1 Set-based pool driven through the SAME op stream.
    // `v1Active` mirrors its currently-checked-out objects (a plain LIFO array;
    // identity order differs from v2 by design, so only COUNTS are compared).
    const v1pool = new ObjectPoolV1({ create: () => ({}), size: CAP, expand: false });
    const v1Active = [];

    // Oracle: v1-style. `active` is the set of currently-checked-out objects;
    // `known` is every distinct object the pool has ever issued (for picking
    // double-release and re-acquire targets). free count is derived.
    const active = new Set();
    const known = [];

    // Scratch for the per-op active-identity comparison, built fresh each op
    // (T5 is a correctness tier, not the alloc gate).
    function poolActiveIds() {
        const ids = [];
        pool.forEachActive((o) => ids.push(o.id));
        ids.sort((a, b) => a - b);
        return ids;
    }
    function oracleActiveIds() {
        const ids = [];
        for (const o of active) ids.push(o.id);
        ids.sort((a, b) => a - b);
        return ids;
    }

    function replay(op, i) {
        return `TORTURE_SEED=${SEED} npm run torture  (T5 op #${i}, kind=${op})`;
    }

    function compare(op, i) {
        check(pool.used === active.size,
            () => `T5: used=${pool.used} oracle=${active.size} at op #${i} (${op})\n  ${replay(op, i)}`);
        check(pool.free === CAP - active.size,
            () => `T5: free=${pool.free} oracle=${CAP - active.size} at op #${i} (${op})\n  ${replay(op, i)}`);
        check(pool.size === CAP,
            () => `T5: size=${pool.size} grew from ${CAP} at op #${i} (${op})\n  ${replay(op, i)}`);
        // v1-fixture lane: COUNTS only (never identity -- v1 free-list order !=
        // v2 cursor order). used/free/size must agree with v2 op-for-op.
        check(v1pool.used === pool.used,
            () => `T5: v1 used=${v1pool.used} vs v2 used=${pool.used} at op #${i} (${op})\n  ${replay(op, i)}`);
        check(v1pool.free === pool.free,
            () => `T5: v1 free=${v1pool.free} vs v2 free=${pool.free} at op #${i} (${op})\n  ${replay(op, i)}`);
        check(v1pool.size === pool.size,
            () => `T5: v1 size=${v1pool.size} vs v2 size=${pool.size} at op #${i} (${op})\n  ${replay(op, i)}`);
        const a = poolActiveIds();
        const b = oracleActiveIds();
        check(a.length === b.length,
            () => `T5: active-set size ${a.length} vs oracle ${b.length} at op #${i} (${op})\n  ${replay(op, i)}`);
        for (let k = 0; k < a.length; k++) {
            check(a[k] === b[k],
                () => `T5: active-set identity diverged at op #${i} (${op}): pool=[${a}] oracle=[${b}]\n  ${replay(op, i)}`);
        }
    }

    for (let i = 0; i < OPS; i++) {
        const roll = rng() % 100;

        if (roll < 40) {
            // acquire
            const canGive = active.size < CAP;
            const obj = pool.acquire();
            // v1 lane: same cap, same used -> same success/failure this op.
            const v1obj = v1pool.acquire();
            if (v1obj !== null) v1Active.push(v1obj);
            if (canGive) {
                check(obj !== null, () => `T5: acquire returned null with free capacity at op #${i}\n  ${replay('acquire', i)}`);
                if (known.indexOf(obj) === -1) known.push(obj);
                active.add(obj);
            } else {
                check(obj === null, () => `T5: acquire returned an object past capacity at op #${i}\n  ${replay('acquire', i)}`);
            }
            compare('acquire', i);
        } else if (roll < 70) {
            // release an active object (expect true)
            if (active.size > 0) {
                let pick = rng() % active.size;
                let target = null;
                for (const o of active) { if (pick-- === 0) { target = o; break; } }
                const r = pool.release(target);
                check(r === true, () => `T5: release of an active object returned ${r} at op #${i}\n  ${replay('release-active', i)}`);
                active.delete(target);
                // v1 lane: release one of its own active objects (count parity).
                if (v1Active.length > 0) v1pool.release(v1Active.pop());
            }
            compare('release-active', i);
        } else if (roll < 80) {
            // double-release: a known object that is NOT currently active (expect false)
            let target = null;
            for (let t = 0; t < known.length; t++) {
                const cand = known[(rng() + t) % known.length];
                if (!active.has(cand)) { target = cand; break; }
            }
            if (target !== null) {
                const r = pool.release(target);
                check(r === false, () => `T5: double-release returned ${r} (expected false) at op #${i}\n  ${replay('double-release', i)}`);
            }
            compare('double-release', i);
        } else if (roll < 85) {
            // foreign object release (expect throw)
            const foreign = { id: -1 };
            let threw = false;
            try { pool.release(foreign); } catch { threw = true; }
            check(threw, () => `T5: foreign release did not throw at op #${i}\n  ${replay('foreign', i)}`);
            compare('foreign', i);
        } else if (roll < 92) {
            // releaseAll
            pool.releaseAll();
            active.clear();
            // v1 lane
            v1pool.releaseAll();
            v1Active.length = 0;
            compare('releaseAll', i);
        } else {
            // explicit forEachActive coverage (the compare already walks it, but
            // this exercises releasing the current object mid-walk, D3)
            if (active.size > 0 && (rng() & 1) === 0) {
                const usedBefore = pool.used;
                pool.forEachActive((o) => {
                    if ((o.id & 3) === 0) {
                        pool.release(o);
                        active.delete(o);
                    }
                });
                // v1 lane: the id predicate keys on v2's ids, so mirror the COUNT
                // v2 released (identities differ; counts must not).
                const releasedN = usedBefore - pool.used;
                for (let k = 0; k < releasedN && v1Active.length > 0; k++) v1pool.release(v1Active.pop());
            }
            compare('forEachActive', i);
        }
    }

    // Final drain leaves the pool at rest.
    pool.releaseAll();
    active.clear();
    v1pool.releaseAll();
    v1Active.length = 0;
    check(pool.used === 0 && pool.free === CAP,
        () => `T5: final state used=${pool.used} free=${pool.free} (expected 0/${CAP})`);
    check(v1pool.used === 0 && v1pool.free === CAP && v1pool.size === CAP,
        () => `T5: v1 final state used=${v1pool.used} free=${v1pool.free} size=${v1pool.size} (expected 0/${CAP}/${CAP})`);

    if (pool.used !== 0) die('T5: unreachable');
    return { findings: 0, warnings: 0 };
}
