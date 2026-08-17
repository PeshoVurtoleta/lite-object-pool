/**
 * bench/torture.js -- run with: node --expose-gc bench/torture.js  (npm run bench)
 *
 * Bench protocol v3 for @zakkster/lite-object-pool, stamped with machine
 * provenance so a number is attributable and a second machine's run can be
 * compared against this one. Three implementations are put side by side:
 *
 *   v2  the shipped sparse-set pool   (../ObjectPool.js)
 *   v1  the frozen Set-based pool     (../test/baseline/ObjectPool-1.1.0.js)
 *   naive  per-acquire allocation into a RETAINED sink (the thing a pool avoids)
 *
 * The interesting axis is BYTES/op, not ns/op, and it is the one v1 loses on:
 * v1's `_out` Set rehashes as it grows during exactly the spawn spike this
 * package exists to absorb, so a gc-anchored drain of a never-drained 20,000
 * pool retains ~1.3 MB. v2's sparse set retains zero. This bench reproduces the
 * CHANGELOG's headline "1,321,024 bytes -> 0" as a re-runnable number.
 *
 * WHY THE V1 FIXTURE IS FROZEN, NOT PULLED FROM NPM. `git show d3a13ad:
 * ObjectPool.js` (VERSION '1.1.0', Set-based) frozen verbatim to
 * ../test/baseline/ObjectPool-1.1.0.js. The SAME file is driven from
 * test/torture/t5-fuzz.mjs (a third differential lane on used/free/size), and
 * both this bench and T5 assert they loaded it -- two divergent "v1"s would make
 * the headline comparison unfalsifiable.
 *
 * NON-GOAL: this bench does not tune itself to agree with the CHANGELOG. A
 * stamped number is allowed to disagree; if it does, the resolution is recorded
 * in the CHANGELOG, not smuggled into a threshold here.
 *
 * @license MIT
 */

import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

import { ObjectPool, VERSION } from '../ObjectPool.js';
import { ObjectPool as ObjectPoolV1, VERSION as V1_VERSION } from '../test/baseline/ObjectPool-1.1.0.js';

const hasGC = typeof globalThis.gc === 'function';
const fmt = (n) => n.toLocaleString('en-US');

// ---- fixture provenance: bench and T5 must load the SAME frozen v1 ---------
// Both resolve the fixture to the one absolute repo path and assert its VERSION.
// Rename or fork the fixture and BOTH this assertion and T5's fail -- that is
// what keeps the headline v1-vs-v2 comparison falsifiable. To make this FAIL:
// point the import above at a different file, or bump the fixture's VERSION.
const FIXTURE_URL = new URL('../test/baseline/ObjectPool-1.1.0.js', import.meta.url);
const FIXTURE_PATH = FIXTURE_URL.pathname;
if (V1_VERSION !== '1.1.0') {
    throw new Error('bench: v1 fixture VERSION is "' + V1_VERSION + '", expected "1.1.0" -- not the frozen Set-based baseline');
}
if (!FIXTURE_PATH.endsWith('/test/baseline/ObjectPool-1.1.0.js')) {
    throw new Error('bench: v1 fixture resolved to ' + FIXTURE_PATH + ', not test/baseline/ObjectPool-1.1.0.js');
}

// ---- provenance stamp (template: LiteRouter/bench/bench.js:51-66) ----------
const cpus = os.cpus();
const provenance = {
    date: new Date().toISOString(),
    objectPoolVersion: VERSION,
    v1FixtureVersion: V1_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0] ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    totalMemGB: Math.round(os.totalmem() / 1024 ** 3),
    gc: hasGC,
};

// ---- statistics (template: LiteRouter/bench/bench.js:67+) ------------------
function quantile(sorted, q) {
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return sorted[base + 1] !== undefined
        ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
        : sorted[base];
}

const IQR_FLAG_PCT = 15; // spread wider than this vs the median = noisy sample.
                         // This is ALSO the "within noise" band for the headline
                         // reproduction below -- one definition of noise, reused,
                         // so the headline assertion is falsifiable.

