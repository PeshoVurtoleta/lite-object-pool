/**
 * T3 -- adversarial churn.
 *
 * Hammers the pool with the release orders and re-entrancy patterns a real
 * game loop produces on its worst frame: full-drain spikes, steady 1:1 churn at
 * capacity, LIFO / FIFO / random / every-other release orders, acquisition past
 * maxSize, mutation of the active set from inside forEachActive, re-entrant
 * acquire from inside reset, and continued use after an exhaustion null.
 *
 * The invariant checked throughout is conservation (`used + free === size`) plus
 * the specific pinned outcomes of the re-entrant cases. This tier changes no
 * behaviour; it proves the pool survives the abuse it already survives.
 */

import { ObjectPool } from '../../ObjectPool.js';
import { check, conserved, makePrng, SEED } from './harness.mjs';

const CAP = 64;

export function run() {
    const rng = makePrng(SEED);

    // --- full-drain spike ---------------------------------------------------
    {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: CAP, expand: false });
        const held = [];
        for (let i = 0; i < CAP; i++) held.push(pool.acquire());
        check(pool.used === CAP && pool.free === 0,
            () => `T3: full drain used=${pool.used} free=${pool.free}`);
        check(pool.acquire() === null, () => `T3: acquire past a drained no-expand pool != null`);
        pool.releaseAll();
        check(pool.used === 0 && pool.free === CAP && conserved(pool),
            () => `T3: post-drain releaseAll used=${pool.used} free=${pool.free}`);
    }

    // --- 1:1 steady churn at capacity ---------------------------------------
    {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: CAP, expand: false });
        const held = new Array(CAP);
        for (let i = 0; i < CAP; i++) held[i] = pool.acquire();
        for (let i = 0; i < 100000; i++) {
            const idx = rng() & (CAP - 1);
            check(pool.release(held[idx]) === true, () => `T3: steady release i=${i} returned false`);
            held[idx] = pool.acquire();
            check(held[idx] !== null, () => `T3: steady re-acquire i=${i} returned null at capacity`);
        }
        check(pool.used === CAP && conserved(pool),
            () => `T3: steady churn broke conservation used=${pool.used} free=${pool.free}`);
    }

    // --- LIFO / FIFO / random / every-other release orders ------------------
    for (const order of ['lifo', 'fifo', 'random', 'every-other']) {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: CAP, expand: false });
        const held = [];
        for (let i = 0; i < CAP; i++) held.push(pool.acquire());

        const idxs = [];
        for (let i = 0; i < CAP; i++) idxs.push(i);
        if (order === 'lifo') idxs.reverse();
        else if (order === 'random') {
            for (let i = idxs.length - 1; i > 0; i--) {
                const j = rng() % (i + 1);
                const t = idxs[i]; idxs[i] = idxs[j]; idxs[j] = t;
            }
        } else if (order === 'every-other') {
            const evens = idxs.filter((n) => (n & 1) === 0);
            const odds = idxs.filter((n) => (n & 1) === 1);
            idxs.length = 0;
            idxs.push(...evens, ...odds);
        }
        // 'fifo' keeps 0..CAP-1 as-is.

        for (let k = 0; k < idxs.length; k++) {
            check(pool.release(held[idxs[k]]) === true,
                () => `T3: ${order} release step ${k} returned false`);
        }
        check(pool.used === 0 && pool.free === CAP && conserved(pool),
            () => `T3: ${order} order left used=${pool.used} free=${pool.free}`);
    }

    // --- acquire past maxSize repeatedly, then keep using the pool ----------
    {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 1, expand: true, maxSize: 2 });
        const a = pool.acquire(); // preallocated
        const b = pool.acquire(); // expanded to cap
        check(pool.size === 2, () => `T3: maxSize cap gave size ${pool.size} (expected 2)`);
        for (let i = 0; i < 10; i++) {
            check(pool.acquire() === null, () => `T3: acquire past maxSize iteration ${i} != null`);
        }
        // The pool is still usable after the exhaustion nulls.
        check(pool.release(a) === true, () => `T3: release after exhaustion failed`);
        const reused = pool.acquire();
        check(reused === a, () => `T3: post-exhaustion re-acquire did not reuse the freed object`);
        check(conserved(pool) && pool.used === 2,
            () => `T3: post-exhaustion state used=${pool.used} free=${pool.free}`);
        pool.release(b); pool.release(reused);
    }

    // --- release during forEachActive: the visited object (release ALL) -----
    {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 4, expand: false });
        for (let i = 0; i < 4; i++) pool.acquire();
        let visits = 0;
        pool.forEachActive((o) => { visits++; pool.release(o); });
        check(visits === 4, () => `T3: release-visited visited ${visits} of 4`);
        check(pool.used === 0 && pool.free === 4 && conserved(pool),
            () => `T3: release-visited left used=${pool.used} free=${pool.free}`);
    }

    // --- release the CURRENT object once mid-forEachActive (D3 contract) -----
    {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 4, expand: false });
        for (let i = 0; i < 4; i++) pool.acquire();
        let visits = 0;
        pool.forEachActive((o) => {
            visits++;
            if (visits === 1) pool.release(o); // release the object we were handed
        });
        // Reverse iteration makes releasing the current object safe: all 4 are
        // still visited exactly once, and exactly one is freed.
        check(visits === 4, () => `T3: release-current-once visited ${visits} of 4`);
        check(pool.used === 3 && pool.free === 1 && conserved(pool),
            () => `T3: release-current-once left used=${pool.used} free=${pool.free}`);
        pool.releaseAll();
        check(pool.used === 0 && pool.free === 4, () => `T3: cleanup after release-current failed`);
    }

    // --- releaseAll from inside forEachActive -------------------------------
    {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 4, expand: false });
        for (let i = 0; i < 4; i++) pool.acquire();
        let visits = 0;
        pool.forEachActive(() => { visits++; pool.releaseAll(); });
        // Clearing the Set mid-iteration ends the walk after the first callback.
        check(visits === 1, () => `T3: releaseAll-in-forEach made ${visits} visits (expected 1)`);
        check(pool.used === 0 && pool.free === 4 && conserved(pool),
            () => `T3: releaseAll-in-forEach left used=${pool.used} free=${pool.free}`);
    }

    // --- re-entrant acquire from inside reset -------------------------------
    {
        let self = null;
        let guard = false;
        const pool = new ObjectPool({
            create: () => ({ v: 0 }),
            size: 2,
            expand: true,
            reset: () => { if (!guard) { guard = true; self.acquire(); } },
        });
        self = pool;
        const x = pool.acquire();
        pool.release(x); // reset() re-enters acquire() once
        check(pool.used === 1 && pool.free === 1,
            () => `T3: re-entrant acquire in reset used=${pool.used} free=${pool.free}`);
        check(conserved(pool), () => `T3: re-entrant acquire broke conservation`);
    }

    // --- growth is chunked and hard-capped at maxSize (OP-10) ---------------
    // v2 grows in bounded contiguous chunks on a free-list miss, clamped by the
    // remaining room to maxSize -- so a finite cap still yields an EXACT size.
    // A size:0,maxSize:MAX pool grows to exactly MAX on its first acquire (the
    // chunk clamps to the 8 slots of room), never one past.
    {
        const MAX = 8;
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 0, expand: true, maxSize: MAX });
        check(pool.size === 0, () => `T3: pre-grow size=${pool.size} (expected 0)`);
        for (let i = 0; i < MAX; i++) check(pool.acquire() !== null, () => `T3: fill to maxSize got null at ${i}`);
        check(pool.size === MAX, () => `T3: at maxSize size=${pool.size} (expected ${MAX})`);
        check(pool.used === MAX, () => `T3: at maxSize used=${pool.used} (expected ${MAX})`);
        check(pool.acquire() === null, () => `T3: acquire one past maxSize != null`);
        check(pool.size === MAX, () => `T3: one past maxSize grew size to ${pool.size}`);
        check(conserved(pool), () => `T3: maxSize boundary broke conservation`);
    }

    // --- a chunk overshoots a small size but never the cap ------------------
    // size:1,maxSize:1000: the first miss grows a full GROW_CHUNK (bounded),
    // so size jumps well past 2 but stays <= maxSize.
    {
        const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 1, expand: true, maxSize: 1000 });
        pool.acquire();            // the one preallocated object
        pool.acquire();            // first miss -> one chunk created
        check(pool.size > 2, () => `T3: chunked grow did not overshoot (size=${pool.size})`);
        check(pool.size <= 1000, () => `T3: chunked grow breached maxSize (size=${pool.size})`);
        check(conserved(pool), () => `T3: chunked grow broke conservation`);
    }
}
