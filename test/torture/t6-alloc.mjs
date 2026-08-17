/**
 * T6 -- the allocation gate. This is the package's gate; everything else
 * supports it.
 *
 * Three hot shapes, measured STRICTLY SEQUENTIALLY (lite-gc-profiler is
 * one-measurement-at-a-time):
 *
 *   (c) the DEFINING shape: acquire-to-capacity + forEachActive + release-to-empty
 *   (a) steady 1:1 churn at capacity on a preallocated pool
 *   (b) the spike: acquire-to-capacity + releaseAll
 *
 * Shape (c) is the sentence the P2 roadmap calls "the gate that defines this
 * session" and runs FIRST so it owns the OBJECTPOOL_TORTURE_BREAK=t6 control.
 *
 * As of P2 (v2.0.0) the v1 `_out` Set is gone: acquire is a cursor advance,
 * release is a swap-remove over a preallocated Uint32Array pair, and the
 * per-object slot index lives in a WeakMap that is READ (never grown) on the
 * hot path. So OP-01 is FIXED: both shapes allocate ZERO bytes per op, and the
 * two ratchets that recorded 66.78 / 42.10 B/acquire in v1.1.0 are now live
 * `check(=== 0)` gates.
 *
 * How "0 B/op" is measured, and WHY this exact window. A raw gc-anchored
 * `heapUsed` delta (the v1 method, the only shape in which the Set rehash could
 * be seen) carries kilobytes of ambient noise and cannot certify a zero. v2 has
 * no rehash, so any acquire-heavy window proves the point -- the figure is
 * lite-gc-profiler `heap.allocBytes` over the window, NETTED against a no-op
 * baseline, floored at 0, and taken as the MIN over NET_TRIES attempts. A truly
 * zero-alloc path hits the 0 floor on most attempts (noise only adds); a path
 * that allocates N B/op can never read below N, so min-over-N cannot falsely
 * floor a real allocation.
 *
 * The WINDOW SIZE is load-bearing and was swept against a positive control (a
 * body that retains one object per op) at 12 tries each. Do not re-derive it:
 *
 *   ops=  1000  pool zero=10/12  ctl zero=11/12  POSITIVE zero= 0/12 min=0.7680
 *   ops=  5000  pool zero=12/12  ctl zero=12/12  POSITIVE zero= 2/12 min=0.0000  BAD
 *   ops= 20000  pool zero= 8/12  ctl zero= 8/12  POSITIVE zero= 1/12 min=0.0000  BAD
 *   ops=200000  pool zero= 7/12  ctl zero= 6/12  POSITIVE zero= 0/12 min=0.0094
 *
 * At 5000 and 20000 ops the POSITIVE control sometimes reads zero -- the window
 * cannot tell "zero" from "blind" and is unusable. At ~1000 ops a zero-alloc
 * path lands exact zero ~83-92% of tries while the allocating control reads
 * 0.768 B/op and NEVER zero (an ~80x margin), so the small window is chosen for
 * discrimination, not convenience. NET_TRIES=8 at p(zero)~0.83 puts a false FAIL
 * near 1e-6. A POSITIVE control lane runs as part of the gate and MUST read
 * non-zero: a zero-proof with no positive control cannot distinguish clean from
 * blind. (The control retains `{v}` into a sink so V8 cannot scalar-replace it;
 * a non-escaping object reads 0.0000 and would masquerade as instrument failure.)
 *
 * The 200000-op `runOpsGate` churn below is UNCHANGED and correct for what it
 * gates -- maxMajor / maxPauseMs / maxArrayBuffersGrowth over a long window.
 * Only the netted-bytes figure uses the small discrimination window.
 *
 * Also gated: structural conservation (pool.size must not grow, used+free===
 * size). Control: OBJECTPOOL_TORTURE_BREAK=t6 retains a Float64Array in the hot
 * body, whose ArrayBuffer backing store trips maxArrayBuffersGrowth and forces a
 * non-zero exit. A gate that cannot fail is decorative.
 */

import { measureOps } from '@zakkster/lite-gc-profiler';
import { ObjectPool } from '../../ObjectPool.js';
import { runOpsGate, check, die, breaking, controlTripped, controlDefeated } from './harness.mjs';

const CAP = 4096;         // power of two -> cheap index mask
const STEADY_OPS = 200000;
const STEADY_WARMUP = 2000;
const SPIKE_OPS = 400;
const SPIKE_WARMUP = 20;
const NET_OPS = 1000;     // discrimination window for the netted B/op figure
const NET_WARMUP = 2000;
const NET_TRIES = 8;      // min over N attempts -- the zero floor wins ~1e-6 false-fail

/** Retained sink for the t6 control -- survives GC so arrayBuffers grows. */
const leak = [];

