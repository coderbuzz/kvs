<!-- docs: sync from coderbuzz/codex@c0ec729 -->

# KVS — AI Agent Knowledge File

**Package:** `@coderbuzz/kvs` v0.2.11
**Purpose:** Multi-backend key-value store. Sync `KVStore` (bun:sqlite) and async `AsyncKVStore` (bun:sql — SQLite + PostgreSQL).
**Distribution:** ESM only (`dist/index.js` + `dist/index.d.ts`).

---

## Mental Model

```
KVStore("kv.db")                — sync, bun:sqlite, embedded SQLite only
AsyncKVStore("sqlite://kv.db")  — async, bun:sql, SQLite
AsyncKVStore("postgres://...")  — async, bun:sql, PostgreSQL
```

### KVStore (sync)
```
KVStore("kv.db")
  ├── get/set/delete          — CRUD (sync)
  ├── increment               — atomic counter (sync)
  ├── list                    — prefix/range queries (sync)
  ├── atomic()                — version-checked transactions (sync)
  ├── enqueue/dequeue/ack     — persistent queue (sync)
  ├── watch()                 — in-process callbacks (sync)
  ├── addQueueListener()      — push-based queue delivery (sync)
  ├── getAsync()              — cache-with-compute (singleflight, async)
  ├── cleanExpired() / reset()
  └── close()
```

### AsyncKVStore (async)
```
AsyncKVStore("sqlite://kv.db" | "postgres://...")
  ├── get/set/delete          — CRUD (async)
  ├── increment               — atomic counter (async)
  ├── list                    — prefix/range queries (async)
  ├── atomic()                — version-checked transactions (async commit)
  ├── enqueue/dequeue/ack     — persistent queue (async)
  ├── watch()                 — same as KVStore (in-process)
  ├── addQueueListener()      — same as KVStore
  ├── getAsync()              — same as KVStore
  ├── cleanExpired() / reset() — async
  └── close()                 — async
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

type WatchCallback = (entries: (KvEntry | null)[]) => void
```

---

## Key Encoding

```
KvKeyPart = string | number | bigint | boolean | Uint8Array
KvKey = KvKeyPart[]
Sort: Uint8Array < string < number < bigint < false < true
```

Encoding: each key part is prefixed with a type-tag byte + varint-length, then sorted lexicographically as bytes.

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
  - `"sqlite://..."`, `"file://..."`, `":memory:"`, or plain filename → `SQLiteAsyncAdapter`

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
Every `set` increments `version` by 1. TTL is in milliseconds.

### `delete(key: KvKey): void`

```ts
store.delete(["users", "alice"]);
```

### `increment(key: KvKey, delta?: number): number`

Atomically increment a numeric value. Creates the key with `delta` if it doesn't exist. Uses a single SQL UPDATE + RETURNING — no JSON parse/stringify overhead.

```ts
// Basic increment (default delta: 1)
store.increment(["counter", "visits"]);        // 1 (first call)
store.increment(["counter", "visits"]);        // 2

// Custom delta — positive or negative
store.increment(["counter", "visits"], 5);      // 7
store.increment(["counter", "visits"], -1);     // 6

// Rate limiting pattern
const attempts = store.increment(["ratelimit", "192.168.1.1"], 1);
if (attempts > 10) throw new Error("Rate limit exceeded");
// Returns the new value after increment
```

### `list(selector: KvListSelector, options?: KvListOptions): KvListResult`

**Defaults:** `limit: 100`, max `1000`, ascending, `reverse: false`. `cursor` is opaque base64.

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
  console.log("Check failed — retry");
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

Dequeue messages ready for delivery. Messages are moved to `"processing"` status. Not acknowledging within 30s → auto-requeue (up to `maxAttempts`).

```ts
const messages = store.dequeue("emails", 10);

// Worker loop — acknowledge on success, skip on failure
for (const msg of messages) {
  try {
    await sendEmail(msg.payload);
    store.acknowledge(msg.id);  // mark as done
  } catch {
    // Don't acknowledge — requeued after 30s (up to maxAttempts)
    console.error(`Failed ${msg.id}, attempt ${msg.attempts + 1}/${msg.maxAttempts}`);
  }
}
```

### `acknowledge(id: number): boolean`

```ts
store.acknowledge(message.id); // marks as "done". Returns true if found.
```

**Message lifecycle:**
```
pending → (dequeue) → processing → (acknowledge) → done
                           ↓ not acked within 30s
                        requeue → pending (up to maxAttempts)
```

Failed message requeue runs every 60s. Messages older than 30s with `attempts < maxAttempts` are requeued.

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

**Internal:** Uses a `watchIndex: Map<hex-encoded-key, Set<Watcher>>`. On any `set`/`delete`/`increment`/`atomic.commit`, all watchers for that key fire. One watcher per `watch()` call can watch multiple keys.

### `addQueueListener(topic: string, callback: (msg: QueueMessage) => void): { cancel: () => void }`

Push-based queue delivery with round-robin work-stealing.

```ts
const { cancel } = store.addQueueListener("emails", (msg) => {
  processEmail(msg.payload);
  store.acknowledge(msg.id);  // must ack manually
});
cancel();
```

