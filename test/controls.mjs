/**
 * @zakkster/lite-object-pool -- control driver.
 *
 * Every gate must be provably able to fail. Running the suite with every
 * control armed at once proves only that SOMETHING failed: T0 runs first,
 * trips, and exits, so T6's and T7's controls never execute. A control that
 * never executes is not a proven control -- it is a comment.
 *
 * This driver arms each tier's control ALONE and requires that run to exit
 * non-zero, then requires the clean run to exit zero. Both directions matter:
 * a suite that always fails is as useless as one that never does.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';

const TIERS = ['t0', 't6', 't7'];
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

// 2. Each tier's control, armed alone, must make the suite exit non-zero AND
//    must be the tier that reports the failure. Checking the message keeps a
//    control honest: a t6 control that trips because T0 broke is not a t6
//    control.
for (const tier of TIERS) {
    const r = runWith(tier);
    if (r.code === 0) {
        fail(tier + ' control armed but the suite still exited 0 -- that gate is decorative');
    }
    const tag = tier.toUpperCase() + ':';
    if (r.stderr.indexOf(tag) === -1) {
        fail(tier + ' control exited ' + r.code + ' but no ' + tag +
            ' failure was reported -- it tripped somewhere else:\n' + r.stderr);
    }
    if (r.stdout.trim() === 'ok') {
        fail(tier + ' control printed "ok" on a failing run');
    }
}

process.stdout.write('ok\n');
