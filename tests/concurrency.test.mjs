import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promiseAllLimited } from "../dist/scanner/concurrency.js";

describe("promiseAllLimited", () => {
  it("executes all tasks and returns results in order", async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)];
    const results = await promiseAllLimited(tasks, 2);
    assert.deepEqual(results, [1, 2, 3]);
  });

  it("limits concurrency", async () => {
    let running = 0;
    let maxRunning = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      running++;
      if (running > maxRunning) maxRunning = running;
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return i;
    });
    const results = await promiseAllLimited(tasks, 3);
    assert.equal(results.length, 10);
    assert.ok(maxRunning <= 3, `maxRunning was ${maxRunning}, expected <= 3`);
  });

  it("handles empty array", async () => {
    const results = await promiseAllLimited([], 4);
    assert.deepEqual(results, []);
  });

  it("handles errors without losing other results", async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error("fail")),
      () => Promise.resolve(3),
    ];
    const results = await promiseAllLimited(tasks, 2);
    assert.equal(results[0], 1);
    assert.equal(results[1], null);
    assert.equal(results[2], 3);
  });
});
