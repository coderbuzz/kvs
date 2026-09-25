<!-- docs: sync from coderbuzz/codex@15d78e0 -->

# KVS: AI Agent Knowledge File

**Package:** `@coderbuzz/kvs`
**Purpose:** Multi-backend key-value store. Sync `KVStore` (bun:sqlite) and async `AsyncKVStore` (bun:sql, SQLite + PostgreSQL).
**Distribution:** ESM only (`dist/index.js` + `dist/index.d.ts`).

---

## Mental Model

```
KVStore("kv.db")                : sync, bun:sqlite, embedded SQLite only
AsyncKVStore("sqlite://kv.db")  : async, bun:sql, SQLite
AsyncKVStore("postgres://...")  : async, bun:sql, PostgreSQL
```

### KVStore (sync)
```
KVStore("kv.db")
  ├── get/set/delete          : CRUD (sync)
  ├── increment               : atomic counter (sync)
  ├── list                    : prefix/range queries (sync)
  ├── atomic()                : version-checked transactions (sync)
  ├── enqueue/dequeue         : persistent queue with leases (sync)
  ├── acknowledge/nack/extendLease(id, token)
  ├── listDead/retryDead/deleteDead, queueStats, cleanQueue
  ├── watch()                 : in-process callbacks (sync)
  ├── addQueueListener()      : awaited handlers, auto-ack/nack, concurrency
  ├── getAsync()              : cache-with-compute (singleflight, async)
  ├── cleanExpired() / reset()
  └── close()
```

### AsyncKVStore (async)
```
AsyncKVStore("sqlite://kv.db" | "postgres://...")
  ├── get/set/delete          : CRUD (async)
  ├── increment               : atomic counter (async)
  ├── list                    : prefix/range queries (async)
  ├── atomic()                : version-checked transactions (async commit)
  ├── enqueue/dequeue/ack/nack, dead letters, stats : persistent queue (async)
  ├── watch()                 : same as KVStore (in-process; initial snapshot delivered async)
  ├── addQueueListener()      : same as KVStore
  ├── getAsync()              : same as KVStore
  ├── cleanExpired() / reset() : async
  └── close()                 : async
```

---

## Complete Import

```ts
import {
  KVStore, AtomicOperation,                       // sync
  AsyncKVStore, AsyncAtomicOperation,              // async
  Singleflight,
  type WatchCallback,
  type KVStoreOptions, type AsyncKVStoreOptions, type AsyncKVStoreSettings,
  openDatabase, StmtCache, type OpenDatabaseOptions,
  SQLiteAsyncAdapter, PostgresAdapter,             // adapters
  type SQLiteAdapterOptions, type PostgresAdapterOptions, type TableOptions, type Durability,
  type SqlAdapter, type KvRow, type QueueRow, type QueueStatsRow, type LeaseRow,
  type SetResult, type IncrementResult, type EnqueueResult,
  SCHEMA_VERSION,                                  // 2
  type KvQueueConfig, type KvQueueDiagnostics,
  type QueueDeadMessage, type QueueDequeueOptions, type QueueNackOptions,
  type QueueListenerOptions, type QueueStats,
  encodeKey, decodeKey, encodeKeyPrefix, prefixSuccessor,
  type KvKey, type KvKeyPart, type KvEntry,
  type KvWatchEvent, type KvWatchDiagnostics,
  type KvCommitResult, type KvCommitError,
  type KvCheck, type KvMutation,
  type KvListSelector, type KvListOptions, type KvListResult,
  type QueueMessage, type QueueOptions,
} from "@coderbuzz/kvs";
```

---

## Types

```ts
type KvKeyPart = string | number | bigint | boolean | Uint8Array
type KvKey = KvKeyPart[]

interface KvEntry {
  key: KvKey
  value: unknown
  version: number
}

interface KvCommitResult { ok: true; version: number }
interface KvCommitError { ok: false }

interface KvCheck {
  key: KvKey
  version: number | null   // number = "key must be at this version"
                            // null   = "key must not exist"
}

interface KvMutation { type: "set" | "delete"; key: KvKey; value?: unknown; ttl?: number }

interface KvListSelector { prefix?: KvKey; start?: KvKey; end?: KvKey }
interface KvListOptions { limit?: number; cursor?: string; reverse?: boolean }
interface KvListResult { entries: KvEntry[]; cursor: string | null }

interface QueueMessage {
  id: number; topic: string; payload: unknown
  enqueuedAt: number
  deliverAt: number       // due time; a nack with backoff moves it to the retry time
  attempts: number        // deliveries so far, this one included
  maxAttempts: number
  token: string           // lease token of this delivery (crypto.randomUUID, shared by one dequeue call)
  lockedUntil: number     // lease end, ms epoch
  lastError: string | null // error text of the last failed attempt (nack or "lease expired")
}
interface QueueDeadMessage {
  id: number; topic: string; payload: unknown
  enqueuedAt: number; deliverAt: number; attempts: number; maxAttempts: number
  lastError: string | null
  failedAt: number        // when it was dead-lettered
}
interface QueueOptions { topic?: string; delay?: number; maxAttempts?: number } // maxAttempts: integer >= 1, default 3
interface QueueDequeueOptions { visibilityTimeout?: number }                    // ms > 0
interface QueueNackOptions { error?: string | null; delay?: number }            // delay ms >= 0 overrides backoff
interface QueueListenerOptions { concurrency?: number; visibilityTimeout?: number; autoAck?: boolean }
interface KvQueueConfig {
  visibilityTimeout?: number                         // default 30_000
  backoff?: number[] | ((attempt: number) => number) // default min(1000 * 2^(attempt-1), 300_000)
  doneRetention?: number                             // default 0 (delete on ack)
  deadRetention?: number                             // default Infinity
}
interface QueueStats {
  topic: string
  pending: number; delayed: number; processing: number; dead: number; done: number
  oldestPendingAt: number | null
}
interface KvQueueDiagnostics {
  listeners: number; inFlight: number
  delivered: number; acked: number; nacked: number
  handlerErrors: number
  leaseLost: number       // ack/nack/renewal refused: the lease moved to another delivery
  dispatchErrors: number  // failed dequeue/ack/renewal (closed store, lost connection)
}

interface KvWatchEvent {
  sequence: number       // monotonic only for the current store process
  initial: boolean
  changedKeys: KvKey[]
  coalesced?: boolean
  reset?: boolean
}
interface KvWatchDiagnostics {
  activeWatchers: number
  committedBatches: number
  callbacks: number
  sharedReads: number
  callbackErrors: number
  dispatchErrors: number
}
type WatchCallback = (entries: (KvEntry | null)[], event?: KvWatchEvent) => void
```