/** Run `fn` `iterations` times, `reps` times over, and report median ops/sec + IQR. */
function benchReps(label, iterations, reps, fn) {
    for (let i = 0; i < Math.min(iterations, 20_000); i++) fn(i); // warm the JIT once
    const samples = [];
    for (let r = 0; r < reps; r++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) fn(i);
        const t1 = process.hrtime.bigint();
        samples.push(iterations / (Number(t1 - t0) / 1e6 / 1000));
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    const median = quantile(sorted, 0.5);
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    const iqrPct = (iqr / median) * 100;
    return { label, iterations, reps, medianOpsPerSec: median, nsPerOp: 1e9 / median, iqrPct, spreadFlag: iqrPct > IQR_FLAG_PCT };
}

// ---- bytes/op instrument (the t6 discrimination window, reused verbatim) ---
// NET_OPS=1000 is load-bearing: the T6 header records that the netted-bytes
// figure goes BLIND (a real allocation reads 0.0000) at ops=5000/20000. This
// bench reuses the SAME validated window, and validates its positive control AT
// THAT WINDOW below before trusting any zero.
const NET_OPS = 1000;
const NET_WARMUP = 2000;
const NET_TRIES = 8;

function baselineAllocBytes() {
    return measureOps((i) => { void i; }, { ops: NET_OPS, warmup: NET_WARMUP, stabilize: 'deep' }).summary.heap.allocBytes;
}

/** Net bytes per op for `step`, floored at 0, min over NET_TRIES. A truly
 *  zero-alloc path hits 0 on most tries (noise only adds); a path that allocates
 *  N B/op can never read below N, so min-over-N cannot falsely floor it. */
function netBytesPerOp(step) {
    let min = Infinity;
    for (let t = 0; t < NET_TRIES; t++) {
        const base = baselineAllocBytes();
        const got = measureOps(step, { ops: NET_OPS, warmup: NET_WARMUP, stabilize: 'deep' }).summary.heap.allocBytes;
        const net = got - base;
        const v = (net <= 0 ? 0 : net) / NET_OPS;
        if (v < min) min = v;
    }
    return min;
}

// ---- object shapes ---------------------------------------------------------
// TWO shapes, unconditionally. The roadmap made this conditional on "IF the
// OP-17 probe showed polymorphism costs"; it ran during P2a and DID -- the
// mixed-mechanism lane measured 0.0055 B/op (decisions/D1-structure.md:119),
// which killed the symbol-with-WeakMap-fallback design and forced WeakMap-only.
// The condition is satisfied, so we bench both shapes and report the delta, even
// when it is noise at bench scale: a small monomorphic particle and a larger
// entity, so a polymorphic slot-reader regression would show as a bytes/op or
// ns/op split between them.
const makeSmall = () => ({ x: 0, y: 0 });
const makeLarge = () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, active: false });

const RESULTS = { protocol: 3, provenance, sections: {} };

const RULE = '-'.repeat(66);
console.log('\n@zakkster/lite-object-pool -- benchmark (protocol v3)\n' + RULE);
console.log(provenance.cpu + ' -- ' + provenance.cores + ' cores -- ' + provenance.totalMemGB + ' GB');
console.log('node ' + provenance.node + ' -- ' + provenance.platform + '/' + provenance.arch +
    ' -- gc=' + hasGC + ' -- object-pool ' + provenance.objectPoolVersion + ' -- v1 fixture ' + provenance.v1FixtureVersion);
console.log(provenance.date);
console.log('v1 fixture: ' + FIXTURE_PATH + '  (same file driven by test/torture/t5-fuzz.mjs)\n');

if (!hasGC) {
    console.log('bytes/op lanes need --expose-gc:  node --expose-gc bench/torture.js');
    console.log('(ns/op lanes will still run)\n');
}

