<!-- docs: sync from coderbuzz/codex@8a99d5c -->

# KVS &mdash; `@coderbuzz/kvs`

> **Lightweight SQLite-backed key-value store for TypeScript.** Atomic transactions, TTL expiry, persistent queue, real-time watch. Embed directly in your app.
> AI agents: see [AI_KNOWLEDGE.md](https://github.com/coderbuzz/kvs/blob/main/AI_KNOWLEDGE.md) for expert context.

KVS is an embeddable key-value store powered by SQLite (WAL mode). Use it directly in your code — no HTTP server required. Pair with `@coderbuzz/kvs-server` for HTTP/WS, or `@coderbuzz/kvs-client` for the client SDK.

---

## Why KVS?

| Need | KVS | Redis | Upstash |
|---|---|---|---|
| Infrastructure | SQLite file | Server required | Managed |
| Embeddable | Yes — just `new KVStore()` | No (separate process) | No |
| Bundle size | ~30 KB | ~1 MB (ioredis) | N/A |
| Transactions | Version-based checks + atomic commit | MULTI/EXEC/WATCH | Conditional checks |
| Queue | Built-in with retries | Redis lists + pub/sub | Add-on |
| Watch | Push-based (via server) | Keyspace notifications | Polling |

---

## Benchmarks

Full results at **[github.com/coderbuzz/benchmarks](https://github.com/coderbuzz/benchmarks)**.

SQLite-backed KV store on Apple M-series, Bun runtime (direct throughput measurement):

| Operation | Ops/s |
|---|---|
| `set('k', 'v')` | **198,720 ops/s** |
| `get()` — cache hit | **1,156,635 ops/s** |
| `get()` — cache miss | **1,931,481 ops/s** |
| `delete()` | **1,689,546 ops/s** |
| `increment()` | **138,163 ops/s** |

KVS is powered by SQLite WAL mode — read performance is exceptional (1.2M hits, 1.9M misses per second), while writes are bounded by SQLite commit speed (~200K ops/s). All operations are **winner** benchmarks with no comparable competitor at this speed for an embeddable KV store.

---

## Features

- **Hierarchical keys** — `["users", "alice"]`, prefix/range queries, deterministic sort
- **Any JSON value** — strings, numbers, objects, arrays, null
- **Atomic transactions** — version checks + set/delete/enqueue in one commit
- **TTL expiry** — millisecond precision, background cleanup every 60 s
- **Built-in queue** — delayed delivery, retries, work-stealing listeners
- **Real-time watch** — subscribe to key changes (requires `@coderbuzz/kvs-server`)
- **getAsync** — cache-with-compute with singleflight deduplication
- **Zero dependencies** — no external libs beyond bun:sqlite

---

## Installation

```sh
npm install @coderbuzz/kvs
```

Requires **Bun** (for `bun:sqlite`).

---

## Quick Start

```ts
import { KVStore } from "@coderbuzz/kvs";

const store = new KVStore("kv.db");

// Basic CRUD
store.set(["users", "alice"], { name: "Alice", plan: "pro" });
const entry = store.get(["users", "alice"]);
console.log(entry?.value, entry?.version); // { name: "Alice", plan: "pro" }, 1

store.delete(["users", "alice"]);

// With TTL
store.set(["cache", "hot-key"], computedValue, { ttl: 60_000 });
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

- **Server**: `@coderbuzz/kvs-server` wraps `KVStore` into HTTP REST + WebSocket server
- **Client**: `@coderbuzz/kvs-client` is the TypeScript SDK for the server

---

## License

MIT &copy; 2026 Indra Gunawan
