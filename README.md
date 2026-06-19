<!-- docs: sync from coderbuzz/codex@4dfdb6b -->

# KVS &mdash; `@coderbuzz/kvs`

> **Lightweight SQLite-backed key-value store.** Atomic transactions, TTL expiry, persistent queue, real-time watch. Embed directly in your app or pair with `@coderbuzz/kvs-rest` for an HTTP server.
> AI agents: see [AI_KNOWLEDGE.md](https://github.com/coderbuzz/kvs/blob/main/AI_KNOWLEDGE.md) for expert context.

KVS is a lightweight, embeddable key-value store powered by SQLite (WAL mode). Use it directly in your code, or wrap it with `@coderbuzz/kvs-rest` for a full HTTP/WebSocket server. The `KvsClient` SDK talks to the server over REST and WebSocket RPC.

---

## Why KVS Over Redis, Upstash, or WorkOS KV?

| Pain Point | Redis | Upstash | WorkOS KV | **KVS** |
|---|---|---|---|---|
| Infrastructure | Requires Redis server, memory-heavy | Serverless (3s cold start on free) | Managed (vendor lock-in) | **Self-hosted** — single binary, SQLite file |
| Data persistence | RDB/AOF (configurable) | Managed | Managed | **SQLite WAL** — ACID, crash-safe, ~300 KB overhead |
| Cost | Server cost + ops overhead | Pay-per-request (costly at scale) | Pay-per-use | **Zero ongoing cost** — runs anywhere |
| Key hierarchy | Flat with `:` convention | Flat with `:` convention | Namespace-prefixed | **Native hierarchical** — `["users", "alice", "profile"]` |
| Queue | Redis lists + pub/sub | Queue add-on | Not built-in | **Built-in** — delayed delivery, retries, work-stealing |
| Real-time watch | Keyspace notifications | Polling | Polling | **WebSocket push** — subscribe to key changes instantly |
| Atomic transactions | MULTI/EXEC with WATCH | Conditional checks | Version-based | **Version-based check + atomic commit** — set, delete, enqueue in one |
| SDK | `ioredis` (~1 MB) | REST-based SDK | REST-based SDK | **Tiny** — <20 KB, pure `fetch`, works everywhere |

KVS was designed for developers who want Redis-like capabilities without the Redis tax — deploy it on a $5 VPS, a Fly.io machine, or right next to your app.

---

## Features

- **Hierarchical keys** — `["users", "alice"]`, prefix and range queries, deterministic sort order across all key types
- **Any JSON value** — store strings, numbers, objects, arrays, `null`
- **Atomic transactions** — conditional multi-key writes with version checks, mix set/delete/enqueue in one transaction
- **TTL expiry** — automatic record expiry with millisecond precision, background cleanup
- **Built-in queue** — delayed delivery, per-message retry limits, automatic requeue of failed messages
- **Real-time watch** — subscribe to key changes over WebSocket; fires immediately with current values
- **Push-based listen** — register a WebSocket listener for a queue topic; round-robin distribution (work-stealing)
- **`getAsync` cache pattern** — get-or-compute with singleflight deduplication and atomic set-if-not-exists
- **Dual transport** — starts as REST (fetch), upgrades to WebSocket RPC with `open()` for lower latency
- **Bearer-token auth** — all endpoints protected by a configurable access token
- **TypeScript client SDK** — type-safe, works in Bun, Deno, Node.js 18+, browsers, and Cloudflare Workers
- **Singleflight** — exported standalone for deduplicating any concurrent async work

---

## Installation

```sh
# npm
npm install @coderbuzz/kvs

# Bun
bun add @coderbuzz/kvs

# Deno
import { KvsClient } from "npm:@coderbuzz/kvs";
```

---

## Running as a Server

KVS is a library — embed it directly. For a standalone HTTP/WebSocket server, use `@coderbuzz/kvs-rest`:

```sh
npm install @coderbuzz/kvs @coderbuzz/kvs-rest
```

```ts
import { KVStore } from "@coderbuzz/kvs";
import { createServer } from "@coderbuzz/kvs-rest";

const store = new KVStore("kv.db");
const server = createServer(store, { port: 3000, accessToken: "your-secret" });
await server.run();
```

See [@coderbuzz/kvs-rest documentation](https://github.com/coderbuzz/kvs-rest) for details.

---

## TypeScript Types

```ts
import type {
  KvCheck, KvCommitError, KvCommitResult, KvEntry,
  KvKey, KvKeyPart, KvListOptions, KvListResult, KvListSelector,
  KvMutation, KvsClientOptions, QueueMessage, QueueOptions,
} from "@coderbuzz/kvs";
```

### Key Types

```ts
type KvKeyPart = string | number | bigint | boolean | Uint8Array;
type KvKey = KvKeyPart[];
```

Keys are encoded to bytes with a deterministic sort order:
`Uint8Array < string < number < bigint < false < true`

Numeric values use IEEE 754 double encoding with flipped bits so positive numbers sort in natural order:

```ts
["a"] < ["b"]
["users", 1] < ["users", 2]
["items", true] > ["items", false]
```

---

## Client SDK

All methods are async and transport-agnostic. After calling `open()` they automatically switch to WebSocket RPC for lower latency.

### Setup

```ts
const kv = new KvsClient({
  url: "http://localhost:3000",
  token: "your-access-token",
});
```

### Get / Set / Delete

```ts
// Set with optional TTL
const result = await kv.set(["users", "alice"], { name: "Alice", plan: "pro" });
// { ok: true, version: 1 }

// Set with TTL
await kv.set(["cache", "hot-key"], computedValue, { ttl: 60_000 });

// Get — returns null if missing or expired
const entry = await kv.get(["users", "alice"]);
console.log(entry?.value, entry?.version); // { name: "Alice", plan: "pro" }, 1

// Delete
await kv.delete(["users", "alice"]);
```

### getAsync — Cache-with-Compute (Singleflight)

Built-in protection against thundering herds:

```ts
// 50 concurrent requests — fn() runs once, cached for 30 s
const user = await kv.getAsync(["users", userId], () => db.findUser(userId), 30_000);

// Without TTL — persists until deleted
const config = await kv.getAsync(["config", "feature-flags"], () => fetchFlagsFromRemote());
```

### List

```ts
// Prefix query
const result = await kv.list({ prefix: ["users"] });

// Paginated
const page1 = await kv.list({ prefix: ["logs"] }, { limit: 20 });
if (page1.cursor) {
  const page2 = await kv.list({ prefix: ["logs"] }, { limit: 20, cursor: page1.cursor });
}

// Reverse order
const latest = await kv.list({ prefix: ["logs"] }, { limit: 5, reverse: true });

// Range query
const range = await kv.list({ start: ["events", 1000], end: ["events", 2000] }, { limit: 100 });
```

### Atomic Operations

Version-checked transactions — all or nothing:

```ts
// Optimistic counter
const entry = await kv.get(["counters", "visits"]);
const result = await kv
  .atomic()
  .check({ key: ["counters", "visits"], version: entry?.version ?? null })
  .set(["counters", "visits"], (entry?.value as number ?? 0) + 1)
  .commit();

if (result.ok) {
  console.log("Updated to version", result.version);
} else {
  console.log("Conflict — retry");
}

// Set-if-not-exists (distributed lock)
const r = await kv
  .atomic()
  .check({ key: ["locks", "job-1"], version: null })
  .set(["locks", "job-1"], { owner: workerId }, { ttl: 30_000 })
  .commit();

// Mix set + delete + enqueue in one transaction
await kv
  .atomic()
  .set(["orders", orderId], { status: "processing" })
  .enqueue({ orderId, action: "fulfill" }, { topic: "fulfillment" })
  .commit();
```

**AtomicBuilder methods:**

| Method | Description |
|---|---|
| `.check(…checks: KvCheck[]): this` | Assert key versions before applying |
| `.set(key, value, options?): this` | Set a key; options: `{ ttl?: number }` |
| `.delete(key): this` | Delete a key |
| `.enqueue(payload, options?): this` | Enqueue a message as part of the commit |
| `.commit(): Promise<KvCommitResult \| KvCommitError>` | Execute |

### Queue

```ts
// Enqueue with delay and retry limit
const result = await kv.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);

// Dequeue and process
const messages = await kv.dequeue("emails", 10);
for (const msg of messages) {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id);
  } catch {
    // Not acknowledging → automatically requeued after 30 s
  }
}
```

**Message lifecycle:**
```
enqueue → pending → dequeue → processing → acknowledge → done
                                         ↓ (if not acked within 30s)
                                      requeue → pending (up to maxAttempts)
```

### Health Check

```ts
const health = await kv.health();
console.log(health.ok, health.uptime); // true, 123.45
```

### Reset (Testing)

```ts
await kv.reset(); // Deletes ALL data — use only in tests
```

---

## WebSocket Transport

Calling `open()` establishes a WebSocket connection and automatically switches all subsequent calls to JSON-RPC for lower latency. WebSocket is also required for **Watch** and **Listen** features.

```ts
await kv.open();
const entry = await kv.get(["users", "alice"]); // now over WebSocket
kv.close();
```

### Authentication

Two modes:
1. **Post-connection message** (default) — sends an `auth` message with the token
2. **Query param** — `ws://localhost:3000/ws?token=your-secret`

### Watch

Subscribe to key changes — fires immediately with current values:

```ts
await kv.open();

const { cancel } = kv.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries) => {
    const theme = entries[0]?.value as string | undefined;
    const lang = entries[1]?.value as string | undefined;
    applySettings({ theme, lang });
  },
);

// Stop watching
cancel();
```

### Listen (Push-Based Queue)

Messages are distributed round-robin across all active listeners:

```ts
await kv.open();

const { cancel } = kv.listen("emails", async (msg) => {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id);
  } catch (err) {
    console.error("Failed:", err);
  }
});

// Scale out: multiple processes listen() on the same topic
// Server distributes messages across all connected listeners

cancel();
```

**Listen vs. Poll:**

| Feature | `listen()` (push) | `dequeue()` (poll) |
|---|---|---|
| Transport | WebSocket required | REST or WebSocket |
| Delivery | Push when available | Manual poll |
| Distribution | Round-robin work-stealing | Caller controls |
| Acknowledging | Must call `acknowledge()` | Must call `acknowledge()` |

---

## Singleflight

Exported standalone for deduplicating concurrent async work:

```ts
const sf = new Singleflight<User>();
const user = await sf.do("user:42", () => fetchUser(42));
sf.clear(); // cancel all in-flight state
```

---

## Common Patterns

### Counter with Optimistic Locking

```ts
async function increment(key: KvKey): Promise<number> {
  while (true) {
    const entry = await kv.get(key);
    const current = (entry?.value as number) ?? 0;
    const result = await kv
      .atomic()
      .check({ key, version: entry?.version ?? null })
      .set(key, current + 1)
      .commit();
    if (result.ok) return current + 1;
  }
}
```

### Distributed Lock with TTL

```ts
async function acquireLock(name: string, ttl: number): Promise<boolean> {
  const result = await kv
    .atomic()
    .check({ key: ["locks", name], version: null })
    .set(["locks", name], { acquiredAt: Date.now() }, { ttl })
    .commit();
  return result.ok;
}
```

### Paginate All Entries

```ts
async function* listAll(prefix: KvKey) {
  let cursor: string | null = null;
  do {
    const page = await kv.list({ prefix }, { limit: 100, cursor: cursor ?? undefined });
    yield* page.entries;
    cursor = page.cursor;
  } while (cursor);
}
```

### Real-Time Config Sync

```ts
await kv.open();
kv.watch([["config", "rateLimit"], ["config", "featureFlags"]], (entries) => {
  const rateLimit = entries[0]?.value as number ?? 100;
  const featureFlags = entries[1]?.value as Record<string, boolean> ?? {};
  updateAppConfig({ rateLimit, featureFlags });
});
```

### Background Worker with Push Delivery

```ts
// Worker process
await kv.open();
kv.listen("jobs", async (msg) => {
  await processJob(msg.payload);
  await kv.acknowledge(msg.id);
});

// Producer
await kv.enqueue({ type: "resize-image", data: { url, width: 800 } }, {
  topic: "jobs", maxAttempts: 3,
});
```

---

## HTTP API & WebSocket

The HTTP API and WebSocket protocol are provided by `@coderbuzz/kvs-rest`. See its [documentation](https://github.com/coderbuzz/kvs-rest) for the full API reference.

`KvsClient` communicates with the server over REST and WebSocket RPC.

---

## License

MIT © 2026 Indra Gunawan
