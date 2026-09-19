#!/usr/bin/env node
/**
 * SilaTV PRO — clean.m3u'yu byte-safe chunk'lara böler. KV'ye YAZMAZ.
 * Girdi : OUT_DIR/clean.m3u
 * Çıktı : OUT_DIR/chunks/000,001,...   (ham byte parçaları)
 *         OUT_DIR/clean-parts.json
 * Health mantığına DOKUNMAZ; scan.mjs'e dokunmaz.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = process.env.OUT_DIR || "out";
const CHUNK = parseInt(
  process.env.CHUNK_BYTES || String(8 * 1024 * 1024),
  10
);
const src = path.join(OUT, "clean.m3u");

const buf = fs.readFileSync(src);
const dir = path.join(OUT, "chunks");

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const n = Math.max(1, Math.ceil(buf.length / CHUNK));

for (let i = 0; i < n; i++) {
  const part = buf.subarray(
    i * CHUNK,
    Math.min((i + 1) * CHUNK, buf.length)
  );

  fs.writeFileSync(
    path.join(dir, String(i).padStart(3, "0")),
    part
  );
}

const meta = {
  chunks: n,
  chunkBytes: CHUNK,
  totalBytes: buf.length,
  sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(
  path.join(OUT, "clean-parts.json"),
  JSON.stringify(meta, null, 2)
);

console.log(
  `split: ${meta.totalBytes} bytes -> ${meta.chunks} chunk (${CHUNK} B/chunk) sha256=${meta.sha256}`
);
