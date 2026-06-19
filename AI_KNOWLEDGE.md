<!-- docs: sync from coderbuzz/codex@6f70be3 -->

# KVS — AI Agent Knowledge File

**Package:** `@coderbuzz/kvs` v0.1.7\
**Purpose:** Lightweight SQLite-backed key-value server with HTTP REST API,
WebSocket RPC, atomic transactions, TTL, persistent queue, real-time watch, and
push-based queue listeners.\
**Distribution:** ESM only (`dist/index.js` + `dist/index.d.ts`). No source
`.ts` files in the package.

---

## Mental Model

KVS has two sides:

- **Server** — a standalone process (`dist/index.js`) backed by SQLite. Exposes
  HTTP REST + WebSocket endpoints. Run it with
  `ACCESS_TOKEN=secret bun run
  node_modules/@coderbuzz/kvs/dist/index.js`.
- **Client** — `KvsClient` is a fetch-based TypeScript SDK. After `open()` it
  transparently upgrades to WebSocket JSON-RPC for lower latency. Same API over
  both transports.

```
KvsClient
  ├── REST transport (default, no setup)
  └── WebSocket RPC transport (after open())
        ├── All KV/queue methods
        ├── watch()   — real-time key-change subscriptions
        └── listen()  — push-based queue delivery
```

---

## Complete Import Map

```ts
import {
  type KvCheck,
  type KvCommitError,
  type KvCommitResult,
  type KvEntry,
  type KvKey,
  type KvKeyPart,
  type KvListOptions,
  type KvListResult,
  type KvListSelector,
  type KvMutation,
  KvsClient,
  // Types
  type KvsClientOptions,
  type QueueMessage,
  type QueueOptions,
  Singleflight,
} from "@coderbuzz/kvs";
```

---

## Key System

### KvKeyPart

```ts
type KvKeyPart = string | number | bigint | boolean | Uint8Array;
type KvKey = KvKeyPart[]; // always an array, min length 1
```

Keys are encoded to bytes with a **deterministic sort order**:

```
Uint8Array(1) < string(2) < number(3) < bigint(4) < false(5) < true(6)
```

Within the same type, natural ordering applies (lexicographic for strings,
numeric for numbers). Numbers use IEEE 754 doubles with flipped sign bits.

```ts
// Sort order examples
["a"] < ["b"]["users", 1] < ["users", 2] < ["users", "alice"]["items", false] <
  ["items", true];
```

---

## KvsClient — Constructor

```ts
const kv = new KvsClient({
  url: "http://localhost:3000", // trailing slashes stripped
  token: "your-access-token",
});
```

---

## KV Operations

### get(key)

```ts
const entry: KvEntry | null = await kv.get(["users", "alice"]);
// entry = { key, value, version } or null if missing/expired
```

### set(key, value, options?)

```ts
const result: KvCommitResult = await kv.set(["users", "alice"], {
  name: "Alice",
});
// result = { ok: true, version: 1 }

// With TTL (milliseconds)
await kv.set(["cache", "key"], value, { ttl: 60_000 });
```

Every `set` increments `version` by 1. Returns `KvCommitResult`
(`{ ok: true, version: N }`).

### delete(key)

```ts
await kv.delete(["users", "alice"]);
// Returns { ok: true } — no-op if key missing
```

### list(selector, options?)

```ts
// By prefix
const result = await kv.list({ prefix: ["users"] });
// result = { entries: KvEntry[], cursor: string | null }

// By range (start inclusive, end exclusive)
const range = await kv.list({ start: ["events", 1000], end: ["events", 2000] });

// With options
const page = await kv.list(
  { prefix: ["logs"] },
  { limit: 20, cursor: prevCursor, reverse: true },
);
```

**Defaults:** `limit: 100`, max `1000`, ascending. `cursor` is opaque base64 —
always pass it as-is from the previous result.

### getAsync(key, fn, ttl?)

Cache-with-compute pattern. Protects against thundering herds:

```ts
// fn() runs once even with 100 concurrent callers; result cached for 30 s
const user = await kv.getAsync(
  ["users", userId],
  () => db.findUser(userId),
  30_000,
);
```

**Algorithm:**

