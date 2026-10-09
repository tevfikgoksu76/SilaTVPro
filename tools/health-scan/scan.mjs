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

/**
 * YAYIN GUVENLIK KARARI (saf, test edilebilir). Onceki GECERLI snapshot ile karsilastirir;
 * sabit kanal sayisi VARSAYMAZ. force=true YALNIZ kucilme kontrolunu atlar;
 * asagidaki HARD guard'lar force ile BILE asilamaz.
 *  - guardTripped===true          -> yayinlama (health-core oran-guard: sistemik basarisizlik turu)
 *  - newKept<=0                   -> yayinlama (bos clean)
 *  - checked===0                  -> yayinlama (no-op run; yeni bir sey dogrulanmadi)  [#142 modu]
 *  - prevStatsOk===false          -> yayinlama (snap:stats GERCEK read FAILURE; mevcut yayin durumu
 *                                    DOGRULANAMAZ). Bunu bootstrap da force da ASAMAZ (okuma hatasi
 *                                    "ilk kurulum" sayilmaz).
 *  - prevKept sonlu DEGIL          -> yayinlama; YALNIZ prevStatsOk===true (okuma basarili, veri yok) +
 *                                    allowBootstrap ile acilir (gercek ilk kurulum).
 *  - prevKept biliniyorsa ve newKept < prevKept*minRatio -> yayinlama (beklenmedik kucilme; force bunu asar)
 *  - aksi halde -> yayinla (buyume/kucuk dususler serbest)
 * allowBootstrap: workflow'un DOGRULADIGI gercek ilk kurulum (hstate+snap:stats KESIN yok, okuma basarili);
 *                 okuma hatasinda workflow bunu 0 verir. prevStatsOk=false iken ETKISIZDIR.
 */
export function decidePublish({ checked, newKept, prevKept, minRatio = 0.80, force = false, guardTripped = false, prevStatsOk = true, allowBootstrap = false }) {
  // HARD guard'lar (force BILE atlayamaz):
  if (guardTripped) return { publish: false, reason: "ratio-guard-tripped (sistemik basarisizlik; state yazilmadi)" };
  if (!(newKept > 0)) return { publish: false, reason: "empty-clean (kept=" + newKept + ")" };
  if (checked === 0) return { publish: false, reason: "no-op-run (checkedThisRun=0)" };
  // snap:stats OKUNAMADI (prevStatsOk=false = GERCEK read FAILURE) -> mevcut yayin durumu dogrulanamaz.
  // Bu HARD guard'i ne allowBootstrap ne de force asabilir (okuma hatasi "ilk kurulum" SAYILMAZ).
  if (!prevStatsOk) return { publish: false, reason: "prev-stats-unverified (snap:stats OKUNAMADI; bootstrap/force bunu asamaz)" };
  // onceki snapshot boyutu bilinmiyor. allowBootstrap'a yalniz BURADA, prevStatsOk===true GECTIKTEN sonra
  // bakilir -> bootstrap ancak okuma BASARILI + kesin "veri yok" iken mumkun (workflow dogrular).
  if (!Number.isFinite(prevKept)) {
    if (allowBootstrap) return { publish: true, reason: "bootstrap (dogrulanmis ilk kurulum; snap:stats okundu, onceki snapshot yok)" };
    return { publish: false, reason: "prev-kept-missing (onceki snapshot dogrulanamadi; gercek ilk kurulumsa allow_bootstrap=1)" };
  }
  // force YALNIZ kucilme (shrink) kontrolunu atlar; buraya gelmek icin: guard kapali, kept>0, checked>0,
  // snap:stats OK ve prevKept SONLU sart (tum dogrulama guard'lari gecti).
  if (force) return { publish: true, reason: "force (shrink bypass; diger tum guard'lar gecti)" };
  if (prevKept > 0 && newKept < prevKept * minRatio) {
    return { publish: false, reason: `shrink (new=${newKept} < prev=${prevKept} x ${minRatio})` };
  }
  return { publish: true, reason: "ok" };
}

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

  // 4) clean snapshot + YAYIN KARARI (publish-guard)
  const clean = buildCleanM3U(masterText, res.state);
  const prevKept = (() => { const v = parseInt(env("PREV_KEPT", ""), 10); return Number.isFinite(v) ? v : null; })();
  const minRatio = parseFloat(env("MIN_PUBLISH_RATIO", "0.80"));
  const force = env("FORCE_PUBLISH", "0") === "1";
  // PREV_STATS_OK: workflow snap:stats'i BASARIYLA okuduysa "1". "0" -> mevcut yayin durumu dogrulanamadi -> yayin yok.
  // Varsayilan "1" DEGIL; workflow acikca set etmezse guvenli tarafta kal (dogrulanmamis say).
  const prevStatsOk = env("PREV_STATS_OK", "0") === "1";
  const allowBootstrap = env("ALLOW_BOOTSTRAP", "0") === "1";
  const decision = decidePublish({ checked: res.checked, newKept: clean.kept, prevKept, minRatio, force, guardTripped: res.guardTripped, prevStatsOk, allowBootstrap });
  const stats = {
    ...res.stats,
    breakdown: res.breakdown,
    checkedThisRun: res.checked,
    timeouts: res.timeouts,
    neterrs: res.neterrs,
    clean: { kept: clean.kept, removed: clean.removed },
    published: decision.publish,
    publishSkipReason: decision.publish ? null : decision.reason,
    prevKept, minPublishRatio: minRatio, prevStatsOk, allowBootstrap,
    timings: { fetchMs, scanMs },
    generatedAt: new Date().toISOString(),
  };

  // 5) yaz
  fs.writeFileSync(stateFile, JSON.stringify(res.state));
  fs.writeFileSync(path.join(outDir, "clean.m3u"), clean.body);
  fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify(stats, null, 2));

  // YAYIN SENTINEL: workflow upload+manifest-flip adimi SADECE bu dosya varsa calisir.
  // Yoksa aktif snapshot + manifest KORUNUR (KV'ye hic yazilmaz).
  const okFlag = path.join(outDir, "publish_ok");
  try { fs.rmSync(okFlag, { force: true }); } catch (_) {}
  if (decision.publish) {
    fs.writeFileSync(okFlag, "1");
    console.log("   PUBLISH: " + decision.reason + " (kept=" + clean.kept + ", prev=" + prevKept + ")");
  } else {
    console.log("   PUBLISH ATLANDI: " + decision.reason + " -> aktif snapshot/manifest KORUNUR, KV'ye YAZILMAZ");
  }

  console.log("✅ Scan tamam:");
  console.log(`   total=${res.breakdown.total} checkable=${res.breakdown.checkable} ` +
              `youtube=${res.breakdown.youtube} acestream=${res.breakdown.acestream} nonhttp=${res.breakdown.nonhttp}`);
  console.log(`   healthy=${stats.healthy} temp=${stats.temporaryFailure} dead=${stats.dead} unknown=${stats.unknown}`);
  console.log(`   checkedThisRun=${res.checked} timeouts=${res.timeouts} neterrs=${res.neterrs}`);
  console.log(`   clean: kept=${clean.kept} removed=${clean.removed}`);
  console.log(`   timings: fetch=${fetchMs}ms scan=${scanMs}ms`);
  console.log(`   → ${path.join(outDir, "clean.m3u")}, ${path.join(outDir, "stats.json")}, ${stateFile}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("❌ scan hata:", e && e.stack || e); process.exit(1); });