/** Accumulator for the composite shape's forEachActive body, so V8 cannot
 *  dead-code-eliminate the visit. The composite pools seed each object's `x` to
 *  a NON-ZERO sentinel (COMPOSITE_X) and this sum is asserted after the measured
 *  window, so "visited 4096 objects" is distinguishable from "visited 0" -- a
 *  write-only, always-zero sink could not tell those apart. */
const COMPOSITE_X = 1;
let compositeSink = 0;
const compositeVisit = (o) => { compositeSink += o.x; };

/** allocBytes over an OPS window for a no-op body -- the instrument's own cost,
 *  subtracted so a lane's figure reflects the pool and not the measurement. */
function baselineAllocBytes(ops, warmup) {
    return measureOps((i) => { void i; }, { ops, warmup, stabilize: 'deep' }).summary.heap.allocBytes;
}

/** Net bytes per unit-op for `step`, floored at 0 and taken as the MIN over
 *  NET_TRIES attempts. `perUnit` is how many pool ops one `step` performs. */
function netBytesPerOp(step, ops, warmup, perUnit) {
    let min = Infinity;
    for (let t = 0; t < NET_TRIES; t++) {
        const base = baselineAllocBytes(ops, warmup);
        const got = measureOps(step, { ops, warmup, stabilize: 'deep' }).summary.heap.allocBytes;
        const net = got - base;
        const v = (net <= 0 ? 0 : net) / (ops * perUnit);
        if (v < min) min = v;
    }
    return min;
}

