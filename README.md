<!-- docs: sync from coderbuzz/codex@e5210d1 -->

# KVS &mdash; `@coderbuzz/kvs`

> **Multi-backend key-value store for TypeScript.** Synchronous SQLite, asynchronous SQLite, and PostgreSQL. Atomic transactions, TTL expiry, persistent queue, real-time watch.
> AI agents: see [AI_KNOWLEDGE.md](https://github.com/coderbuzz/kvs/blob/main/AI_KNOWLEDGE.md) for expert context.
<p align="center">
  <a href="https://www.npmjs.com/package/@coderbuzz/kvs"><img src="https://img.shields.io/npm/v/@coderbuzz/kvs.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@coderbuzz/kvs"><img src="https://img.shields.io/npm/dm/@coderbuzz/kvs.svg?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/coderbuzz/kvs/blob/main/LICENSE"><img src="https://img.shields.io/github/license/coderbuzz/kvs.svg?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/coderbuzz/kvs"><img src="https://img.shields.io/github/stars/coderbuzz/kvs.svg?style=flat-square" alt="GitHub Stars" /></a>
  <a href="https://github.com/coderbuzz/codex/actions/workflows/ci.kvs.yml"><img src="https://github.com/coderbuzz/codex/actions/workflows/ci.kvs.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/coderbuzz/codex"><img src="https://codecov.io/gh/coderbuzz/codex/graph/badge.svg?flag=kvs" alt="Codecov" /></a>
</p>

KVS is an embeddable key-value store backed by **SQLite** (sync or async) or **PostgreSQL** (async). Use it directly in your code — no HTTP server required. Pair with `@coderbuzz/kvs-server` for HTTP/WS, or `@coderbuzz/kvs-client` for the client SDK.

---

## Why KVS?

| Need | KVS | Redis | Upstash |
|---|---|---|---|
| Infrastructure | SQLite file or PostgreSQL | Server required | Managed |
| Embeddable | Yes — just `new KVStore()` | No (separate process) | No |
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
| Sync SQLite | **205,747 ops/s** | **1,241,691 ops/s** | **2,140,495 ops/s** | **1,786,171 ops/s** | **162,501 ops/s** |
| Async SQLite | 65,001 ops/s | 140,799 ops/s | 155,489 ops/s | 270,737 ops/s | 43,183 ops/s |
| Async PostgreSQL | 1,621 ops/s | 9,206 ops/s | 8,491 ops/s | 10,495 ops/s | 1,621 ops/s |

KVS is powered by SQLite WAL mode — read performance is exceptional (1.24M hits, 2.14M misses per second), while writes are bounded by SQLite commit speed (~206K ops/s). All operations are **winner** benchmarks with no comparable competitor at this speed for an embeddable KV store.

Sync SQLite throughput is identical to `KVStore` benchmarks. Async SQLite adds ~2-4x overhead per operation due to `await` + `bun:sql` abstraction. PostgreSQL adds network round-trip overhead (~10-50x vs SQLite) but enables multi-process concurrency, horizontal scaling, and shared access.

---

## Features

- **Hierarchical keys** — `["users", "alice"]`, prefix/range queries, deterministic sort
- **Any JSON value** — strings, numbers, objects, arrays, null
- **Atomic transactions** — version checks + set/delete/enqueue in one commit
- **TTL expiry** — millisecond precision, background cleanup every 60 s
- **Built-in queue** — delayed delivery, retries, work-stealing listeners
- **Real-time watch** — subscribe to key changes (requires `@coderbuzz/kvs-server`)
- **getAsync** — cache-with-compute with singleflight deduplication
- **Multi-backend** — SQLite (sync), SQLite + PostgreSQL (async) via unified `AsyncKVStore`
- **Zero dependencies** — no external libs beyond bun:sqlite / bun:sql

---

## Installation

```sh
npm install @coderbuzz/kvs
```

**KVStore** requires Bun (for `bun:sqlite`). **AsyncKVStore** uses `bun:sql` (built-in, no extra deps) and works with SQLite or PostgreSQL.

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

### `new KVStore(path?: string)`

Creates or opens a SQLite database. Default path: `"kv.db"`.

Opens with WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`.

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

Every `set` increments `version` by 1.

### `delete(key: KvKey): void`

```ts
store.delete(["users", "alice"]);
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

**Defaults:** `limit: 100`, max `1000`, ascending. `cursor` is opaque base64.

**`KvListResult`:** `{ entries: KvEntry[], cursor: string | null }`

### `getAsync<T>(key: KvKey, fn: () => T | Promise<T>, ttl?: number): Promise<T>`

Cache-with-compute pattern with singleflight deduplication:

```ts
// 100 concurrent callers — fn() runs once, result cached for 30 s
const ad = await store.getAsync(["ads", "venue", 42], () => fetchNextAd(42), 30_000);
```

**Algorithm:**
1. Check SQLite — return immediately on cache hit
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
  console.log("Check failed — retry");
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

### `enqueue(payload: unknown, options?: QueueOptions): { ok: true, id: number }`

```ts
store.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
```

Defaults: `topic: "default"`, `delay: 0`, `maxAttempts: 3`.

### `dequeue(topic?: string, limit?: number): QueueMessage[]`

```ts
const messages = store.dequeue("emails", 10);
// Each message: { id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts }
```

Moves messages to `"processing"` status.

### `acknowledge(id: number): boolean`

```ts
store.acknowledge(message.id);
```

Marks message as `"done"`. Not acking within 30 s → auto-requeue (up to `maxAttempts`).

**Message lifecycle:**
```
pending → (dequeue) → processing → (acknowledge) → done
                               ↓ not acked within 30s
                            requeue → pending (up to maxAttempts)
```

### `watch(keys: KvKey[], callback: WatchCallback): { cancel: () => void }`

Subscribe to key changes. Fires immediately with current values:

```ts
const { cancel } = store.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries) => {
    // entries[0] = KvEntry | null for ["config", "theme"]
  },
);
cancel(); // stop watching
```

### `addQueueListener(topic: string, callback: (msg: QueueMessage) => void): { cancel: () => void }`

Register a push-based listener. Messages distributed round-robin (work-stealing):

```ts
const { cancel } = store.addQueueListener("emails", (msg) => {
  processEmail(msg.payload);
  store.acknowledge(msg.id);
});
cancel();
```

Dispatcher runs every 1 s, pushing to one listener per message.

### `cleanExpired(): number`

Manually trigger cleanup of expired entries. Returns number of deleted rows.

### `reset(): void`

Delete ALL data from kv + queue tables. Cancels all watchers.

### `close(): void`

Close database, stop cleanup/dispatch timers, cancel watchers/listeners.

---

## AsyncKVStore API

### `new AsyncKVStore(connection: string | { adapter: SqlAdapter })`

Creates an async KV store backed by SQLite or PostgreSQL. Adapter auto-detected from connection string:

```ts
// SQLite file
new AsyncKVStore("sqlite://kv.db");
// SQLite in-memory
new AsyncKVStore(":memory:");
// PostgreSQL
new AsyncKVStore("postgres://user:pass@localhost:5432/kvdb");
// Pre-built adapter
new AsyncKVStore({ adapter: new PostgresAdapter("postgres://...") });
```

**Connection string rules:**
- `sqlite://...`, `file://...`, `:memory:`, or plain filename → SQLite
- `postgres://...` or `postgresql://...` → PostgreSQL

### Methods

All methods return `Promise<T>` (same signatures as `KVStore` but async):

```ts
await store.get(key);             // Promise<KvEntry | null>
await store.set(key, val, opts?); // Promise<KvCommitResult>
await store.delete(key);          // Promise<void>
await store.list(sel, opts?);     // Promise<KvListResult>
await store.increment(key, n?);   // Promise<number>
await store.enqueue(payload, opts?); // Promise<{ ok, id }>
await store.dequeue(topic?, n?);  // Promise<QueueMessage[]>
await store.acknowledge(id);      // Promise<boolean>
await store.cleanExpired();       // Promise<number>
await store.reset();              // Promise<void>
await store.close();              // Promise<void>
await store.getAsync(key, fn, ttl?); // Promise<T> (already async)
```

`watch()` and `addQueueListener()` remain sync (in-process callbacks).

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

const adapter = new PostgresAdapter("postgres://user:pass@localhost:5432/kvdb");
const store = new AsyncKVStore({ adapter });
```

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

## Types

```ts
import type {
  KvKey,           // KvKeyPart[]
  KvKeyPart,       // string | number | bigint | boolean | Uint8Array
  KvEntry,         // { key, value, version }
  KvCommitResult,  // { ok: true, version }
  KvCommitError,   // { ok: false }
  KvCheck,         // { key, version }
  KvMutation,      // { type: "set"|"delete", key, value?, ttl? }
  KvListSelector,  // { prefix?, start?, end? }
  KvListOptions,   // { limit?, cursor?, reverse? }
  KvListResult,    // { entries, cursor }
  QueueMessage,    // { id, topic, payload, enqueuedAt, deliverAt, attempts, maxAttempts }
  QueueOptions,    // { topic?, delay?, maxAttempts? }
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
