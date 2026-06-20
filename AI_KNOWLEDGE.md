<!-- docs: sync from coderbuzz/codex@5f93304 -->

# KVS — AI Agent Knowledge File

**Package:** `@coderbuzz/kvs` v0.2.10
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
  ├── list                    — prefix/range queries (sync)
  ├── atomic()                — version-checked transactions (sync)
  ├── enqueue/dequeue/ack     — persistent queue (sync)
  ├── watch()                 — in-process callbacks
  ├── addQueueListener()      — push-based queue delivery
  ├── getAsync()              — cache-with-compute (singleflight, async)
  ├── cleanExpired() / reset()
  └── close()
```

### AsyncKVStore (async)
```
AsyncKVStore("sqlite://kv.db" | "postgres://...")
  ├── get/set/delete          — CRUD (async)
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
  encodeKey, decodeKey,
  type KvKey, type KvKeyPart, type KvEntry,
  type KvCommitResult, type KvCommitError,
  type KvCheck, type KvMutation,
  type KvListSelector, type KvListOptions, type KvListResult,
  type QueueMessage, type QueueOptions,
} from "@coderbuzz/kvs";
```

---

## Constructors

```ts
const store = new KVStore("kv.db");                 // sync, bun:sqlite, WAL
const asyncStore = new AsyncKVStore("sqlite://kv.db");  // async, bun:sql
const pgStore = new AsyncKVStore("postgres://user:pass@localhost:5432/kvdb");
```

Connection string auto-detects adapter. Can also pass `{ adapter: SqlAdapter }`.

---

## Key Methods

### KVStore (all sync except getAsync)
```
get(key) → KvEntry | null
set(key, value, { ttl? }) → { ok, version }
delete(key) → void
list(selector, options?) → { entries, cursor }
atomic() → AtomicOperation
enqueue(payload, options?) → { ok, id }
dequeue(topic?, limit?) → QueueMessage[]
acknowledge(id) → boolean
watch(keys, callback) → { cancel }
addQueueListener(topic, callback) → { cancel }
getAsync(key, fn, ttl?) → Promise<T>
cleanExpired() → number
reset() → void
close() → void
```

### AsyncKVStore (all async)
```
get(key) → Promise<KvEntry | null>
set(key, value, { ttl? }) → Promise<{ ok, version }>
delete(key) → Promise<void>
list(selector, options?) → Promise<{ entries, cursor }>
atomic() → AsyncAtomicOperation  (commit() is async)
enqueue(payload, options?) → Promise<{ ok, id }>
dequeue(topic?, limit?) → Promise<QueueMessage[]>
acknowledge(id) → Promise<boolean>
watch(keys, callback) → { cancel }  (sync)
addQueueListener(topic, callback) → { cancel }  (sync)
getAsync(key, fn, ttl?) → Promise<T>
cleanExpired() → Promise<number>
reset() → Promise<void>
close() → Promise<void>
```

---

## Key Encoding

```
KvKeyPart = string | number | bigint | boolean | Uint8Array
KvKey = KvKeyPart[]
Sort: Uint8Array < string < number < bigint < false < true
```

---

## Server & Client

- `@coderbuzz/kvs-server` — `createServer(store)` for sync, `createAsyncServer(store)` for async
- `@coderbuzz/kvs-client` — TypeScript SDK for the server

---

## Backend Config

### SQLite (KVStore)
- WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`
- TTL cleanup every 60 s
- Failed message requeue every 60 s (older than 30 s, up to maxAttempts)
- List max: 1000 per page

### SQLite (AsyncKVStore via bun:sql)
- Same performance, async API
- Same SQL features (RETURNING, ON CONFLICT, WAL)

### PostgreSQL (AsyncKVStore via bun:sql)
- Connection pooling (configurable via connection string)
- SKIP LOCKED for safe concurrent dequeue
- NUMERIC → FLOAT8 for increment operations
- BYTEA for binary key/value storage
