<!-- docs: sync from coderbuzz/codex@70f6ace -->

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
  ├── enqueue/dequeue/ack     : persistent queue (sync)
  ├── watch()                 : in-process callbacks (sync)
  ├── addQueueListener()      : push-based queue delivery (sync)
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
  ├── enqueue/dequeue/ack     : persistent queue (async)
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
  openDatabase, StmtCache,
  SQLiteAsyncAdapter, PostgresAdapter,             // adapters
  type SqlAdapter,
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
  enqueuedAt: number; deliverAt: number
  attempts: number; maxAttempts: number
}
interface QueueOptions { topic?: string; delay?: number; maxAttempts?: number }

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

### `new KVStore(path?: string)`
- **Default path:** `"kv.db"`
- Opens/creates SQLite database with WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`
- Starts TTL cleanup timer (every 60s) and failed message requeue timer (every 60s)

```ts
const store = new KVStore("kv.db");                 // sync, bun:sqlite
```

### `new AsyncKVStore(connection: string | { adapter: SqlAdapter })`
- Auto-detects adapter from connection string:
  - `"postgres://..."` or `"postgresql://..."` → `PostgresAdapter`
  - anything else → `SQLiteAsyncAdapter`, which hands the string to Bun's `new SQL(...)`. Use `"sqlite://..."`, `"file://..."`, or `":memory:"`.
  - A plain filename such as `"kv.db"` is NOT SQLite: Bun's `SQL` parses it as a PostgreSQL connection, so the first operation fails with a connection error.
- Migration and the 60 s cleanup/requeue timer start lazily on the first operation (`ensureInit()`), not in the constructor. If `migrate()` rejects (database not up yet), that call rejects and the next operation runs `migrate()` again; a failure is not cached.

```ts
const asyncStore = new AsyncKVStore("sqlite://kv.db");
const pgStore = new AsyncKVStore("postgres://user:pass@localhost:5432/kvdb");
const customStore = new AsyncKVStore({ adapter: new PostgresAdapter("postgres://...") });
```

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

### `enqueue(payload: unknown, options?: QueueOptions): { ok: true, id: number }`

**Defaults:** `topic: "default"`, `delay: 0`, `maxAttempts: 3`.

```ts
store.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
// { ok: true, id: 1 }
```

### `dequeue(topic?: string, limit?: number): QueueMessage[]`

**Defaults:** `topic: "default"`, `limit: 1`.

Dequeue messages ready for delivery (`status = 'pending' AND deliver_at <= now`, ordered by `deliver_at ASC, id ASC`, at most `limit` rows). Messages are moved to `"processing"` and `attempts` is incremented. Unacknowledged messages are requeued by the 60 s maintenance timer once `deliver_at` is more than 30 s in the past (up to `maxAttempts`).

```ts
const messages = store.dequeue("emails", 10);

// Worker loop: acknowledge on success, skip on failure
for (const msg of messages) {
  try {
    await sendEmail(msg.payload);
    store.acknowledge(msg.id);  // mark as done
  } catch {
    // Don't acknowledge, requeued after 30s (up to maxAttempts)
    console.error(`Failed ${msg.id}, attempt ${msg.attempts + 1}/${msg.maxAttempts}`);
  }
}
```

### `acknowledge(id: number): boolean`

```ts
store.acknowledge(message.id); // marks as "done". Returns true only if the message was in "processing".
```

**Message lifecycle:**
```
pending → (dequeue) → processing → (acknowledge) → done
                           ↓ not acked within 30s
                        requeue → pending (up to maxAttempts)
```

Failed message requeue runs every 60s. It sets `status = 'pending'` for rows with `status = 'processing' AND attempts < max_attempts AND deliver_at <= now - 30000`. The 30 s is measured from `deliver_at`, not from dequeue time, so the effective redelivery delay is 30 to 90 s after `deliver_at` (or the next tick if the message was dequeued late). A message whose `attempts` reached `maxAttempts` stays `processing` permanently; there is no dead-letter state.

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

### `addQueueListener(topic: string, callback: (msg: QueueMessage) => void): { cancel: () => void }`

Push-based queue delivery with round-robin work-stealing.

```ts
const { cancel } = store.addQueueListener("emails", (msg) => {
  processEmail(msg.payload);
  store.acknowledge(msg.id);  // must ack manually
});
cancel();
```

**Internal:** Pending messages are dispatched immediately when a listener is added and after every non-delayed `store.enqueue()`. A 1 s timer covers delayed, requeued, and `atomic().enqueue()` messages (atomic commits do not trigger dispatch). Messages distributed round-robin across all listeners for the same topic. Timer starts on first listener, stops when last listener is removed. Listener exceptions are swallowed; the message stays `processing` until requeued.

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

### `new AsyncKVStore(connection: string | { adapter: SqlAdapter })`

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
await store.dequeue(topic?: string, limit?: number): Promise<QueueMessage[]>
await store.acknowledge(id: number): Promise<boolean>
await store.cleanExpired(): Promise<number>
await store.reset(): Promise<void>
await store.close(): Promise<void>
await store.getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>
```

`watch()` and `addQueueListener()` remain **sync** (in-process callbacks):

