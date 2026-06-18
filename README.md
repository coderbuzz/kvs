<!-- docs: sync from coderbuzz/codex@76ca592 -->

# KVS &mdash; `@coderbuzz/kvs`

Lightweight SQLite-backed key-value server with a built-in TypeScript client
SDK. KVS is designed for serverless and edge workloads that need a simple,
self-hosted KV service with atomic transactions, hierarchical keys, TTL expiry,
persistent queue, real-time watch, and push-based queue listeners — all over a
secure HTTP API and optional WebSocket transport.

## Features

- **Hierarchical keys** — `["users", "alice"]`, prefix and range queries,
  deterministic sort order across all key types
- **Any JSON value** — store strings, numbers, objects, arrays, `null`
- **Atomic transactions** — conditional multi-key writes with version checks,
  mix set/delete/enqueue in one transaction
- **TTL expiry** — automatic record expiry with millisecond precision,
  background cleanup every 60 s
- **Built-in queue** — delayed delivery, per-message retry limits, automatic
  requeue of failed messages
- **Real-time watch** — subscribe to key changes over WebSocket; fires
  immediately with current values
- **Push-based listen** — register a WebSocket listener for a queue topic;
  messages are distributed round-robin (work-stealing)
- **`getAsync` cache pattern** — get-or-compute with singleflight deduplication
  and atomic set-if-not-exists for cross-process safety
- **Dual transport** — starts as REST (fetch), upgrades to WebSocket RPC with
  `open()` for lower latency
- **Bearer-token auth** — all endpoints protected by a configurable access token
- **TypeScript client SDK** — type-safe, works in Bun, Deno, Node.js 18+,
  browsers, and Cloudflare Workers

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

## Self-Hosting the KVS Server

KVS is a standalone HTTP server that you run alongside your application. It
stores all data in a local SQLite file (WAL mode, 64 MB cache, 256 MB mmap) and
exposes a REST API plus a WebSocket endpoint.

### Requirements

- **Bun** (recommended) or Node.js 18+
- An `ACCESS_TOKEN` environment variable to protect the API

### Running with Bun

```sh
ACCESS_TOKEN=your-secret bun run node_modules/@coderbuzz/kvs/dist/index.js
```

Or add it as a script in your `package.json`:

```json
{
  "scripts": {
    "kvs": "ACCESS_TOKEN=your-secret bun run node_modules/@coderbuzz/kvs/dist/index.js"
  }
}
```

### Environment Variables

| Variable       | Default  | Description                                      |
| -------------- | -------- | ------------------------------------------------ |
| `ACCESS_TOKEN` | required | Bearer token required for all KV/queue endpoints |
| `PORT`         | `3000`   | Port the server listens on                       |
| `KV_DB_PATH`   | `kv.db`  | Path to the SQLite database file                 |

---

## TypeScript Types

```ts
import type {
  KvCheck,
  KvCommitError,
  KvCommitResult,
  KvEntry,
  KvKey,
  KvKeyPart,
  KvListOptions,
  KvListResult,
  KvListSelector,
  KvMutation,
  KvsClientOptions,
  QueueMessage,
  QueueOptions,
} from "@coderbuzz/kvs";
```

### Key Types

```ts
/** A key part: string, number, bigint, boolean, or Uint8Array */
type KvKeyPart = string | number | bigint | boolean | Uint8Array;

/** Hierarchical key — an ordered array of parts */
type KvKey = KvKeyPart[];
```

Keys are encoded to bytes with a deterministic sort order:

```
Uint8Array < string < number < bigint < false < true
```

Numeric values use IEEE 754 double encoding with flipped bits so that positive
numbers sort in natural order. This means:

```ts
["a"] < ["b"]["users", 1] <
    ["users", 2]["items", true] > ["items", false];
```

### Entry & Commit Types

```ts
interface KvEntry {
  key: KvKey;
  value: unknown; // any JSON-serializable value
  version: number; // increments on every set
}

interface KvCommitResult {
  ok: true;
  version: number;
}
interface KvCommitError {
  ok: false;
}

interface KvCheck {
  key: KvKey;
  version: number | null; // null = key must not exist
}
```

### List Types

