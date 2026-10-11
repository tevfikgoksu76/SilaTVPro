import test from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, classifyResponse, nextRecord, scanAll, urlKeyHex, HEALTH_CFG } from "./health-core.mjs";

function neterrFetch() {
  return async () => { const e = new Error("getaddrinfo ENOTFOUND host"); e.name = "FetchError"; throw e; };
}
function statusFetch(code) {
  return async () => ({ status: code, headers: { get: () => null }, async text() { return ""; } });
}
function healthyFetch() {
  return async () => ({ status: 200, headers: { get: () => null }, async text() { return "#EXTM3U\\n#EXTINF:-1,x\\nhttps://seg/1.ts\\n"; } });
}
function makeMaster(n) {
  let s = "#EXTM3U\\n";
  for (let i = 0; i < n; i++) s += `#EXTINF:-1,Ch${i}\\nhttps://host-${i}.example/live.m3u8\\n`;
  return s;
}

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


// Regression: uncertainty must not trip systemic-failure ratio guard.
test("all uncertain network results do not trip guard or create DEAD records", async () => {
  const n = 50;
  const r = await scanAll(makeMaster(n), {}, { fetchImpl: neterrFetch(), ttlMs: 0, concurrency: 10, now: () => 1000 });
  assert.equal(r.checked, n);
  assert.equal(r.confirmedFails, 0);
  assert.equal(r.uncertain, n);
  assert.equal(r.guardTripped, false);
  assert.equal(r.stats.dead, 0);
  assert.equal(r.stats.unknown, n);
});

test("high ratio of confirmed 404 failures still trips guard and preserves prior state", async () => {
  const n = 40;
  const master = makeMaster(n);
  const prev = {};
  const { urlKeyHex } = await import("./health-core.mjs");
  for (let i = 0; i < n; i++) prev[urlKeyHex(`https://host-${i}.example/live.m3u8`)] = { status: HEALTH_CFG.ST_HEALTHY, fails: 0, ts: 0 };
  const r = await scanAll(master, prev, { fetchImpl: statusFetch(404), ttlMs: 0, concurrency: 10, now: () => 1000 });
  assert.equal(r.confirmedFails, n);
  assert.equal(r.guardTripped, true);
  assert.equal(r.stats.healthy, n);
  assert.equal(r.stats.dead, 0);
});

test("uncertain result preserves old DEAD status and verification timestamp, but records attempt time", () => {
  const before = { status: HEALTH_CFG.ST_DEAD, fails: 3, ts: 10, lastAttemptTs: 5 };
  const r = nextRecord(before, { ok: null, httpStatus: 0 }, 100);
  assert.equal(r.status, HEALTH_CFG.ST_DEAD);
  assert.equal(r.fails, 3);
  assert.equal(r.ts, 10);
  assert.equal(r.lastAttemptTs, 100);
});

test("real healthy evidence restores an old DEAD record", () => {
  const before = { status: HEALTH_CFG.ST_DEAD, fails: 3, ts: 10 };
  const r = nextRecord(before, { ok: true, httpStatus: 200 }, 100);
  assert.equal(r.status, HEALTH_CFG.ST_HEALTHY);
  assert.equal(r.fails, 0);
  assert.equal(r.ts, 100);
});

test("LIMIT retries progress past prior uncertain results instead of repeatedly checking first batch", async () => {
  const n = 25;
  const master = makeMaster(n);
  const prev = {};
  for (let i = 0; i < n; i++) prev[urlKeyHex(`https://host-${i}.example/live.m3u8`)] = { status: HEALTH_CFG.ST_DEAD, fails: 3, ts: 0 };
  const t1 = HEALTH_CFG.HEALTH_TTL_MS + 1;
  const first = await scanAll(master, prev, { fetchImpl: neterrFetch(), ttlMs: HEALTH_CFG.HEALTH_TTL_MS, limit: 10, concurrency: 1, now: () => t1 });
  assert.equal(first.checked, 10);
  const t2 = t1 + 1000;
  const second = await scanAll(master, first.state, { fetchImpl: neterrFetch(), ttlMs: HEALTH_CFG.HEALTH_TTL_MS, limit: 10, concurrency: 1, now: () => t2 });
  assert.equal(second.checked, 10);
  const firstBatch = new Set(Object.entries(first.state).filter(([, r]) => r.lastAttemptTs === t1).map(([k]) => k));
  const secondBatch = Object.entries(second.state).filter(([, r]) => r.lastAttemptTs === t2).map(([k]) => k);
  assert.equal(secondBatch.some(k => firstBatch.has(k)), false);
});

test("three confirmed 404/410 failures still obey 3-strike rule across an uncertain probe", () => {
  let r = nextRecord(undefined, { ok: false, httpStatus: 404 }, 1);
  assert.equal(r.fails, 1);
  r = nextRecord(r, { ok: null, httpStatus: 0 }, 2);
  assert.equal(r.fails, 1);
  r = nextRecord(r, { ok: false, httpStatus: 410 }, 3);
  assert.equal(r.fails, 2);
  r = nextRecord(r, { ok: false, httpStatus: 404 }, 4);
  assert.equal(r.status, HEALTH_CFG.ST_DEAD);
});
