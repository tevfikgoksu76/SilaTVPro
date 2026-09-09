/**
 * SilaTV PRO — Health Checker ÇEKİRDEK KURALLARI (tek kaynak)
 * ==============================================================================================
 * HİBRİT MİMARİ (Free plan): 43k M3U parse + health-check + 3-strike + clean snapshot üretimi
 * DIŞ JOB'da (GitHub Actions) çalışır. Cloudflare Worker yalnız hazır snapshot'ı servis eder.
 *
 * Bu modül SAF/taşınabilir kurallardır (network probe dahil) ve HEM dış job (scan.mjs) HEM de
 * test paketi tarafından kullanılır → kural tutarlılığı garanti (skip YouTube/AceStream, 3-strike,
 * yanıt politikası). Cloudflare'e/KV'ye bağımlılığı YOKTUR; düz Node/tarayıcı fetch ile çalışır.
 */

export const HEALTH_CFG = {
  DEAD_THRESHOLD: 3,            // 3 ARDIŞIK başarısızlık → DEAD (tek başarısızlıkta DEAD yok)
  CONNECT_TIMEOUT_MS: 5000,
  READ_TIMEOUT_MS: 5000,
  MAX_REDIRECTS: 3,
  CONCURRENCY: 100,            // dış runner'da subrequest limiti yok → yüksek eşzamanlılık
  HEALTH_TTL_MS: 6 * 3600 * 1000,  // bir kayıt bu süre boyunca "taze" → yeniden kontrol edilmez
  ST_HEALTHY: "HEALTHY",
  ST_TEMP: "TEMPORARY_FAILURE",
  ST_DEAD: "DEAD",
  ST_UNKNOWN: "UNKNOWN",
};

/* ---------------- küçük yardımcılar ---------------- */
function hostOf(lowUrl) {
  try { return new URL(lowUrl).host; } catch (_) {
    const m = String(lowUrl).match(/^[a-z]+:\/\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase() : "";
  }
}
function absolutize(loc, base) { try { return new URL(loc, base).toString(); } catch (_) { return loc; } }

/**
 * URL anahtarı — SENKRON, ucuz hash (iki tohumlu 32-bit FNV-1a → 16 hex). Çakışma ihmal edilebilir.
 */
export function urlKeyHex(str) {
  const s = String(str);
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x1000193 ^ 0x9e37;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ c) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h1) + hex(h2);
}

/**
 * URL tipini sınıflandır. YouTube ve acestream:// HTTP health-check'e GİRMEZ (checkable=false).
 */