```ts
interface KvListSelector {
  prefix?: KvKey; // all keys that start with this prefix
  start?: KvKey; // inclusive lower bound (alternative to prefix)
  end?: KvKey; // exclusive upper bound (alternative to prefix)
}

interface KvListOptions {
  limit?: number; // default: 100, max: 1000
  cursor?: string; // opaque pagination token from previous result
  reverse?: boolean; // default: false
}

interface KvListResult {
  entries: KvEntry[];
  cursor: string | null; // null when no more pages
}
```

### Queue Types

```ts
interface QueueMessage {
  id: number;
  topic: string;
  payload: unknown;
  enqueuedAt: number; // ms since epoch
  deliverAt: number; // ms since epoch
  attempts: number; // how many times dequeued so far
  maxAttempts: number;
}

interface QueueOptions {
  topic?: string; // default: "default"
  delay?: number; // ms before delivery, default: 0
  maxAttempts?: number; // default: 3
}
```

---

## Client SDK

The package includes a TypeScript client SDK that wraps all KVS HTTP endpoints
using `fetch`. All methods are async and transport-agnostic — after calling
`open()` they automatically switch to WebSocket RPC for lower latency.

### Setup

```ts
import { KvsClient } from "@coderbuzz/kvs";

const kv = new KvsClient({
  url: "http://localhost:3000",
  token: "your-access-token",
});
```

---

### Get / Set / Delete

```ts
// Set a value (with optional TTL in ms)
const result = await kv.set(["users", "alice"], { name: "Alice", plan: "pro" });
// result: { ok: true, version: 1 }

// Set with TTL — auto-expires after 60 seconds
await kv.set(["cache", "hot-key"], computedValue, { ttl: 60_000 });

// Get a value — returns null if missing or expired
const entry = await kv.get(["users", "alice"]);
console.log(entry?.value); // { name: "Alice", plan: "pro" }
console.log(entry?.version); // 1

// Delete a key — no-op if missing
await kv.delete(["users", "alice"]);
```

---

### getAsync — Cache-with-Compute

`getAsync` is a cache-miss pattern with built-in protection against thundering
herds and concurrent duplicate work:

1. Checks the remote cache
2. On miss: deduplicates concurrent calls within the same process (singleflight)
3. Calls your `fn()` producer exactly once
4. Stores the result atomically (set-if-not-exists) — another process that won
   the race will have its value returned instead

```ts
// 50 concurrent requests hit this — fn() runs once, result is cached for 30 s
const user = await kv.getAsync(
  ["users", userId],
  () => db.findUser(userId),
  30_000,
);

// Without TTL — persists until explicitly deleted
const config = await kv.getAsync(
  ["config", "feature-flags"],
  () => fetchFlagsFromRemote(),
);
```

---

### List

```ts
// List by prefix
const result = await kv.list({ prefix: ["users"] });
for (const entry of result.entries) {
  console.log(entry.key, entry.value);
}

// With limit — result.cursor is set when more pages exist
const page1 = await kv.list({ prefix: ["logs"] }, { limit: 20 });
if (page1.cursor) {
  const page2 = await kv.list(
    { prefix: ["logs"] },
    { limit: 20, cursor: page1.cursor },
  );
}

// Reverse order (latest first)
const latest = await kv.list({ prefix: ["logs"] }, { limit: 5, reverse: true });

// Range query — start inclusive, end exclusive
const range = await kv.list(
  { start: ["events", 1000], end: ["events", 2000] },
  { limit: 100 },
);
```

---

### Atomic Operations

Transactions with version checks guarantee safe concurrent writes. All mutations
apply in one SQLite transaction — either all succeed or none do.

```ts
// Simple multi-key write
const result = await kv
  .atomic()
  .set(["counters", "visits"], 1)
  .set(["counters", "unique"], 1)
  .commit();

// Conditional update (optimistic concurrency)
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

// Set-if-not-exists (version: null)
const r = await kv
  .atomic()
  .check({ key: ["locks", "job-1"], version: null })
  .set(["locks", "job-1"], { owner: workerId }, { ttl: 30_000 })
  .commit();

// Mix set + delete in one transaction
await kv
  .atomic()
  .delete(["sessions", oldSessionId])
  .set(["sessions", newSessionId], sessionData, { ttl: 86_400_000 })
  .commit();

// Atomically enqueue + update state
await kv
  .atomic()
  .set(["orders", orderId], { status: "processing" })
  .enqueue({ orderId, action: "fulfill" }, { topic: "fulfillment" })
  .commit();
```