---

## Key Encoding

```
KvKeyPart = string | number | bigint | boolean | Uint8Array
KvKey = KvKeyPart[]
Sort: Uint8Array < string < number < bigint < false < true
```

Encoding: each key part is a type-tag byte (`0x01` bytes, `0x02` string, `0x03` number, `0x04` bigint, `0x05` false, `0x06` true) followed by its payload, then a `0x00` separator. String/byte payloads escape `0x00` as `0x00 0xff`; numbers are 8-byte big-endian float64 with sign-flip so byte order matches numeric order; bigints are a sign byte, a length byte, then magnitude bytes. The concatenated bytes sort lexicographically. An empty key encodes to zero bytes.

```ts
import { encodeKey, decodeKey, encodeKeyPrefix, prefixSuccessor } from "@coderbuzz/kvs";

["a"] < ["b"]
["users", 1] < ["users", 2]
["items", true] > ["items", false]

// Round-trip: KvKey → bytes → KvKey
const encoded = encodeKey(["users", "alice"]);
const decoded = decodeKey(encoded); // ["users", "alice"]

// Low-level prefix scan for custom range queries
const prefix = encodeKeyPrefix(["events"]);
const upper = prefixSuccessor(prefix);
// Resulting range: key >= prefix AND key < upper
```

---

## Constructors

### `new KVStore(path?: string, options?: KVStoreOptions)`
- **Default path:** `"kv.db"`
- Opens/creates SQLite database with WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`, then runs the schema migration (see "Schema versions") inside `BEGIN IMMEDIATE`. A failed migration closes the database and throws.
- Starts one 60 s maintenance timer: TTL cleanup + queue maintenance (`cleanQueue()`).
- `options`:

| Option | Type | Default | Notes |
|---|---|---|---|
| `tablePrefix` | `string` | `""` | `/^[A-Za-z_][A-Za-z0-9_]*$/`, max 40 chars; else `TypeError`. Applies to tables and indexes (`idx_<prefix>kv_expires` …) |
| `durability` | `"normal" \| "full"` | `"normal"` | `PRAGMA synchronous`; other values `TypeError` |
| `queue` | `KvQueueConfig` | see Types | invalid values `RangeError` (`backoff` of the wrong type: `TypeError`) |

```ts
const store = new KVStore("kv.db");                 // sync, bun:sqlite
const shared = new KVStore("app.db", { tablePrefix: "kvs_", durability: "full", queue: { visibilityTimeout: 60_000 } });
```

### `new AsyncKVStore(connection: string | { adapter: SqlAdapter; queue?: KvQueueConfig }, settings?: AsyncKVStoreSettings)`
- Auto-detects adapter from connection string:
  - `"postgres://..."` or `"postgresql://..."` → `PostgresAdapter(conn, { tablePrefix, schema })`
  - anything else → `SQLiteAsyncAdapter(conn, { tablePrefix, durability })`, which hands the string to Bun's `new SQL(...)`. Use `"sqlite://..."`, `"file://..."`, or `":memory:"`.
  - A plain filename such as `"kv.db"` is NOT SQLite: Bun's `SQL` parses it as a PostgreSQL connection, so the first operation fails with a connection error.
- `settings: { tablePrefix?, schema?, durability?, queue? }`. `schema` with SQLite, or `durability` with PostgreSQL, throws `TypeError`. With `{ adapter }`, passing `tablePrefix`/`schema`/`durability` in `settings` throws `TypeError` (configure the adapter); `queue` may go in either object.
- Migration and the 60 s maintenance timer start lazily on the first operation (`ensureInit()`), not in the constructor. If `migrate()` rejects (database not up yet, or a foreign table), that call rejects and the next operation runs `migrate()` again; a failure is not cached.

```ts
const asyncStore = new AsyncKVStore("sqlite://kv.db");
const pgStore = new AsyncKVStore("postgres://user:pass@localhost:5432/app", { tablePrefix: "kvs_", schema: "infra" });
const customStore = new AsyncKVStore({ adapter: new PostgresAdapter("postgres://...", { tablePrefix: "kvs_" }) });
```

### Schema versions (KVS-21)
- `SCHEMA_VERSION = 2`, stored as text in `<prefix>meta` under key `schema_version`. A database without the row is new or was written by kvs <= 0.3 (whose tables are exactly version 1).
- Every open: `CREATE TABLE IF NOT EXISTS meta`, read the version, run the missing steps, write the version, then verify every table has the current columns, all in ONE transaction (SQLite `BEGIN IMMEDIATE`; PostgreSQL `sql.begin` + `pg_advisory_xact_lock` on a hash of `migrate:<meta table>`, and `CREATE SCHEMA IF NOT EXISTS` first when `schema` is set). Concurrent openers (processes) wait for each other; any failure rolls everything back.
- Step 0 → 1: `CREATE TABLE IF NOT EXISTS kv / queue`, then **verify the version-1 columns**, then the indexes. An existing table of the same name that is not a kvs table (e.g. an application `queue`) fails here with `Error: kvs: table "queue" exists but is not a kvs table (missing columns: payload, enqueued_at, attempts, max_attempts). Use the tablePrefix option ...` before anything is indexed or altered.
- Step 1 → 2: queue columns `locked_until`, `lease_token`, `last_error`, `finished_at`; `processing` rows get `locked_until = 0` (expired lease: redelivered, or dead-lettered by `cleanQueue()` if attempts are used up); `done` rows get `finished_at = now` (then aged out by `doneRetention`); indexes `idx_<p>queue_lease (status, locked_until) WHERE status='processing'` and `idx_<p>queue_finished (status, finished_at) WHERE finished_at IS NOT NULL`. PostgreSQL also runs `ALTER TABLE kv ALTER COLUMN version TYPE BIGINT`, `ALTER TABLE queue ALTER COLUMN id TYPE BIGINT` and `ALTER SEQUENCE <serial seq> AS BIGINT` (KVS-17): each rewrites its table under an `ACCESS EXCLUSIVE` lock, once.
- A stored version above `SCHEMA_VERSION` throws `Error: kvs: the database schema is version N, newer than this kvs release supports (2). Upgrade @coderbuzz/kvs.` A non-integer value throws too.

### Durability (KVS-21)
- SQLite: WAL + `synchronous = NORMAL` (default): durable across a process crash; a power loss or OS crash can lose the last committed transactions (no corruption). `durability: "full"` sets `synchronous = FULL` (fsync per commit). `PRAGMA synchronous` reads 1 / 2.
- PostgreSQL: the server's `synchronous_commit` decides; kvs sets nothing.

---

## KVStore API (all sync except `getAsync`)

### `get(key: KvKey): KvEntry | null`

```ts
const entry = store.get(["users", "alice"]);
// { key: ["users", "alice"], value: { name: "Alice" }, version: 1 }
// null if missing or expired
```

### `set(key: KvKey, value: unknown, options?: { ttl?: number }): KvCommitResult`

```ts
store.set(["users", "alice"], { name: "Alice" });
// { ok: true, version: 1 }

