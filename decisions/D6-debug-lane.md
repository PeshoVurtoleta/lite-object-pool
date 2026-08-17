# D6 -- the debug lane, stats(out), and where the counters live

Session P3 (v2.2.0). Recorded BEFORE any product code, per BRIEF2's hard
ordering. This settles the nine points BRIEF2 enumerates. The counter question
(point 6) is answered by a NUMBER measured against a frozen candidate copy with
T2's own machinery -- never by editing the shipped `ObjectPool.js` to find out.

## The single-file law is not violated (resolved, not blocking)

Suite law says "single PascalCase main file", and it means one main ENTRY, not
one file. Verified evidence: 17 sibling packages ship subpath exports, including
BOTH peers this package gates against --
`node_modules/@zakkster/lite-gc-profiler/llms.txt:44-52` ships
`./register ./test-helpers ./explain`, and LiteLeakforge ships
`./harness ./formatters ./scenarios ./panels`. A second entry
(`@zakkster/lite-object-pool/debug`) is legal. `files[]` grows 7 -> 8.

## 1. Option B confirmed -- a `/debug` subpath. A and C rejected.

**B: a `@zakkster/lite-object-pool/debug` subpath exporting a wrapper.**
The production `ObjectPool.js` stays byte-identical on the hot path; the debug
surface lives in a second file that never loads in production.

Rejected:

- **A -- a `{debug: true}` constructor flag, branched per acquire.** The law
  ("a branch that never fires still costs its bytes in the hot body") is the
  soft argument. The MECHANICAL argument is decisive: `t2-speed.mjs` pins four
  hot-body sha256 hashes and REFUSES TO RUN if either side drifts. Putting
  `if (this._debug)` inside `acquire()` changes `acquire.toString()`, which
  fails the named hash test in `ObjectPool.test.js` AND in `t2-speed.mjs`, and
  falsifies T2's stated premise ("the true ns/op ratio is exactly 1.0, every
  deviation is pure timing noise"). A never resolves without paying the exact
  cost the "MOVE" branch of point 6 pays -- so A buys nothing and costs the
  production hot body.
- **C -- a build-time flag dead-code-eliminated by the consumer's bundler.**
  Zero cost, but ONLY for consumers who bundle, and this package ships
  unbundled ESM (`"type": "module"`, `main`/`module`/`exports` all point at the
  raw source). Dead on this distribution shape. Recorded so it is not
  re-proposed.

## 2. `{debug: true}` handling -- leave it to the generic throw, PIN it.

There is NO reserved-name list to add to. `FUTURE_KEYS` and its constructor
branch were DELETED in 2.1.0 (D5 point 3); what remains is `ALLOWED_KEYS` plus a
generic unknown-key throw with a did-you-mean hint. `new ObjectPool({ create,
debug: true })` ALREADY throws by name today (verified live):

    TypeError: ObjectPool: "debug" is not a recognized option. Known options:
    create, reset, capacity, prealloc, onExhausted (or the aliases size, expand,
    maxSize)

DECISION: leave `debug` to the generic throw and PIN it with a test. A
`debug`-specific message pointing at the subpath would re-create the exact
special-case shape D5 deleted -- and the constructor is touched ZERO times this
session (NON-GOAL: no option-shape change). The subpath is a separate ENTRY, not
an option.

## 3. The debug lane is a public-surface WRAPPER, not a privates-reading subclass.

DECISION: `DebugObjectPool` COMPOSES an `ObjectPool` (holds one as `_pool`) and
speaks only its public surface -- `acquire` / `release` / `releaseAll` /
`forEachActive` / `destroy` / `stats` / `size` / `used` / `free`. It reads NO
`_items` / `_sparse` / `_slots` / `_active`.

Same NON-GOAL as BRIEF1's option layer: a subclass reaching into the sparse set
would couple the debug lane to the internal structure and break silently on a
future structural change. If the diff touches `_dense` / `_sparse` / `_slots`,
stop. It does not.

## 4. What an acquire-site tag IS -- bounded by lite-leak's HELD-VALUE CONTRACT.

lite-leak's contract (`node_modules/@zakkster/lite-leak/llms.txt:125-130`):
neither `cleanup` nor `tag` may close over the tracked target, or finalization
is defeated. Our tag design honours it whether or not lite-leak is in play.