// ===========================================================================
// 0. INSTRUMENT VALIDATION -- prove the bytes/op netting is not blind, at the
//    exact window this bench uses, before any zero below is trusted. This is
//    the scalar-replacement trap that read the first T6 positive control as
//    0.0000 B/op: an allocation that never escapes is deleted by V8.
// ===========================================================================
if (hasGC) {
    console.log('0. Instrument validation  (window ops=' + NET_OPS + ', min-over-' + NET_TRIES + ')');

    // RETAINED: {v} escapes into `sink`, so V8 cannot scalar-replace it. MUST be
    // > 0 or every zero below is a blind zero. To make this FAIL: change the
    // push line to `const o = { v: i }; void o;` -- it then reads 0.0000.
    const sink = [];
    const escaping = (i) => { sink.push({ v: i }); if (sink.length > 4096) sink.length = 0; };
    const escapeBytes = netBytesPerOp(escaping);

    // NON-ESCAPING: the identical allocation, dropped. V8 scalar-replaces it,
    // so it reads 0.0000 -- the proof that the escaping lane is measuring escape
    // and not the instrument. To make this FAIL: retain `o` (push it into sink).
    const dropped = (i) => { const o = { v: i }; void o; };
    const droppedBytes = netBytesPerOp(dropped);

    console.log('   positive control (retained) : ' + escapeBytes.toFixed(4) + ' B/op   (must be > 0)');
    console.log('   same alloc, dropped         : ' + droppedBytes.toFixed(4) + ' B/op   (scalar-replaced -> 0)');
    RESULTS.sections.instrument = { escapeBytes, droppedBytes };

    if (!(escapeBytes > 0)) {
        console.error('  FAIL: positive control read 0 B/op -- the netting instrument is BLIND at ops=' + NET_OPS +
            '; every zero below is meaningless.');
        process.exitCode = 1;
    }
    if (!(droppedBytes < escapeBytes)) {
        console.error('  FAIL: the dropped (non-escaping) allocation did not read below the retained one -- ' +
            'escape analysis is not behaving as the trap requires; the baseline could be measuring nothing.');
        process.exitCode = 1;
    }
    console.log('');
}

// ===========================================================================
// 1. THROUGHPUT -- acquire+release ns/op, v2 vs v1 vs naive. Absolute ns is
//    machine-specific (hence provenance); the shape of the gap is the signal.
// ===========================================================================
console.log('1. Throughput  (median of reps, IQR flagged > ' + IQR_FLAG_PCT + '%)');
const REPS = 7;
const THRU_CAP = 4096;

function churnFn(Pool) {
    const pool = new Pool({ create: makeSmall, size: THRU_CAP, expand: false });
    const held = new Array(THRU_CAP);
    for (let i = 0; i < THRU_CAP; i++) held[i] = pool.acquire();
    return (i) => {
        const k = i & (THRU_CAP - 1);
        pool.release(held[k]);
        held[k] = pool.acquire();
    };
}

// naive: a fresh allocation per "op" retained into a bounded sink -- what a
// caller does when they have no pool at all.
const naiveSink = [];
const naiveChurn = (i) => { naiveSink.push(makeSmall()); if (naiveSink.length > THRU_CAP) naiveSink.length = 0; };

const r_v2 = benchReps('v2 acquire+release pair', 2_000_000, REPS, churnFn(ObjectPool));
const r_v1 = benchReps('v1 acquire+release pair', 2_000_000, REPS, churnFn(ObjectPoolV1));
const r_naive = benchReps('naive alloc (no pool)', 2_000_000, REPS, naiveChurn);
for (const r of [r_v2, r_v1, r_naive]) {
    console.log('   ' + r.label.padEnd(26) + fmt(Math.round(r.medianOpsPerSec)).padStart(14) + ' ops/s   ' +
        r.nsPerOp.toFixed(2).padStart(7) + ' ns/op   (IQR ' + r.iqrPct.toFixed(1) + '%)' + (r.spreadFlag ? '  [!] NOISY' : ''));
}
RESULTS.sections.throughput = { v2: r_v2, v1: r_v1, naive: r_naive };
console.log('');

