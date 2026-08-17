// Is 2.1.0 ACTUALLY additive? Differential: drive the frozen 2.0.0 module and
// the live 2.1.0 module through identical LEGACY configs and identical op
// sequences, and compare observable state at every step. Any divergence means
// the reshape was breaking, not additive.
import { ObjectPool as V200 } from '../test/baseline/ObjectPool-2.0.0.js';
import { ObjectPool as V210 } from '../ObjectPool.js';

// Every legacy-vocabulary config a 2.0.0 caller could have written.
const CONFIGS = [
    ['bare',              () => ({ create: () => ({ x: 0 }) })],
    ['size 0',            () => ({ create: () => ({ x: 0 }), size: 0 })],
    ['size 1',            () => ({ create: () => ({ x: 0 }), size: 1 })],
    ['size 32 default',   () => ({ create: () => ({ x: 0 }), size: 32 })],
    ['expand false',      () => ({ create: () => ({ x: 0 }), size: 4, expand: false })],
    ['expand true',       () => ({ create: () => ({ x: 0 }), size: 4, expand: true })],
    ['maxSize 0',         () => ({ create: () => ({ x: 0 }), size: 0, maxSize: 0 })],
    ['maxSize == size',   () => ({ create: () => ({ x: 0 }), size: 8, maxSize: 8 })],
    ['maxSize > size',    () => ({ create: () => ({ x: 0 }), size: 4, maxSize: 9 })],
    ['maxSize Infinity',  () => ({ create: () => ({ x: 0 }), size: 4, maxSize: Infinity })],
    ['reset',             () => ({ create: () => ({ x: 0 }), reset: (o) => { o.x = 0; }, size: 4 })],
    ['cap 1 no expand',   () => ({ create: () => ({ x: 0 }), size: 1, maxSize: 1, expand: false })],
    ['chunk boundary',    () => ({ create: () => ({ x: 0 }), size: 0, maxSize: 257 })],
];

// A fixed op script, run against both. Mixes growth, exhaustion, release,
// double-release, releaseAll and iteration.
function drive(Pool, mk) {
    const trace = [];
    let pool;
    try { pool = new Pool(mk()); }
    catch (e) { return [`CTOR THROW ${e.constructor.name}: ${e.message}`]; }

    const held = [];
    const snap = (tag) => trace.push(`${tag} size=${pool.size} used=${pool.used} free=${pool.free}`);
    snap('init');

    for (let i = 0; i < 300; i++) {
        try {
            const o = pool.acquire();
            trace.push(o === null ? `acq${i}=null` : `acq${i}=obj`);
            if (o !== null) held.push(o);
        } catch (e) { trace.push(`acq${i} THROW ${e.constructor.name}: ${e.message}`); }
        if (i % 50 === 0) snap(`a${i}`);
    }
    snap('filled');

    let n = 0;
    try { pool.forEachActive(() => { n++; }); trace.push(`visited=${n}`); }
    catch (e) { trace.push(`iter THROW ${e.constructor.name}: ${e.message}`); }

    for (let i = 0; i < held.length; i += 3) {
        try { trace.push(`rel${i}=${pool.release(held[i])}`); }
        catch (e) { trace.push(`rel${i} THROW ${e.constructor.name}: ${e.message}`); }
    }
    snap('partial');

    // double release + foreign
    if (held.length) {
        try { trace.push(`dbl=${pool.release(held[0])}`); }
        catch (e) { trace.push(`dbl THROW ${e.constructor.name}: ${e.message}`); }
    }
    try { trace.push(`foreign=${pool.release({ x: 0 })}`); }
    catch (e) { trace.push(`foreign THROW ${e.constructor.name}: ${e.message}`); }

    try { pool.releaseAll(); snap('releaseAll'); }
    catch (e) { trace.push(`releaseAll THROW ${e.constructor.name}: ${e.message}`); }

    try { pool.destroy(); trace.push('destroyed'); }
    catch (e) { trace.push(`destroy THROW ${e.constructor.name}: ${e.message}`); }
    try { pool.acquire(); trace.push('acq-after-destroy NO THROW'); }
    catch (e) { trace.push(`acq-after-destroy THROW ${e.constructor.name}: ${e.message}`); }

    return trace;
}

let bad = 0;
for (const [label, mk] of CONFIGS) {
    const a = drive(V200, mk);
    const b = drive(V210, mk);
    let diffAt = -1;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) if (a[i] !== b[i]) { diffAt = i; break; }
    if (diffAt === -1) {
        console.log(`OK       ${label.padEnd(18)} (${a.length} steps identical)`);
    } else {
        bad++;
        console.log(`DIVERGES ${label.padEnd(18)} at step ${diffAt}`);
        console.log(`    2.0.0: ${a[diffAt]}`);
        console.log(`    2.1.0: ${b[diffAt]}`);
    }
}
console.log(`\n=== ${CONFIGS.length - bad}/${CONFIGS.length} legacy configs behave identically ===`);
