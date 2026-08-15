# lite-object-pool — v2 Roadmap (`@zakkster/lite-object-pool`)

Audited: v1.0.2 (unscoped), 2026-08-15. Source, d.ts, README, llms.txt, tests (45 cases, vitest), package.json.

**Decision:** Deprecate unscoped `lite-object-pool`; ship `@zakkster/lite-object-pool` v2.0.0.
Keeps lineage/searchability. Alternative `@zakkster/lite-pool` is cleaner but collides
conceptually with future typed/SAB pools. Owner call.

---

## Audit findings (S1 input)

### Architecture bugs vs Law 1 ("bytes in a hot body, not instructions")

- **B1** — `forEachActive()` iterates the `_out` Set via `for...of`: allocates an iterator
  per call. This is the game-loop API allocating every frame. V8 may elide it under
  optimization, but it is not guaranteed.
- **B2** — `releaseAll()` — same iterator allocation.
- **B3** — The Set guard itself: `Set.add()` on acquire triggers internal hash-table
  rehash allocations exactly during spawn spikes — the moment the package exists to protect.
- **B4** — `_free.push()` after expansion regrows the backing array mid-frame.
- **B5** — No option validation: `size: -1` / `size: 2.5` throws cryptic `RangeError`
  from `new Array`; `maxSize: 0, size: 32` preallocates 32 objects past the cap
  (`_totalCreated = size` unconditionally).
- **B6** — README game-loop example allocates `const dead = []` per frame. The documented
  pattern violates the package's own premise because v1 has no safe
  release-during-iteration contract.

### Law violations (conventions)

- vitest instead of `node:test`
- Emoji in test `describe` (ASCII-only law)
- No `CHANGELOG.md`
- No `VERSION` constant (triple lockstep bump impossible)
- llms.txt unversioned
- No `sideEffects: false`
- No demo

---

## Sessions

### S1 — Spec + compliance scaffold
- Lock the v2 design doc: sparse-set core (see S2), API surface frozen as drop-in:
  `acquire / release / releaseAll / forEachActive / used / free / size / destroy`.
- Repo scaffold under scope: `node:test`, ASCII-only source, `CHANGELOG.md`,
  `VERSION` constant, `sideEffects: false`, versioned llms.txt.
- Settle naming decision.
- **Design question to settle before S2:** is `forEachActive` iteration order
  contractual? v1's Set gave insertion order; sparse-set swap-remove does not.
  Recommendation: declare order unspecified in v2 and take the free performance.

### S2 — Core rewrite (sparse-set)
- Replace Set + free-array with: flat `items[]` store, `Uint32Array` dense/sparse
  index pair, `activeCount` cursor.
- Acquire = O(1) cursor advance. Release = O(1) swap-remove.
- Double-release / foreign-object guard = `sparse[i] < activeCount && dense[sparse[i]] === i`
  cross-check — zero-alloc, no Set anywhere.
- `forEachActive` = plain for-loop over `dense[0..activeCount)` with a
  **reverse-iteration contract making release-during-iteration safe**
  (kills B6 and the `dead[]` pattern). Optional `thisArg` to avoid closure churn.
- When `maxSize` is finite, preallocate all capacity up front:
  zero allocations post-construction, period.
- Option validation with real error messages (size integer >= 0, maxSize >= size, etc.).
- Port + grow test suite: 45 -> ~90+ under `node:test`.

### S3 — Ecosystem lanes
- Zero-alloc `stats(out)` snapshot into caller-provided object, shaped for
  `lite-gc-profiler` `watchPool` pool-escape canary compatibility.
- `lite-leak` sink: acquired-never-released kernel. Dev-only acquire-site tagging
  behind a flag — allocations permitted in the debug lane only, stated in llms.txt.
- SPP probe for lite-hud / lite-scope pool telemetry.
- Playwright browser lane wired into the shared portfolio harness.

### S4 — Bench + demo
- Bench protocol v3, stamped provenance: v2 sparse-set vs v1 Set-based vs
  naive-alloc baseline. Report acquire/release ns/op.
- Verify `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'` under lite-gc-profiler.
- Demo per convention: oscilloscope phosphor-green, oklch tokens with hex declared
  first, `@media (hover: hover)`, rem sizing, `$`-prefixed cached DOM refs,
  importmap routing, pre-allocated ring buffers, ~10Hz telemetry throttle,
  multi-scene `data-scene` tabs:
  - particle burst scene
  - churn stress scene
  - live watchPool pool-escape canary scene (wired to lite-gc-profiler)
- Demo never in `files[]`.

### S5 — Release train
- `@zakkster/lite-object-pool` v2.0.0: lockstep triple version bump
  (`package.json` + `VERSION` + llms.txt), CHANGELOG, README migration section.
- Migration note: v1 -> v2 is drop-in **except** iteration-order guarantees —
  Set was insertion-order, dense array is not. Document explicitly.
- `npm deprecate lite-object-pool "Superseded by @zakkster/lite-object-pool"`.
- Optional final unscoped v1.0.3: README banner only.
- Copyright: Zahary Shinikchiev.

---

## Deferred (written trigger conditions required)

- **D1 — u32 gen-guarded handle API** (lite-signal recycled-slot lesson applied here:
  raw pointers crash on recycled slots; generation bits catch stale handles).
  **Trigger:** a consumer needs serializable / cross-worker pool refs.
- **D2 — SAB shared pool via lite-worker subpath.**
  **Trigger:** lite-ambient-fx or lite-worker demand for cross-thread pooling.
- **D3 — `shrink()` / TTL decay.**
  **Trigger:** lite-gc-profiler evidence lane shows sustained oversized pools
  in a real consumer.