// ===========================================================================
// 2. THE HEADLINE -- reproduce "1,321,024 bytes -> 0" on a gc-anchored 20,000
//    drain of a NEVER-DRAINED pool. This is the ONLY shape in which v1's Set
//    rehash fires (CHANGELOG.md:449 is the exact reproduction; :432 is the
//    claim row). Each rep builds a FRESH pool -- the rehash is one-shot per pool.
// ===========================================================================
console.log('2. Headline  "1,321,024 bytes -> 0" on a 20,000 drain of a never-drained pool');
if (hasGC) {
    const DRAIN_N = 20_000;
    const DRAIN_REPS = 7;
    const CLAIM_BYTES = 1_321_024; // CHANGELOG.md:432 / :164 -- the 2.0.0 headline
    const V2_DRAIN_FRAC = 0.02;    // v2's raw drain must be < 2% of v1's, or the
                                   // "-> 0" half is contradicted by the drain itself
    const DRAIN_PRE = NET_OPS + NET_WARMUP + 1024; // fully preallocate the instrument
                                   // pool so the measured acquires (warmup 2000 + ops
                                   // 1000) drain it without ever triggering growth
                                   // (growth would allocate). Generous headroom so a
                                   // few extra measureOps steps cannot exhaust it.
                                   // DEPENDENCY: v1's non-zero control relies on the
                                   // Set rehashing near 2048 entries landing INSIDE
                                   // the post-warmup window (warmup ends at ~2000, the
                                   // window runs 2000 -> 3000), which straddles 2048.
                                   // Widening prealloc does not move that; changing
                                   // NET_WARMUP/NET_OPS could.

    // --- (a) absolute retained bytes: v1's own before-figure method. A gc-
    // anchored heapUsed delta over a drain of a NEVER-DRAINED pool -- the only
    // shape in which v1's Set rehash fires (CHANGELOG.md:449). Fresh pool per
    // rep (the rehash is one-shot per pool). This gives the absolute 1.3 MB the
    // claim states; it is ambient-noise-limited on the v2 side (which is exactly
    // why the strict "-> 0" is certified by the instrument in (b), not here).
    function drainBytes(Pool) {
        const p = new Pool({ create: () => ({ x: 0 }), size: DRAIN_N, maxSize: DRAIN_N });
        globalThis.gc(); globalThis.gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < DRAIN_N; i++) p.acquire();
        const after = process.memoryUsage().heapUsed;
        void p; // keep the drained pool alive across the read
        return after - before;
    }
    function medianDrain(Pool) {
        const s = [];
        for (let r = 0; r < DRAIN_REPS; r++) s.push(drainBytes(Pool));
        s.sort((a, b) => a - b);
        const median = quantile(s, 0.5);
        const iqr = quantile(s, 0.75) - quantile(s, 0.25);
        return { median, iqrPct: median !== 0 ? (iqr / median) * 100 : 0, samples: s };
    }

    // --- (b) per-acquire allocation on the SAME drain shape, via the NET_OPS
    // discrimination instrument (section 0 validated this window). Each try
    // builds a FRESH fully-preallocated pool and measures `acquire()` (never
    // released -- a drain). v1's Set.add rehashes as it grows -> non-zero, which
    // is ALSO the positive control proving the drain window is not blind; v2's
    // cursor advance nets exactly 0. This certifies "-> 0" on the claimed
    // workload, not on a churn stand-in.
    //
    // The step RETAINS the acquire return into a bounded ring so a
    // return-value-only allocation regression cannot be scalar-replaced to a
    // false 0 (the exact failure that read this package's first T6 positive
    // control as 0.0000). The ring is fixed-size -- an escape, not a retention
    // test. v2's return is an `_items[]` load (no allocation), so it still nets 0.
    const drainSink = new Array(64).fill(null);
    let drainSinkIdx = 0;
    function drainNetBytesPerAcquire(makePool) {
        let min = Infinity;
        for (let t = 0; t < NET_TRIES; t++) {
            const p = makePool();
            const step = () => {
                drainSink[drainSinkIdx & 63] = p.acquire();  // escape via a bounded ring
                drainSinkIdx = (drainSinkIdx + 1) | 0;
            };
            const base = baselineAllocBytes();
            const got = measureOps(step, { ops: NET_OPS, warmup: NET_WARMUP, stabilize: 'deep' }).summary.heap.allocBytes;
            const net = got - base;
            const v = (net <= 0 ? 0 : net) / NET_OPS;
            if (v < min) min = v;
        }
        return min;
    }

    const d_v1 = medianDrain(ObjectPoolV1);
    const d_v2 = medianDrain(ObjectPool);
    const v1DrainNet = drainNetBytesPerAcquire(() => new ObjectPoolV1({ create: () => ({ x: 0 }), size: DRAIN_PRE, expand: false }));
    const v2DrainNet = drainNetBytesPerAcquire(() => new ObjectPool({ create: () => ({ x: 0 }), capacity: DRAIN_PRE, prealloc: 'eager', onExhausted: 'null' }));
    if (drainSink[0] === undefined) throw new Error('bench: drain ring never written'); // keep the ring escaped

    const v1PerAcquire = d_v1.median / DRAIN_N;
    const v2PerAcquire = d_v2.median / DRAIN_N;
    const claimDevPct = Math.abs(d_v1.median - CLAIM_BYTES) / CLAIM_BYTES * 100;

    // The drain window MUST discriminate: v1's drain-acquire allocates (the Set
    // rehash). If it reads 0 the instrument is BLIND on this shape and v2's zero
    // proves nothing -- a hard fail, not a verdict. To make this FAIL: point the
    // v1 makePool at the v2 sparse-set pool (it nets 0, tripping this).
    const drainWindowValid = v1DrainNet > 0;
    if (!drainWindowValid) {
        console.error('  FAIL: v1 drain-acquire netted 0 B/op -- the drain discrimination window is BLIND; ' +
            'v2\'s "-> 0" cannot be certified on this shape.');
        process.exitCode = 1;
    }

    // --- the verdict tests BOTH halves of "1,321,024 -> 0" ---
    // v1 half: the absolute retained bytes reproduce the claim within the noise band.
    const confirmedV1 = claimDevPct <= IQR_FLAG_PCT;
    // v2 half ("-> 0"): TWO independent conditions, either alone can force DISAGREES:
    //   (1) strict zero on the DRAIN shape via the instrument (the authoritative one), and
    //   (2) a raw-drain sanity: v2 retains a negligible fraction of v1 on the same
    //       drain, so a v2 that suddenly retained like v1 (or more) fails here too.
    const confirmedV2 = drainWindowValid && v2DrainNet === 0 && d_v2.median < d_v1.median * V2_DRAIN_FRAC;
    const confirmed = confirmedV1 && confirmedV2;

    console.log('   v1 (Set)     retained ' + fmt(Math.round(d_v1.median)).padStart(11) + ' B   (' + v1PerAcquire.toFixed(2) + ' B/acquire raw delta, IQR ' + d_v1.iqrPct.toFixed(1) + '%)');
    console.log('   v2 (sparse)  retained ' + fmt(Math.round(d_v2.median)).padStart(11) + ' B   (' + v2PerAcquire.toFixed(4) + ' B/acquire raw delta, IQR ' + d_v2.iqrPct.toFixed(1) + '% -- ambient-noise-limited, see instrument line)');
    console.log('   drain-acquire instrument (ops=' + NET_OPS + ', min-over-' + NET_TRIES + ', SAME drain shape):');
    console.log('       v1 : ' + v1DrainNet.toFixed(4) + ' B/op   (positive control -- MUST be > 0: the Set rehash)');
    console.log('       v2 : ' + v2DrainNet.toFixed(4) + ' B/op   (the certified "-> 0")');
    console.log('   CHANGELOG claim ' + fmt(CLAIM_BYTES) + ' B -> 0:');
    console.log('       v1 half : bench deviates ' + claimDevPct.toFixed(2) + '% from ' + fmt(CLAIM_BYTES) + ' B  (' + (confirmedV1 ? 'WITHIN ' + IQR_FLAG_PCT + '% band' : 'OUTSIDE ' + IQR_FLAG_PCT + '% band') + ')');
    console.log('       v2 half : instrument ' + v2DrainNet.toFixed(4) + ' B/op AND raw ' + fmt(Math.round(d_v2.median)) + ' B < ' + (V2_DRAIN_FRAC * 100).toFixed(0) + '% of v1  (' + (confirmedV2 ? 'both hold' : 'FAILS -- v2 does not reach 0') + ')');
    console.log('   resolution: ' + (confirmed ? 'CONFIRMED -- both halves reproduce; no CHANGELOG correction needed.' : 'DISAGREES -- record the bench figure in the CHANGELOG (task 8); do NOT tune the bench.'));

    RESULTS.sections.headline = {
        drainN: DRAIN_N, claimBytes: CLAIM_BYTES,
        v1RawDrain: d_v1, v2RawDrain: d_v2, v1PerAcquire, v2PerAcquire, claimDevPct,
        v1DrainNetBytesPerAcquire: v1DrainNet, v2DrainNetBytesPerAcquire: v2DrainNet,
        drainWindowValid, confirmedV1, confirmedV2, confirmed,
        resolution: confirmed
            ? 'CONFIRMED: both halves ("1,321,024 B" and "-> 0") reproduce; no correction needed.'
            : 'DISAGREES: record the bench figure in the CHANGELOG; do not tune the bench.',
    };
} else {
    console.log('   skipped -- re-run with --expose-gc');
}
console.log('');

