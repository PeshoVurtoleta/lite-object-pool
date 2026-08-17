/**
 * T8 -- cross-package conformance (filled in P3, v2.2.0).
 *
 * Five checks, all synchronous, none arming a control (T8 owns no injectable
 * control -- arming it hits the entry-point BACKSTOP, which controls.mjs walks):
 *
 *   1. Three-place version sync: VERSION === package.json.version === the
 *      llms.txt header version line. Enforced by a test, not by discipline.
 *   2. Docs-drift, BOTH directions, against deliberately-broken in-process
 *      fixtures: a prototype method with no llms.txt line, and an llms.txt line
 *      with no prototype method. A one-direction guard passes forever while
 *      drifting, so both are exercised and both broken fixtures MUST be flagged.
 *   3. The lite-leak audit()+count() kernel round trip: clean cycle -> count()===0,
 *      one deliberate leak -> count()===1. The deliberate-leak half IS the
 *      positive control -- a kernel reporting clean on a real leak is the exact
 *      failure lite-leak's docs name. Self-contained: the leak is released before
 *      the tier returns, so T8 never leaves the run dirty.
 *   4. createCollectionGrowthKernel({ collections: [pool] }) against `pool.size`
 *      (ObjectPool exposes a numeric `.size`, so unbounded-growth detection works
 *      with zero new product code): it constructs and its count() tracks size.
 *   5. watchPool -- ADVISORY ONLY. It is asserted available with its documented
 *      handle surface, and DELIBERATELY not treated as a pass on escapeCount===0.
 *      watchPool is structurally incapable of observing an acquired-never-released
 *      object from THIS pool: _items[] retains every pooled object for the pool's
 *      whole life, so no checked-out object is ever collected and escapeCount is 0
 *      by construction (D6.9). The absence of a pass assertion IS the assertion.
 *
 * No control is wired here. Reads no breaking() -- arming t8 falls through to the
 * backstop by design.
 */

import { readFileSync } from 'node:fs';
import { createLeakTracker, createCollectionGrowthKernel } from '@zakkster/lite-leak';
import { watchPool } from '@zakkster/lite-gc-profiler';
import { ObjectPool, VERSION } from '../../ObjectPool.js';
import { DebugObjectPool, createPoolLeakKernel } from '../../ObjectPoolDebug.js';
import { check } from './harness.mjs';

/** Public (non-underscore, non-constructor) names on a prototype. */
function publicMethods(proto) {
    return Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && n.charCodeAt(0) !== 0x5f);
}

/** The named `## ` section of the llms text, sliced to the next `## ` heading.
 *  Anchors the heading to a LINE boundary (`\n<heading>\n`), so an inline mention
 *  of the heading text mid-sentence -- e.g. "like the core `## API` below" -- does
 *  not match and steal another section's tokens. */
function section(llms, heading) {
    const hay = '\n' + llms;
    const idx = hay.indexOf('\n' + heading + '\n');
    if (idx === -1) return '';
    const rest = hay.slice(idx + 1 + heading.length);
    const next = rest.indexOf('\n## ');
    return next === -1 ? rest : rest.slice(0, next);
}

