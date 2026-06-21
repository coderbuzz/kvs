import { test, expect } from "bun:test";
import { KVStore, encodeKey, decodeKey } from "@coderbuzz/kvs";

test("KVStore set/get", () => {
  const store = new KVStore();
  store.set(["user", "1"], { name: "Alice" });
  const entry = store.get(["user", "1"]);
  expect(entry?.value).toEqual({ name: "Alice" });
});

test("encodeKey/decodeKey roundtrip", () => {
  const key = ["users", 42, true];
  expect(decodeKey(encodeKey(key))).toEqual(key);
});