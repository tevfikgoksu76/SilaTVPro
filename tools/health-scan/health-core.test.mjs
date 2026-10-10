import test from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, classifyResponse, nextRecord, HEALTH_CFG } from "./health-core.mjs";

test("404/410 are failures but not hard-dead", () => {
  assert.deepEqual(classifyResponse(404), { ok: false, hard: false });
  assert.deepEqual(classifyResponse(410), { ok: false, hard: false });
});

test("one or two 404/410 failures do not mark a record DEAD; third consecutive failure does", () => {
  let rec = nextRecord(undefined, { ok: false, hard: false, httpStatus: 404 }, 1);
  assert.equal(rec.status, HEALTH_CFG.ST_TEMP);
  assert.equal(rec.fails, 1);
  rec = nextRecord(rec, { ok: false, hard: false, httpStatus: 410 }, 2);
  assert.equal(rec.status, HEALTH_CFG.ST_TEMP);
  assert.equal(rec.fails, 2);
  rec = nextRecord(rec, { ok: false, hard: false, httpStatus: 404 }, 3);
  assert.equal(rec.status, HEALTH_CFG.ST_DEAD);
  assert.equal(rec.fails, 3);
});

test("a successful probe resets the consecutive-failure counter", () => {
  const rec = nextRecord(
    { status: HEALTH_CFG.ST_TEMP, fails: 2 },
    { ok: true, hard: false, httpStatus: 200 },
    4
  );
  assert.equal(rec.status, HEALTH_CFG.ST_HEALTHY);
  assert.equal(rec.fails, 0);
});

test("vidmody.com and its subdomains are excluded from external probing", () => {
  for (const url of [
    "https://vidmody.com/embed/abc",
    "https://www.vidmody.com/player?id=1",
    "https://cdn.vidmody.com/path"
  ]) {
    assert.equal(classifyUrl(url).checkable, false, url);
    assert.equal(classifyUrl(url).kind, "vidmody_embed", url);
  }
});

test("unrelated hosts containing the text vidmody remain checkable", () => {
  for (const url of [
    "https://notvidmody.com/live.m3u8",
    "https://vidmody.com.example.org/live.m3u8"
  ]) {
    assert.equal(classifyUrl(url).checkable, true, url);
  }
});
