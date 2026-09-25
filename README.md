<!-- docs: sync from coderbuzz/codex@15d78e0 -->

# KVS: `@coderbuzz/kvs`

> **Multi-backend key-value store for TypeScript.** Synchronous SQLite, asynchronous SQLite, and PostgreSQL. Atomic transactions, TTL expiry, persistent queue, real-time watch.
> AI agents: see [AI_KNOWLEDGE.md](https://github.com/coderbuzz/kvs/blob/main/AI_KNOWLEDGE.md) for expert context.
<p align="center">
  <a href="https://www.npmjs.com/package/@coderbuzz/kvs"><img src="https://img.shields.io/npm/v/@coderbuzz/kvs.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@coderbuzz/kvs"><img src="https://img.shields.io/npm/dm/@coderbuzz/kvs.svg?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/coderbuzz/kvs/blob/main/LICENSE"><img src="https://img.shields.io/github/license/coderbuzz/kvs.svg?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/coderbuzz/kvs"><img src="https://img.shields.io/github/stars/coderbuzz/kvs.svg?style=flat-square" alt="GitHub Stars" /></a>
  <a href="https://github.com/coderbuzz/kvs/actions/workflows/ci.yml"><img src="https://github.com/coderbuzz/kvs/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/coderbuzz/kvs"><img src="https://codecov.io/gh/coderbuzz/kvs/graph/badge.svg" alt="Codecov" /></a>
</p>

KVS is an embeddable key-value store backed by **SQLite** (sync or async) or **PostgreSQL** (async). Use it directly in your code. No HTTP server required. Pair with `@coderbuzz/kvs-server` for HTTP/WS, or `@coderbuzz/kvs-client` for the client SDK.

---

## Why KVS?

| Need | KVS | Redis | Upstash |
|---|---|---|---|
| Infrastructure | SQLite file or PostgreSQL | Server required | Managed |
| Embeddable | Yes, just `new KVStore()` | No (separate process) | No |
| Backends | SQLite (sync), SQLite + PostgreSQL (async) | - | - |
| Bundle size | ~30 KB (SQLite) / ~no extra (PG) | ~1 MB (ioredis) | N/A |
| Transactions | Version-based checks + atomic commit | MULTI/EXEC/WATCH | Conditional checks |
| Queue | Built-in with retries | Redis lists + pub/sub | Add-on |
| Watch | Push-based (via server) | Keyspace notifications | Polling |

---

## Benchmarks

Full results at **[github.com/coderbuzz/benchmarks](https://github.com/coderbuzz/benchmarks)**.

### Async KV Throughput (SQLite sync/async + PostgreSQL async)

| Backend | set('k','v') | get() hit | get() miss | delete() | increment() |
|---|---|---|---|---|---|
| bun:sqlite | **198,033 ops/s** | **1,198,124 ops/s** | **2,027,065 ops/s** | **1,782,730 ops/s** | **158,310 ops/s** |
| Async SQLite | 63,515 ops/s | 138,270 ops/s | 154,585 ops/s | 269,875 ops/s | 42,597 ops/s |
| Async PostgreSQL | 1,796 ops/s | 10,947 ops/s | 11,181 ops/s | 11,609 ops/s | 1,589 ops/s |

KVS runs on SQLite WAL mode: reads hit 1.20M ops/s (cache hit) and 2.03M ops/s (cache miss), while writes are bounded by SQLite commit speed (~198K ops/s).

bun:sqlite throughput is identical to `KVStore` benchmarks. Async SQLite adds ~2-4x overhead per operation due to `await` + `bun:sql` abstraction. PostgreSQL adds network round-trip overhead (~10-50x vs SQLite) but enables multi-process concurrency, horizontal scaling, and shared access.

---

## Features

- **Hierarchical keys**: `["users", "alice"]`, prefix/range queries, deterministic sort
- **Any JSON value**: strings, numbers, objects, arrays, null
- **Atomic transactions**: version checks + set/delete/enqueue in one commit
- **TTL expiry**: millisecond precision, background cleanup every 60 s
- **Built-in queue**: leases with ack tokens, retries with backoff, dead letters, awaited listeners with concurrency, per-topic stats
- **Versioned schema**: migrations run on open; `tablePrefix` (and `schema` on PostgreSQL) keep kvs tables apart from yours
- **Real-time watch**: in-process key-change callbacks; over the network via `@coderbuzz/kvs-server`
- **getAsync**: cache-with-compute with singleflight deduplication
- **Multi-backend**: SQLite (sync), SQLite + PostgreSQL (async) via unified `AsyncKVStore`
- **Zero dependencies**: no external libs beyond bun:sqlite / bun:sql

---

## Installation

```sh
npm install @coderbuzz/kvs
```

**KVStore** requires Bun (for `bun:sqlite`). **AsyncKVStore** uses `bun:sql` (built-in, no extra deps) and works with SQLite or PostgreSQL.

**Engine minimums.** The queue picker uses `WITH ... AS MATERIALIZED`, which needs **PostgreSQL 12+** and **SQLite 3.35+**. Bun 1.4 bundles SQLite 3.53, so the SQLite backends are always fine; only an older PostgreSQL server is a problem.

### Upgrading from 0.3

Opening a 0.3 database migrates it in place to schema version 2 (recorded in the `meta` table). Nothing to run by hand, but note:

- **PostgreSQL rewrites `kv` and `queue` once** (`version` and the queue `id` become `BIGINT`), holding an exclusive lock on each while it runs. Plan it for a quiet moment on a large table.
- **`acknowledge(id)` is now `acknowledge(id, token)`**: pass `msg.token` from `dequeue()`.
- **Listeners are awaited and acknowledge for you**: a handler that resolves acks its message, one that throws nacks it. Remove your own `acknowledge()` call from listeners, or pass `autoAck: false`.
- **Acknowledged messages are deleted** (0.3 kept them as `done` forever). Keep them for a while with `queue.doneRetention`.
- A message a 0.3 worker was holding counts as an expired lease and is delivered again.
- A database that a newer kvs has migrated is refused with an error rather than misread.

---

## Quick Start

```ts
import { KVStore, AsyncKVStore } from "@coderbuzz/kvs";

// Sync (SQLite via bun:sqlite)
const store = new KVStore("kv.db");
store.set(["users", "alice"], { name: "Alice" });
console.log(store.get(["users", "alice"])?.value);

// Async (SQLite via bun:sql)
const asyncStore = new AsyncKVStore("sqlite://kv.db");
await asyncStore.set(["users", "alice"], { name: "Alice" });
console.log(await asyncStore.get(["users", "alice"]));

// Async (PostgreSQL)
const pgStore = new AsyncKVStore("postgres://user:pass@localhost:5432/kvdb");
await pgStore.set(["key"], "value");
await pgStore.delete(["key"]);
```

---

## KVStore API

### `new KVStore(path?: string, options?: KVStoreOptions)`

Creates or opens a SQLite database. Default path: `"kv.db"`.

Opens with WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`, then creates or migrates the tables.

| Option | Default | Meaning |
|---|---|---|
| `tablePrefix` | `""` | Prefix for the `kv`, `queue` and `meta` tables, e.g. `"kvs_"` |
| `durability` | `"normal"` | `"full"` syncs every commit to disk, see [Durability](#durability) |
| `queue.visibilityTimeout` | `30_000` | Lease length of a dequeued message, ms |
| `queue.backoff` | 1 s, 2 s, 4 s … max 5 min | Retry delay after a failure: `number[]` (last entry repeats) or `(attempt) => ms` |
| `queue.doneRetention` | `0` | Keep acknowledged messages this long, ms (0 deletes on ack) |
| `queue.deadRetention` | `Infinity` | Keep dead messages this long, ms |

**Sharing a database with your application?** kvs refuses to open when a table named `kv`, `queue` or `meta` exists without the kvs columns, and never alters it. The check only looks at column names, so give kvs its own names with `tablePrefix`:

```ts
const store = new KVStore("app.db", { tablePrefix: "kvs_" }); // kvs_kv, kvs_queue, kvs_meta
```

### `get(key: KvKey): KvEntry | null`

```ts
const entry = store.get(["users", "alice"]);
// { key: ["users", "alice"], value: { name: "Alice" }, version: 1 }
// null if missing or expired
```

### `set(key: KvKey, value: unknown, options?: { ttl?: number }): KvCommitResult`

```ts
const result = store.set(["users", "alice"], { name: "Alice" });
// { ok: true, version: 1 }

store.set(["cache", "key"], value, { ttl: 60_000 }); // expires in 60 s
```

Every `set` increments `version` by 1. `ttl` must be a finite number ≥ 0 (`RangeError` otherwise).

### `delete(key: KvKey): void`

```ts
store.delete(["users", "alice"]);
```

### `increment(key: KvKey, delta?: number): number`

Atomically increment a numeric value. Creates the key with `delta` if it doesn't exist or has expired. Default `delta: 1`.

- A live key keeps its TTL, so `set(key, 0, { ttl })` + `increment(key)` makes a fixed-window rate limiter.
- A key that holds anything but a number throws a `TypeError` and is left unchanged.
- `delta` must be a finite number (`RangeError` otherwise).

```ts
// Basic increment
store.increment(["counters", "pageviews"]); // 1 (first call)
store.increment(["counters", "pageviews"]); // 2

// Custom delta (decrement with negative)
store.increment(["users", "alice", "balance"], 500);  // 500
store.increment(["users", "alice", "balance"], -100); // 400

// Rate limiting pattern
const attempts = store.increment(["ratelimit", ip], 1);
if (attempts > 10) throw new Error("Rate limit exceeded");
```

### `list(selector: KvListSelector, options?: KvListOptions): KvListResult`

```ts
// Prefix query
store.list({ prefix: ["users"] });
// Range query
store.list({ start: ["events", 1000], end: ["events", 2000] });
// Paginated
store.list({ prefix: ["logs"] }, { limit: 20, cursor: cursor });
// Reverse
store.list({ prefix: ["logs"] }, { limit: 5, reverse: true });
```

**Defaults:** `limit: 100`, max `1000` (larger values are capped), ascending. `limit` must be an integer ≥ 1. `cursor` is opaque base64 and only valid for the selector it came from: a cursor outside the selector's range throws a `RangeError`, so a cursor cannot page past a prefix.

**`KvListResult`:** `{ entries: KvEntry[], cursor: string | null }`

### `getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>`

Cache-with-compute pattern with singleflight deduplication:

```ts
// 100 concurrent callers: fn() runs once, result cached for 30 s
const ad = await store.getAsync(["ads", "venue", 42], () => fetchNextAd(42), 30_000);
```

**Algorithm:**
1. Check SQLite: return immediately on cache hit
2. Singleflight dedup within process
3. Call `fn()` exactly once
4. Store result in SQLite with TTL
5. Return to all concurrent callers

### `atomic(): AtomicOperation`

Fluent builder for version-checked transactions:

```ts
const result = store
  .atomic()
  .check({ key: ["counter"], version: 3 })  // fail if not at version 3
  .check({ key: ["new-key"], version: null }) // fail if exists
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

| Method | Signature | Description |
|---|---|---|
| `check` | `(...checks: KvCheck[]): this` | Assert key versions |
| `set` | `(key, value, options?): this` | `options: { ttl?: number }` |
| `delete` | `(key): this` | |
| `enqueue` | `(payload, options?): this` | `options: QueueOptions` |
| `commit` | `(): KvCommitResult \| KvCommitError` | Execute transaction |

**`check(version: null)`** = "key must not exist".
**`check(version: N)`** = "key must be at version N".

### Queue

A message is **leased** to one consumer at a time. `dequeue()` hands out the message with a `token`; finish it with `acknowledge(id, token)` or give it back with `nack(id, token)`. If the consumer dies, the lease runs out after `visibilityTimeout` (30 s) and the message is delivered again. After `maxAttempts` deliveries it is **dead-lettered** instead of retried, where you can inspect, retry or delete it.

```
enqueue → pending ──dequeue──▶ processing ──acknowledge──▶ deleted (or done, with doneRetention)
             ▲                    │   │
             └── nack / lease ────┘   └── nack or lease expiry on the last attempt ──▶ dead
                 expiry (backoff)                                           retryDead ─┘
```

### `enqueue(payload: unknown, options?: QueueOptions): { ok: true, id: number }`

```ts
store.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
```

Defaults: `topic: "default"`, `delay: 0`, `maxAttempts: 3` (an integer >= 1).

### `dequeue(topic?: string, limit?: number, options?: { visibilityTimeout?: number }): QueueMessage[]`

Lease up to `limit` (default 1, max 1000) due messages, oldest first. Each message carries `token`, `lockedUntil`, `attempts` and the `lastError` of the previous attempt.

```ts
for (const msg of store.dequeue("emails", 10)) {
  try {
    await sendEmail(msg.payload);
    store.acknowledge(msg.id, msg.token);
  } catch (error) {
    store.nack(msg.id, msg.token, { error: String(error) }); // retried after the backoff
  }
}
```

### `acknowledge(id: number, token: string): boolean`

Finish a message: it is deleted (kept as `done` under `queue.doneRetention`). Returns `false` if the lease is no longer yours: it expired and the message went to someone else.

### `nack(id: number, token: string, options?: { error?: string, delay?: number }): boolean`

Give a message back after a failure. It is retried after the backoff (or `delay` ms), or dead-lettered once it has used `maxAttempts`. `error` is stored as `lastError`.

### `extendLease(id: number, token: string, visibilityTimeout?: number): boolean`

Keep a long job's lease: the lease now ends `visibilityTimeout` ms from now (default: the store's). `0` hands the message back at once.

### `listDead(topic?, { limit?, after? }?)`, `retryDead(topic?, id?)`, `deleteDead(topic?, id?)`

```ts
for (const msg of store.listDead("emails")) console.log(msg.id, msg.lastError, msg.failedAt);
store.retryDead("emails", 42); // one message, attempts start again at 0
store.retryDead("emails");     // every dead message of the topic
store.deleteDead("emails");
```

### `queueStats(topic?: string): QueueStats[]`

Counts per topic: `pending` (due now), `delayed`, `processing`, `dead`, `done`, and `oldestPendingAt` (lag = `Date.now() - oldestPendingAt`).

### `cleanQueue(): number`

Queue maintenance: dead-letters messages whose last lease expired, and deletes `done`/`dead` messages past their retention. Runs every 60 s on its own; call it from a short-lived script, whose timers never fire.

### `watch(keys: KvKey[], callback: WatchCallback): { cancel: () => void }`

Subscribe to key changes. Fires immediately with current values. The optional
second callback argument carries a process-local ordered sequence:

```ts
const { cancel } = store.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries, event) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
    console.log(event?.sequence, event?.initial, event?.changedKeys);
  },
);
cancel(); // stop watching
```

One committed mutation batch invokes each matching watcher once. Committed
entries are reused directly, and unchanged keys in multi-key watches are read at
most once per batch regardless of subscriber count. Atomic commits changing
multiple watched keys therefore produce one coherent callback.

### `getWatchDiagnostics(): KvWatchDiagnostics`

Returns bounded counters for active watchers, committed batches, callbacks,
shared reads, callback errors, and dispatcher errors. It does not expose raw
keys or values.

### `addQueueListener(topic, handler, options?): { cancel: () => Promise<void> }`

Run `handler` for each message of a topic. The handler is awaited; when it resolves the message is acknowledged, when it throws it is nacked (retried with backoff, dead-lettered after `maxAttempts`). While it runs, the lease is renewed.

```ts
const listener = store.addQueueListener("emails", async (msg) => {
  await sendEmail(msg.payload); // throw to retry
}, { concurrency: 4 });

await listener.cancel(); // stops taking messages, waits for running handlers
```

| Option | Default | Meaning |
|---|---|---|
| `concurrency` | `1` | Handlers of this listener running at once |
| `visibilityTimeout` | store's | Lease length |
| `autoAck` | `true` | `false`: the handler calls `acknowledge`/`nack` itself |

Handlers never run inside `enqueue()`. Several listeners of a topic (in this or other processes) share its messages. New messages wake the listener at once, including those from `atomic().enqueue()`; delayed messages, retries and other processes' messages are picked up by a 1 s poll. `getQueueDiagnostics()` returns counters: delivered, acked, nacked, handler errors, lost leases.

### `cleanExpired(): number`

Manually trigger cleanup of expired entries. Auto-runs every 60s. Returns number
of deleted rows and emits `null` tombstones to active watchers.

```ts
store.set(["cache", "a"], "x", { ttl: 1000 });
store.set(["cache", "b"], "y", { ttl: 1000 });
// After 2s, entries are expired: cleanExpired() removes them immediately
store.cleanExpired(); // returns 2
```

### `reset(): void`

Delete ALL data from kv + queue tables. Active watchers receive a reset
tombstone and remain registered, so later writes continue to be delivered.

```ts
store.set(["users", "alice"], { name: "Alice" });
store.enqueue("test");
store.reset();
store.get(["users", "alice"]); // null
```

### Durability

SQLite runs in WAL mode with `synchronous = NORMAL` by default: a power cut or OS crash can lose the last transactions, but never corrupts the file. A process crash loses nothing. Pass `durability: "full"` to sync every commit, at the cost of write throughput. On PostgreSQL durability is the server's setting (`synchronous_commit`).

### `close(): void`

Close database, stop cleanup/dispatch timers, cancel watchers/listeners. No operations work after close. The timers are unref'd, so a script that never calls `close()` still exits.

```ts
// Graceful shutdown
process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});
```

---

## AsyncKVStore API

### `new AsyncKVStore(connection: string | { adapter: SqlAdapter, queue? }, settings?)`

Creates an async KV store backed by SQLite or PostgreSQL. Adapter auto-detected from connection string:

```ts
// SQLite file
new AsyncKVStore("sqlite://kv.db");
// SQLite in-memory
new AsyncKVStore(":memory:");
// SQLite via file:// URL
new AsyncKVStore("file://kv.db");
// PostgreSQL, tables kvs_kv/kvs_queue/kvs_meta in schema "infra"
new AsyncKVStore("postgres://user:pass@localhost:5432/app", { tablePrefix: "kvs_", schema: "infra" });
// Pre-built adapter
new AsyncKVStore({ adapter: new PostgresAdapter("postgres://...", { tablePrefix: "kvs_" }) });
```

`settings` takes `tablePrefix`, `schema` (PostgreSQL only, created if missing), `durability` (SQLite only) and `queue` (as for `KVStore`). With a pre-built adapter, give the table options to the adapter.

**Connection string rules:**
- `postgres://...` or `postgresql://...` → `PostgresAdapter`
- anything else → `SQLiteAsyncAdapter`, which passes the string to Bun's `SQL`. Use `sqlite://...`, `file://...`, or `:memory:`. A plain filename such as `"kv.db"` is parsed by Bun as a PostgreSQL connection and fails to connect.

### Methods

All methods return `Promise<T>` (same signatures as `KVStore` but async):

```ts
await store.get(key);             // Promise<KvEntry | null>
await store.set(key, val, opts?); // Promise<KvCommitResult>
await store.delete(key);          // Promise<void>
await store.list(sel, opts?);     // Promise<KvListResult>
await store.increment(key, n?);   // Promise<number>
await store.enqueue(payload, opts?); // Promise<{ ok, id }>
await store.dequeue(topic?, n?, opts?); // Promise<QueueMessage[]>
await store.acknowledge(id, token);    // Promise<boolean>
await store.nack(id, token, opts?);    // Promise<boolean>
await store.extendLease(id, token, ms?); // Promise<boolean>
await store.listDead(topic?, opts?);   // Promise<QueueDeadMessage[]>
await store.retryDead(topic?, id?);    // Promise<number>
await store.deleteDead(topic?, id?);   // Promise<number>
await store.queueStats(topic?);        // Promise<QueueStats[]>
await store.cleanQueue();              // Promise<number>
await store.cleanExpired();       // Promise<number>
await store.reset();              // Promise<void>
await store.close();              // Promise<void>
await store.getAsync(key, fn, ttl?); // Promise<T> (already async)
```

`watch()`, `addQueueListener()`, `getWatchDiagnostics()` and `getQueueDiagnostics()` remain sync (in-process callbacks). On `AsyncKVStore` the initial watch snapshot is delivered asynchronously.

On SQLite, `AsyncKVStore` runs one statement at a time (Bun's SQLite client has a single connection), so an `atomic()` never picks up or rolls back another call's write. On PostgreSQL, `atomic()` locks the keys it checks and writes, so two concurrent commits against the same version cannot both succeed.

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

---

## Adapters

The `AsyncKVStore` uses an internal `SqlAdapter` interface. You can build custom adapters or use the built-in ones:

| Adapter | Class | Backend |
|---|---|---|
| SQLite | `SQLiteAsyncAdapter` | SQLite via `bun:sql` |
| PostgreSQL | `PostgresAdapter` | PostgreSQL via `bun:sql` |

```ts
import { PostgresAdapter } from "@coderbuzz/kvs";

const adapter = new PostgresAdapter("postgres://user:pass@localhost:5432/kvdb", { tablePrefix: "kvs_", schema: "infra" });
const store = new AsyncKVStore({ adapter });
```

`SQLiteAsyncAdapter(connection, { tablePrefix?, durability? })` and `PostgresAdapter(connection, { tablePrefix?, schema? })`. A custom adapter implements `SqlAdapter`, whose queue methods changed in 0.4 (see AI_KNOWLEDGE.md).

### SQL Dialect Differences

| Feature | SQLite | PostgreSQL |
|---|---|---|
| Key column | `BLOB` | `BYTEA` |
| Queue ID | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT` from a sequence (0.3 `SERIAL` migrated) |
| Entry version | `INTEGER` (64-bit) | `BIGINT` (0.3 `INTEGER` migrated) |
| Timestamp | `INTEGER` | `BIGINT` |
| `increment()` | read-modify-write in one transaction (JS arithmetic) | one upsert with `NUMERIC` arithmetic (exact decimals) |
| `atomic()` concurrency | transactions run one at a time | advisory lock per key, `FOR UPDATE` on checked rows |
| Concurrent dequeue | `MATERIALIZED` CTE picker (writers serialized) | `MATERIALIZED` CTE picker with `FOR UPDATE SKIP LOCKED` |
| Concurrent migration | `BEGIN IMMEDIATE` | transaction-scoped advisory lock |
| Partial indexes | `WHERE expires_at IS NOT NULL` | same |

---

## Types

```ts
import type {
  KvKey,           // KvKeyPart[]
  KvKeyPart,       // string | number | bigint | boolean | Uint8Array
  KvEntry,         // { key, value, version }
  KvWatchEvent,    // { sequence, initial, changedKeys, coalesced?, reset? }
  KvWatchDiagnostics,
  KvCommitResult,  // { ok: true, version }
  KvCommitError,   // { ok: false }
  KvCheck,         // { key, version }
  KvMutation,      // { type: "set"|"delete", key, value?, ttl? }
  KvListSelector,  // { prefix?, start?, end? }
  KvListOptions,   // { limit?, cursor?, reverse? }
  KvListResult,    // { entries, cursor }
  QueueMessage,    // { id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts, token, lockedUntil, lastError }
  QueueDeadMessage,// { id, topic, payload, …, lastError, failedAt }
  QueueOptions,    // { topic?, delay?, maxAttempts? }
  QueueStats,      // { topic, pending, delayed, processing, dead, done, oldestPendingAt }
  KvQueueConfig,   // { visibilityTimeout?, backoff?, doneRetention?, deadRetention? }
} from "@coderbuzz/kvs";
```

---

## Key Encoding

Keys are encoded to bytes with deterministic sort order:
```
Uint8Array < string < number < bigint < false < true
```

```ts
["a"] < ["b"]
["users", 1] < ["users", 2]
["items", true] > ["items", false]
```

### Encoding Utilities

Low-level functions for key serialization:

```ts
import { encodeKey, decodeKey, encodeKeyPrefix, prefixSuccessor } from "@coderbuzz/kvs";

// Round-trip: KvKey → bytes → KvKey
const encoded = encodeKey(["users", "alice"]);
const decoded = decodeKey(encoded); // ["users", "alice"]

// Low-level prefix scan for custom range queries
const prefix = encodeKeyPrefix(["events"]);
const upper = prefixSuccessor(prefix);
// Range: key >= prefix AND key < upper
```

---

## Singleflight

Exported standalone for deduplicating concurrent async work:

```ts
import { Singleflight } from "@coderbuzz/kvs";

const sf = new Singleflight<User>();
const user = await sf.do("user:42", () => fetchUser(42));
sf.clear();
```

---

## Server & Client

- **Server**: `@coderbuzz/kvs-server` wraps `KVStore` (sync) or `AsyncKVStore` (async) into HTTP REST + WebSocket server
  - `createServer(store, opts)` for sync `KVStore`
  - `createAsyncServer(store, opts)` for async `AsyncKVStore`
- **Client**: `@coderbuzz/kvs-client` is the TypeScript SDK for the server

---

## License

MIT &copy; 2026 Indra Gunawan
