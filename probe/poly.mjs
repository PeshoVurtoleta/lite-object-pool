/**
 * probe/poly.mjs -- mechanism selection probe for the P2a sparse-set core.
 *
 *     node --expose-gc probe/poly.mjs
 *
 * Decision 1 (structure) needs a MEASURED answer to one question: when the
 * object -> slot-index map is a symbol stamp for some pools and a WeakMap
 * fallback for others, does a caller that drives BOTH kinds push `release`
 * polymorphic and lose the hot path? This is OP-17's question landing on the
 * fallback. The probe answers it before a line of ObjectPool.js is written.
 *
 * Lanes (each is a minimal sparse-set pool doing acquire+release churn):
 *   1. single-kind symbol   -- release reads o[SLOT]
 *   2. single-kind WeakMap  -- release reads weakmap.get(o)
 *   3. mixed-kind           -- interleave releases across a symbol pool AND a
 *                              WeakMap pool, 1e6 ops, so the call site sees two
 *                              slot-reader shapes
 *   4. WeakMap-only         -- both pools WeakMap; the safe fallback if 3 fails
 *
 * ADOPT the symbol+WeakMap fallback iff mixed-kind (lane 3) is within 5% of the
 * single-kind mean AND every lane is 0.0000 B/op. REJECT -> WeakMap-only.
 *
 * B/op comes from lite-gc-profiler measureOps (`heap.allocBytes / ops`) -- a
 * hand-rolled heapUsed delta drifts negative and is noise (roadmap D1 note).
 * ns/op comes from a warm perf_hooks loop OUTSIDE the measured window.
 *
 * @license MIT
 */

import { measureOps } from '@zakkster/lite-gc-profiler';
import { performance } from 'node:perf_hooks';

const CAP = 4096;
const MASK = CAP - 1;

/**
 * Build a minimal sparse-set pool over a fixed capacity. `mech` is 'symbol' or
 * 'weakmap' and selects the slot-index mechanism ONCE, here, cold -- exactly as
 * the real pool will. The hot `release` closes over a per-instance `readSlot`
 * so it carries zero mechanism branch.
 */
const SLOT = Symbol('slot');
function makePool(mech) {
    const items = new Array(CAP);
    const dense = new Uint32Array(CAP);
    const sparse = new Uint32Array(CAP);
    const map = mech === 'weakmap' ? new WeakMap() : null;
    let active = 0;

    for (let i = 0; i < CAP; i++) {
        const o = { x: 0 };
        items[i] = o;
        dense[i] = i;
        sparse[i] = i;
        if (mech === 'weakmap') map.set(o, i);
        else o[SLOT] = i;
    }

    const readSlot = mech === 'weakmap'
        ? (o) => map.get(o)
        : (o) => o[SLOT];

    return {
        acquire() {
            if (active >= CAP) return null;
            const idx = dense[active];
            active++;
            return items[idx];
        },
        release(obj) {
            const idx = readSlot(obj);
            if (idx === undefined) return false;
            const pos = sparse[idx];
            if (pos >= active) return false;
            active--;
            const lastItem = dense[active];
            dense[pos] = lastItem;
            sparse[lastItem] = pos;
            dense[active] = idx;
            sparse[idx] = active;
            return true;
        },
    };
}

/** Warm ns/op over `iters` release-churn ops, timed outside any gc window. */
function nsPerOp(step, iters) {
    for (let i = 0; i < 50000; i++) step(i); // warm
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) step(i);
    const t1 = performance.now();
    return ((t1 - t0) * 1e6) / iters; // ms -> ns
}

/** Fixed per-window sampling overhead of measureOps, isolated from a no-op body
 *  so a lane's B/op reflects the release path and not the instrument. */
let baselineAllocBytes = -1;
function calibrate(ops) {
    const noop = (i) => { void i; };
    const res = measureOps(noop, { ops, warmup: 2000, stabilize: 'deep' });
    baselineAllocBytes = res.summary.heap.allocBytes;
}

/** Net B/op over a measured window, floored at 0 -- the instrument's own
 *  allocation is subtracted so only the release path shows. */
