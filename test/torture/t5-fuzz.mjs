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
 * On any divergence: print the seed and op index and a minimal replay line, then
 * exit non-zero. Control: OBJECTPOOL_TORTURE_BREAK is not wired here (T5 owns no
 * control; T9 owns the oracle-corruption control).
 */

import { ObjectPool } from '../../ObjectPool.js';
import { check, die, makePrng, SEED } from './harness.mjs';

const CAP = 64;
const OPS = 100000;

export function run() {
    const rng = makePrng(SEED);

    let nextId = 0;
    const pool = new ObjectPool({ create: () => ({ id: nextId++ }), size: CAP, expand: false });

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
            compare('releaseAll', i);
        } else {
            // explicit forEachActive coverage (the compare already walks it, but
            // this exercises releasing the current object mid-walk, D3)
            if (active.size > 0 && (rng() & 1) === 0) {
                pool.forEachActive((o) => {
                    if ((o.id & 3) === 0) {
                        pool.release(o);
                        active.delete(o);
                    }
                });
            }
            compare('forEachActive', i);
        }
    }

    // Final drain leaves the pool at rest.
    pool.releaseAll();
    active.clear();
    check(pool.used === 0 && pool.free === CAP,
        () => `T5: final state used=${pool.used} free=${pool.free} (expected 0/${CAP})`);

    if (pool.used !== 0) die('T5: unreachable');
    return { findings: 0, warnings: 0 };
}
