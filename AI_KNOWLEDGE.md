<!-- docs: sync from coderbuzz/codex@54cd4a7 -->

# KVS — AI Agent Knowledge File

**Package:** `@coderbuzz/kvs` v0.2.4
**Purpose:** Lightweight SQLite-backed key-value store. Embeddable `KVStore` with atomic transactions, TTL, persistent queue, real-time watch, and push-based queue listeners.
**Distribution:** ESM only (`dist/index.js` + `dist/index.d.ts`).

---

## Mental Model

`KVStore` is the core engine. Create an instance, call methods synchronously (except `getAsync`).

```
KVStore("kv.db")
  ├── get/set/delete          — basic CRUD
  ├── list                    — prefix/range queries
  ├── atomic()                — version-checked transactions
  ├── enqueue/dequeue/ack     — persistent queue
  ├── watch()                 — real-time key subscriptions
  ├── addQueueListener()      — push-based queue delivery
  ├── getAsync()              — cache-with-compute (singleflight)
  ├── cleanExpired() / reset()
  └── close()
```

---

## Complete Import

```ts
import {
  KVStore,
  AtomicOperation,
  Singleflight,
  type WatchCallback,
  openDatabase,
  StmtCache,
  encodeKey,
  decodeKey,
  type KvKey,
  type KvKeyPart,
  type KvEntry,
  type KvCommitResult,
  type KvCommitError,
  type KvCheck,
  type KvMutation,
  type KvListSelector,
  type KvListOptions,
  type KvListResult,
  type QueueMessage,
  type QueueOptions,
} from "@coderbuzz/kvs";
```

---

## KVStore Constructor

```ts
const store = new KVStore("kv.db"); // bun:sqlite, WAL mode, 64MB cache
```

---

## Key Methods (all sync except getAsync)

### get(key) → KvEntry | null
### set(key, value, { ttl? }) → { ok, version }
### delete(key) → void
### list(selector, options?) → { entries, cursor }
### atomic() → AtomicOperation (fluent builder)
### enqueue(payload, options?) → { ok, id }
### dequeue(topic?, limit?) → QueueMessage[]
### acknowledge(id) → boolean
### watch(keys, callback) → { cancel }
### addQueueListener(topic, callback) → { cancel }
### getAsync(key, fn, ttl?) → Promise<T>
### cleanExpired() → number (rows deleted)
### reset() → void
### close() → void

---

## Key Encoding

```
KvKeyPart = string | number | bigint | boolean | Uint8Array
KvKey = KvKeyPart[]
Sort: Uint8Array < string < number < bigint < false < true
```

---

## Server & Client

- `@coderbuzz/kvs-server` — wraps KVStore into HTTP/WS server
- `@coderbuzz/kvs-client` — TypeScript SDK for the server

---

## SQLite Config

- WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`
- TTL cleanup every 60 s
- Failed message requeue every 60 s (older than 30 s, up to maxAttempts)
- List max: 1000 per page
