/**
 * T2 -- the DIFFERENTIAL speed tier (P2b, v2.1.0).
 *
 * P2a shipped 2.0.0 without ever recording an absolute acquire/release ns/op
 * baseline, so its `assertOps` assertion had no referent. This tier records the
 * honest thing instead: a DIFFERENTIAL A-vs-B gate. It runs the SHIPPED
 * ObjectPool.js (A) against a FROZEN, byte-identical copy of the 2.0.0 source
 * (B, test/baseline/ObjectPool-2.0.0.js) through lite-gc-profiler's `compareOps`
 * -- the A-vs-B primitive -- and asserts neither side is more than a
 * measured-and-justified margin slower than the other, BOTH directions. Because
 * the four hot bodies are hash-identical across A and B (guarded below), the true
 * ns/op ratio is exactly 1.0 and every deviation is pure timing noise; the gate
 * is a noise-floor gate, not a magic-number gate.
 *
 * THE STATISTIC, and WHY. Timing on a shared machine is noisy and one-sided:
 * scheduling jitter, GC, and CPU contention only ever SLOW a side, inflating one
 * direction's ratio. So the per-run figure is `max(A/B, B/A)` of opsPerSec (the
 * symmetric ns/op ratio), and the reported statistic is the MIN over N runs of
 * that figure -- min-over-N floors the jitter exactly as T6 floors allocation
 * noise (the least-perturbed run is the truest estimate). A real regression slows
 * one side on EVERY run, so even the min run shows it; the positive control below
 * proves that.
 *
 * THE SWEEP (node on darwin, 2026-08-16; verbatim, do not re-derive):
 *
 *   single-run max-ratio, N=15 identical-body runs:  min 1.003  median 1.040  max 1.110
 *   min-over-9 (identical bodies), 6 trials:  1.005 1.009 1.014 1.002 1.007 1.003  -> worst 1.014
 *   min-over-9 (B slowed by a ~200-iter sqrt loop), 6 trials best:  3.892
 *
 * A bare single-run 1.05 threshold sat INSIDE the noise floor (single runs
 * reached 1.11) and would have been a coin-flip. min-over-9 collapses the clean
 * floor to <= 1.014 across six independent trials, while the positive control
 * reads >= 3.89. THRESHOLD = 1.15: ~10x above the clean deviation, ~3.4x below the
 * positive control. An honest 1.15 beats a flaky 1.05.
 *
 * CONTROL: OBJECTPOOL_TORTURE_BREAK=t2 deliberately slows the candidate side with
 * a non-eliminable sqrt loop and requires the gate to TRIP (ratio > threshold).
 * A speed gate that has never been shown to fail is not a gate.
 *
 * The recorded baseline is test/baseline/speed-2.1.0.json. This tier is
 * self-contained (the threshold is a const here); the JSON is the committed
 * record of the sweep, not a runtime input.
 */

import { createHash } from 'node:crypto';
import { compareOps } from '@zakkster/lite-gc-profiler';
import { ObjectPool as Shipped } from '../../ObjectPool.js';
import { ObjectPool as Frozen } from '../baseline/ObjectPool-2.0.0.js';
import { check, die, breaking, controlDefeated } from './harness.mjs';

const CAP = 4096;          // power of two -> cheap index mask
const OPS = 50000;
const WARMUP = 5000;
const N = 9;               // min-over-N; see header. Clean floor <= 1.014, control >= 3.89.
const THRESHOLD = 1.15;    // justified above; matches test/baseline/speed-2.1.0.json

/** The four hot-body sha256 hashes pinned to the 2.0.0 fixture. The A-vs-B
 *  comparison is only meaningful if A and B carry byte-identical hot bodies, so
 *  the tier refuses to run if either side has drifted. The authoritative pin also
 *  lives in ObjectPool.test.js; duplicated here so the torture gate is
 *  self-validating and does not depend on the node:test run having passed. */
const HOT_HASHES = {
    acquire: '55f3a646dd5e9a5700609d82fedc88077dffabb434749776790f4ccc48800de0',
    release: '239ef75c603bf839d2f0df7089651955f8342e5df7bbc89a05e2b23eeeeb8e7a',
    releaseAll: 'b29b13b9996ffd342a3e45bf42b370c83ede18676e19a08d91d882715d7905b9',
    forEachActive: '937941616f65fd728957e65031092991fe34ed3fbfe2990567c994cbffc5550c',
};