```ts
store.watch(keys: KvKey[], callback: WatchCallback): { cancel: () => void }
store.addQueueListener(topic: string, callback: (msg: QueueMessage) => void): { cancel: () => void }
store.getWatchDiagnostics(): KvWatchDiagnostics
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
| `KVStore(path)` | `path` | `"kv.db"` |
| `set(key, value, options)` | `options` | `{}` (no TTL) |
| `increment(key, delta)` | `delta` | `1` |
| `list(selector, options)` | `options.limit` | `100` |
| | `options.reverse` | `false` |
| `enqueue(payload, options)` | `options.topic` | `"default"` |
| | `options.delay` | `0` |
| | `options.maxAttempts` | `3` |
| `dequeue(topic, limit)` | `topic` | `"default"` |
| | `limit` | `1` |
| `openDatabase(path)` | `path` | `"kv.db"` |

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
  dequeue(topic: string, now: number, limit: number): Promise<QueueRow[]>;
  ack(id: number): Promise<boolean>;
  requeueFailed(now: number): Promise<number>;
  transaction<T>(fn: (adapter: SqlAdapter) => Promise<T>): Promise<T>;
  // Optional, called on the transaction adapter by atomic().commit(). Needed on a
  // backend that runs transactions concurrently (PostgresAdapter implements all three):
  lockKeys?(keys: Uint8Array[]): Promise<void>;                      // held until the transaction ends
  getVersionForUpdate?(key: Uint8Array, now: number): Promise<number | null>; // locks the row
  insertIfAbsent?(key: Uint8Array, value: Uint8Array, expiresAt: number | null, now: number): Promise<{ version: number } | null>;
  close(): Promise<void>;
  raw(sql: string): Promise<void>;
}
```

`atomic().commit()` inside `transaction()`: `lockKeys(checked ∪ mutated keys)` → each check via `getVersionForUpdate ?? getVersion` → each `set` via `insertIfAbsent` when its key was checked `version: null` (null result = `{ ok: false }`), otherwise `set` → deletes → enqueues.

### SQL Dialect Differences

| Feature | SQLite | PostgreSQL |
|---|---|---|
| Key column | `BLOB` | `BYTEA` |
| Queue ID | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| Timestamp | `INTEGER` | `BIGINT` |
| `increment()` | read-modify-write in one transaction (JS arithmetic) | one upsert, `convert_from(value,'UTF8')::numeric + delta`, returned as `FLOAT8` |
| `atomic()` concurrency | serial queue: one statement or transaction at a time | `pg_advisory_xact_lock` per key, `SELECT ... FOR UPDATE` for checks, `insertIfAbsent` for `version: null` keys |
| Concurrent dequeue | `MATERIALIZED` CTE picker (writers serialized) | `MATERIALIZED` CTE picker with `FOR UPDATE SKIP LOCKED` |
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
- TTL cleanup every 60 s
- Failed message requeue every 60 s (older than 30 s, up to maxAttempts)
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
- `atomic()` locks: advisory lock ids are FNV-1a 64 of `"kvs:" ‖ encodedKey`, deduplicated and taken in ascending order (no lock-order deadlock). A hash collision only makes two keys share a lock. They can collide with an application's own `pg_advisory_xact_lock(bigint)` ids in the same database; that only serializes, it never breaks correctness
- `BYTEA` for binary key/value storage

---

## Internal Behavior (important for debugging)

### Timers (stopped in close(), unref'd)
- All internal timers are `unref()`'d: an open store never keeps the process alive. A script that forgets `close()` exits normally (kvs ≤ 0.3.1 hung forever).
- **TTL cleanup + failed message requeue:** one 60s timer. `KVStore` starts it in the constructor; `AsyncKVStore` starts it after the first operation runs `migrate()`.
  - Cleanup deletes rows where `expires_at IS NOT NULL AND expires_at <= now` (`DELETE ... RETURNING key`) and emits tombstones.
  - Requeue sets `status = 'pending'` where `status = 'processing' AND attempts < max_attempts AND deliver_at <= now - 30000`.
- **Queue dispatch:** Every 1s while at least one listener exists, dispatches deliverable messages to active listeners (round-robin)

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
- `queueListeners: Map<topic, Set<callback>>`
- `queueRRIndex: Map<topic, number>`, the round-robin index per topic
- `dispatchToListeners()`: dequeues messages one-by-one, distributes round-robin
- Stops dispatch timer when all topics have no listeners
- **Not re-entrant (`KVStore`).** A listener that calls `enqueue()` on its own topic does not start a nested dispatch; the running loop dequeues the new message next. Stack depth stays 1 (kvs ≤ 0.3.1 recursed once per message and silently stopped at the stack limit, ~8,000 messages).
- **One drain loop per topic (`AsyncKVStore`).** Requests that arrive while it runs set an `again` flag so the loop checks once more before stopping. A failing `dequeue()` (store closed, connection lost) ends the loop and increments `dispatchErrors` instead of becoming an unhandled rejection; `close()` stops the loop.
- A listener that throws, or returns a rejected promise, is ignored (the promise gets a no-op `catch`). The message stays `processing` until acknowledged or requeued. Handlers are not awaited: an async listener runs concurrently with the next delivery.

---

## Gotchas

1. `KVStore.get()` returns `null` for expired entries (TTL respected).
2. `AtomicOperation.check({ version: null })` means "key must NOT exist". This is the opposite of checking a version number.
3. `watch()` fires immediately with current values, not just on future changes.
4. `addQueueListener()` callbacks must call `acknowledge()` manually. Messages are NOT auto-acked.
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

---

## Server & Client

- `@coderbuzz/kvs-server`: `createServer(store)` for sync, `createAsyncServer(store)` for async
- `@coderbuzz/kvs-client`: TypeScript SDK for the server