store.set(["cache", "key"], value, { ttl: 60_000 }); // expires in 60s
```
Every `set` increments `version` by 1. TTL is in milliseconds and must be a finite number ≥ 0; `NaN`, `Infinity` and negative values throw `RangeError` (on `AsyncKVStore`, the promise rejects). `ttl: 0` expires immediately.

### `delete(key: KvKey): void`

```ts
store.delete(["users", "alice"]);
```

### `increment(key: KvKey, delta?: number): number`

Atomically increment a numeric value and return the new value. Default `delta: 1`.

| Stored state | Result |
|---|---|
| key missing | created with `delta`, no TTL, `version` 1 |
| key expired (row still present until cleanup) | treated as missing: value `delta`, TTL removed, `version` continues from the old row |
| live number | `value + delta`; the key **keeps its TTL** |
| live non-number (object, string, `null`, boolean) | throws `TypeError` (`KVStore`) or rejects (SQLite `AsyncKVStore`); PostgreSQL rejects with its own `invalid input syntax for type numeric` error. The value is left unchanged |
| `delta` not a finite number | `RangeError`, nothing written |
| result not finite (overflow) | `RangeError`, nothing written (SQLite backends) |

Implementation per backend:
- `KVStore` (bun:sqlite): `BEGIN IMMEDIATE`, `SELECT value, version, expires_at`, JS arithmetic, upsert through the same statement as `atomic().set()`, `COMMIT`. The value is re-encoded like any `set()`, so it stays a BLOB.
- `SQLiteAsyncAdapter`: the same read-modify-write inside `sql.begin()`, behind the adapter's serial queue.
- `PostgresAdapter`: one `INSERT ... ON CONFLICT (key) DO UPDATE` statement with `NUMERIC` arithmetic on the JSON text. The upsert takes the row lock, so concurrent increments of a new key never lose an update. Decimals are exact in storage (`0.1 + 0.2` stores `0.3`); the returned number is `FLOAT8`.

History: kvs ≤ 0.3.1 stored the result with `CAST(... AS TEXT)` on SQLite, which made every later `get()`/`list()` on that key throw `TextDecoder.decode expects an ArrayBuffer`, overwrote non-numeric values with `delta`, and resurrected expired keys. On PostgreSQL, concurrent increments of a new key lost updates. Rows written as TEXT are decoded again since 0.3.2 and rewritten as BLOB on the next `increment()`.

Cost (Bun 1.4.2, Xeon 2.1 GHz, `bench/core.bench.ts`): `KVStore.increment` ~63K ops/s (was ~112K on the broken path), SQLite `AsyncKVStore.increment` ~23K ops/s (was ~60K).

```ts
// Basic increment (default delta: 1)
store.increment(["counter", "visits"]);        // 1 (first call)
store.increment(["counter", "visits"]);        // 2

// Custom delta: positive or negative
store.increment(["counter", "visits"], 5);      // 7
store.increment(["counter", "visits"], -1);     // 6

// Rate limiting pattern
const attempts = store.increment(["ratelimit", "192.168.1.1"], 1);
if (attempts > 10) throw new Error("Rate limit exceeded");
// Returns the new value after increment
```

### `list(selector: KvListSelector, options?: KvListOptions): KvListResult`

**Defaults:** `limit: 100`, max `1000`, ascending, `reverse: false`. `cursor` is opaque base64.

**Validation:**
- `limit` must be an integer ≥ 1, otherwise `RangeError` (`0`, negatives, `2.5`, `NaN`, `Infinity`). Values above 1000 are capped to 1000, not rejected.
- `cursor` is the base64 of the last returned key's encoded bytes. It must fall inside the selector's byte range `[start, end)`, otherwise `RangeError: kvs: list cursor is outside the selector range`. Forward pagination then starts at `cursor ‖ 0x00` (exclusive); reverse pagination ends at `cursor` (exclusive). kvs ≤ 0.3.1 accepted any cursor and replaced the range bound with it, so a caller authorised for one prefix could read every key in the store (`AA==` below, `/w==` above). kvs-server maps this `RangeError` to HTTP 400.
- A cursor is not bound to its selector beyond that range check: reusing a cursor with a different selector whose range still contains it is allowed.

```ts
// Prefix query
store.list({ prefix: ["users"] });

// Range query
store.list({ start: ["events", 1000], end: ["events", 2000] });

// Paginated
const page1 = store.list({ prefix: ["logs"] }, { limit: 20 });
// page1 = { entries: [...], cursor: "Abc..." }
const page2 = store.list({ prefix: ["logs"] }, { limit: 20, cursor: page1.cursor });

// Reverse
store.list({ prefix: ["logs"] }, { limit: 5, reverse: true });
```

### `atomic(): AtomicOperation`

Fluent builder for version-checked transactions. All operations run in a single SQLite transaction.

```ts
const result = store
  .atomic()
  .check({ key: ["counter"], version: 3 })       // fail if not at version 3
  .check({ key: ["new-key"], version: null })     // fail if key exists
  .set(["counter"], 4)
  .set(["meta"], { updatedAt: Date.now() })
  .delete(["old-key"])
  .enqueue({ task: "notify" }, { topic: "jobs" })
  .commit();

