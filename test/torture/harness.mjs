/**
 * @zakkster/lite-object-pool -- torture harness.
 *
 * Shared seed, the deliberately-broken control switch, the zero-GC rule set,
 * a seeded xorshift32 PRNG, the fail-closed assertion helpers, the
 * lite-gc-profiler gate wrapper, and a `todo()` recorder for KNOWN-FAILING
 * cases. Every tier imports from here so the discipline is enforced in one
 * place:
 *
 *   - `check()` builds its message ONLY on failure -- a template literal per
 *     iteration is an allocation and would pollute the T6 gate. Pass a thunk.
 *   - The PRNG is a seeded xorshift32. On any failure a tier prints the seed so
 *     the case replays with `TORTURE_SEED=... node --expose-gc test/torture.mjs`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run sequentially,
 *     never nested. `runOpsGate` opens and closes a single window per call and
 *     uses `stabilize:'deep'` so the `maxArrayBuffersGrowth` rule resolves.
 *   - `todo()` RECORDS a measured known-failure to stderr and does NOT fail the
 *     run. This session (P0) builds the instrument; it fixes no bugs. A todo is
 *     a falsifiable before-figure for the session that fixes it.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/**
 * Deliberately-broken control mode. Every gate must be provably able to fail,
 * so each tier that owns a control reads `breaking(tier)` rather than a single
 * global flag.
 *
 * `OBJECTPOOL_TORTURE_BREAK=1` (or `all`) arms EVERY control. That proves the
 * suite exits non-zero, but only the first-armed tier is actually observed --
 * T0 runs before T6, trips, and exits, so T6's and T7's controls never execute.
 * A control that is never executed is not a proven control.
 *
 * So the value may instead name ONE tier -- `t0`, `t2`, `t6`, `t7` -- arming that
 * control alone and leaving the others clean. `npm run torture:controls` walks
 * every tier in turn and requires each to exit non-zero on its own.
 */
const BREAK_RAW = (process.env.OBJECTPOOL_TORTURE_BREAK || '').trim().toLowerCase();

/** True when any control is armed. Kept for the entry-point's final backstop. */
export const BREAK = BREAK_RAW !== '' && BREAK_RAW !== '0';

/**
 * Tiers that OWN an injectable control keyed to `breaking(tier)`. Arming one of
 * these alone MUST trip THAT tier for THAT tier's reason -- it prints that tier's
 * `TN:` tag and exits non-zero. `controls.mjs` walks these with the strict check.
 *
 * Every OTHER armable tier (T1/T3/T4/T5/T9) owns NO injectable control by design:
 * T1/T3/T4 are pure assertion tiers, T5 is a differential-fuzz tier that
 * documents "T5 owns no control; T9 owns the oracle-corruption control", and T9's
 * controls run on EVERY invocation rather than being armed. Arming one of those
 * exercises the entry-point BACKSTOP instead (no tier trips -> "every control
 * still passed" -> non-zero exit), which `controls.mjs` walks with the backstop
 * check. Proving the backstop bites is itself a real property: arming a tier that
 * has no control must fail SAFE, never silently print "ok".
 */
export const CONTROL_OWNING_TIERS = ['t0', 't2', 't6', 't7'];

/** Every tier id that can be named in OBJECTPOOL_TORTURE_BREAK. controls.mjs
 *  walks all of them; CONTROL_OWNING_TIERS decides which check each one gets. */
export const ALL_ARMABLE_TIERS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't9'];

/** The tiers whose controls this run has armed. `1`/`all` arms the owning set. */
export const BREAK_TIERS = BREAK_RAW === '1' || BREAK_RAW === 'all'
    ? CONTROL_OWNING_TIERS.slice()
    : BREAK_RAW.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Is this tier's deliberately-broken variant armed?
 * @param {string} tier lowercase tier id, e.g. 't6'
 */
export function breaking(tier) {
    return BREAK_TIERS.indexOf(tier) !== -1;
}

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/** The distinct token a DEFEATED control emits. `controls.mjs` asserts it is
 *  ABSENT on a healthy run. Kept here as the single source of truth so the
 *  emitter (controlDefeated) and the driver's grep cannot drift apart. */
export const CONTROL_DEFEATED_TOKEN = 'CONTROL-DEFEATED';