// ===========================================================================
// 3. NAIVE-ALLOC BASELINE -- genuinely naive (allocate per acquire), asserted
//    non-zero by RETAINING/escaping. The same allocation dropped reads 0.0000
//    (scalar replacement), which is why the retained figure is the honest one.
// ===========================================================================
console.log('3. Naive-alloc baseline  (window ops=' + NET_OPS + ')');
if (hasGC) {
    const sinkA = [];
    const naiveRetainSmall = (i) => { sinkA.push(makeSmall()); if (sinkA.length > 4096) sinkA.length = 0; };
    const naiveRetainBytes = netBytesPerOp(naiveRetainSmall);

    // Same allocation, NOT retained -- V8 scalar-replaces it to 0.0000. This is
    // the control that proves the retained figure measures a real allocation and
    // not the instrument. To make the assertion below FAIL: retain here too.
    const naiveDropSmall = (i) => { const o = makeSmall(); void o; };
    const naiveDropBytes = netBytesPerOp(naiveDropSmall);

    console.log('   per-acquire, RETAINED sink : ' + naiveRetainBytes.toFixed(4) + ' B/op   (must be > 0 -- a pool avoids exactly this)');
    console.log('   per-acquire, sink DELETED  : ' + naiveDropBytes.toFixed(4) + ' B/op   (scalar-replaced -> 0; a baseline that reads this measures nothing)');
    RESULTS.sections.naive = { retainedBytesPerOp: naiveRetainBytes, droppedBytesPerOp: naiveDropBytes };

    // Gate: the naive baseline MUST be non-zero, or it is not a baseline.
    if (!(naiveRetainBytes > 0)) {
        console.error('  FAIL: the naive baseline read 0 B/op -- it optimised to zero and measures nothing.');
        process.exitCode = 1;
    }
} else {
    console.log('   skipped -- re-run with --expose-gc');
}
console.log('');