/** Every `` `.name `` token in an API-section string (backtick then dot then id). */
function llmsMethodNames(apiText) {
    const set = new Set();
    const re = /`\.([A-Za-z][A-Za-z0-9]*)/g;
    let m;
    while ((m = re.exec(apiText)) !== null) set.add(m[1]);
    return [...set];
}

/** Both-direction drift: methods with no llms line, llms names with no method. */
function driftCheck(methodNames, apiText) {
    const llmsNames = llmsMethodNames(apiText);
    return {
        missing: methodNames.filter((n) => llmsNames.indexOf(n) === -1),
        extra: llmsNames.filter((n) => methodNames.indexOf(n) === -1),
    };
}

export function run() {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const llms = readFileSync(new URL('../../llms.txt', import.meta.url), 'utf8');

    // --- 1. three-place version sync ----------------------------------------
    check(VERSION === pkg.version,
        () => `T8: VERSION ${VERSION} != package.json ${pkg.version}`);
    const hdr = llms.match(/^# @zakkster\/lite-object-pool v(\d+\.\d+\.\d+)/m);
    check(hdr !== null, () => `T8: llms.txt has no parseable "# @zakkster/lite-object-pool vX.Y.Z" header`);
    check(hdr[1] === VERSION, () => `T8: llms.txt header v${hdr[1]} != VERSION ${VERSION}`);

    // --- 2. docs-drift, both directions, CORE + DEBUG surfaces --------------
    // A surface with no drift guard silently diverges from its docs, so BOTH the
    // core ObjectPool.prototype and the DebugObjectPool.prototype public surfaces
    // are checked, each both directions, each proven by a deliberately-broken
    // in-process fixture (a method with no llms line; an llms line with no
    // method). A one-direction guard passes forever while drifting.
    const surfaces = [
        ['core', publicMethods(ObjectPool.prototype), section(llms, '## API')],
        ['debug', publicMethods(DebugObjectPool.prototype), section(llms, '## /debug API')],
    ];
    for (const [label, methods, api] of surfaces) {
        check(api !== '', () => `T8: llms.txt has no drift-guardable section for the ${label} surface`);
        const real = driftCheck(methods, api);
        check(real.missing.length === 0,
            () => `T8: llms.txt ${label} section is missing prototype method(s): ${real.missing.join(', ')}`);
        check(real.extra.length === 0,
            () => `T8: llms.txt ${label} section names non-existent method(s): ${real.extra.join(', ')}`);

        // Broken fixture A: a prototype method with no llms line MUST be flagged.
        const brokenA = driftCheck(methods.concat('phantom'), api);
        check(brokenA.missing.indexOf('phantom') !== -1,
            () => `T8: ${label} drift guard FAILED to flag a prototype method absent from llms.txt (one-direction hole)`);
        // Broken fixture B: an llms line with no prototype method MUST be flagged.
        const brokenApi = api + '\n- `.ghost(x)` -- a method that does not exist\n';
        const brokenB = driftCheck(methods, brokenApi);
        check(brokenB.extra.indexOf('ghost') !== -1,
            () => `T8: ${label} drift guard FAILED to flag an llms.txt line with no prototype method (one-direction hole)`);
    }

    // --- 3. lite-leak audit()+count() kernel round trip ---------------------
    const dbg = new DebugObjectPool({ create: () => ({ v: 0 }), size: 8, expand: false });
    const kernel = createPoolLeakKernel(dbg);
    const tracker = createLeakTracker({ name: 'objectpool-t8' });
    tracker.registerKernel(kernel); // registers clean: audit()+count() only, no install

    const held = [];
    for (let i = 0; i < 8; i++) held.push(dbg.acquire());
    for (let i = 0; i < held.length; i++) dbg.release(held[i]);
    check(kernel.count() === 0,
        () => `T8: leak kernel count()=${kernel.count()} after a clean acquire/release cycle (expected 0)`);

    const leaked = dbg.acquire();     // deliberate leak: acquired, never released
    check(kernel.count() === 1,
        () => `T8: leak kernel count()=${kernel.count()} after ONE leaked acquire (expected 1) -- ` +
            `a kernel that reports clean on a real leak is the failure lite-leak's docs name`);
    const findings = tracker.audit();
    check(findings.some((f) => f.kind === 'object-pool-leak' && f.reason === 'acquired-not-released'),
        () => `T8: tracker.audit() did not surface the deliberate acquired-not-released leak`);

    dbg.release(leaked);              // clean up so the tier leaves the run at rest
    check(kernel.count() === 0,
        () => `T8: leak kernel count()=${kernel.count()} after releasing the deliberate leak (expected 0)`);
    tracker.unregisterKernel(kernel);

    // --- 4. createCollectionGrowthKernel against pool.size ------------------
    const growthPool = new ObjectPool({ create: () => ({}), size: 4, expand: true, maxSize: Infinity });
    let gk = null;
    try {
        gk = createCollectionGrowthKernel({ collections: [growthPool] });
    } catch (e) {
        check(false, () => `T8: createCollectionGrowthKernel rejected ObjectPool (which exposes numeric .size): ${e.message}`);
    }
    check(typeof gk.count === 'function',
        () => `T8: growth kernel has no count() -- cannot measure pool.size growth`);
    const before = gk.count();
    check(before === growthPool.size,
        () => `T8: growth kernel count()=${before} != pool.size ${growthPool.size} at rest`);
    for (let i = 0; i < 300; i++) growthPool.acquire();
    check(gk.count() === growthPool.size && growthPool.size > before,
        () => `T8: growth kernel count()=${gk.count()} != grown pool.size ${growthPool.size} (before ${before})`);

    // --- 5. watchPool -- ADVISORY ONLY (D6.9) -------------------------------
    check(typeof watchPool === 'function',
        () => `T8: lite-gc-profiler no longer exports watchPool (advisory)`);
    const wp = watchPool({ label: 'objectpool-t8' });
    check(wp !== null && typeof wp === 'object',
        () => `T8: watchPool did not return a handle`);
    for (const fn of ['register', 'release', 'settle', 'dispose']) {
        check(typeof wp[fn] === 'function',
            () => `T8: watchPool handle is missing documented method ${fn}() (advisory shape check)`);
    }
    // DELIBERATELY no escapeCount / assertNoEscapes pass here: watchPool cannot
    // fire against this pool (_items[] retention, D6.9), and its settle() is async
    // and does not compose with the harness's stabilize:'deep'. The absence of a
    // pass assertion IS the assertion.
    if (typeof wp.dispose === 'function') wp.dispose();

    return { findings: 0, warnings: 0 };
}
