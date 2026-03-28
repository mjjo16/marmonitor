import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedMap } from "../dist/scanner/bounded-map.js";

describe("BoundedMap", () => {
  it("evicts oldest entry when maxSize exceeded", () => {
    const map = new BoundedMap(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("d", 4); // should evict "a"
    assert.equal(map.size, 3);
    assert.equal(map.has("a"), false);
    assert.equal(map.get("d"), 4);
  });

  it("re-setting existing key does not evict", () => {
    const map = new BoundedMap(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("a", 10); // update, not new entry
    assert.equal(map.size, 3);
    assert.equal(map.get("a"), 10);
    assert.equal(map.has("b"), true);
  });

  it("re-set refreshes insertion order (LRU-like)", () => {
    const map = new BoundedMap(3);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    map.set("a", 10); // refresh "a" to newest
    map.set("d", 4); // should evict "b" (now oldest), not "a"
    assert.equal(map.has("a"), true);
    assert.equal(map.has("b"), false);
    assert.equal(map.has("c"), true);
    assert.equal(map.has("d"), true);
  });

  it("get, has, delete work normally", () => {
    const map = new BoundedMap(5);
    map.set("x", 42);
    assert.equal(map.has("x"), true);
    assert.equal(map.get("x"), 42);
    map.delete("x");
    assert.equal(map.has("x"), false);
    assert.equal(map.get("x"), undefined);
  });

  it("works with maxSize of 1", () => {
    const map = new BoundedMap(1);
    map.set("a", 1);
    map.set("b", 2);
    assert.equal(map.size, 1);
    assert.equal(map.has("a"), false);
    assert.equal(map.get("b"), 2);
  });
});
