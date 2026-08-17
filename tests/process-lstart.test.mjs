/**
 * Regression tests for local issue #112 — `ps -o lstart=` locale dependence.
 *
 * `ps` renders lstart through LC_TIME, so a non-English locale emits a string
 * `new Date()` cannot parse. The resulting NaN used to flow into
 * processStartedAt, where it is cached for PROCESS_START_TTL_MS and silently
 * corrupts every downstream comparison: `NaN > threshold` is false so bounds
 * checks pass, and `mtimeMs >= NaN - window` is false so mtime prefilters
 * select nothing.
 *
 * The live `ps` call is now pinned to LC_ALL=C. The parser is tested against
 * captured output because a CI runner may not have any given locale installed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { getProcessStartTime, parsePsLstart } from "../dist/scanner/process.js";

const execFileAsync = promisify(execFile);

describe("parsePsLstart (#112)", () => {
  it("parses the C locale format ps is pinned to", () => {
    const parsed = parsePsLstart("Mon Aug 17 16:27:49 2026");
    assert.equal(typeof parsed, "number");
    assert.ok(Number.isFinite(parsed));
    assert.equal(new Date(parsed * 1000).getUTCFullYear(), 2026);
  });

  it("tolerates surrounding whitespace", () => {
    assert.equal(
      parsePsLstart("  Mon Aug 17 16:27:49 2026  "),
      parsePsLstart("Mon Aug 17 16:27:49 2026"),
    );
  });

  it("returns undefined for locale formats new Date() cannot parse", () => {
    // Captured from `LC_TIME=<locale> ps -o lstart=` on macOS. Six of the eight
    // locales sampled are unparseable; ja_JP and de_DE happen to survive V8's
    // lenient parser, which is luck rather than a guarantee worth relying on.
    for (const localized of [
      "2026년 8월 17일 월요일 18시 51분 12초", // ko_KR
      "lun. 17 août 18:51:12 2026", // fr_FR
      "lun. 17 ago. 18:51:12 2026", // es_ES
      "一 8月/17 18:51:12 2026", // zh_CN
      "lun 17 ago 18:51:12 2026", // it_IT
      "понедельник, 17 августа 2026 г. 18:51:12", // ru_RU
    ]) {
      assert.equal(parsePsLstart(localized), undefined, localized);
    }
  });

  it("returns undefined rather than NaN for empty or junk output", () => {
    assert.equal(parsePsLstart(""), undefined);
    assert.equal(parsePsLstart("   "), undefined);
    assert.equal(parsePsLstart("ps: process id too large: 999999"), undefined);
  });

  it("never returns NaN — NaN would pass every threshold comparison", () => {
    for (const raw of ["", "not a date", "2026년 8월 17일 월요일 18시 51분 12초"]) {
      const parsed = parsePsLstart(raw);
      assert.notEqual(Number.isNaN(parsed), true, `parsePsLstart(${JSON.stringify(raw)})`);
    }
  });
});

describe("getProcessStartTime pins the locale (#112)", () => {
  it("resolves a finite start time even when the caller's LC_TIME is not English", async () => {
    // Sanity-check that the locale actually changes ps output on this host;
    // if it does not, the assertion below would pass vacuously.
    const { stdout: localized } = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-p", String(process.pid)],
      { encoding: "utf-8", env: { ...process.env, LC_ALL: "ko_KR.UTF-8" } },
    ).catch(() => ({ stdout: "" }));

    const previous = process.env.LC_ALL;
    process.env.LC_ALL = "ko_KR.UTF-8";
    try {
      const startedAt = await getProcessStartTime(process.pid);
      if (parsePsLstart(localized) === undefined && localized.trim()) {
        // Host does localize ps output — this is the case #112 is about.
        assert.ok(
          Number.isFinite(startedAt),
          "pinned LC_ALL=C must still yield a parseable start time",
        );
      } else {
        // Host ignores LC_TIME (locale not installed); just assert we never
        // hand back NaN.
        assert.equal(Number.isNaN(startedAt), false);
      }
    } finally {
      // Reflect.deleteProperty rather than `delete` — biome's noDelete would
      // otherwise rewrite this to an assignment, and `process.env.LC_ALL =
      // undefined` stores the string "undefined" instead of unsetting it.
      if (previous === undefined) Reflect.deleteProperty(process.env, "LC_ALL");
      else process.env.LC_ALL = previous;
    }
  });
});