REPRESENTATION: a monotonic `id` (a `number`, minted per acquire) plus an
optional `at` string (`new Error().stack`, captured only when the wrapper is
constructed with `captureStacks: true`). Both are primitives; NEITHER closes
over the pooled object. The wrapper keeps `obj -> { id, at }` in a `Map` it owns;
the pooled object is retained anyway by `ObjectPool._items[]`, so the Map adds no
retention the pool did not already have.

PER-ACQUIRE BYTE COST (measured node v26.3.1, darwin, 2026-08-17, net min-over-6
via lite-gc-profiler `measureOps` `heap.allocBytes` against a plain-pool
baseline; stated as a number in llms.txt):
- `captureStacks: false` (default): ~102 B/acquire -- one `{ id, at }` record
  plus its Map entry.
- `captureStacks: true`: ~1173 B/acquire (~1.2 KB) -- the above plus a captured
  stack string, shape-dependent.
These are DEBUG-LANE bytes. The production `ObjectPool` hot path is still
0 B/op; this lane loads only from the `/debug` subpath.

## 5. `leaks()` allocates a report per call, by design.

`DebugObjectPool.leaks()` builds and returns a fresh array of
`{ id, at }` records naming every currently-acquired-but-not-released object.
It allocates per call and is documented not-for-production in llms.txt. It is a
diagnostic read, called at human/telemetry rate, never in a frame loop.

## 6. Where peakUsed / totalAcquires / totalReleases live -- MEASURED: they MOVE.

METHOD (fixed by BRIEF2, executed here): a frozen candidate copy
(`test/baseline/ObjectPool-2.2.0-counters.js`) with the three counters LANDED IN
the hot bodies was measured with T2's own `compareOps` machinery against the
frozen 2.0.0 copy -- min-over-9 of `max(A/B, B/A)`, OPS=50000, WARMUP=5000 --
over THREE independent trials per run, and its OP-01 lanes were netted through
`netBytesPerOp` at the T6 windows. Threshold: KEEP iff min-over-9 <= 1.05 on
every trial AND every OP-01 lane reads exactly 0. Any trial > 1.05, any non-zero
lane, or ambiguity -> MOVE. Fail closed.

MEASURED (node v26.3.1, darwin, 2026-08-17):

    run A trials:  1.0016  1.0005  1.0644   <- one trial OVER 1.05
    run B trials:  1.0045  1.0065  1.0138
    T6 OP-01 candidate lanes:  spike=0  churn=0  composite=0  (both runs)

OUTCOME: **MOVE.** One of six independent min-over-9 trials read 1.0644, above
the 1.05 threshold; the rest sat 1.0005-1.0138. That is a borderline reading
with an excursion over threshold -- exactly the ambiguity the rule fails closed
on. The cost of KEEP compounds the decision: it would force re-pinning all four
hot-body hashes in two files, freezing a new 2.2.0 speed fixture, and REWRITING
T2's rationale (it stops being an identical-body noise-floor gate and becomes a
magic-number gate its own header argues against). MOVE keeps HOT_HASHES
untouched, `speed-2.1.0.json` the record of record, and the byte-identical claim
proven by a test that ALREADY RUNS.

CONSEQUENCE: `totalAcquires` / `totalReleases` / `peakUsed` live in the
`DebugObjectPool` wrapper (its own integer fields, incremented on its own
acquire/release). They are NOT in the shipped `ObjectPool` hot bodies, which stay
byte-identical to 2.0.0. `ObjectPool.stats(out)` therefore ships only the four
free fields (point 7); `DebugObjectPool.stats(out)` adds the three counters.

The candidate copy is DELETED at session end (never shipped, never promoted).

## 7. The `stats(out)` field set -- four free fields.

`ObjectPool.stats(out)` ships, decided per-field on cost:
- `size` / `used` / `free` -- free, they are existing getters (`_size`,
  `_active`, `_size - _active`).
- `expansions` -- free because `_grow` is COLD and NOT hash-pinned: a single
  `this._expansions++` on the growth branch adds nothing to `acquire`'s hot
  body, and the field ships regardless of point 6's outcome.
