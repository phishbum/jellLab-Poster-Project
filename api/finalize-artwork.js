import { get, put } from "@vercel/blob";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";

const WIDTH = 3600;
const HEIGHT = 4800;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 8;
const requestBuckets = new Map();
const require = createRequire(import.meta.url);
const POSTER_FONT = readFileSync(require.resolve("@fontsource/inter/files/inter-latin-900-normal.woff2")).toString("base64");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

function clean(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set([
    "https://jell-lab-poster-project.vercel.app",
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3210",
    "http://127.0.0.1:3210"
  ]);
  return allowed.has(origin);
}

function underRateLimit(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  const bucket = requestBuckets.get(forwarded);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    requestBuckets.set(forwarded, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= MAX_REQUESTS) return false;
  bucket.count += 1;
  return true;
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}

function wrapWords(value, maxChars, maxLines) {
  const words = value.split(/\s+/).filter(Boolean).flatMap(word => {
    if (word.length <= maxChars) return word;
    const chunks = [];
    for (let index = 0; index < word.length; index += maxChars) chunks.push(word.slice(index, index + maxChars));
    return chunks;
  });
  const lines = [];
  for (const word of words) {
    const current = lines[lines.length - 1] || "";
    if (!current || `${current} ${word}`.length > maxChars) {
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s*…$/, "")}…`;
        break;
      }
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${current} ${word}`;
    }
  }
  return lines;
}

function textLines(lines, x, y, lineHeight, attributes) {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" ${attributes}>${escapeXml(line)}</text>`).join("");
}

export function buildTypographySvg({ venue, city, date, song, style }) {
  const venueLines = wrapWords(venue.toUpperCase(), 14, 3);
  const songLines = song ? wrapWords(song.toUpperCase(), 30, 2) : [];
  const accent = style === "vintage" ? "#ffd58d" : "#73f4cf";
  const longestVenueLine = Math.max(...venueLines.map(line => line.length), 1);
  const venueSize = longestVenueLine > 12 ? 290 : longestVenueLine > 9 ? 320 : 350;
  const venueStart = 3530 - (venueLines.length - 1) * 320;
  const songStart = 4240 - (songLines.length - 1) * 135;
  const detail = [city.toUpperCase(), date.toUpperCase()].filter(Boolean).join("  •  ");

  return Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>@font-face{font-family:PosterInter;src:url(data:font/woff2;base64,${POSTER_FONT}) format('woff2');font-weight:900}text{font-family:PosterInter,sans-serif}</style>
        <linearGradient id="topShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05030d" stop-opacity=".88"/><stop offset="1" stop-color="#05030d" stop-opacity="0"/></linearGradient>
        <linearGradient id="bottomShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05030d" stop-opacity="0"/><stop offset=".42" stop-color="#05030d" stop-opacity=".64"/><stop offset="1" stop-color="#05030d" stop-opacity=".96"/></linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity=".85"/></filter>
      </defs>
      <rect width="${WIDTH}" height="1050" fill="url(#topShade)"/>
      <rect y="2700" width="${WIDTH}" height="2100" fill="url(#bottomShade)"/>
      <rect x="92" y="92" width="3416" height="4616" rx="14" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="8"/>
      <g font-family="PosterInter, sans-serif" fill="#fff" filter="url(#shadow)">
        <text x="230" y="510" font-size="330" font-weight="900" letter-spacing="60">PHISH</text>
        <text x="3370" y="470" text-anchor="end" font-size="80" font-weight="800" letter-spacing="16">GOOD TIMES</text>
        <text x="230" y="${venueStart - 380}" fill="${accent}" font-size="78" font-weight="900" letter-spacing="18">CONCERT MEMORY</text>
        ${textLines(venueLines, 230, venueStart, 320, `font-size="${venueSize}" font-weight="900" letter-spacing="-12"`)}
        <text x="230" y="3990" font-size="94" font-weight="800" letter-spacing="10">${escapeXml(detail)}</text>
        ${textLines(songLines, 230, songStart, 135, `fill="${accent}" font-size="112" font-weight="900" letter-spacing="8"`)}
      </g>
    </svg>
  `);
}

export async function composePrintMaster(sourceBytes, details) {
  const background = await sharp(sourceBytes)
    .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return sharp(background)
    .composite([{ input: buildTypographySvg(details), top: 0, left: 0 }])
    .withMetadata({ density: 300 })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Origin");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST for this endpoint." });
  }
  if (!allowedOrigin(req)) return res.status(403).json({ error: "This request origin is not allowed." });
  if (!underRateLimit(req)) return res.status(429).json({ error: "Several print files were just prepared. Please wait a moment." });
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: "Secure artwork storage is temporarily unavailable." });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "The request body must be valid JSON." });
  }

  const source = body.source && typeof body.source === "object" ? body.source : {};
  const sourceId = clean(source.id, 40);
  const sourceToken = clean(source.token, 70);
  const details = {
    venue: clean(body.venue, 120),
    city: clean(body.city, 100),
    date: clean(body.date, 20),
    song: clean(body.song, 180),
    style: ["psychedelic", "scenic", "vintage"].includes(body.style) ? body.style : "psychedelic"
  };
  if (!UUID_PATTERN.test(sourceId) || !TOKEN_PATTERN.test(sourceToken)) return res.status(400).json({ error: "That generated artwork link is invalid." });
  if (!details.venue || !details.date) return res.status(400).json({ error: "Venue and show date are required." });

  try {
    const sourceResult = await get(`generations/${sourceId}-${sourceToken}.webp`, { access: "private" });
    if (!sourceResult || sourceResult.statusCode !== 200) return res.status(404).json({ error: "The generated artwork could not be found." });
    const sourceBytes = Buffer.from(await new Response(sourceResult.stream).arrayBuffer());
    const finalBytes = await composePrintMaster(sourceBytes, details);
    if (!finalBytes.length || finalBytes.length > 35 * 1024 * 1024) throw new Error("The composed print file size was invalid.");

    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const pathname = `finals/${id}-${token}.jpg`;
    await put(pathname, finalBytes, { access: "private", addRandomSuffix: false, contentType: "image/jpeg" });
    const createdAt = new Date().toISOString();
    const record = { id, pathname, kind: "print-master", contentType: "image/jpeg", size: `${WIDTH}x${HEIGHT}`, density: 300, sourceId, createdAt };
    await put(`records/${id}-${token}.json`, JSON.stringify(record), { access: "private", addRandomSuffix: false, contentType: "application/json" });

    const query = `id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
    return res.status(200).json({ finalArtwork: { id, token, assetUrl: `/api/artwork?${query}`, downloadUrl: `/api/artwork?${query}&download=1`, kind: "print-master", format: "JPEG", size: `${WIDTH}x${HEIGHT}`, density: 300, createdAt } });
  } catch (error) {
    console.error("Print-master composition failed.", { name: error?.name || "Error", message: error?.message || "Unknown error" });
    return res.status(502).json({ error: "The print-ready artwork could not be prepared. Please try again." });
  }
}