export function run() {
    let allocBytesPerOp = 0;
    let gcMetrics = { major: 0, minor: 0, maxMs: 0 };

    // --- shape (c): the DEFINING shape of this session ----------------------
    // A fully preallocated pool running acquire-to-capacity + forEachActive over
    // the full active set + release-to-empty, all inside ONE measured window.
    // This is the exact sentence the P2 roadmap calls "the gate that defines this
    // session"; the two shapes below (steady churn, spike) do not exercise
    // forEachActive, so without this a regression in the composite path the
    // README teaches would slip the gate. Run FIRST so it OWNS the t6 control:
    // under OBJECTPOOL_TORTURE_BREAK=t6 it is the shape that trips and exits
    // non-zero (the two shapes below keep their own control code but are not
    // reached under the token -- the spike already was not). Sequential, never
    // nested (lite-gc-profiler is one-measurement-at-a-time).
    {
        const pool = new ObjectPool({ create: () => ({ x: COMPOSITE_X }), size: CAP, expand: false });
        const sizeBefore = pool.size;
        compositeSink = 0;                                  // observe THIS window's visits
        const hot = () => {
            for (let j = 0; j < CAP; j++) pool.acquire();   // acquire-to-capacity
            pool.forEachActive(compositeVisit);             // over the full active set
            pool.releaseAll();                              // release-to-empty
            if (breaking('t6')) leak.push(new Float64Array(64)); // control: retained growth
        };

        const { report, summary } = runOpsGate(hot, { ops: SPIKE_OPS, warmup: SPIKE_WARMUP });

        check(pool.size === sizeBefore,
            () => `T6: composite grew pool.size ${sizeBefore} -> ${pool.size}`);
        check(pool.used + pool.free === pool.size,
            () => `T6: composite broke conservation used=${pool.used} free=${pool.free} size=${pool.size}`);
        // Non-vacuous visit proof: each of the >= SPIKE_OPS steady steps visits
        // exactly CAP objects each contributing COMPOSITE_X. A DCE'd or empty
        // forEachActive would leave the sink near 0, far below this lower bound --
        // so the composite lane cannot masquerade as measuring a body it skipped.
        check(compositeSink >= SPIKE_OPS * CAP * COMPOSITE_X,
            () => `T6: composite forEachActive visited too few -- sink=${compositeSink} < ` +
                `${SPIKE_OPS * CAP * COMPOSITE_X} (a vacuous or eliminated visit)`);

        if (breaking('t6')) {
            if (!controlTripped(report)) {
                // DEFEATED: the injected allocations were NOT caught. Emit the
                // defeat token so the driver distinguishes this from a working
                // control (both exit non-zero with a T6: tag otherwise).
                controlDefeated('T6: composite control armed but verdict=' + report.verdict +
                    ' (expected "fail"); the alloc gate did not catch the injected ' +
                    'allocations on the defining shape');
            }
            die('T6: composite control tripped the alloc gate with verdict=fail (expected non-zero exit)');
        }

        // The session's defining assertion: an unambiguous PASS, never inconclusive.
        if (report.verdict !== 'pass') {
            const g = summary.gc;
            die('T6 composite gate verdict=' + report.verdict + ' (expected "pass") -- ' +
                'source=' + summary.source + ' major=' + g.major +
                ' maxMs=' + g.maxMs.toFixed(3) + ' abGrowth=' + summary.arrayBuffers.growthBytes);
        }
    }

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
            // `inconclusive` verdict as proof, which is not proof.
            if (!controlTripped(report)) {
                controlDefeated('T6: control armed but verdict=' + report.verdict +
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

    // --- POSITIVE control: the instrument MUST see a real allocation --------
    // A body that retains one object per op reads clearly non-zero. If THIS
    // reads 0, the netting is blind and every "0" below is meaningless. The
    // sink makes `{v}` escape so V8 cannot scalar-replace it away.
    {
        const sink = [];
        const allocStep = (i) => { sink.push({ v: i }); if (sink.length > 4096) sink.length = 0; };
        const ctlPerOp = netBytesPerOp(allocStep, NET_OPS, NET_WARMUP, 1);
        check(ctlPerOp > 0,
            () => `T6: positive control read ${ctlPerOp.toFixed(4)} B/op -- the netting instrument is BLIND, ` +
                `so the OP-01 zero-checks below cannot be trusted`);
    }

    // --- SECOND positive control: the COMPOSITE lane's own window -----------
    // The netting window is load-bearing (the header sweep shows the NET_OPS
    // control going BLIND at ops=5000/20000), and OP-01c runs at a DIFFERENT
    // window -- SPIKE_OPS steps of CAP acquires, perUnit=CAP -- than the NET_OPS
    // control above. So the NET_OPS control validating does NOT prove OP-01c's
    // window discriminates. This control retains one object per step at OP-01c's
    // EXACT parameters (SPIKE_OPS x CAP) and MUST read > 0, or OP-01c's zero is an
    // unvalidated, blind zero. Same failure mode, same BLIND message.
    {
        const sink = [];
        const compCtlStep = (i) => {
            sink.push({ v: i });                 // one retained object per step
            if (sink.length > 4096) sink.length = 0;
        };
        const compCtlPerAcquire = netBytesPerOp(compCtlStep, SPIKE_OPS, SPIKE_WARMUP, CAP);
        check(compCtlPerAcquire > 0,
            () => `T6: composite positive control read ${compCtlPerAcquire.toFixed(6)} B/acquire at the ` +
                `composite window (ops=${SPIKE_OPS} x CAP=${CAP}) -- the netting instrument is BLIND there, ` +
                `so the OP-01c composite zero cannot be trusted`);
    }

    // --- OP-01 is FIXED: both ratchets are now hard `=== 0` checks ----------
    //
    // v1.1.0 recorded these as ratchets: draining a preallocated pool retained
    // 66.78 B/acquire (20000) and 42.10 B/acquire (4096) through the `_out` Set
    // rehash. v2 has no Set. The figures below are the netted, min-over-tries
    // allocBytes over the small discrimination window (see header), gated at
    // zero -- the headline "1,321,024 bytes -> 0" as a live assertion.
    {
        // OP-01a: the spike shape (acquire-to-capacity + releaseAll), reused
        // pool, no per-rep construction. `per` is CAP acquires per step.
        const spikePool = new ObjectPool({ create: () => ({ x: 0 }), size: CAP, expand: false });
        const spikeStep = () => {
            for (let j = 0; j < CAP; j++) spikePool.acquire();
            spikePool.releaseAll();
        };
        const spikePerAcquire = netBytesPerOp(spikeStep, SPIKE_OPS, SPIKE_WARMUP, CAP);
        check(spikePerAcquire === 0,
            () => `OP-01a NOT fixed: spike retained ${spikePerAcquire.toFixed(4)} B/acquire (must be 0)`);

        // OP-01b: steady 1:1 churn at capacity, on the small discrimination
        // window (NET_OPS), NOT the 200000-op gate window above.
        const churnPool = new ObjectPool({ create: () => ({ x: 0 }), size: CAP, expand: false });
        const churnHeld = new Array(CAP);
        for (let i = 0; i < CAP; i++) churnHeld[i] = churnPool.acquire();
        const churnStep = (i) => {
            const k = i & (CAP - 1);
            churnPool.release(churnHeld[k]);
            churnHeld[k] = churnPool.acquire();
        };
        const churnPerOp = netBytesPerOp(churnStep, NET_OPS, NET_WARMUP, 1);
        check(churnPerOp === 0,
            () => `OP-01b NOT fixed: steady churn retained ${churnPerOp.toFixed(4)} B/op (must be 0)`);

        // OP-01c: the DEFINING composite shape -- acquire-to-capacity +
        // forEachActive + release-to-empty -- also nets exactly zero.
        const compPool = new ObjectPool({ create: () => ({ x: COMPOSITE_X }), size: CAP, expand: false });
        const compStep = () => {
            for (let j = 0; j < CAP; j++) compPool.acquire();
            compPool.forEachActive(compositeVisit);
            compPool.releaseAll();
        };
        const compPerAcquire = netBytesPerOp(compStep, SPIKE_OPS, SPIKE_WARMUP, CAP);
        check(compPerAcquire === 0,
            () => `OP-01c NOT fixed: composite retained ${compPerAcquire.toFixed(4)} B/acquire (must be 0)`);

        allocBytesPerOp = churnPerOp;
    }

    return { allocBytesPerOp, gc: gcMetrics };
}