if (result.ok) {
  console.log("Version:", result.version);
} else {
  console.log("Check failed, retry");
}
```

**AtomicOperation methods:**

| Method | Signature | Description |
|---|---|---|
| `check` | `(...checks: KvCheck[]): this` | Assert key versions. `version: null` = "must not exist". `version: N` = "must be at version N". |
| `set` | `(key, value, options?): this` | `options: { ttl?: number }` |
| `delete` | `(key): this` | |
| `enqueue` | `(payload, options?): this` | `options: QueueOptions` |
| `commit` | `(): KvCommitResult \| KvCommitError` | Execute all operations atomically. Returns `{ ok: false }` if any check fails. |

### Queue model (0.4)

Statuses: `pending` → `processing` (leased) → deleted on ack (or `done` with `doneRetention > 0`), or `dead`.

```
enqueue ─▶ pending ──dequeue──▶ processing(lease: locked_until, lease_token)
             ▲  ▲                 │ acknowledge(id, token) ─▶ row deleted | done (finished_at)
             │  └─ nack, attempts < max: deliver_at = now + backoff(attempts), token cleared
             └──── lease expired, attempts < max: reclaimed before a dequeue, token cleared
                                  │ nack on the last attempt, or lease expired on it (cleanQueue)
                                  ▼
                                 dead (finished_at, last_error) ── retryDead ─▶ pending, attempts = 0
```

- A lease is `visibilityTimeout` ms from dequeue (default 30 000), **not** from `deliver_at` (0.3 counted from `deliver_at`, so a message from a backlog older than 30 s was redelivered while still being processed: KVS-06).
- `acknowledge`, `nack` and `extendLease` all match `id AND lease_token = token AND status = 'processing'`; a stale token (lease expired and the message reclaimed or redelivered) returns `false`. The token is 122 random bits (`crypto.randomUUID()`), one per `dequeue()` call.
- Delivery is at-least-once: a handler that outlives its lease without `extendLease` can run twice.

### `enqueue(payload: unknown, options?: QueueOptions): { ok: true, id: number }`

**Defaults:** `topic: "default"`, `delay: 0`, `maxAttempts: 3`. `maxAttempts` must be an integer >= 1 (`RangeError`); `delay` finite (negative = already due).

```ts
store.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
// { ok: true, id: 1 }
```

A due message wakes this store's listeners of the topic (in a microtask, never on the caller's stack).

### `dequeue(topic?: string, limit?: number, options?: QueueDequeueOptions): QueueMessage[]`

**Defaults:** `topic: "default"`, `limit: 1` (integer >= 1, capped at 1000), `visibilityTimeout: queue.visibilityTimeout`.

1. At most once per second per store instance (`RECLAIM_INTERVAL`), first reclaim expired leases **of every topic**: `UPDATE queue SET status='pending', locked_until=NULL, lease_token=NULL WHERE status='processing' AND locked_until <= now AND attempts < max_attempts` (PostgreSQL: inside a `MATERIALIZED` CTE with `FOR UPDATE SKIP LOCKED`). `extendLease(…, 0)` resets the interval, so a release is visible to this store's next dequeue at once; other processes see it within a second.
2. Pick `status = 'pending' AND deliver_at <= now` in a `MATERIALIZED` CTE, `ORDER BY deliver_at, id LIMIT n` (PostgreSQL adds `FOR UPDATE SKIP LOCKED`), set `status='processing', attempts+1, locked_until = now + visibilityTimeout, lease_token = token`, `RETURNING` the message columns. Rows are sorted by `(deliver_at, id)` in JS (RETURNING has no order).

Why not one picker with `OR (status='processing' AND locked_until <= now)`: SQLite answers it with `MULTI-INDEX OR` + `USE TEMP B-TREE FOR ORDER BY`, sorting the whole backlog of the topic on every dequeue (measured: queue cycle behind 10 000 due messages 17 600 → 556 ops/s). A `UNION ALL` of two limited branches kept the index walk but cost 40% at an empty backlog. The separate reclaim + pending-only picker walks `idx_<p>queue_pending (topic, status, deliver_at)` and stops at the LIMIT.

```ts
for (const msg of store.dequeue("emails", 10, { visibilityTimeout: 60_000 })) {
  try {
    await sendEmail(msg.payload);
    store.acknowledge(msg.id, msg.token);
  } catch (error) {
    store.nack(msg.id, msg.token, { error: String(error) });
  }
}
```

### `acknowledge(id: number, token: string): boolean`
- Missing/empty token or non-integer id: `TypeError` (sync throw; async rejects).
- `doneRetention === 0` (default): `DELETE ... WHERE id AND lease_token AND status='processing'`. Otherwise `UPDATE status='done', finished_at=now, locked_until=NULL, lease_token=NULL`.
- `false`: not leased under this token any more.

### `nack(id: number, token: string, options?: QueueNackOptions): boolean`
- Reads `attempts, max_attempts` of the lease (`getLease`), then one conditional UPDATE. No transaction needed: attempts only change on a dequeue, which changes the token.
- `attempts >= maxAttempts` → `status='dead', finished_at=now, last_error`. Else `status='pending', deliver_at = now + (options.delay ?? backoff(attempts)), last_error`. Lease cleared either way.
- `backoff(attempt)`: array → `schedule[min(attempt, length) - 1]`; function → its result, which must be finite >= 0 (`RangeError` otherwise); default `min(1000 * 2^(attempt-1), 300000)` (1 s, 2 s, 4 s … 5 min), no jitter.
- `error` is stored as given, truncated to 2000 chars. Listener nacks store `error.message` (or `String(error)`).

### `extendLease(id: number, token: string, visibilityTimeout?: number): boolean`
- `locked_until = now + visibilityTimeout` (default `queue.visibilityTimeout`); `0` releases at once (the next dequeue reclaims it, attempts are not refunded). Negative/NaN → `RangeError`.
- Works after the lease expired as long as the message was not reclaimed yet.

### `listDead(topic = "default", { limit = 100, after = 0 }?): QueueDeadMessage[]`
Runs `expireLeases` first (dead-letters leases that expired on their last attempt, `last_error = 'lease expired'`), then `SELECT ... WHERE topic AND status='dead' AND id > after ORDER BY id LIMIT limit`.

### `retryDead(topic = "default", id?: number): number` / `deleteDead(topic = "default", id?: number): number`
One dead message of the topic (`id`), or all of them. `retryDead` sets `status='pending', attempts=0, deliver_at=now, finished_at=NULL` (keeps `last_error`) and wakes listeners. Returns the row count.

### `queueStats(topic?: string): QueueStats[]`
Runs `expireLeases` first. One row per topic that has rows, ordered by topic; with `topic` given and no rows, one all-zero entry. `pending` = pending and due, `delayed` = pending not yet due, `processing` includes expired leases not yet reclaimed, `oldestPendingAt` = min `deliver_at` of due pending rows.

### `cleanQueue(): number`
Maintenance, also run by the 60 s timer: `expireLeases(now)` + delete `done` with `finished_at <= now - doneRetention` + (if `deadRetention` finite) delete `dead` with `finished_at <= now - deadRetention`. Returns rows changed. Short-lived scripts should call it: timers are unref'd and may never fire.

### `watch(keys: KvKey[], callback: WatchCallback): { cancel: () => void }`

Fires **immediately** with current values, then on every mutation to watched keys.

```ts
const { cancel } = store.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
    // entries[1] = KvEntry | null for ["config", "lang"]
  },
);
cancel(); // stop watching
```

**Internal:** Uses a `watchIndex: Map<hex-encoded-key, Set<Watcher>>`. On any `set`/`delete`/`increment`/`getAsync` write/`atomic.commit`, every watcher for a changed key fires once per batch. Deleting a key that does not exist emits nothing. One watcher per `watch()` call can watch multiple keys. The callback receives `(entries, event)` where `event` is a `KvWatchEvent`; the initial call has `initial: true`, `changedKeys: []`, and the current sequence. Callback exceptions are caught and counted in `callbackErrors`.

### `addQueueListener(topic, handler: (msg) => unknown, options?: QueueListenerOptions): { cancel: () => Promise<void> }`

```ts
const listener = store.addQueueListener("emails", async (msg) => {
  await sendEmail(msg.payload);           // resolve → acknowledged, throw → nacked
}, { concurrency: 4, visibilityTimeout: 60_000 });
await listener.cancel();                  // resolves once running handlers settled
```

- Options: `concurrency` integer 1..1000 (default 1, `RangeError` otherwise), `visibilityTimeout` (default store's), `autoAck` (default `true`).
- `autoAck: true`: handler resolves → `acknowledge`; throws/rejects → `nack({ error: message })`. The lease is renewed every `visibilityTimeout / 2` (min 10 ms) while the handler runs.
- `autoAck: false`: the handler owns the message (call `acknowledge`/`nack` with `msg.token`); the slot is held until the handler's promise settles; no renewal.
- `cancel()`: stops dequeuing, returns a promise that resolves when in-flight handlers (and their ack/nack) are done. Messages already dequeued after cancel are released (`extendLease(…, 0)`). `close()` cancels all listeners without waiting.
- See "Queue dispatch internals" for the algorithm.

### `getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>`

Cache-with-compute with singleflight deduplication. Returns `Promise`. It is the only async method on `KVStore`.

```ts
// 100 concurrent callers: fn() runs once, result cached for 30s
const ad = await store.getAsync(["ads", "venue", 42], () => fetchNextAd(42), 30_000);
```

**Algorithm:**
1. Check SQLite: return immediately on cache hit
2. Singleflight dedup within process (coalesce concurrent calls for same key)
3. Call `fn()` exactly once
4. Store result in SQLite with TTL (if provided)
5. Return to all concurrent callers

### `cleanExpired(): number`

Manually delete expired entries. Returns count of deleted rows. (Auto-runs every 60s.) Each deleted key is emitted to active watchers as a `null` tombstone. On `AsyncKVStore`, tombstones require the adapter to implement the optional `cleanExpiredKeys()`; both built-in adapters do, a custom adapter without it only returns the count.

```ts
store.set(["cache", "a"], "x", { ttl: 1_000 });
store.set(["cache", "b"], "y", { ttl: 1_000 });
// After 2s, entries are expired: cleanExpired() removes them immediately
const deleted = store.cleanExpired(); // 2
```

### `reset(): void`

Delete ALL data from `kv` and `queue` tables. Watchers stay registered: every watched key receives a `null` tombstone in one batch with `event.reset: true`, and later writes keep being delivered. Queue listeners stay registered.

```ts
store.set(["users", "alice"], { name: "Alice" });
store.enqueue("test");
store.reset();
store.get(["users", "alice"]); // null
```

### `close(): void`

Close database, stop cleanup/dispatch timers, cancel all watchers/listeners. No operations work after close.

```ts
// Graceful shutdown handler
process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});

