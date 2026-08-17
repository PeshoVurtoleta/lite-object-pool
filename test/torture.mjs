/**
 * @zakkster/lite-object-pool -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Tiers wired in P0 (this session builds the INSTRUMENT; it fixes no bugs):
 *
 *     T0  metamorphic laws              T1  degenerate constructor options
 *     T2  differential speed (P2b)      T3  adversarial churn
 *     T4  identity / lifecycle abuse    T6  the allocation gate
 *     T7  soak + leak witness           T9  controls (must be able to fail)
 *
 * T5 (differential fuzz vs oracle) was filled in P2. T8 (cross-package
 * conformance: three-place version sync, both-direction docs-drift, the
 * lite-leak audit()+count() kernel round trip, createCollectionGrowthKernel vs
 * pool.size, and an ADVISORY watchPool shape check) was filled in P3. The control
 * walk (controls.mjs / ALL_ARMABLE_TIERS) is now TEN tiers.
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent.
 *
 * Known failures OP-01 (per-acquire Set-rehash allocation) and OP-02 (maxSize
 * is not a cap) are made OBSERVABLE here via todo() records with measured
 * before-figures; they are fixed in P2 and P1 respectively.
 *
 * Controls: `OBJECTPOOL_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`
 * corrupts the T0 distinctness law, injects a retained allocation into the T6
 * hot loop, and leaks a T7 tracked resource -- the run MUST exit non-zero.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only. ObjectPool.js
 * has zero runtime dependencies.
 *
 * @license MIT
 */

import { SEED, BREAK, BACKSTOP_MESSAGE } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t2 } from './torture/t2-speed.mjs';
import { run as t3 } from './torture/t3-adversarial.mjs';
import { run as t4 } from './torture/t4-identity.mjs';
import { run as t5 } from './torture/t5-fuzz.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t8 } from './torture/t8-cross.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T2 speed', t2],
    ['T3 adversarial', t3],
    ['T4 identity', t4],
    ['T5 fuzz', t5],       // empty until P2
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T8 cross', t8],      // empty until P3
    ['T9 controls', t9],
];

function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    const metrics = { alloc: 0, gc: { major: 0, minor: 0, maxMs: 0 }, leakSize: 0, findings: 0, warnings: 0 };

    for (const [name, run] of TIERS) {
        try {
            const out = run();
            if (out && typeof out === 'object') {
                if (typeof out.allocBytesPerOp === 'number') metrics.alloc = out.allocBytesPerOp;
                if (out.gc) metrics.gc = out.gc;
                if (typeof out.leakSize === 'number') metrics.leakSize = out.leakSize;
                if (typeof out.findings === 'number') metrics.findings = out.findings;
                if (typeof out.warnings === 'number') metrics.warnings = out.warnings;
            }
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means no control tripped. For a CONTROL-OWNING
    // tier that is a fault (its control failed to fire). For a non-owning tier
    // (T1/T3/T4/T5/T9, which own no injectable control by design) this backstop
    // IS the expected outcome -- arming a tier with no control must still fail
    // safe. Either way: exit non-zero, never a silent "ok".
    if (BREAK) {
        process.stderr.write('torture: FAIL -- ' + BACKSTOP_MESSAGE + '\n');
        process.exit(1);
    }

    // Diagnostic GATE summary on stderr; stdout stays exactly "ok".
    process.stderr.write(
        'torture: GATE leak=size ' + metrics.leakSize + '/0' +
        ' findings=' + metrics.findings + ' warnings=' + metrics.warnings +
        ' | gc major=' + metrics.gc.major + ' minor=' + metrics.gc.minor +
        ' maxMs=' + metrics.gc.maxMs.toFixed(2) +
        ' | alloc=' + metrics.alloc.toFixed(3) + ' B/op\n');

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