function hashBody(Cls, method) {
    return createHash('sha256').update(Cls.prototype[method].toString()).digest('hex');
}

/** A preallocated pool primed to full capacity, returning a 1:1 churn step that
 *  releases then re-acquires one slot per op -- exercising BOTH hot bodies. When
 *  `slow` is set the step does extra non-eliminable sqrt work on the acquired
 *  object (the deliberate slowdown for the control). */
function makeChurn(Cls, slow) {
    const pool = new Cls({ create: () => ({ x: 0 }), size: CAP, expand: false });
    const held = new Array(CAP);
    for (let i = 0; i < CAP; i++) held[i] = pool.acquire();
    if (slow) {
        return (i) => {
            const k = i & (CAP - 1);
            pool.release(held[k]);
            const o = pool.acquire();
            let s = o.x;
            for (let z = 1; z < 200; z++) s += Math.sqrt(z + (i & 7));
            o.x = s;              // escape: keeps the loop from being eliminated
            held[k] = o;
        };
    }
    return (i) => {
        const k = i & (CAP - 1);
        pool.release(held[k]);
        held[k] = pool.acquire();
    };
}

/** One A-vs-B differential: compareOps runs both under MATCHED opts, sequentially
 *  (lite-gc-profiler is one-measurement-at-a-time), and we read opsPerSec off both
 *  sides. Returns the symmetric ns/op ratio max(A/B, B/A) >= 1. */
function ratioOnce(slowCandidate) {
    const a = makeChurn(Shipped, false);
    const b = makeChurn(Frozen, slowCandidate);
    const r = compareOps(a, b, {}, { ops: OPS, warmup: WARMUP });
    const aps = r.control.opsPerSec;
    const bps = r.candidate.opsPerSec;
    return aps > bps ? aps / bps : bps / aps;
}

/** min over N runs of the symmetric ns/op ratio -- floors one-sided jitter. */
function minRatio(slowCandidate) {
    let m = Infinity;
    for (let t = 0; t < N; t++) {
        const v = ratioOnce(slowCandidate);
        if (v < m) m = v;
    }
    return m;
}

export function run() {
    // Precondition: A and B hot bodies must be byte-identical (else the diff is
    // measuring two different functions, and any ratio is meaningless).
    for (const method of Object.keys(HOT_HASHES)) {
        const want = HOT_HASHES[method];
        const shipped = hashBody(Shipped, method);
        const frozen = hashBody(Frozen, method);
        check(shipped === want,
            () => `T2: shipped ${method}() body hash ${shipped} != 2.0.0 fixture ${want} -- ` +
                `a hot body changed; the differential speed gate is invalid`);
        check(frozen === want,
            () => `T2: frozen baseline ${method}() body hash ${frozen} != 2.0.0 fixture ${want} -- ` +
                `test/baseline/ObjectPool-2.0.0.js has drifted; restore it, do not "fix" it`);
    }

    if (breaking('t2')) {
        // The gate MUST catch a deliberately-slowed side. A speed gate that has
        // never tripped is decorative.
        const tripped = minRatio(true);
        if (tripped > THRESHOLD) {
            // Correct outcome: the deliberately-slowed side pushed the ratio past
            // the threshold, so the gate caught it. die() (no defeat token).
            die('T2: speed control (candidate deliberately slowed) tripped the gate at ratio=' +
                tripped.toFixed(3) + ' > threshold=' + THRESHOLD.toFixed(2) + ' (expected non-zero exit)');
        }
        // DEFEATED: a real slowdown stayed inside the threshold (e.g. someone
        // widened THRESHOLD until nothing can trip). Emit the defeat token so the
        // driver -- not just a human reading stderr -- catches it.
        controlDefeated('T2: speed control armed but ratio=' + tripped.toFixed(3) +
            ' stayed within threshold=' + THRESHOLD.toFixed(2) +
            ' -- the speed gate cannot catch a real slowdown, so it cannot be trusted');
    }

    const ratio = minRatio(false);
    check(ratio <= THRESHOLD,
        () => `T2: shipped acquire/release is off the 2.0.0 baseline -- min-over-${N} ns/op ratio ` +
            `${ratio.toFixed(3)} exceeds threshold ${THRESHOLD.toFixed(2)} (both directions). ` +
            `A hot body regressed, or the machine is contended; re-run before widening the budget.`);
}
