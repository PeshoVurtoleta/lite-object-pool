# D5 -- the option shape: capacity / prealloc / onExhausted

Session P2b (v2.1.0). Recorded BEFORE implementation. This is the additive
reshape 2.0.0 deferred. Everything here is constructor-cold: `acquire`,
`release`, `releaseAll` and `forEachActive` gain ZERO instructions, and their
`.toString()` hashes are pinned byte-for-byte against the 2.0.0 fixture (see
`test/baseline/ObjectPool-2.0.0.js` and the hash test in `ObjectPool.test.js`).

## The shape (roadmap Decision 5, recommendation B)

One bound, one separate population strategy, one exhaustion policy -- so the
`{size: 10, maxSize: 4}` contradiction 1.1.0 had to REJECT becomes something the
API cannot even SPELL on the same axis:

- `capacity` -- the single upper bound on how many objects can ever exist.
  `Infinity` or a finite integer >= 0. Default `Infinity`. Maps to the legacy
  `maxSize`.
- `prealloc` -- how much of the capacity is built at construction:
  `"eager"` (all of it -- REQUIRES a finite capacity), `"lazy"` (none), or an
  integer count. Default `32`. Maps to the legacy `size`.
- `onExhausted` -- what `acquire()` does when it cannot serve:
  `"null"` | `"grow"` | `"throw"`. Default `"grow"`. Folds in the legacy
  `expand` per Decision 4 (`expand:true` = `"grow"`, `expand:false` = `"null"`).

The legacy triple `{size, expand, maxSize}` keeps working as ALIASES (below).

## The four points 2.0.0 left for this record to settle

### 1. Alias precedence -- mixing the two vocabularies THROWS

`{size: 8, capacity: 16}` throws. `{expand: false, onExhausted: "grow"}` throws.
The two vocabularies are MUTUALLY EXCLUSIVE: the presence of any legacy alias
(`size`/`expand`/`maxSize`) together with any canonical name
(`capacity`/`prealloc`/`onExhausted`) is a `TypeError` naming one key from each
side. Accepting both -- silently letting one win -- would reintroduce exactly the
class of ambiguity this session exists to delete: two spellings of the same
intent, disagreeing, with the library guessing. Fail closed instead. An explicit
`key: undefined` counts as ABSENT (matching the optional-key rule already tested
in 2.0.0), so `{size: 8, capacity: undefined}` is legacy, not a conflict.

### 2. `prealloc: "eager"` with `capacity: Infinity` THROWS by name

"Build all of an unbounded capacity" is a request to allocate forever. It is the
2.1.0 spelling of the old OP-02 trap and must throw a named `TypeError` at
construction, not hang. The throw names `"prealloc"` and points at the
contradiction with `capacity: Infinity`. `"eager"` therefore REQUIRES a finite
`capacity`.

### 3. The reserved-name errors flip to real handling

2.0.0 shipped a `FUTURE_KEYS` table whose messages said `capacity`/`prealloc`/
`onExhausted` were "not an option ... coming in 2.1.0". Those three keys are now
REAL options. `FUTURE_KEYS` and its constructor branch are DELETED in the same
diff; the three names join `ALLOWED_KEYS`. No "coming in 2.1.0" or "reserved"
string may survive in a shipped file -- asserted by an in-repo grep test, because
a stale forward-reference shipping IN the release it pointed at is precisely the
kind of thing that survives a whole version.

### 4. Deprecation posture -- aliases are permanent and NEVER warned

`size`/`expand`/`maxSize` are accepted and documented as PERMANENTLY supported.
They are not deprecated and emit no warning. A `console.warn` in a constructor is
an allocation and a side effect, and this library's identity is neither. Recorded
here so "warn the caller as a kindness" is not re-proposed: it would trade the
package's zero-side-effect guarantee for a nag. Callers who want the canonical
spelling can adopt it; callers who do not are never nagged and never broken.

## Defaults -- an explicit OVERTURN of the roadmap's D5 recommendation

The roadmap's Decision 5 recommended `prealloc: "eager"` and a fail-closed
`onExhausted` default, on the argument that hard-real-time is this package's
stated audience. That default would be BREAKING: a bare `new ObjectPool({create})`
in 2.0.0 preallocates 32 and grows on demand; an eager + fail-closed default
would preallocate nothing sane against `capacity: Infinity` (or force a required
`capacity`) and turn today's exhaustion-returns-null into a throw. This session's
whole justification is that the reshape is ADDITIVE and rides a MINOR bump, so no
caller is forced through a second migration.

Therefore the shipped defaults stay 2.0.0-equal:

    capacity: Infinity      (was maxSize: Infinity)
    prealloc: 32            (was size: 32)
    onExhausted: "grow"     (was expand: true)

`new ObjectPool({ create })` builds an identical pool under both vocabularies and
both spellings of the defaults. The "eager + fail-closed" posture remains
available -- callers who want hard-real-time determinism write
`{ capacity: N, prealloc: "eager", onExhausted: "throw" }` explicitly -- but it is
opt-in, not the default.

This is the SECOND overturn of a roadmap recommendation in this package, after
the P2a WeakMap/OP-01 decision (D1) that rejected the roadmap's symbol+WeakMap
fallback on the B/op clause. Recorded as such so the divergence from the roadmap
is deliberate and traceable, not drift.

