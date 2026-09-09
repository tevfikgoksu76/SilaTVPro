#!/usr/bin/env node
/**
 * SilaTV PRO — Health Scan JOB (GitHub Actions'ta çalışır; Cloudflare Worker'da DEĞİL)
 * ==============================================================================================
 * NE YAPAR:
 *   1) Gerçek master M3U'yu çeker (env.M3U_SOURCE_URL — Actions SECRET; APK'da değil).
 *   2) Önceki health state'i yükler (STATE_FILE; yoksa boş) → 3-strike geçmişi korunur.
 *   3) health-core ile parse + classify (YouTube/AceStream ATLA) + eşzamanlı health-check + 3-strike.
 *   4) CLEAN M3U snapshot + stats.json üretir; state'i günceller.
 *   5) Çıktıları OUT_DIR'e yazar. (KV'ye yükleme workflow adımında `wrangler kv key put` ile yapılır.)
 *
 * Master M3U FİZİKSEL OLARAK DEĞİŞTİRİLMEZ (yalnız okunur). Kotlin/uygulama tarafı ETKİLENMEZ.
 *
 * ENV:
 *   M3U_SOURCE_URL  (zorunlu)  gerçek master M3U adresi
 *   STATE_FILE      (ops.)     önceki/yeni state json yolu (vars: state.json)
 *   OUT_DIR         (ops.)     çıktı klasörü (vars: out)
 *   CONCURRENCY     (ops.)     eşzamanlı probe (vars: 100)
 *   LIMIT           (ops.)     bu run'da en çok N kontrol (0 = tüm taze-olmayanlar)
 *   TTL_MS          (ops.)     kayıt tazelik süresi (vars: 6h)
 *   SOURCE_UA       (ops.)     master'ı çekerken gönderilecek UA (bazı kaynaklar UA ister)
 */
import fs from "node:fs";
import path from "node:path";
import { scanAll, buildCleanM3U, computeStats } from "./health-core.mjs";

function env(k, d) { const v = process.env[k]; return (v === undefined || v === "") ? d : v; }

async function main() {
  const source = env("M3U_SOURCE_URL");
  if (!source) { console.error("❌ M3U_SOURCE_URL tanımlı değil (Actions secret)."); process.exit(1); }
  const stateFile = env("STATE_FILE", "state.json");
  const outDir = env("OUT_DIR", "out");
  const concurrency = parseInt(env("CONCURRENCY", "100"), 10);
  const limit = parseInt(env("LIMIT", "0"), 10);
  const ttlMs = parseInt(env("TTL_MS", String(6 * 3600 * 1000)), 10);
  const sourceUA = env("SOURCE_UA", "SilaTV-Worker/1.0");
  const masterTimeoutMs = parseInt(env("MASTER_TIMEOUT_MS", "20000"), 10);  // master fetch güvenli timeout (~4.5MB için)

  fs.mkdirSync(outDir, { recursive: true });

  // 1) önceki state
  let prevState = {};
  if (fs.existsSync(stateFile)) {
    try { prevState = JSON.parse(fs.readFileSync(stateFile, "utf-8")) || {}; }
    catch (_) { console.warn("⚠️ state okunamadı; boştan başlıyor."); prevState = {}; }
  }

  // 2) master'ı çek (GÜVENLİ TIMEOUT: takılı/yanıtsız kaynak job'u sonsuza kadar bekletmesin)
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), masterTimeoutMs);
  let masterText;
  try {
    const resp = await fetch(source, { headers: { "User-Agent": sourceUA, "Accept": "*/*" }, signal: ctrl.signal });
    if (!resp.ok) { console.error("❌ master fetch HTTP " + resp.status); process.exit(1); }
    masterText = await resp.text();
  } catch (e) {
    const isAbort = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    console.error(isAbort ? `❌ master fetch timeout (${masterTimeoutMs}ms aşıldı)` : ("❌ master fetch hata: " + (e && e.message || e)));
    process.exit(1);
  } finally {
    clearTimeout(to);
  }
  const fetchMs = Date.now() - t0;

  // 3) tara
  const t1 = Date.now();
  const res = await scanAll(masterText, prevState, { concurrency, limit, ttlMs });
  const scanMs = Date.now() - t1;

  // 4) clean snapshot + stats
  const clean = buildCleanM3U(masterText, res.state);
  const stats = {
    ...res.stats,
    breakdown: res.breakdown,
    checkedThisRun: res.checked,
    timeouts: res.timeouts,
    neterrs: res.neterrs,
    clean: { kept: clean.kept, removed: clean.removed },
    timings: { fetchMs, scanMs },
    generatedAt: new Date().toISOString(),
  };

  // 5) yaz
  fs.writeFileSync(stateFile, JSON.stringify(res.state));
  fs.writeFileSync(path.join(outDir, "clean.m3u"), clean.body);
  fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify(stats, null, 2));

  console.log("✅ Scan tamam:");
  console.log(`   total=${res.breakdown.total} checkable=${res.breakdown.checkable} ` +
              `youtube=${res.breakdown.youtube} acestream=${res.breakdown.acestream} nonhttp=${res.breakdown.nonhttp}`);
  console.log(`   healthy=${stats.healthy} temp=${stats.temporaryFailure} dead=${stats.dead} unknown=${stats.unknown}`);
  console.log(`   checkedThisRun=${res.checked} timeouts=${res.timeouts} neterrs=${res.neterrs}`);
  console.log(`   clean: kept=${clean.kept} removed=${clean.removed}`);
  console.log(`   timings: fetch=${fetchMs}ms scan=${scanMs}ms`);
  console.log(`   → ${path.join(outDir, "clean.m3u")}, ${path.join(outDir, "stats.json")}, ${stateFile}`);
}

main().catch((e) => { console.error("❌ scan hata:", e && e.stack || e); process.exit(1); });