/** The entry-point backstop message, printed when a control is armed but no tier
 *  trips. Shared so the driver greps the exact string, not a paraphrase. */
export const BACKSTOP_MESSAGE = 'OBJECTPOOL_TORTURE_BREAK set but every control still passed';

/**
 * A control was ARMED but the gate did NOT catch the injected fault -- the gate
 * is DEFEATED (e.g. a budget was widened until nothing can trip it). This is a
 * DIFFERENT outcome from a control that fired correctly, yet both must exit
 * non-zero, so a driver that only checks the exit code and the tier tag cannot
 * tell them apart. Emitting CONTROL_DEFEATED_TOKEN lets `controls.mjs` (not just
 * a human) distinguish a working control from a broken one. Use this in the
 * "armed but did NOT trip" branch of any both-branches-fail control; use `die`
 * only in the "tripped correctly" branch.
 * @param {string} msg
 */
export function controlDefeated(msg) {
    process.stderr.write('torture: ' + CONTROL_DEFEATED_TOKEN + ' -- ' + msg + '\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Record a KNOWN-FAILING case without failing the run. Writes the measured
 * number to stderr so the session that fixes the bug has a falsifiable
 * before-figure to beat. This is the P0 discipline: make the bug OBSERVABLE,
 * do not fix it here.
 * @param {string} name  Short case id, e.g. 'OP-01a'.
 * @param {string} note  The measured fact and its reproduction.
 */
export function todo(name, note) {
    process.stderr.write('torture: TODO ' + name + ' -- ' + note + '\n');
}

/**
 * A known-failing case WITH AN UPPER BOUND -- a ratchet.
 *
 * A bare `todo()` records a number and gates nothing, so a regression is
 * indistinguishable from the status quo: if acquire() started retaining 500
 * B/op instead of 66, the suite would print the new number and still exit 0.
 * That is a gate that cannot fail, which is the one thing the suite forbids.
 *
 * `ratchet` records the measurement AND fails when it exceeds `ceiling`. The
 * bug stays known and unfixed; getting WORSE is still a failure. When the
 * fixing session lands, it replaces the call with a hard `check(... === 0)`.
 *
 * @param {string} name     Short case id, e.g. 'OP-01a'.
 * @param {number} measured The value this run observed.
 * @param {number} ceiling  The most this may be before the run fails.
 * @param {string} note     The measured fact and its reproduction.
 */
export function ratchet(name, measured, ceiling, note) {
    process.stderr.write(
        'torture: TODO ' + name + ' -- ' + note +
        ' [ratchet ' + measured.toFixed(2) + ' <= ' + ceiling.toFixed(2) + ']\n');
    if (!(measured <= ceiling)) {
        die(name + ' REGRESSED: measured ' + measured.toFixed(2) +
            ' exceeds the recorded ceiling ' + ceiling.toFixed(2) +
            '. This bug is known and unfixed, but it must not get worse. ' +
            'Raise the ceiling only with a written reason.');
    }
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * Uses measureOps with `stabilize:'deep'` so `maxArrayBuffersGrowth` resolves
 * (ArrayBuffer backing stores live outside the V8 heap). Returns the checkNoGc
 * report plus the raw summary for diagnostics.
 *
 * @param {(i:number)=>void} fn      Sync hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/** The one structural invariant that holds in v1.0.2 and must keep holding. */
export function conserved(pool) {
    return pool.used + pool.free === pool.size;
}

/**
 * Fail-closed control assertion for a lite-gc-profiler report.
 *
 * lite-gc-profiler has THREE verdicts (pass/fail/inconclusive), and
 * `report.ok` is `verdict === 'pass'` -- so `ok === false` is reachable via
 * EITHER `fail` or `inconclusive` (e.g. `not_observed`, an unresolved uasm
 * quantum, an unchecked rule). A control that only asserts `!report.ok`
 * cannot tell "the gate caught the injected allocation" (fail, proof) from
 * "the gate could not tell" (inconclusive, no proof) -- an inconclusive
 * verdict would let an allocating control silently count as tripped. A
 * control MUST demand `verdict === 'fail'` specifically.
 *
 * @param {{verdict:string}} report
 * @returns {boolean} true only when the report is an unambiguous fail.
 */
export function controlTripped(report) {
    return report.verdict === 'fail';
}