**`AtomicBuilder` methods:**

| Method                                                | Description                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `.check(…checks: KvCheck[]): this`                    | Assert key versions before applying                         |
| `.set(key, value, options?): this`                    | Set a key; options: `{ ttl?: number }`                      |
| `.delete(key): this`                                  | Delete a key                                                |
| `.enqueue(payload, options?): this`                   | Enqueue a message as part of the commit                     |
| `.commit(): Promise<KvCommitResult \| KvCommitError>` | Execute; returns `{ ok: true, version }` or `{ ok: false }` |

---

### Queue

```ts
// Enqueue — with optional delay and retry limit
const result = await kv.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
console.log(result.id); // message id

// Dequeue — pulls and locks messages for processing
const messages = await kv.dequeue("emails", 10);
for (const msg of messages) {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id); // marks as done
  } catch {
    // Not acknowledging → message is automatically requeued after 30 s
    // up to msg.maxAttempts total attempts
  }
}

// Default topic ("default" when topic is omitted)
await kv.enqueue({ task: "cleanup" });
const msgs = await kv.dequeue("default");
```

**Queue message lifecycle:**

```
enqueue → pending → dequeue → processing → acknowledge → done
                                         ↓ (if not acked within 30s)
                                      requeue → pending (up to maxAttempts)
```

---

### Health Check

```ts
const health = await kv.health(); // no auth required
console.log(health.ok); // true
console.log(health.uptime); // server uptime in seconds
```

---

### Reset (Testing)

```ts
// Deletes ALL kv and queue data — use only in tests
await kv.reset();
```

---

## WebSocket Transport

By default, `KvsClient` uses REST (fetch) for all operations. Calling `open()`
establishes a WebSocket connection to the server and automatically switches all
subsequent calls to WebSocket JSON-RPC for lower latency. The same methods
(`get`, `set`, `list`, `atomic`, `enqueue`, `dequeue`, `acknowledge`) work
transparently over both transports.

WebSocket is also required for **Watch** and **Listen** features.

```ts
// Establish WS connection
await kv.open();

// All KV/queue methods now route over WebSocket automatically
const entry = await kv.get(["users", "alice"]);

// Disconnect
kv.close();
```

### WebSocket Authentication

Two modes:

1. **Post-connection message** (default) — `open()` sends an `auth` message with
   the token after the connection is established.