1. Call `get(key)` — return immediately if cache hit.
2. Deduplicate within this process via `Singleflight`.
3. Call `fn()` exactly once.
4. `atomic().check({ version: null }).set(key, value)` — set-if-not-exists.
5. If another process won the race, return their stored value.

---

## Atomic Operations

`atomic()` returns an `AtomicBuilder`. Chains are fluent. All mutations apply in
a single SQLite transaction.

```ts
const result = await kv
  .atomic()
  .check({ key: ["k"], version: 3 }) // fail if version ≠ 3
  .check({ key: ["new"], version: null }) // fail if key exists
  .set(["k"], newValue)
  .set(["meta"], { updatedAt: Date.now() }, { ttl: 86_400_000 })
  .delete(["old"])
  .enqueue({ task: "notify" }, { topic: "jobs" })
  .commit();

// result: { ok: true, version: N } or { ok: false }
```

**`check(version: null)`** = "key must not exist" (create-only guard).\
**`check(version: N)`** = "key must be at version N" (optimistic lock).

### AtomicBuilder API

| Method    | Signature                                      | Notes                       |
| --------- | ---------------------------------------------- | --------------------------- |
| `check`   | `(...checks: KvCheck[]): this`                 | Multiple checks allowed     |
| `set`     | `(key, value, options?): this`                 | `options: { ttl?: number }` |
| `delete`  | `(key): this`                                  |                             |
| `enqueue` | `(payload, options?): this`                    | `options: QueueOptions`     |
| `commit`  | `(): Promise<KvCommitResult \| KvCommitError>` |                             |

---

## Queue

### enqueue(payload, options?)

```ts
const result = await kv.enqueue(
  { to: "user@example.com", subject: "Welcome" },
  { topic: "emails", delay: 5_000, maxAttempts: 5 },
);
// result = { ok: true, id: 42 }
```

Defaults: `topic: "default"`, `delay: 0`, `maxAttempts: 3`.

### dequeue(topic?, limit?)

```ts
const messages: QueueMessage[] = await kv.dequeue("emails", 10);
// Defaults: topic "default", limit 1
// Moves messages to "processing" status
```

### acknowledge(id)

```ts
const ok: boolean = await kv.acknowledge(messages[0].id);
// Marks as "done" — message will not be delivered again
```

**Message lifecycle:**

```
pending → (dequeue) → processing → (acknowledge) → done
                               ↓ not acked within 30s
                            requeue → pending  (up to maxAttempts)
```

### QueueMessage fields

```ts
{
  id: number; // stable DB id
  topic: string;
  payload: unknown;
  enqueuedAt: number; // ms epoch
  deliverAt: number; // ms epoch
  attempts: number; // increments on each dequeue
  maxAttempts: number;
}
```

---

## WebSocket Transport

### open() / close()

```ts
await kv.open(); // connects to ws://host/ws, authenticates, switches transport
kv.close(); // disconnects, reverts to REST
```

After `open()`, all KV/queue methods automatically route over WebSocket RPC
(same paths, same return types). If the connection drops, `close()` is called
internally and REST is restored.

**Auth modes:**

1. Post-connect message (default, handled by `open()` automatically)
2. URL query param: `ws://host/ws?token=TOKEN` (for upgrade-time auth)

### watch(keys, callback) — requires open()

```ts
const { cancel } = kv.watch(
  [["config", "a"], ["config", "b"]],
  (entries: (KvEntry | null)[]) => {
    // entries[0] = KvEntry | null for ["config", "a"]
    // entries[1] = KvEntry | null for ["config", "b"]
  },
);

// Cancel at any time
cancel();
```

**Behavior:**

- Fires immediately with current values (initial state)
- Fires on every `set`, `delete`, or `atomic` that touches a watched key
- Only one active watch per client connection — calling `watch()` replaces the
  previous subscription
- `entries` array is parallel to the `keys` input array; `null` =
  missing/expired

### listen(topic, callback) — requires open()

```ts
const { cancel } = kv.listen("emails", async (msg: QueueMessage) => {
  await sendEmail(msg.payload);
  await kv.acknowledge(msg.id); // must acknowledge manually
});

cancel(); // stop receiving
```

**Behavior:**

- Push-based delivery — no polling required
- Multiple listeners on the same topic get messages distributed round-robin
  (work-stealing): each message goes to exactly one listener