export function classifyUrl(rawUrl) {
  const u = String(rawUrl || "").trim();
  const low = u.toLowerCase();
  if (!u) return { kind: "empty", checkable: false };

  if (low.startsWith("acestream://") || low.includes("acestream://") ||
      low.startsWith("infohash://") || /(?:^|[?&])(?:infohash|content_id)=/.test(low)) {
    return { kind: "acestream", checkable: false };
  }
  if (/(?:^|\.)youtube\.com$/.test(hostOf(low)) || hostOf(low) === "youtu.be" ||
      low.includes("youtube.com/") || low.includes("youtu.be/") ||
      low.includes("youtube-nocookie.com")) {
    return { kind: "youtube", checkable: false };
  }
  if (!low.startsWith("http://") && !low.startsWith("https://")) {
    return { kind: "nonhttp", checkable: false };
  }
  const tokenish = /[?&](?:token|auth|sig|signature|hmac|expires|key|hash|md5|wmsauthsign)=/.test(low) ||
                   /\/[a-f0-9]{16,}\//.test(low);
  let kind = "http_other";
  if (/\.m3u8(?:$|[?#])/.test(low)) kind = "m3u8";
  else if (/\.ts(?:$|[?#])/.test(low)) kind = "ts";
  else if (/\.mp4(?:$|[?#])/.test(low)) kind = "mp4";
  return { kind, checkable: true, tokenish, isM3U8: kind === "m3u8" };
}

/**
 * HTTP yanıt kodunu sonuç sınıfına çevir. ok:true sağlıklı, ok:false başarısızlık (sayaç artar),
 * ok:null BELİRSİZ (401/403/429/451 → false-positive DEAD önleme; durum/sayaç değişmez).
 */
export function classifyResponse(status, opts = {}) {
  const s = status | 0;
  if (s >= 200 && s < 300) {
    if (opts.isM3U8) return { ok: opts.looksLikeM3U ? true : null, hard: false };
    return { ok: true, hard: false };
  }
  if (s >= 300 && s < 400) return { ok: null, hard: false };
  if (s === 401 || s === 403 || s === 429 || s === 451) return { ok: null, hard: false };
  if (s === 404 || s === 410) return { ok: false, hard: true };
  if (s >= 500 && s < 600) return { ok: false, hard: false };
  return { ok: null, hard: false };
}

/**
 * Önceki kayıt + yeni probe → yeni kayıt. 3-strike durum makinesi.
 */
export function nextRecord(prev, probe, now) {
  const p = prev && typeof prev === "object" ? prev : { status: HEALTH_CFG.ST_UNKNOWN, fails: 0 };
  const rec = {
    status: p.status || HEALTH_CFG.ST_UNKNOWN,
    fails: p.fails | 0,
    ts: now,
    rt: probe.responseTimeMs ?? null,
    code: probe.httpStatus ?? null,
  };
  if (probe.ok === true) {
    rec.status = HEALTH_CFG.ST_HEALTHY; rec.fails = 0;
  } else if (probe.ok === false) {
    rec.fails = (p.fails | 0) + 1;
    const dead = probe.hard === true || rec.fails >= HEALTH_CFG.DEAD_THRESHOLD;
    rec.status = dead ? HEALTH_CFG.ST_DEAD : HEALTH_CFG.ST_TEMP;
  } else {
    rec.status = p.status || HEALTH_CFG.ST_UNKNOWN; rec.fails = p.fails | 0;
  }
  return rec;
}

/**
 * Master M3U'yu {name, group, url} girişlerine ayrıştır (read-only, minimal, sağlam).
 * Master ASLA değiştirilmez — bu yalnız okuma.
 */
export function parseM3U(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  let name = "", group = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const comma = line.indexOf(",");
      name = comma >= 0 ? line.slice(comma + 1).trim() : "";
      const gm = line.match(/group-title="([^"]*)"/i);
      group = gm ? gm[1] : "";
    } else if (line.startsWith("#")) {
      const gm = line.match(/^#EXTGRP:(.*)$/i);
      if (gm) group = gm[1].trim();
    } else {
      out.push({ name, group, url: line });
      name = ""; group = "";
    }
  }
  return out;
}

/**
 * Tek HTTP(S) URL'ini kısa timeout ile yokla; redirect'i elle takip eder.
 * deps.fetchImpl verilirse onu kullanır (TEST); yoksa global fetch (Node 18+/tarayıcı).
 */
export async function probeUrl(rawUrl, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const cfg = HEALTH_CFG;
  const cls = deps.classify || classifyUrl(rawUrl);
  const startNow = deps.now ? deps.now() : Date.now();
  const nowFn = deps.now || (() => Date.now());
  let current = rawUrl, redirects = 0, subrequests = 0, lastStatus = 0;
  try {
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.CONNECT_TIMEOUT_MS + cfg.READ_TIMEOUT_MS);
      let resp;
      try {
        subrequests++;
        resp = await fetchImpl(current, {
          method: "GET", redirect: "manual", signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (SmartTV) SilaTV-HealthBot/1.0", "Accept": "*/*", "Range": "bytes=0-2047" },
        });
      } finally { clearTimeout(timer); }
      lastStatus = resp.status | 0;
      if (lastStatus >= 300 && lastStatus < 400) {
        const loc = resp.headers.get("location");
        if (loc && redirects < cfg.MAX_REDIRECTS) { redirects++; current = absolutize(loc, current); continue; }
        return { ok: null, hard: false, httpStatus: lastStatus, responseTimeMs: Math.max(0, nowFn() - startNow), redirects, subrequests };
      }
      let looksLikeM3U = false;
      if (cls.isM3U8 && lastStatus >= 200 && lastStatus < 300) {
        try { const head = await resp.text(); looksLikeM3U = /#EXTM3U/i.test(head) || /#EXTINF/i.test(head) || /\.ts(\b|\?)/i.test(head); }
        catch (_) { looksLikeM3U = false; }
      }
      const verdict = classifyResponse(lastStatus, { isM3U8: cls.isM3U8, looksLikeM3U });
      return { ok: verdict.ok, hard: verdict.hard, httpStatus: lastStatus, responseTimeMs: Math.max(0, nowFn() - startNow), redirects, subrequests };
    }
  } catch (e) {
    const isAbort = e && (e.name === "AbortError" || /abort/i.test(String(e.message || "")));
    return { ok: false, hard: false, httpStatus: lastStatus || 0, responseTimeMs: Math.max(0, nowFn() - startNow), redirects, subrequests, error: isAbort ? "timeout" : ("neterr:" + (e && e.name || "error")) };
  }
}

/** state → aggregate sayımlar. */
export function computeStats(state, now = Date.now()) {
  const c = { total: 0, healthy: 0, temporaryFailure: 0, dead: 0, unknown: 0 };
  for (const k in state) {
    c.total++;
    const st = state[k].status;
    if (st === HEALTH_CFG.ST_HEALTHY) c.healthy++;
    else if (st === HEALTH_CFG.ST_TEMP) c.temporaryFailure++;
    else if (st === HEALTH_CFG.ST_DEAD) c.dead++;
    else c.unknown++;
  }
  c.lastScan = now;
  return c;
}

/**
 * TAM TARAMA (dış job çekirdeği): master metni + önceki state → güncel state + breakdown + stats.
 *  - YouTube/AceStream/non-HTTP → checkable değil → probe EDİLMEZ (breakdown'da sayılır).
 *  - Yalnız "taze olmayan" (ts > ttl) veya yeni URL'ler kontrol edilir (gereksiz trafik yok).
 *  - Eşzamanlı havuz (CONCURRENCY) ile hızlı; state'ten artık master'da olmayan kayıtlar temizlenir.
 *  - opts: { fetchImpl, now, concurrency, ttlMs, limit }  (limit>0 → bu run'da en çok N kontrol)
 */
export async function scanAll(masterText, prevState, opts = {}) {
  const nowFn = opts.now || (() => Date.now());
  const t = nowFn();
  const fetchImpl = opts.fetchImpl || fetch;
  const conc = opts.concurrency || HEALTH_CFG.CONCURRENCY;
  const ttl = (opts.ttlMs != null) ? opts.ttlMs : HEALTH_CFG.HEALTH_TTL_MS;
  const limit = opts.limit || 0;

  const entries = parseM3U(masterText);
  const breakdown = { total: entries.length, checkable: 0, youtube: 0, acestream: 0, nonhttp: 0, empty: 0 };

  const seen = new Set();
  const targets = [];
  for (const e of entries) {
    const cls = classifyUrl(e.url);
    if (cls.kind === "youtube") breakdown.youtube++;
    else if (cls.kind === "acestream") breakdown.acestream++;
    else if (cls.kind === "nonhttp") breakdown.nonhttp++;
    else if (cls.kind === "empty") breakdown.empty++;
    if (!cls.checkable) continue;
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    targets.push({ url: e.url, key: urlKeyHex(e.url), cls });
  }
  breakdown.checkable = targets.length;

  // state'i buda: yalnız güncel master'daki checkable URL kayıtlarını taşı (sınırsız büyümeyi önle).
  const prev = prevState && typeof prevState === "object" ? prevState : {};
  const state = {};
  for (const tg of targets) if (prev[tg.key]) state[tg.key] = prev[tg.key];

  // kontrol edilecekler: taze olmayanlar (veya yeni). ttl=0 → hepsi.
  let toCheck = targets.filter((x) => { const p = state[x.key]; return !p || (t - (p.ts || 0) >= ttl); });
  if (limit && limit > 0) toCheck = toCheck.slice(0, limit);

  let idx = 0, checked = 0, timeouts = 0, neterrs = 0;
  async function worker() {
    while (idx < toCheck.length) {
      const cur = toCheck[idx++];
      const probe = await probeUrl(cur.url, { fetchImpl, classify: cur.cls, now: () => nowFn() });
      if (probe.error === "timeout") timeouts++;
      else if (probe.error && probe.error.startsWith("neterr")) neterrs++;
      state[cur.key] = nextRecord(state[cur.key], probe, nowFn());
      checked++;
    }
  }
  const pool = Array.from({ length: Math.max(1, Math.min(conc, toCheck.length || 1)) }, () => worker());
  await Promise.all(pool);

  return { state, breakdown, checked, timeouts, neterrs, stats: computeStats(state, t) };
}

/**
 * CLEAN M3U SNAPSHOT üret: master'ı satır satır gez, yalnız KESİN DEAD checkable URL'leri (ve
 * onların #EXTINF başlığını) ELE. YouTube/AceStream/non-HTTP ve HEALTHY/TEMP/UNKNOWN → KALIR.
 * Master ASLA değiştirilmez — bu yalnız türetilmiş çıktı. Aynı kanalda sağlıklı alternatif varsa,
 * DEAD olan zaten elendiği için sağlıklı olan kendiliğinden görünür.
 */
export function buildCleanM3U(masterText, state) {
  const lines = String(masterText || "").split(/\r?\n/);
  const out = [];
  let held = [];
  let kept = 0, removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.startsWith("#EXTM3U")) { out.push(raw); continue; }
    if (line.startsWith("#")) { held.push(raw); continue; }
    if (!line) { if (held.length) { out.push(...held); held = []; } out.push(raw); continue; }
    const cls = classifyUrl(line);
    let drop = false;
    if (cls.checkable) {
      const rec = state[urlKeyHex(line)];
      if (rec && rec.status === HEALTH_CFG.ST_DEAD) drop = true;
    }
    if (drop) { removed++; held = []; }
    else { if (held.length) { out.push(...held); held = []; } out.push(raw); kept++; }
  }
  if (held.length) out.push(...held);
  return { body: out.join("\n"), kept, removed };
}