2. **Query param** — pass the token in the URL:
   `ws://localhost:3000/ws?token=your-secret` (for environments where headers
   aren't available during the upgrade).

---

### Watch

Watch one or more keys for changes. Requires `open()` first. The callback fires
immediately with the current values, then again on every change.

```ts
await kv.open();

const { cancel } = kv.watch(
  [["config", "theme"], ["config", "lang"]],
  (entries) => {
    // entries[0] = current value of ["config", "theme"], or null if missing
    // entries[1] = current value of ["config", "lang"], or null if missing
    const theme = entries[0]?.value as string | undefined;
    const lang = entries[1]?.value as string | undefined;
    applySettings({ theme, lang });
  },
);

// Later — stop watching
cancel();
```

**Watch behavior:**

- Fires immediately with current values (including `null` for missing keys)
- Fires on `set`, `delete`, and `atomic` mutations
- Only one watch subscription per client connection; calling `watch` again
  replaces the previous one
- Callback receives an array aligned with the `keys` input array

---

### Listen (Push-Based Queue)

Register a push listener for a queue topic. Requires `open()` first. Messages
are distributed round-robin across all active listeners (work-stealing) — each
message goes to exactly one listener.

```ts
await kv.open();

const { cancel } = kv.listen("emails", async (msg) => {
  try {
    await sendEmail(msg.payload);
    await kv.acknowledge(msg.id);
  } catch (err) {
    // Don't acknowledge — will be requeued after 30 s
    console.error("Failed:", err);
  }
});

// Scale out: multiple processes each call listen() on the same topic
// The server distributes messages across all connected listeners

// Stop listening
cancel();
```

**Listen vs. poll (dequeue):**

| Feature       | `listen()` (push)         | `dequeue()` (poll)        |
| ------------- | ------------------------- | ------------------------- |
| Transport     | WebSocket required        | REST or WebSocket         |
| Delivery      | Push when available       | Manual poll               |
| Distribution  | Round-robin work-stealing | Caller controls           |
| Acknowledging | Must call `acknowledge()` | Must call `acknowledge()` |

---

## Singleflight

`Singleflight` is also exported and can be used independently to deduplicate any
concurrent async work within a single process:

```ts
import { Singleflight } from "@coderbuzz/kvs";

const sf = new Singleflight<User>();

// 100 concurrent requests for user 42 — fetchUser runs once
const user = await sf.do("user:42", () => fetchUser(42));

console.log(sf.size); // 0 (no in-flight calls)
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
    // Conflict → retry
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
    const page = await kv.list({ prefix }, {
      limit: 100,
      cursor: cursor ?? undefined,
    });
    yield* page.entries;
    cursor = page.cursor;
  } while (cursor);
}

for await (const entry of listAll(["users"])) {
  console.log(entry.key, entry.value);
}
```

### Transactional Enqueue + State Update

```ts
// Atomically mark order as processing and enqueue fulfillment job
// If either step fails, neither is applied
const result = await kv
  .atomic()
  .check({ key: ["orders", orderId], version: currentVersion })
  .set(["orders", orderId], { ...order, status: "processing" })
  .enqueue({ orderId, type: "fulfill" }, {
    topic: "fulfillment",
    maxAttempts: 5,
  })
  .commit();
```

### Real-Time Config Sync

```ts
await kv.open();

// Watch multiple config keys — apply whenever any changes
kv.watch([["config", "rateLimit"], ["config", "featureFlags"]], (entries) => {
  const rateLimit = entries[0]?.value as number ?? 100;
  const featureFlags = entries[1]?.value as Record<string, boolean> ?? {};
  updateAppConfig({ rateLimit, featureFlags });
});
```

### Background Worker with Push Delivery

```ts
// Worker process — receives jobs as soon as they are enqueued
await kv.open();

kv.listen("jobs", async (msg) => {
  const job = msg.payload as { type: string; data: unknown };
  await processJob(job);
  await kv.acknowledge(msg.id);
});

// Producer (separate process / HTTP handler)
await kv.enqueue({ type: "resize-image", data: { url, width: 800 } }, {
  topic: "jobs",
  maxAttempts: 3,
});
```

### getAsync for Expensive Computed Values

```ts
// Multiple concurrent requests for the same venue's ad — compute once
app.get("/ads/:venueId", async (ctx) => {
  const ad = await kv.getAsync(
    ["ads", ctx.params.venueId],
    () => fetchBestAd(ctx.params.venueId),
    30_000, // cache for 30 s
  );
  return Response.json(ad);
});
```

---

## HTTP API Reference

All endpoints except `/health` require:

```http
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

### Health

```sh
GET /health
```

```sh
curl http://localhost:3000/health
# → { "ok": true, "uptime": 123.45 }
```

---

### KV Endpoints

All KV endpoints use `POST` with a JSON body.

#### Set

```sh
POST /kv/set
```

| Field   | Type                | Description            |
| ------- | ------------------- | ---------------------- |
| `key`   | `array`             | Hierarchical key parts |
| `value` | `any`               | Any JSON value         |
| `ttl`   | `number` (optional) | Expiry in milliseconds |

```sh
curl -X POST http://localhost:3000/kv/set \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{"key":["users","alice"],"value":{"name":"Alice"},"ttl":60000}'
# → { "ok": true, "version": 1 }
```

#### Get

```sh
POST /kv/get
```

| Field | Type    | Description      |
| ----- | ------- | ---------------- |
| `key` | `array` | Hierarchical key |

```sh
curl -X POST http://localhost:3000/kv/get \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{"key":["users","alice"]}'
# → { "entry": { "key": ["users","alice"], "value": {...}, "version": 1 } }
# → { "entry": null }   (if missing or expired)
```

#### Delete

```sh
POST /kv/delete
```

```sh
curl -X POST http://localhost:3000/kv/delete \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{"key":["users","alice"]}'
# → { "ok": true }
```

#### List

```sh
POST /kv/list
```

| Field     | Type                 | Description                            |
| --------- | -------------------- | -------------------------------------- |
| `prefix`  | `array` (optional)   | List all keys under this prefix        |
| `start`   | `array` (optional)   | Inclusive lower bound (use with `end`) |
| `end`     | `array` (optional)   | Exclusive upper bound                  |
| `limit`   | `number` (optional)  | Max results, default 100, max 1000     |
| `cursor`  | `string` (optional)  | Pagination cursor from previous result |
| `reverse` | `boolean` (optional) | Return in descending order             |

```sh
curl -X POST http://localhost:3000/kv/list \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{"prefix":["users"],"limit":10}'
# → { "entries": [...], "cursor": "base64..." }
# → { "entries": [...], "cursor": null }  (last page)
```

#### Atomic

```sh
POST /kv/atomic
```

| Field       | Type               | Description                                    |
| ----------- | ------------------ | ---------------------------------------------- |
| `checks`    | `array` (optional) | Version assertions: `{ key, version }` pairs   |
| `mutations` | `array` (optional) | `{ type: "set"\|"delete", key, value?, ttl? }` |
| `enqueues`  | `array` (optional) | `{ payload, options? }` queue entries          |

```sh
curl -X POST http://localhost:3000/kv/atomic \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{
    "checks": [{ "key": ["users","alice"], "version": 1 }],
    "mutations": [
      { "type": "set", "key": ["users","alice"], "value": { "name": "Alice Updated" } },
      { "type": "set", "key": ["audit","log"], "value": { "action": "update" }, "ttl": 86400000 }
    ],
    "enqueues": [
      { "payload": { "userId": "alice" }, "options": { "topic": "notifications" } }
    ]
  }'