The contested three (`peakUsed` / `totalAcquires` / `totalReleases`) MOVED to
the debug lane per point 6, so they are NOT on core `stats(out)`.

There is no external consumer to satisfy: watchPool never consumes a stats
object (point 9), so the field set is justified on our own contract alone.

## 8. `out` aliasing -- fail closed, throw naming "out". No shared object.

`out` cannot be the pool's own counters object, because THERE ISN'T ONE -- the
pool holds no stats object to alias. DECISION: `stats(out)` writes into the
caller's `out`, returns it, and allocates nothing. A non-object `out`
(`undefined` / `null` / a primitive) throws a `TypeError` naming `"out"`:

    ObjectPool: "out" must be an object to receive stats, received ...

`stats()` with NO argument must NOT silently allocate a fresh object -- that is a
hidden allocation in a package whose identity is the absence of one, so the
no-arg call throws by the same guard (`undefined` is not an object). A
module-level shared object is REJECTED: two callers writing the same buffer is an
aliasing hazard, and it would make `stats()` non-reentrant.

### Round-2 refinement (2026-08-17): the transactional writer

The reviewer found that the type-only guard above is necessary but not
sufficient: it rejects a non-object `out`, but a real object that is FROZEN,
sealed-empty, or has a getter-only / non-writable field passes the type check and
then throws PARTWAY through the four (or seven) assignments -- leaving the
caller's buffer with some fields fresh and some stale: silently wrong telemetry.
A half-written buffer is not fail-closed.

Descriptor pre-validation (`Object.getOwnPropertyDescriptor` per key) would fix
it but ALLOCATES a descriptor object per key, which breaks the T6
`stats(out) === 0` gate -- a genuine collision between the reviewer's literal
"validate before writing" and the package's zero-alloc identity. Resolved by
delivering the same OBSERVABLE contract (throws naming `"out"`, `out` left in its
exact prior shape) with a TRANSACTIONAL writer instead:

1. Snapshot each field's prior OWN value (`Object.hasOwn` + a primitive read --
   neither allocates, so the writable common path stays 0 B/op, proven by T6).
2. Write every field.
3. On ANY non-writable slot, roll `out` back to its EXACT prior shape -- present
   keys restored to their value, keys THIS write created (absent before) DELETED
   rather than left as fresh `undefined` keys (a plain assignment makes a
   configurable property, so the delete cannot fail) -- guarded per slot so one
   non-writable field cannot skip another's cleanup, then throw a `TypeError`
   naming `"out"`.

So a frozen / sealed-empty / getter-only `out` throws naming `"out"` and is
observably unchanged. `DebugObjectPool.stats` applies the same design over all
seven fields, reading the four core values through an owned always-writable
scratch so a hostile `out` cannot corrupt the read. Pinned by the fail-closed
matrix in `ObjectPool.test.js`, including the extensible-out-with-absent-keys
case (created keys must be deleted, not left `undefined`).

## 9. watchPool cannot observe an acquired-never-released object from this pool.

Written down once so nobody plans against that canary a third time. Verified
against `node_modules/@zakkster/lite-gc-profiler/llms.txt:197-216` (v1.15.0):
`watchPool` is a DETECTOR for the INVERSE of a leak -- a pooled object that
should live but DIED (lost its last ref, got collected). Against THIS pool it is
structurally incapable of firing: `ObjectPool._items[]` holds a strong reference
to every pooled object for the pool's whole lifetime, so no checked-out object
can ever be collected. `escapeCount` is 0 by construction, forever. watchPool is
also async and does not compose with `stabilize:'deep'` (which `harness.mjs`
always passes), and by its own law (2) an empty escapes list is advisory, never
a pass -- `assertNoEscapes` never throws on empty, and there is deliberately no
`assertPoolClean`. So T8 records watchPool as ADVISORY: it asserts the handle is
available and exposes its documented surface, and DELIBERATELY does not treat
`escapeCount === 0` as a pass. The absence of a pass assertion IS the assertion.

The acquired-never-released signal this session actually needs comes from the
`audit()` + `count()` lite-leak kernel over the debug wrapper's own outstanding
tags (point 4), NOT from watchPool and NOT from a `refine()`/FinalizationRegistry
kernel (which would report clean forever here, by the same `_items[]` retention).
