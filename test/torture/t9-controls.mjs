/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * Runs deliberately-broken variants IN PROCESS and asserts the corresponding
 * gate flags each one. If a control slips through, T9 itself fails the run -- a
 * gate that cannot fail is decorative. This runs on a plain `node ...
 * torture.mjs`, so the gates are proven to bite without needing the
 * whole-suite OBJECTPOOL_TORTURE_BREAK=1 switch (which the T0/T6/T7 tiers also
 * honour for an end-to-end non-zero exit).
 */

import { createLeakTracker } from '@zakkster/lite-leak';
import { runOpsGate, die, controlTripped } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];
const NOOP = function () {};

export function run() {
    // --- Control 1: the alloc gate ------------------------------------------
    // A hot body that retains a Float64Array every iteration MUST be rejected by
    // runOpsGate (maxArrayBuffersGrowth:0). If it passes, the T6 gate is blind.
    //
    // `report.ok` is `verdict === 'pass'`, so `!report.ok` is true for BOTH
    // `fail` and `inconclusive`. An inconclusive verdict (e.g. `not_observed`,
    // an unresolved uasm quantum) proves nothing about whether the injected
    // allocation was caught, so checking `!report.ok` alone would let an
    // inconclusive window silently count as "the control tripped". Demand
    // `verdict === 'fail'` specifically via `controlTripped`.
    const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, {
        ops: 4000,
        warmup: 0,
    });
    if (!controlTripped(report)) {
        die('T9 control: an allocating hot loop did not produce verdict=fail ' +
            '(got verdict=' + report.verdict + ', ok=' + report.ok + ')');
    }
    leak.length = 0; // release the control's garbage

    // --- Control 2: the T0 distinctness law ---------------------------------
    // The Set-based distinctness check must flag a fabricated duplicate. If a
    // duplicated handle still counts as "all distinct", the T0 law is decorative.
    const objs = [{}, {}, {}];
    const seenOk = new Set(objs);
    if (seenOk.size !== objs.length) {
        die('T9 control: distinctness checker flagged genuinely-distinct objects');
    }
    objs[1] = objs[0]; // fabricate a duplicate
    const seenBad = new Set(objs);
    if (seenBad.size === objs.length) {
        die('T9 control: distinctness checker missed a duplicated handle');
    }

    // --- Control 3: the T7 leak witness -------------------------------------
    // A resource tracked and never untracked must leave tracker.size() non-zero.
    // If size() returns to 0 without an untrack, the soak witness is blind.
    const tracker = createLeakTracker({ name: 'objectpool-control' });
    const h = tracker.track({ probe: true }, NOOP, 'control');
    if (tracker.size() === 0) {
        die('T9 control: leak tracker reported 0 for a live tracked resource');
    }
    tracker.untrack(h);
    if (tracker.size() !== 0) {
        die('T9 control: leak tracker did not return to 0 after untrack');
    }
}