// Or in a web framework
server.on("close", () => store.close());
```

---

## AsyncKVStore API (all async)

### `new AsyncKVStore(connection, settings?)`

Same as KVStore constructor but async. See Constructor section above for connection string rules.

### Methods

All methods return `Promise<T>`. Signatures mirror `KVStore` exactly:

```ts
await store.get(key: KvKey): Promise<KvEntry | null>
await store.set(key: KvKey, value: unknown, options?: { ttl?: number }): Promise<KvCommitResult>
await store.delete(key: KvKey): Promise<void>
await store.increment(key: KvKey, delta?: number): Promise<number>     // delta default: 1
await store.list(selector: KvListSelector, options?: KvListOptions): Promise<KvListResult>
await store.enqueue(payload: unknown, options?: QueueOptions): Promise<{ ok: true, id: number }>
await store.dequeue(topic?: string, limit?: number, options?: QueueDequeueOptions): Promise<QueueMessage[]>
await store.acknowledge(id: number, token: string): Promise<boolean>
await store.nack(id: number, token: string, options?: QueueNackOptions): Promise<boolean>
await store.extendLease(id: number, token: string, visibilityTimeout?: number): Promise<boolean>
await store.listDead(topic?: string, options?: { limit?: number; after?: number }): Promise<QueueDeadMessage[]>
await store.retryDead(topic?: string, id?: number): Promise<number>
await store.deleteDead(topic?: string, id?: number): Promise<number>
await store.queueStats(topic?: string): Promise<QueueStats[]>
await store.cleanQueue(): Promise<number>
await store.cleanExpired(): Promise<number>
await store.reset(): Promise<void>
await store.close(): Promise<void>
await store.getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>
```

`watch()` and `addQueueListener()` remain **sync** (in-process callbacks):

```ts
store.watch(keys: KvKey[], callback: WatchCallback): { cancel: () => void }
store.addQueueListener(topic: string, handler: (msg: QueueMessage) => unknown, options?: QueueListenerOptions): { cancel: () => Promise<void> }
store.getWatchDiagnostics(): KvWatchDiagnostics
store.getQueueDiagnostics(): KvQueueDiagnostics
```

### `atomic(): AsyncAtomicOperation`

Same fluent builder as `AtomicOperation` but `commit()` is async:

```ts
const result = await store
  .atomic()
  .check({ key: ["counter"], version: 3 })
  .set(["counter"], 4)
  .enqueue({ task: "notify" }, { topic: "jobs" })
  .commit();