- Must call `acknowledge(msg.id)` manually — not acking causes requeue after 30
  s
- Throws if called before `open()`

---

## Singleflight

Exported as a standalone utility. Deduplicates concurrent async calls within a
single process.

```ts
import { Singleflight } from "@coderbuzz/kvs";

const sf = new Singleflight<User>();

// 100 concurrent calls — fn runs once, all await the same result
const user = await sf.do("key", () => expensiveLoad());

sf.size; // number of in-flight calls
sf.clear(); // clear all in-flight state
```

`KvsClient` exposes its internal singleflight as `kv.sf` for inspection.

---

## Health / Reset

```ts
const h = await kv.health(); // no auth required
// { ok: true, uptime: 123.45 }  (uptime in seconds)

await kv.reset(); // DELETE all kv + queue data (testing only)
```

---

## Server Internals (read-only context)

- **SQLite** with WAL mode, 64 MB cache, 256 MB mmap, `busy_timeout = 5000`
- **TTL cleanup** every 60 seconds
- **Failed message requeue** every 60 seconds (requeues `processing` messages
  older than 30 s that have remaining attempts)
- **List max** hard-capped at 1000 per page

---

## HTTP API — Method Summary

All endpoints require `Authorization: Bearer <TOKEN>` (except `/health`).
Request body is JSON; response body is JSON.

| Endpoint              | Body Fields                                                  | Response                                   |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| `GET /health`         | —                                                            | `{ ok: true, uptime: number }`             |
| `POST /kv/get`        | `key`                                                        | `{ entry: KvEntry \| null }`               |
| `POST /kv/set`        | `key`, `value`, `ttl?`                                       | `{ ok: true, version }`                    |
| `POST /kv/delete`     | `key`                                                        | `{ ok: true }`                             |
| `POST /kv/list`       | `prefix?`, `start?`, `end?`, `limit?`, `cursor?`, `reverse?` | `{ entries, cursor }`                      |
| `POST /kv/atomic`     | `checks?`, `mutations?`, `enqueues?`                         | `{ ok: true, version }` or `{ ok: false }` |
| `POST /queue/enqueue` | `payload`, `topic?`, `delay?`, `maxAttempts?`                | `{ ok: true, id }`                         |
| `POST /queue/dequeue` | `topic?`, `limit?`                                           | `{ messages: QueueMessage[] }`             |
| `POST /queue/ack`     | `id`                                                         | `{ ok: boolean }`                          |
| `POST /kv/reset`      | —                                                            | `{ ok: true }`                             |

---

## WebSocket Protocol Summary

Endpoint: `ws://host/ws` (or with `?token=TOKEN`)

```json
// Client → Server (RPC request)
{ "id": 1, "method": "/kv/get", "params": { "key": ["users", "alice"] } }

// Server → Client (RPC response)
{ "id": 1, "result": { "entry": { ... } } }
{ "id": 1, "error": "error message" }

// Client → Server (watch)
{ "id": 2, "method": "/kv/watch", "params": { "keys": [["config", "a"]] } }

// Client → Server (unwatch)
{ "method": "/kv/unwatch" }

// Server → Client (watch push)
{ "type": "watch", "entries": [{ "key": ..., "value": ..., "version": 1 }] }

// Client → Server (queue listen)
{ "id": 3, "method": "/queue/listen", "params": { "topic": "emails" } }

// Server → Client (queue push)
{ "type": "queue", "topic": "emails", "message": { "id": 42, ... } }

// Auth (must be first message if token not in URL)
{ "id": 0, "method": "auth", "params": { "token": "your-secret" } }
// → { "id": 0, "result": { "ok": true } }
```

Supported RPC methods (same paths as HTTP): `/kv/get`, `/kv/set`, `/kv/delete`,
`/kv/list`, `/kv/atomic`, `/queue/enqueue`, `/queue/dequeue`, `/queue/ack`,
`/kv/reset`, `/kv/watch`, `/kv/unwatch`, `/queue/listen`, `/queue/unlisten`.

---

## Common Patterns

### Optimistic Counter