// ===========================================================================
// 4. TWO OBJECT SHAPES -- both benched, polymorphic delta reported (even if it
//    is noise at bench scale). WHY two shapes: decisions/D1-structure.md:119 --
//    the mixed symbol+WeakMap slot-reader lane measured 0.0055 B/op, the only
//    lane that did not net zero, which forced the WeakMap-only design. v2 has
//    ONE release shape, so both object shapes must net zero and the ns delta
//    must be small; a split here would be the polymorphism regression returning.
// ===========================================================================
console.log('4. Two object shapes  (v2 pool; polymorphic delta reported)');
if (hasGC) {
    const churnSmall = churnFn2(ObjectPool, makeSmall);
    const churnLarge = churnFn2(ObjectPool, makeLarge);
    const smallBytes = netBytesPerOp(churnSmall.step);
    const largeBytes = netBytesPerOp(churnLarge.step);
    const rs = benchReps('small (2 fields)', 2_000_000, REPS, churnSmall.step);
    const rl = benchReps('large (8 fields)', 2_000_000, REPS, churnLarge.step);
    const nsDelta = Math.abs(rs.nsPerOp - rl.nsPerOp);
    const nsDeltaPct = nsDelta / Math.min(rs.nsPerOp, rl.nsPerOp) * 100;

    console.log('   small (2 fields) : ' + smallBytes.toFixed(4) + ' B/op   ' + rs.nsPerOp.toFixed(2) + ' ns/op');
    console.log('   large (8 fields) : ' + largeBytes.toFixed(4) + ' B/op   ' + rl.nsPerOp.toFixed(2) + ' ns/op');
    console.log('   polymorphic delta: ' + Math.abs(smallBytes - largeBytes).toFixed(4) + ' B/op, ' + nsDelta.toFixed(2) + ' ns/op (' + nsDeltaPct.toFixed(1) + '%)');
    console.log('   note: D1-structure.md:119 -- 0.0055 B/op on the mixed slot-reader lane forced WeakMap-only;');
    console.log('         one release shape means both object shapes net zero here.');
    RESULTS.sections.shapes = { smallBytes, largeBytes, smallNs: rs.nsPerOp, largeNs: rl.nsPerOp, nsDeltaPct };
} else {
    console.log('   skipped -- re-run with --expose-gc');
}
console.log('');