function bytesPerOp(step, ops) {
    const res = measureOps(step, { ops, warmup: 2000, stabilize: 'deep' });
    const net = res.summary.heap.allocBytes - baselineAllocBytes;
    return (net <= 0 ? 0 : net) / ops;
}

function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write('poly: run with --expose-gc\n');
        process.exit(1);
    }

    // Steady-state churn: hold capacity, release+reacquire one slot per op.
    const symPool = makePool('symbol');
    const symHeld = new Array(CAP);
    for (let i = 0; i < CAP; i++) symHeld[i] = symPool.acquire();
    const symStep = (i) => {
        const k = i & MASK;
        symPool.release(symHeld[k]);
        symHeld[k] = symPool.acquire();
    };

    const wmPool = makePool('weakmap');
    const wmHeld = new Array(CAP);
    for (let i = 0; i < CAP; i++) wmHeld[i] = wmPool.acquire();
    const wmStep = (i) => {
        const k = i & MASK;
        wmPool.release(wmHeld[k]);
        wmHeld[k] = wmPool.acquire();
    };

    // Mixed-kind: interleave a symbol pool and a WeakMap pool through ONE step,
    // so `release` at this call site observes two slot-reader shapes.
    const mixA = makePool('symbol');
    const mixB = makePool('weakmap');
    const mixAHeld = new Array(CAP);
    const mixBHeld = new Array(CAP);
    for (let i = 0; i < CAP; i++) { mixAHeld[i] = mixA.acquire(); mixBHeld[i] = mixB.acquire(); }
    const mixStep = (i) => {
        const k = i & MASK;
        mixA.release(mixAHeld[k]); mixAHeld[k] = mixA.acquire();
        mixB.release(mixBHeld[k]); mixBHeld[k] = mixB.acquire();
    };

    // WeakMap-only: both pools WeakMap -- the fallback if mixed-kind regresses.
    const woA = makePool('weakmap');
    const woB = makePool('weakmap');
    const woAHeld = new Array(CAP);
    const woBHeld = new Array(CAP);
    for (let i = 0; i < CAP; i++) { woAHeld[i] = woA.acquire(); woBHeld[i] = woB.acquire(); }
    const woStep = (i) => {
        const k = i & MASK;
        woA.release(woAHeld[k]); woAHeld[k] = woA.acquire();
        woB.release(woBHeld[k]); woBHeld[k] = woB.acquire();
    };

    const OPS = 1000000;

    // ns/op first (timing needs the ICs already warm), then B/op windows.
    const lanes = [
        ['single symbol ', symStep, 2],
        ['single weakmap', wmStep, 2],
        ['mixed  sym+wm ', mixStep, 4],
        ['weakmap-only  ', woStep, 4],
    ];

    calibrate(200000);
    const out = [];
    for (const [name, step, opsPerStep] of lanes) {
        const ns = nsPerOp(step, OPS) / opsPerStep;   // per release+acquire op
        const b = bytesPerOp(step, 200000) / opsPerStep;
        out.push({ name, ns, b });
    }

    process.stdout.write('poly: lane                ns/op      B/op\n');
    for (const r of out) {
        process.stdout.write(
            'poly: ' + r.name + '   ' + r.ns.toFixed(3).padStart(8) +
            '   ' + r.b.toFixed(4).padStart(8) + '\n');
    }

    const single = (out[0].ns + out[1].ns) / 2;
    const mixed = out[2].ns;
    const pct = ((mixed - single) / single) * 100;
    const allZero = out.every((r) => r.b === 0);
    const withinBudget = pct <= 5;

    process.stdout.write(
        'poly: mixed-kind is ' + pct.toFixed(1) + '% vs single-kind mean (' +
        single.toFixed(3) + ' ns/op); all lanes 0 B/op: ' + allZero + '\n');

    if (withinBudget && allZero) {
        process.stdout.write('poly: SELECT symbol+WeakMap fallback (mixed-kind within 5%, all 0 B/op)\n');
    } else {
        process.stdout.write('poly: SELECT WeakMap-only (mixed-kind ' +
            (withinBudget ? 'ok' : '>5% slower') +
            (allZero ? '' : ', a lane allocated') + ')\n');
    }
}

main();
