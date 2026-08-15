/**
 * Boundary tests for the torture harness itself.
 *
 * The harness is the instrument every other gate is read through. If `check()`
 * fails open, or `ratchet()` lets a regression past, or `controlTripped()`
 * accepts an inconclusive verdict as proof, then every "ok" the suite prints
 * afterwards is worthless -- and worse, it is worthless silently.
 *
 * These run under `npm test` rather than inside the torture entry on purpose:
 * a broken instrument must be caught by the cheap suite, not by the expensive
 * one that depends on it.
 *
 * `die()` calls process.exit, so the helpers that can die are exercised in a
 * child process and asserted on their exit code and stderr.
 *
 * @license MIT
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { check, ratchet, controlTripped, conserved, makePrng, RULES }
    from './torture/harness.mjs';

const HARNESS = new URL('./torture/harness.mjs', import.meta.url).pathname;

/**
 * Run a snippet in a child process with the harness imported as `h`.
 * Returns { code, stderr, stdout }.
 */
function runSnippet(body) {
    const src =
        'import * as h from ' + JSON.stringify(HARNESS) + ';\n' + body + '\n';
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
        encoding: 'utf8',
    });
    return { code: res.status, stderr: res.stderr || '', stdout: res.stdout || '' };
}

describe('harness: check()', () => {
    test('passes a true condition without invoking the message thunk', () => {
        // The zero-allocation discipline the whole harness rests on: the thunk
        // must not run on the happy path, or every hot loop allocates a string
        // per iteration and the T6 gate measures its own test harness.
        let thunkRuns = 0;
        check(true, () => { thunkRuns++; return 'should never be built'; });
        assert.equal(thunkRuns, 0, 'message thunk ran on the passing path');
    });

    test('fails closed on every falsy non-boolean condition', () => {
        // `if (!cond)` must treat these as failures. A guard that only compared
        // `cond === false` would let all five through.
        for (const falsy of ['0', "''", 'null', 'undefined', 'NaN']) {
            const r = runSnippet(
                'h.check(' + falsy + ', () => "falsy:' + falsy + '");');
            assert.equal(r.code, 1, 'check(' + falsy + ') did not exit 1');
            assert.match(r.stderr, /torture: FAIL/,
                'check(' + falsy + ') did not report a failure');
        }
    });

    test('a truthy non-boolean condition passes', () => {
        let thunkRuns = 0;
        check(1, () => { thunkRuns++; return 'x'; });
        check('nonempty', () => { thunkRuns++; return 'x'; });
        assert.equal(thunkRuns, 0);
    });
});

describe('harness: ratchet()', () => {
    test('below the ceiling records and does not exit', () => {
        const r = runSnippet('h.ratchet("T", 10, 20, "note"); process.stdout.write("survived");');
        assert.equal(r.code, 0);
        assert.equal(r.stdout, 'survived');
        assert.match(r.stderr, /\[ratchet 10\.00 <= 20\.00\]/);
    });

    test('exactly at the ceiling does not exit', () => {
        // The bound is inclusive; a measurement that lands exactly on the
        // recorded number is the status quo, not a regression.
        const r = runSnippet('h.ratchet("T", 80, 80, "note"); process.stdout.write("survived");');
        assert.equal(r.code, 0);
        assert.equal(r.stdout, 'survived');
    });

    test('above the ceiling exits 1 and names the regression', () => {
        const r = runSnippet('h.ratchet("OP-01a", 500, 80, "note"); process.stdout.write("survived");');
        assert.equal(r.code, 1, 'a regression past the ceiling did not fail the run');
        assert.equal(r.stdout, '', 'execution continued past a failed ratchet');
        assert.match(r.stderr, /OP-01a REGRESSED/);
    });

    test('NaN as the measured value fails closed', () => {
        // `NaN <= 80` is false, so `!(NaN <= 80)` is true and this must die.
        // Written as an explicit test because the negation is easy to "simplify"
        // into `measured > ceiling`, which would silently PASS on NaN -- turning
        // an unmeasurable run into a green one.
        const r = runSnippet('h.ratchet("T", NaN, 80, "note"); process.stdout.write("survived");');
        assert.equal(r.code, 1, 'NaN measurement passed the ratchet');
        assert.equal(r.stdout, '');
    });

    test('Infinity as the measured value fails closed', () => {
        const r = runSnippet('h.ratchet("T", Infinity, 80, "note"); process.stdout.write("survived");');
        assert.equal(r.code, 1, 'Infinity measurement passed the ratchet');
        assert.equal(r.stdout, '');
    });
});

describe('harness: controlTripped()', () => {
    test('only a fail verdict counts as a tripped control', () => {
        assert.equal(controlTripped({ verdict: 'fail' }), true);
    });

    test('an inconclusive verdict is NOT proof that a control tripped', () => {
        // This is the whole point of the helper. lite-gc-profiler has three
        // verdicts and `report.ok` is `verdict === 'pass'`, so `!ok` is true for
        // BOTH fail and inconclusive. A control asserting `!ok` would accept
        // "the gate could not tell" as "the gate caught it".
        assert.equal(controlTripped({ verdict: 'inconclusive' }), false);
        assert.equal(controlTripped({ verdict: 'inconclusive', ok: false }), false);
    });

    test('a pass verdict is not a tripped control', () => {
        assert.equal(controlTripped({ verdict: 'pass' }), false);
    });

    test('a missing or malformed verdict is not a tripped control', () => {
        assert.equal(controlTripped({}), false);
        assert.equal(controlTripped({ ok: false }), false);
        assert.equal(controlTripped({ verdict: 'FAIL' }), false);
    });
});

describe('harness: rules and helpers', () => {
    test('RULES carries only keys the profiler implements', () => {
        // Unknown rule keys THROW on every lane as of profiler v1.10.0, so a
        // typo here would take the whole gate down. There is no
        // maxExternalGrowth; asserting the exact key set pins that.
        assert.deepEqual(Object.keys(RULES).sort(),
            ['maxArrayBuffersGrowth', 'maxMajor', 'maxPauseMs']);
        assert.equal(RULES.maxMajor, 0);
        assert.equal(RULES.maxArrayBuffersGrowth, 0);
    });

    test('conserved() detects a broken invariant', () => {
        assert.equal(conserved({ used: 2, free: 3, size: 5 }), true);
        assert.equal(conserved({ used: 2, free: 3, size: 6 }), false);
    });

    test('makePrng is deterministic and never seeds to zero', () => {
        const a = makePrng(12345);
        const b = makePrng(12345);
        for (let i = 0; i < 32; i++) assert.equal(a(), b(), 'PRNG diverged at ' + i);

        // xorshift32 seeded with 0 is stuck at 0 forever, which would silently
        // turn every fuzz tier into the same single case.
        const zero = makePrng(0);
        const first = zero();
        assert.notEqual(first, 0, 'PRNG seeded with 0 produced 0');
    });
});