// ===========================================================================
// 5. FULL-WORKLOAD ArrayBuffer STABILITY -- maxArrayBuffersGrowth:0 with
//    stabilize:'deep' across a mixed acquire/release/releaseAll/forEachActive
//    workload over both shapes, not just a single torture body. ArrayBuffer
//    backing stores live outside the V8 heap; stabilize:'deep' resolves them.
// ===========================================================================
console.log('5. Full-workload ArrayBuffer stability  (maxArrayBuffersGrowth: 0, stabilize: deep)');
if (hasGC) {
    // Seed x to a non-zero sentinel so the forEachActive visit sum is a real
    // proof the walk ran over the full active set, not a vacuous always-zero read.
    const poolS = new ObjectPool({ create: () => ({ x: 1, y: 0 }), size: 1024, expand: false });
    const poolL = new ObjectPool({ create: () => ({ x: 1, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, active: false }), size: 1024, expand: false });
    let sink = 0;
    const visit = (o) => { sink += o.x; };
    // To make this FAIL: push a `new Float64Array(64)` into a retained array in
    // the body -- its backing store trips maxArrayBuffersGrowth and rejects.
    const workload = () => {
        for (let j = 0; j < 1024; j++) poolS.acquire();
        poolS.forEachActive(visit);
        poolS.releaseAll();
        for (let j = 0; j < 1024; j++) poolL.acquire();
        poolL.forEachActive(visit);
        poolL.releaseAll();
    };
    const WL_OPS = 400;
    const res = measureOps(workload, { ops: WL_OPS, warmup: 20, stabilize: 'deep' });
    const report = checkNoGc(res.summary, { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 });
    const ab = res.summary.arrayBuffers.growthBytes;
    // Non-vacuous visit proof, WIRED to the exit code: each measured step visits
    // 1024 poolS + 1024 poolL objects each seeded x=1, and measureOps runs at
    // least WL_OPS steps, so a live workload leaves sink >= WL_OPS*2048. A DCE'd
    // or empty forEachActive leaves it far below -- and now FAILS, not just prints
    // NONE. To make this FAIL: change a `create` seed to `x: 0`.
    const visitFloor = WL_OPS * 2048;
    const visitsOk = sink >= visitFloor;
    console.log('   verdict=' + report.verdict + '  arrayBuffers.growthBytes=' + ab + '  major=' + res.summary.gc.major + '  visits=' + (visitsOk ? 'ok' : 'TOO FEW'));
    RESULTS.sections.arrayBuffers = { verdict: report.verdict, growthBytes: ab, major: res.summary.gc.major, visitFloor, visits: sink, visitsOk };
    if (!visitsOk) {
        console.error('  FAIL: forEachActive visited too few -- sink=' + sink + ' < ' + visitFloor + ' (a vacuous or eliminated walk)');
        process.exitCode = 1;
    }
    if (report.verdict !== 'pass') {
        console.error('  FAIL: full-workload gate verdict=' + report.verdict + ' (arrayBuffers grew or a major GC fired)');
        process.exitCode = 1;
    }
} else {
    console.log('   skipped -- re-run with --expose-gc');
}
console.log(RULE);

// Helper hoisted below the sections that use it (function declaration).
function churnFn2(Pool, make) {
    const pool = new Pool({ create: make, size: THRU_CAP, expand: false });
    const held = new Array(THRU_CAP);
    for (let i = 0; i < THRU_CAP; i++) held[i] = pool.acquire();
    return {
        step: (i) => {
            const k = i & (THRU_CAP - 1);
            pool.release(held[k]);
            held[k] = pool.acquire();
        },
    };
}

// ---- machine-readable artifact for re-runnable, stamped numbers ------------
try {
    const artifactURL = new URL('./bench-results.json', import.meta.url);
    RESULTS.generated = provenance.date;
    writeFileSync(artifactURL, JSON.stringify(RESULTS, null, 2));
    console.log('\nwrote bench/bench-results.json');
} catch { /* ignore */ }