**Internal:** Dispatch timer runs every 1s. Messages distributed round-robin across all listeners for the same topic. Timer starts on first listener, stops when last listener is removed.

### `getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>`

Cache-with-compute with singleflight deduplication. Returns `Promise` — the only async method on `KVStore`.

```ts
// 100 concurrent callers — fn() runs once, result cached for 30s
const ad = await store.getAsync(["ads", "venue", 42], () => fetchNextAd(42), 30_000);
```

**Algorithm:**
1. Check SQLite — return immediately on cache hit
2. Singleflight dedup within process (coalesce concurrent calls for same key)
3. Call `fn()` exactly once
4. Store result in SQLite with TTL (if provided)
5. Return to all concurrent callers

### `cleanExpired(): number`

Manually delete expired entries. Returns count of deleted rows. (Auto-runs every 60s.)

```ts
store.set(["cache", "a"], "x", { ttl: 1_000 });
store.set(["cache", "b"], "y", { ttl: 1_000 });
// After 2s, entries are expired — cleanExpired() removes them immediately
const deleted = store.cleanExpired(); // 2
```

### `reset(): void`

Delete ALL data from `kv` and `queue` tables. Cancels all watchers and listeners.

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

**AsyncAtomicOperation methods:** `check()`, `set()`, `delete()`, `enqueue()` — all return `this`. `commit(): Promise<KvCommitResult | KvCommitError>`.

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

### SQL Dialect Differences

| Feature | SQLite | PostgreSQL |
|---|---|---|
| Key column | `BLOB` | `BYTEA` |
| Queue ID | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| Timestamp | `INTEGER` | `BIGINT` |
| Increment cast | `CAST(value AS TEXT) AS REAL` | `convert_from(value, 'UTF8')::FLOAT8` |
| Concurrent dequeue | Subquery `IN (SELECT ... LIMIT ?)` | `FOR UPDATE SKIP LOCKED` |
| Partial indexes | `WHERE expires_at IS NOT NULL` | same |

---

## Singleflight

Exported standalone for deduplicating concurrent async work:

```ts
import { Singleflight } from "@coderbuzz/kvs";

const sf = new Singleflight<User>();

// 100 concurrent calls for "user:42" — fetchUser() runs once
const user = await sf.do("user:42", () => fetchUser(42));

sf.clear();        // clear all in-flight
sf.size;           // number of in-flight keys
```

---

## Backend Config

### SQLite (KVStore — sync, bun:sqlite)
- WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`
- TTL cleanup every 60 s
- Failed message requeue every 60 s (older than 30 s, up to maxAttempts)
- List max: 1000 per page
- Queue dispatch interval: 1 s

### SQLite (AsyncKVStore via bun:sql)
- Same performance profile, async API
- Same SQL features (RETURNING, ON CONFLICT, WAL)

### PostgreSQL (AsyncKVStore via bun:sql)
- Connection pooling (configurable via connection string)
- `SKIP LOCKED` for safe concurrent dequeue
- `NUMERIC` → `FLOAT8` for increment operations
- `BYTEA` for binary key/value storage

---

## Internal Behavior (important for debugging)

### Timers (started in constructor, stopped in close())
- **TTL cleanup:** Every 60s — deletes rows where `expires_at <= now`
- **Failed message requeue:** Every 60s — requeues messages where `deliver_at <= now` AND `attempts < maxAttempts` AND status is not "done" (older than 30s)
- **Queue dispatch:** Every 1s — dispatches deliverable messages to active listeners (round-robin)

### Watch internals
- `watchIndex: Map<hex-encoded-key, Set<Watcher>>`
- On mutation (`set`/`delete`/`increment`/`atomic.commit`), `notifyWatchers()` fires all watchers for that key
- Each watcher re-fetches ALL its watched keys' current values on every fire
- Errors from individual watcher callbacks are silently caught (won't break other watchers)
- `watch()` fires **immediately** with current values when first registered

### Queue dispatch internals
- `queueListeners: Map<topic, Set<callback>>`
- `queueRRIndex: Map<topic, number>` — round-robin index per topic
- `dispatchToListeners()`: dequeues messages one-by-one, distributes round-robin
- Stops dispatch timer when all topics have no listeners

---

## Gotchas

1. `KVStore.get()` returns `null` for expired entries (TTL respected).
2. `AtomicOperation.check({ version: null })` means "key must NOT exist" — opposite of checking a version number.
3. `watch()` fires immediately with current values, not just on future changes.
4. `addQueueListener()` callbacks must call `acknowledge()` manually — messages are NOT auto-acked.
5. `getAsync()` uses `JSON.stringify(key)` as the singleflight dedup key — same array in same order.
6. `KVStore` requires Bun (for `bun:sqlite`). `AsyncKVStore` uses `bun:sql` (built-in, no extra deps).
7. `close()` stops all timers, cancels all watchers, and closes the database. No operations work after close.
8. SQLite WAL means concurrent readers are fine, but writers are serialized.

---

## Server & Client

- `@coderbuzz/kvs-server` — `createServer(store)` for sync, `createAsyncServer(store)` for async
- `@coderbuzz/kvs-client` — TypeScript SDK for the server