## OP-04's remainder -- what "throw" closes and what "null" still conflates

2.0.0 (D4) closed the destroyed-pool case: `acquire()` on a destroyed pool
throws. It left two cases still both returning `null` and indistinguishable:
exhausted-with-`expand:false` and capped-at-`maxSize`.

`onExhausted: "throw"` gives callers a way out AND disambiguates: its two throw
messages are distinct --

- capped: `acquire() exceeded capacity <N> (onExhausted:"throw")`
  -- reached when `_size >= _maxSize` (the hard ceiling).
- exhausted: `acquire() on an exhausted pool of <N> object(s)
  (onExhausted:"throw")` -- reached when growth is off and all created objects
  are checked out below the ceiling.

`onExhausted: "null"` (and the capped case under `"grow"`) STILL return `null` and
STILL conflate the two. This is a deliberate remainder, not an oversight: `"null"`
exists precisely for the game-loop caller who treats "no object this frame" as one
condition (`if (!p) break`) and does not want to branch on why. Callers who need
to tell capped from exhausted use `"throw"`. So OP-04 is NARROWED, not closed: the
CHANGELOG says exactly this and does not mark OP-04 done.

## KNOWN LIMIT -- "grow to a hard cap, then throw" is not expressible

`onExhausted` couples two concerns that a hard-real-time caller may want
separately: (1) whether the pool grows past `prealloc` toward `capacity`, and
(2) whether the terminal miss returns `null` or throws. `"grow"` = grow +
null-at-cap; `"null"` = never grow + null; `"throw"` = never grow + throw. There
is no value for grow + throw-at-cap. So the single most useful leak-detection
config --

    { capacity: 4096, prealloc: 32, onExhausted: "throw" }   // grow 32 -> 4096, THEN throw

does NOT do that: `"throw"` implies no growth, so it throws at acquire 33 and the
`capacity: 4096` is inert. "Exceeded capacity" is reachable only when
`prealloc === capacity`.

This is a LIMIT, not a contradiction, and it must not be confused with one. The
config still constructs and behaves consistently: `"throw"` caps at `prealloc` and
throws there.

**This limit is a CHOICE, not a requirement -- additivity does not force it.**
An earlier draft of this record claimed grow-then-throw could not be implemented
without breaking alias equivalence. That was wrong, and is corrected here. The
legacy `expand` is a strict boolean folded as `onExh = ex ? 'grow' : 'null'`
(`ObjectPool.js`), so NO legacy config can reach `_onExh === 'throw'` -- verified
across the whole legacy space:

    {}                                        -> grow
    { size: 32 }                              -> grow
    { expand: true }                          -> grow
    { expand: false }                         -> null
    { size: 32, expand: false, maxSize: 4096 }-> null
    { size: 0, maxSize: 0 }                   -> grow

`onExhausted: "throw"` is therefore PURE NEW SURFACE with no alias, and additivity
places NO constraint on its growth semantics: `"throw"` could have been defined as
"grow to capacity, then throw" without breaking a single alias equivalence. The
legacy twin of `{ size: 32, expand: false, maxSize: 4096 }` is
`{ capacity: 4096, prealloc: 32, onExhausted: "null" }` -- the `"null"` policy,
whose inert-capacity behaviour IS inherited (and is what the boundary test pins).
That inheritance says nothing about what `"throw"` must do.

Why grow-then-throw was NOT implemented (option b, not a) -- a scope decision
resting on (1) and (2) below, not on additivity:

- 2.1.0's thesis is that the option SHAPE is settled -- one bound, one population
  strategy, one exhaustion policy. `onExhausted` is a SINGLE axis with three
  values; `"grow"` already occupies it. "grow AND throw-at-cap" needs a SECOND,
  orthogonal axis (e.g. a separate `onCapacity`, or splitting `onExhausted` into a
  grow? flag plus a terminal-policy value). Adding that axis mid-session would be a
  THIRD option-shape iteration in one release and would re-open every
  alias-equivalence proof -- the exact "second migration" churn the session exists
  to avoid.
- The session's promise is "make the CONTRADICTION unrepresentable." It keeps that
  promise. A missing-but-consistent config is a scope boundary, a different kind of
  gap than a representable lie; conflating the two would be its own error.
- The fix is purely ADDITIVE later: a future minor can add the orthogonal axis
  without breaking any current config, precisely because the current shape does
  not lie about the missing one -- it just does not offer it.

TRIGGER to revisit (explicit, in the roadmap's deferral style): open the
orthogonal-axis change when EITHER (1) a real caller reports needing grow-then-
throw for leak detection (the stated audience wants exactly this), OR (2) any
sibling package in the suite ships a decoupled growth/terminal option pair worth
matching for cross-package consistency. Until then this stays a documented limit,
surfaced in `llms.txt` and the README options table so a caller meets it in the
docs, not at runtime.

## Hot-path cost

Zero. The normalization from either vocabulary to the internal `_expand` /
`_maxSize` / `_onExh` triple happens ONCE, in the constructor. `acquire`'s fast
body is unchanged; only the cold `_grow` gains a single `onExhausted` branch off
the pre-normalized `_onExh`, on the already-cold not-serving path. Proven by the
four pinned hot-body hashes and by T6 reading 0.000 B/op.