```

**AsyncAtomicOperation methods:** `check()`, `set()`, `delete()`, `enqueue()` all return `this`. `commit(): Promise<KvCommitResult | KvCommitError>`.

---

## Default Values Reference

| Method | Parameter | Default |
|---|---|---|
| `KVStore(path, options)` | `path` | `"kv.db"` |
| | `options.tablePrefix` | `""` |
| | `options.durability` | `"normal"` |
| | `options.queue.visibilityTimeout` | `30_000` |
| | `options.queue.backoff` | `min(1000 * 2^(n-1), 300_000)` |
| | `options.queue.doneRetention` | `0` |
| | `options.queue.deadRetention` | `Infinity` |
| `set(key, value, options)` | `options` | `{}` (no TTL) |
| `increment(key, delta)` | `delta` | `1` |
| `list(selector, options)` | `options.limit` | `100` |
| | `options.reverse` | `false` |
| `enqueue(payload, options)` | `options.topic` | `"default"` |
| | `options.delay` | `0` |
| | `options.maxAttempts` | `3` |
| `dequeue(topic, limit, options)` | `topic` | `"default"` |
| | `limit` | `1` (max 1000) |
| | `options.visibilityTimeout` | `queue.visibilityTimeout` |
| `extendLease(id, token, ms)` | `ms` | `queue.visibilityTimeout` |
| `listDead(topic, options)` | `options.limit` / `after` | `100` / `0` |
| `addQueueListener(t, h, options)` | `concurrency` / `autoAck` | `1` / `true` |
| `openDatabase(path, options)` | `path` | `"kv.db"` |

---

## Adapters

The `AsyncKVStore` uses an internal `SqlAdapter` interface. Built-in adapters:

| Adapter | Class | Backend |
|---|---|---|
| SQLite | `SQLiteAsyncAdapter` | SQLite via `bun:sql` |
| PostgreSQL | `PostgresAdapter` | PostgreSQL via `bun:sql` |

### `SqlAdapter` contract (for custom adapters)

```ts
import type { SqlAdapter } from "@coderbuzz/kvs";

interface KvRow { key: Uint8Array; value: Uint8Array; version: number }
interface SqlAdapter {
  migrate(): Promise<void>;
  get(key: Uint8Array, now: number): Promise<KvRow | null>;          // live rows only
  set(key: Uint8Array, value: Uint8Array, expiresAt: number | null): Promise<{ version: number }>;
  delete(key: Uint8Array): Promise<boolean>;
  getVersion(key: Uint8Array, now: number): Promise<number | null>;
  // Must create a missing/expired key with `delta` (no TTL), keep a live key's TTL,
  // and throw on a non-numeric value. Returning null = legacy "key missing" (store
  // then does a non-atomic set()).
  increment(key: Uint8Array, delta: number, now?: number): Promise<{ val: number; version: number } | null>;
  listAsc(start: Uint8Array, end: Uint8Array, now: number, limit: number): Promise<KvRow[]>;
  listDesc(start: Uint8Array, end: Uint8Array, now: number, limit: number): Promise<KvRow[]>;
  cleanExpired(now: number): Promise<number>;
  cleanExpiredKeys?(now: number): Promise<Uint8Array[]>;             // enables expiry tombstones
  enqueue(topic: string, payload: Uint8Array, now: number, deliverAt: number, maxAttempts: number): Promise<{ id: number }>;
  // Queue v2 (0.4). Numeric columns must come back as JS numbers (PostgreSQL int8 → Number).
  reclaimLeases(now: number): Promise<number>;       // expired leases with attempts left → pending, token cleared
  dequeue(topic: string, now: number, limit: number, lockedUntil: number, token: string): Promise<QueueRow[]>; // pending only
  ack(id: number, token: string, now: number, retain: boolean): Promise<boolean>;   // delete, or 'done' when retain
  getLease(id: number, token: string): Promise<{ attempts: number; max_attempts: number } | null>;
  nack(id: number, token: string, now: number, retryAt: number | null, error: string | null): Promise<boolean>; // null → dead
  extendLease(id: number, token: string, lockedUntil: number): Promise<boolean>;
  expireLeases(now: number): Promise<number>;        // expired, attempts >= max → dead, last_error 'lease expired'
  purgeFinished(doneBefore: number, deadBefore: number | null): Promise<number>;
  listDead(topic: string, limit: number, afterId: number): Promise<QueueRow[]>;     // rows include finished_at
  retryDead(topic: string, id: number | null, now: number): Promise<number>;
  deleteDead(topic: string, id: number | null): Promise<number>;
  queueStats(topic: string | null, now: number): Promise<QueueStatsRow[]>;
  reset(): Promise<void>;                            // DELETE both tables (prefix-aware); keeps meta
  transaction<T>(fn: (adapter: SqlAdapter) => Promise<T>): Promise<T>;
  // Optional, called on the transaction adapter by atomic().commit(). Needed on a
  // backend that runs transactions concurrently (PostgresAdapter implements all three):
  lockKeys?(keys: Uint8Array[]): Promise<void>;                      // held until the transaction ends
  getVersionForUpdate?(key: Uint8Array, now: number): Promise<number | null>; // locks the row
  insertIfAbsent?(key: Uint8Array, value: Uint8Array, expiresAt: number | null, now: number): Promise<{ version: number } | null>;
  close(): Promise<void>;
  raw(sql: string): Promise<void>;                   // runs as is: table names depend on tablePrefix/schema
}
interface QueueRow {
  id: number; topic: string; payload: Uint8Array; enqueued_at: number; deliver_at: number
  attempts: number; max_attempts: number; locked_until: number | null; last_error: string | null
  finished_at?: number | null
}
```

`migrate()` must implement "Schema versions" above (create or upgrade, verify columns, refuse a newer version). 0.3 adapters (`dequeue(topic, now, limit)`, `ack(id)`, `requeueFailed`) no longer compile against 0.4.

`atomic().commit()` inside `transaction()`: `lockKeys(checked ∪ mutated keys)` → each check via `getVersionForUpdate ?? getVersion` → each `set` via `insertIfAbsent` when its key was checked `version: null` (null result = `{ ok: false }`), otherwise `set` → deletes → enqueues.

### SQL Dialect Differences

| Feature | SQLite | PostgreSQL |
|---|---|---|
| Key column | `BLOB` | `BYTEA` |
| Queue ID | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL` in step 1, `BIGINT` + `AS BIGINT` sequence in step 2 |
| Entry `version` | `INTEGER` (64-bit) | `BIGINT` (step 2); Bun.SQL returns int8 as string, the adapter applies `Number()` |
| Timestamp | `INTEGER` | `BIGINT` |
| `increment()` | read-modify-write in one transaction (JS arithmetic) | one upsert, `convert_from(value,'UTF8')::numeric + delta`, returned as `FLOAT8` |
| `atomic()` concurrency | serial queue: one statement or transaction at a time | `pg_advisory_xact_lock` per key, `SELECT ... FOR UPDATE` for checks, `insertIfAbsent` for `version: null` keys |
| Concurrent dequeue | `MATERIALIZED` CTE picker (writers serialized) | `MATERIALIZED` CTE picker with `FOR UPDATE SKIP LOCKED` |
| Lease reclaim | one UPDATE | `MATERIALIZED` CTE with `FOR UPDATE SKIP LOCKED`, then UPDATE ... FROM |
| Migration lock | `BEGIN IMMEDIATE` | `pg_advisory_xact_lock(hash("migrate:" + meta table))` |
| Table names | `"<prefix>kv"` | `"<schema>"."<prefix>kv"` when `schema` is set |
| Partial indexes | `WHERE expires_at IS NOT NULL` | same |