```ts
async function increment(key: KvKey): Promise<number> {
  while (true) {
    const entry = await kv.get(key);
    const next = ((entry?.value as number) ?? 0) + 1;
    const r = await kv
      .atomic()
      .check({ key, version: entry?.version ?? null })
      .set(key, next)
      .commit();
    if (r.ok) return next;
  }
}
```

### Distributed Lock

```ts
async function withLock<T>(
  name: string,
  ttl: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const r = await kv
    .atomic()
    .check({ key: ["locks", name], version: null })
    .set(["locks", name], 1, { ttl })
    .commit();
  if (!r.ok) return null; // lock taken
  try {
    return await fn();
  } finally {
    await kv.delete(["locks", name]);
  }
}
```

### Full Pagination

```ts
async function* listAll(prefix: KvKey): AsyncGenerator<KvEntry> {
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
```

### Atomic Enqueue + State Transition

```ts
// Transition order to "processing" and enqueue fulfillment job atomically
const r = await kv
  .atomic()
  .check({ key: ["orders", orderId], version: currentVersion })
  .set(["orders", orderId], { ...order, status: "processing" })
  .enqueue({ orderId, action: "fulfill" }, {
    topic: "fulfillment",
    maxAttempts: 5,
  })
  .commit();
```

### Push Worker with Work-Stealing

```ts
// Each worker process connects and listens — messages distributed round-robin
await kv.open();
const { cancel } = kv.listen("jobs", async (msg) => {
  await processJob(msg.payload);
  await kv.acknowledge(msg.id);
});
process.on("SIGTERM", () => {
  cancel();
  kv.close();
});
```

### Real-Time Config Watch

```ts
await kv.open();
kv.watch([["config", "rateLimit"], ["config", "featureFlags"]], (entries) => {
  const rateLimit = (entries[0]?.value as number) ?? 100;
  const featureFlags = (entries[1]?.value as Record<string, boolean>) ?? {};
  updateConfig({ rateLimit, featureFlags });
});
```

### Cache-Stampede-Safe Fetch

```ts
// 100 concurrent misses → 1 DB call; result cached and shared
const product = await kv.getAsync(
  ["products", productId],
  () => db.findProduct(productId),
  300_000, // 5 min TTL
);
```

---

## Gotchas & Edge Cases

1. **`version: null` in check** means "key must not exist". If the key exists
   (even expired before cleanup), the check fails.
2. **Dequeued messages must be acknowledged** within 30 seconds or they are
   automatically requeued as `pending` again (up to `maxAttempts`).
3. **`listen()` requires `open()`** — throws `"WebSocket not connected"` if
   called before `open()`.
4. **`watch()` replaces, not adds** — only one watch subscription per client
   connection at a time. Call `cancel()` before re-watching different keys.
5. **List `cursor` is opaque** — always pass it directly from the previous
   result; never construct it manually.
6. **`getAsync` skips the initial fast-path GET** — it goes straight to
   singleflight deduplication to protect hot keys from thundering herds. The
   in-singleflight GET still serves cache hits.
7. **`reset()` deletes all data** including both `kv` and `queue` tables. It
   also cancels all active watchers. Use only in tests.
8. **Closing the WebSocket** (`close()`) rejects all in-flight RPC promises with
   `"WebSocket closed"` and reverts all subsequent calls to REST.
9. **`dequeue()` returns at most `limit` messages** (default: 1). Pass `limit`
   explicitly for batch processing.
10. **Queue default topic is `"default"`** — `enqueue({ x: 1 })` without options
    goes to `"default"`, and `dequeue()` without a topic reads from `"default"`.

---

## TypeScript Quick Reference

```ts
// Infer value type from entry
const entry = await kv.get(["users", "alice"]);
const user = entry?.value as User | undefined;

// Discriminate commit result
const r = await kv.atomic().set(["k"], v).commit();
if (r.ok) {
  console.log(r.version); // number
} else {
  // r.ok === false — no version field
}

// getAsync with explicit type
const data = await kv.getAsync<MyData>(["key"], () => fetchData(), 60_000);

// watch callback typing
kv.watch([["a"], ["b"]], (entries: (KvEntry | null)[]) => {
  const a = entries[0]?.value as string | undefined;
});

// listen callback typing
kv.listen("jobs", (msg: QueueMessage) => {
  const job = msg.payload as JobPayload;
});
```
