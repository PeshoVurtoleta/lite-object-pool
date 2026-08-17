/**
 * @zakkster/lite-object-pool -- control driver.
 *
 * Every gate must be provably able to fail. Running the suite with every control
 * armed at once proves only that SOMETHING failed: T0 runs first, trips, and
 * exits, so the later controls never execute. A control that never executes is
 * not a proven control -- it is a comment.
 *
 * This driver walks EVERY armable tier ALONE and requires the right kind of
 * non-zero exit for that tier, then requires the clean run to exit zero. Both
 * directions matter: a suite that always fails is as useless as one that never
 * does. Two classes of tier (single source of truth in harness.mjs):
 *
 *   CONTROL-OWNING (t0, t2, t6, t7) -- own an injectable control keyed to
 *     breaking(tier). Armed alone they MUST print their own `TN:` tag, exit
 *     non-zero, and MUST NOT emit CONTROL-DEFEATED. The defeat token is what makes
 *     a WIDENED-until-useless gate distinguishable from a working one: a control
 *     that dies in BOTH its "tripped" and its "armed-but-defeated" branch looks
 *     identical to a driver that only checks the exit code and the tag, so the
 *     driver whose whole job is "the gate must fail" cannot tell them apart. The
 *     defeated branch emits CONTROL-DEFEATED; this driver asserts it is ABSENT.
 *
 *   ASSERTION / DIFFERENTIAL (t1, t3, t4, t5, t8, t9) -- own NO injectable control
 *     by design (T1/T3/T4 are assertion tiers; T5 documents "T5 owns no control;
 *     T9 owns the oracle-corruption control"; T8 is cross-package conformance,
 *     with a self-contained deliberate-leak as its own positive control; T9's
 *     controls run every invocation). Arming one exercises the entry-point
 *     BACKSTOP: no tier trips, so the run fails safe with the shared backstop
 *     message. Proving the backstop bites is a real property -- arming a tier that
 *     has no control must never print "ok". The walk is TEN tiers.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';
import {
    CONTROL_OWNING_TIERS,
    ALL_ARMABLE_TIERS,
    CONTROL_DEFEATED_TOKEN,
    BACKSTOP_MESSAGE,
} from './torture/harness.mjs';

const ENTRY = new URL('./torture.mjs', import.meta.url).pathname;

/** Run the torture entry with a given control armed. Returns its exit code. */
function runWith(breakValue) {
    const env = Object.assign({}, process.env);
    if (breakValue === null) delete env.OBJECTPOOL_TORTURE_BREAK;
    else env.OBJECTPOOL_TORTURE_BREAK = breakValue;

    const res = spawnSync(process.execPath, ['--expose-gc', ENTRY], {
        env,
        encoding: 'utf8',
    });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
    process.stderr.write('controls: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// 1. The clean run must pass. If it does not, every control below is
//    meaningless -- they would "fail" for the wrong reason.
{
    const r = runWith(null);
    if (r.code !== 0) {
        fail('clean run exited ' + r.code + ' (expected 0)\n' + r.stderr);
    }
    if (r.stdout.trim() !== 'ok') {
        fail('clean run stdout was ' + JSON.stringify(r.stdout) + ', expected exactly "ok"');
    }
}

// 2. Walk EVERY armable tier alone. Each must exit non-zero and never print "ok";
//    the KIND of failure required depends on whether the tier owns a control.
for (const tier of ALL_ARMABLE_TIERS) {
    const r = runWith(tier);
    const owns = CONTROL_OWNING_TIERS.indexOf(tier) !== -1;

    if (r.code === 0) {
        fail(tier + ' armed but the suite still exited 0 -- that gate is decorative');
    }
    if (r.stdout.trim() === 'ok') {
        fail(tier + ' armed but printed "ok" on a failing run');
    }
    // A defeated control must never masquerade as a working one, in ANY tier.
    if (r.stderr.indexOf(CONTROL_DEFEATED_TOKEN) !== -1) {
        fail(tier + ' emitted ' + CONTROL_DEFEATED_TOKEN + ' -- its gate was armed but ' +
            'could not catch the injected fault (a widened/broken gate):\n' + r.stderr);
    }

    if (owns) {
        // Must trip for its OWN reason: the tier tag must appear. Checking the tag
        // keeps a control honest -- a t6 control that trips because T0 broke is not
        // a t6 control.
        const tag = tier.toUpperCase() + ':';
        if (r.stderr.indexOf(tag) === -1) {
            fail(tier + ' (control-owning) exited ' + r.code + ' but no ' + tag +
                ' failure was reported -- it tripped somewhere else:\n' + r.stderr);
        }
    } else {
        // Owns no control by design: arming it must fall through to the backstop.
        // If instead some OTHER tier's tag appears, arming a control-less tier
        // tripped an unrelated gate -- a cross-contamination bug worth surfacing.
        if (r.stderr.indexOf(BACKSTOP_MESSAGE) === -1) {
            fail(tier + ' (owns no control) exited ' + r.code + ' without the backstop message ' +
                JSON.stringify(BACKSTOP_MESSAGE) + ' -- arming it tripped something else:\n' + r.stderr);
        }
    }
}

process.stdout.write('ok\n');