---

## Singleflight

Exported standalone for deduplicating concurrent async work:

```ts
import { Singleflight } from "@coderbuzz/kvs";

const sf = new Singleflight<User>();

// 100 concurrent calls for "user:42": fetchUser() runs once
const user = await sf.do("user:42", () => fetchUser(42));

sf.clear();        // clear all in-flight
sf.size;           // number of in-flight keys
```

---

## Backend Config

### SQLite (KVStore, sync, bun:sqlite)
- WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`
- TTL cleanup + queue maintenance (`cleanQueue`) every 60 s
- Lease reclaim before a dequeue, at most once per second
- List max: 1000 per page
- Queue dispatch interval: 1 s

### SQLite (AsyncKVStore via bun:sql)
- Same performance profile, async API
- Same SQL features (RETURNING, ON CONFLICT, WAL)
- Bun's SQLite `SQL` client has **one connection**. A statement sent while a transaction is open runs inside that transaction. `SQLiteAsyncAdapter` therefore runs everything through a serial queue: one statement or one whole `transaction()` at a time. Without it (kvs ≤ 0.3.1) a plain `set()` issued during a failing `atomic()` returned `{ ok: true }` and was rolled back, and a second concurrent `atomic()` threw `cannot start a transaction within a transaction`. Measured cost: none within noise on `get` (~82K vs ~83K ops/s)

### PostgreSQL (AsyncKVStore via bun:sql)
- Connection pooling (configurable via connection string)
- `SKIP LOCKED` for safe concurrent dequeue
- `NUMERIC` arithmetic for increment (exact in storage), result returned as `FLOAT8`
- `atomic()` locks: advisory lock ids are FNV-1a 64 of `namespace ‖ encodedKey`, namespace `"kvs:"` for the default tables (same as 0.3, so 0.3 and 0.4 processes still exclude each other) and `"kvs:<schema>.<prefix>:"` otherwise, deduplicated and taken in ascending order (no lock-order deadlock). A hash collision only makes two keys share a lock. They can collide with an application's own `pg_advisory_xact_lock(bigint)` ids in the same database; that only serializes, it never breaks correctness
- `BYTEA` for binary key/value storage

---

## Internal Behavior (important for debugging)

### Timers (stopped in close(), unref'd)
- All internal timers are `unref()`'d: an open store never keeps the process alive. A script that forgets `close()` exits normally (kvs ≤ 0.3.1 hung forever).
- **Maintenance:** one 60s timer. `KVStore` starts it in the constructor; `AsyncKVStore` starts it after the first operation runs `migrate()`. Errors are counted in `watchDiagnostics.dispatchErrors`.
  - Cleanup deletes rows where `expires_at IS NOT NULL AND expires_at <= now` (`DELETE ... RETURNING key`) and emits tombstones.
  - `cleanQueue()`: dead-letter expired last-attempt leases, apply `doneRetention`/`deadRetention`.
- **Queue poll:** every 1s while at least one listener exists, every listener is notified (picks up delayed messages, retries, reclaimed leases, other processes' enqueues).
- **Lease renewal:** one interval per listener with in-flight handlers (`autoAck` only), every `visibilityTimeout / 2`.

### Watch internals
- `watchIndex: Map<hex-encoded-key, Set<Watcher>>`
- Every successful mutation creates a committed mutation holding the encoded
  key, the encoded value bytes (or null for a tombstone) and the version. Values
  are not re-read from storage. The `KvEntry` is decoded from those bytes only
  for keys some watcher watches, once per batch; with no watchers a write pays
  nothing for watch support. (0.3.0–0.3.1 decoded every write, costing ~36–56% of
  `set()` throughput.)
- Atomic operations collapse repeated keys to their final state and emit one
  batch after the transaction commits. A watcher matching multiple changed keys
  is invoked once for that batch.
- A batch-local entry cache is seeded by changed entries. Every unique unchanged
  key required by legacy multi-key callbacks is fetched at most once, shared by
  all matching watchers.
- Sync callbacks run sequentially after commit. Async batches enter one ordered
  promise chain; watchers are captured at enqueue time and checked for active
  state before callback, preventing post-cancel sends and stale completion order.
- `WatchCallback` is `(entries, event?) => void`. `event.sequence` is monotonic
  only within the current process; it is not a durable database revision.
- `watch()` fires immediately with `initial: true`. `cleanExpired()` emits
  tombstones. `reset()` emits `reset: true` tombstones and keeps watchers active.
- `getWatchDiagnostics()` returns active watcher, batch, callback, shared-read,
  callback-error, and dispatch-error counters without high-cardinality labels.

### Queue dispatch internals
- `queueWorkers: Map<topic, Set<QueueWorker>>`, one `QueueWorker` (`src/queue.ts`) per `addQueueListener()`; the same class serves `KVStore` and `AsyncKVStore` (it awaits whatever the store returns).
- `notify()` sets `again = true` and, if no pump is running, schedules one with `queueMicrotask`. Callers: `enqueue()` and `atomic()` commits with a due message on the topic, `retryDead()`, the 1 s poll, a finished handler, the listener's own start. The handler therefore never runs on `enqueue()`'s stack: a listener that enqueues follow-up work to its own topic keeps the stack flat (5 001 chained messages: depth 1).
- `pump()`: `while (active && again) { again = false; while (inFlight < concurrency) { msgs = await dequeue(topic, concurrency - inFlight, { visibilityTimeout }); if (!msgs.length) break; start each } }`. A dequeue failure (closed store, lost connection) ends the pump and counts `dispatchErrors`; the 1 s poll retries (no hot loop). A wake-up that lands while the pump finishes is not lost: `finally` re-notifies when `again` is set.
- `run(msg)`: `await handler(msg)`; with `autoAck`, `acknowledge` or `nack`; a `false` result counts `leaseLost`, a throw `dispatchErrors`. Then remove from in-flight, stop renewal when idle, resolve `cancel()` waiters, `notify()`.
- Renewal skips deliveries whose handler already settled, so a renewal that crosses the ack is not counted as a lost lease.
- Several listeners of one topic compete: whoever has a free slot dequeues. There is no round-robin (0.3 had one, over a synchronous drain).
- `getQueueDiagnostics()` sums listeners and in-flight handlers over all workers; counters are shared by the store.

## Gotchas

1. `KVStore.get()` returns `null` for expired entries (TTL respected).
2. `AtomicOperation.check({ version: null })` means "key must NOT exist". This is the opposite of checking a version number.
3. `watch()` fires immediately with current values, not just on future changes.
4. `addQueueListener()` handlers are awaited and **auto-acked** (resolve) or **nacked** (throw) since 0.4. Do not also call `acknowledge()` from an `autoAck` handler (the second ack returns `false` and counts `leaseLost`). Use `autoAck: false` to own the message.
5. `getAsync()` uses the hex of the encoded key as the singleflight dedup key, so keys that encode identically share one flight. Dedup is per store instance (in-process only).
6. `KVStore` requires Bun (for `bun:sqlite`). `AsyncKVStore` uses `bun:sql` (built-in, no extra deps).
7. `close()` stops all timers, cancels all watchers, and closes the database. No operations work after close.
8. SQLite WAL means concurrent readers are fine, but writers are serialized.
9. **Engine minimums:** the queue picker is a `WITH ... AS MATERIALIZED` CTE, which requires **PostgreSQL 12+** and **SQLite 3.35+**; `RETURNING` also requires SQLite 3.35+. Bun 1.4 bundles SQLite 3.53, so only the PostgreSQL server version needs checking.
10. **`dequeue(topic, limit)` returns at most `limit` rows, and ties in `deliver_at` break on `id ASC`.** Both are load-bearing. The picker must stay inside the materialized CTE: on PostgreSQL an equivalent `id IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` sublink can be planned on the inner side of a nested-loop semi join with no `Materialize` node, rescanning the picker once per outer row. Each rescan re-runs `SKIP LOCKED` against the rows the previous iteration locked, returns a different window, and every candidate row ends up marked `processing`. This delivers a whole backlog to one worker while the call reports the limit it was given. `deliver_at` is a millisecond timestamp, so enqueue bursts tie constantly; without the `id` tiebreaker FIFO order is whatever the planner produces.
11. `atomic().commit()` returns `{ ok: true, version }` where `version` is the version of the last `set` mutation in the operation, or `0` when it has no `set`.
12. `new AsyncKVStore("kv.db")` does not open SQLite. Bun's `SQL` treats a protocol-less filename as PostgreSQL. Use `"sqlite://kv.db"`.
13. Watch `sequence` starts at 0 per store instance and increments per committed batch (including batches no watcher matches). It is not persisted.
14. `KvWatchEvent.coalesced` is declared but never set by the core store, and `@coderbuzz/kvs-server` does not send it. Treat it as reserved.
15. **Validation errors are `RangeError`/`TypeError`:** `list()` limit/cursor, `ttl`, queue `delay` (must be finite; negative means already due), and `increment()` delta throw `RangeError`; `increment()` on a non-number throws `TypeError`. On `AsyncKVStore` they reject the returned promise. Validation happens before any write.
16. **`atomic().commit()` is safe under concurrency on every backend.** Two commits that check the same `version` (or `version: null`) never both return `ok: true`, including write skew (A checks B absent and writes A, B checks A absent and writes B: exactly one wins). On PostgreSQL a check waits for an uncommitted write to the checked row and then re-reads it; a `version: null` key that a concurrent plain `set()` creates before the commit makes the commit return `{ ok: false }`.
17. **Custom `SqlAdapter` on a concurrent backend** must implement `lockKeys`, `getVersionForUpdate` and `insertIfAbsent` for 16 to hold; without them `atomic()` falls back to plain `getVersion()` + `set()`. Its `increment(key, delta, now)` must create missing/expired keys itself; returning `null` (the pre-0.3.2 contract) makes the store fall back to a non-atomic `set()`.
18. **Do not call a `SQLiteAsyncAdapter` from inside its own `transaction()` callback** except through the adapter the callback receives: the outer adapter waits for the transaction to finish, so the call never completes.
19. **`acknowledge`/`nack`/`extendLease` need `msg.token`.** A 0.3-style `acknowledge(id)` throws `TypeError`.
20. **A message is at-least-once.** A handler slower than its lease (without renewal: `autoAck: false`, or a plain `dequeue()` loop) can see its message redelivered to another consumer; its late `acknowledge` then returns `false`.
21. **Expired leases are reclaimed lazily**: by a dequeue (at most once a second per store) or by `cleanQueue()`/`listDead()`/`queueStats()` (dead-lettering only). Until then `queueStats().processing` still counts them.
22. **Shared databases**: a table named `kv`, `queue` or `meta` that lacks the kvs columns makes `new KVStore()` throw / the first `AsyncKVStore` operation reject, and is never altered. The check is by column names only: an application table that happens to have them (e.g. `meta(key, value)`) passes, and kvs then writes its `schema_version` row into it. Use `tablePrefix` (and `schema` on PostgreSQL) whenever kvs shares a database. `reset()` deletes only the store's own tables.
23. **Upgrading a big PostgreSQL database from 0.3** rewrites `kv` and `queue` once (`ALTER COLUMN ... TYPE BIGINT`) under an exclusive lock; every process opening the database waits for the migration.
24. **`dequeue()` from a 1-row topic can still return nothing right after a release in another process**: other processes reclaim at most once a second.

---

## Server & Client

- `@coderbuzz/kvs-server`: `createServer(store)` for sync, `createAsyncServer(store)` for async. Exposes the queue v2 routes (`/queue/nack`, `/queue/extend`, `/queue/dead`, `/queue/stats`, …) and WebSocket listeners that hold `concurrency` slots until the client acks.
- `@coderbuzz/kvs-client`: TypeScript SDK for the server