# → { "ok": true, "version": 2 }
# → { "ok": false }   (check failed)
```

---

### Queue Endpoints

#### Enqueue

```sh
POST /queue/enqueue
```

| Field         | Type                | Description                      |
| ------------- | ------------------- | -------------------------------- |
| `payload`     | `any`               | Job data                         |
| `topic`       | `string` (optional) | Default: `"default"`             |
| `delay`       | `number` (optional) | Delivery delay in ms, default: 0 |
| `maxAttempts` | `number` (optional) | Max retry attempts, default: 3   |

```sh
curl -X POST http://localhost:3000/queue/enqueue \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{"topic":"emails","payload":{"to":"user@example.com"},"delay":5000,"maxAttempts":3}'
# → { "ok": true, "id": 42 }
```

#### Dequeue

```sh
POST /queue/dequeue
```

| Field   | Type                | Description                         |
| ------- | ------------------- | ----------------------------------- |
| `topic` | `string` (optional) | Default: `"default"`                |
| `limit` | `number` (optional) | Max messages to dequeue, default: 1 |

```sh
curl -X POST http://localhost:3000/queue/dequeue \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{"topic":"emails","limit":10}'
# → { "messages": [{ "id": 42, "topic": "emails", "payload": {...}, ... }] }
```

Dequeued messages are set to `processing` status. They must be acknowledged
within 30 seconds or they are automatically requeued.

#### Acknowledge

```sh
POST /queue/ack
```

| Field | Type     | Description                      |
| ----- | -------- | -------------------------------- |
| `id`  | `number` | Message ID from dequeue response |

```sh
curl -X POST http://localhost:3000/queue/ack \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer your-secret' \
  -d '{"id":42}'
# → { "ok": true }
```

---

### WebSocket Endpoint

```
ws://localhost:3000/ws
```

Or with token in URL: `ws://localhost:3000/ws?token=your-secret`

All RPC messages use the JSON format:

```json
// Request
{ "id": 1, "method": "/kv/get", "params": { "key": ["users", "alice"] } }

// Response (success)
{ "id": 1, "result": { "entry": { ... } } }

// Response (error)
{ "id": 1, "error": "some error message" }
```

The first message after connection must be an auth request (unless the token is
passed in the URL):

```json
{ "id": 0, "method": "auth", "params": { "token": "your-secret" } }
// → { "id": 0, "result": { "ok": true } }
```

Push messages from the server (no `id`):

```json
// Watch update
{ "type": "watch", "entries": [{ "key": [...], "value": ..., "version": 1 }, null] }

// Queue listen delivery
{ "type": "queue", "topic": "emails", "message": { "id": 42, "payload": {...}, ... } }
```

---

## License

MIT © 2026 Indra Gunawan
