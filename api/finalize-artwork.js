import { get, put } from "@vercel/blob";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import opentype from "opentype.js";
import sharp from "sharp";
import { cleanPosterText, exclusionError, hasExcludedReference, sanitizeLayout, sanitizeStyle } from "./_poster-policy.js";

const WIDTH = 3600;
const HEIGHT = 4800;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 8;
const requestBuckets = new Map();
const require = createRequire(import.meta.url);
const fontBytes = readFileSync(require.resolve("@fontsource/inter/files/inter-latin-900-normal.woff"));
const POSTER_FONT = opentype.parse(fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

const clean = cleanPosterText;

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

function pathText(value, x, y, fontSize, { letterSpacing = 0, anchor = "start", fill = "#fff" } = {}) {
  const glyphs = POSTER_FONT.stringToGlyphs(value);
  const scale = fontSize / POSTER_FONT.unitsPerEm;
  let width = 0;
  for (let index = 0; index < glyphs.length; index += 1) {
    if (index) width += POSTER_FONT.getKerningValue(glyphs[index - 1], glyphs[index]) * scale;
    width += (glyphs[index].advanceWidth || POSTER_FONT.unitsPerEm) * scale;
    if (index < glyphs.length - 1) width += letterSpacing;
  }
  let cursor = anchor === "end" ? x - width : x;
  const paths = [];
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    if (index) cursor += POSTER_FONT.getKerningValue(glyphs[index - 1], glyph) * scale;
    paths.push(glyph.getPath(cursor, y, fontSize).toPathData(1));
    cursor += (glyph.advanceWidth || POSTER_FONT.unitsPerEm) * scale + letterSpacing;
  }
  return `<path d="${paths.join(" ")}" fill="${fill}"/>`;
}

function pathLines(lines, x, y, lineHeight, fontSize, options) {
  return lines.map((line, index) => pathText(line, x, y + index * lineHeight, fontSize, options)).join("");
}

export function buildTypographySvg(details) {
  return buildTypographySvgV2(details);
}

function fitSize(value, maxWidth, preferred, minimum, letterSpacing = 0) {
  const glyphs = POSTER_FONT.stringToGlyphs(value);
  const units = glyphs.reduce((sum, glyph, index) => sum + (glyph.advanceWidth || POSTER_FONT.unitsPerEm) + (index ? POSTER_FONT.getKerningValue(glyphs[index - 1], glyph) : 0), 0);
  if (!units) return preferred;
  const spacing = Math.max(0, value.length - 1) * letterSpacing;
  return Math.max(minimum, Math.min(preferred, (maxWidth - spacing) * POSTER_FONT.unitsPerEm / units));
}

export function buildTypographySvgV2({ artist, venue, city, date, song, style, layout }) {
  const safeArtist = clean(artist, 120).toUpperCase();
  const safeVenue = clean(venue, 120).toUpperCase();
  const safeCity = clean(city, 100).toUpperCase();
  const safeDate = clean(date, 20).toUpperCase();
  const safeSong = clean(song, 180).toUpperCase();
  const selectedLayout = sanitizeLayout(layout);
  const selectedStyle = sanitizeStyle(style);
  const accent = selectedStyle === "vintage" ? "#ffd58d" : selectedStyle === "southern-gothic" ? "#e5ad70" : selectedStyle === "cosmic-bluegrass" ? "#87d7ff" : "#73f4cf";
  const artistSize = fitSize(safeArtist, 2860, selectedLayout === "minimal" ? 170 : 220, 112, 18);
  const venueSize = fitSize(safeVenue, 2850, selectedLayout === "corner" ? 150 : 175, 92, 4);
  const detail = [safeVenue, safeCity, safeDate].filter(Boolean).join("  •  ");
  const compactDetailSize = fitSize(detail, 3000, 88, 58, 5);
  const songLabel = safeSong ? `MEMORY: ${safeSong}` : "ONE NIGHT. YOUR STORY.";
  const songSize = fitSize(songLabel, 2860, 92, 58, 4);

  const layouts = {
    gallery: `
      <rect width="${WIDTH}" height="760" fill="url(#topShade)"/>
      <rect y="3740" width="${WIDTH}" height="1060" fill="url(#bottomShade)"/>
      ${pathText(safeArtist, 220, 390, artistSize, { letterSpacing: 18 })}
      ${pathText("GOOD TIMES / CONCERT MEMORY", 3380, 350, 58, { letterSpacing: 9, anchor: "end", fill: accent })}
      ${pathText(safeVenue, 220, 4200, venueSize, { letterSpacing: 4 })}
      ${pathText([safeCity, safeDate].filter(Boolean).join("  •  "), 220, 4390, 78, { letterSpacing: 6 })}
      ${pathText(songLabel, 220, 4590, songSize, { letterSpacing: 4, fill: accent })}`,
    corner: `
      <rect x="125" y="125" width="1430" height="570" rx="28" fill="#05030d" fill-opacity=".72"/>
      <rect y="4050" width="${WIDTH}" height="750" fill="url(#bottomShade)"/>
      ${pathText("GOOD TIMES", 220, 280, 58, { letterSpacing: 14, fill: accent })}
      ${pathText(safeArtist, 220, 545, artistSize, { letterSpacing: 12 })}
      ${pathText(detail, 3380, 4385, compactDetailSize, { letterSpacing: 5, anchor: "end" })}
      ${pathText(songLabel, 3380, 4580, songSize, { letterSpacing: 4, anchor: "end", fill: accent })}`,
    split: `
      <rect width="${WIDTH}" height="650" fill="url(#topShade)"/>
      <rect y="3960" width="${WIDTH}" height="840" fill="url(#bottomShade)"/>
      ${pathText("GOOD TIMES", 220, 300, 60, { letterSpacing: 16, fill: accent })}
      ${pathText(safeArtist, 3380, 430, artistSize, { letterSpacing: 14, anchor: "end" })}
      ${pathText(safeVenue, 220, 4330, venueSize, { letterSpacing: 4 })}
      ${pathText([safeCity, safeDate].filter(Boolean).join("  •  "), 220, 4515, 74, { letterSpacing: 5 })}
      ${pathText(songLabel, 3380, 4515, songSize, { letterSpacing: 3, anchor: "end", fill: accent })}`,
    minimal: `
      <rect y="4100" width="${WIDTH}" height="700" fill="url(#bottomShade)"/>
      <rect x="180" y="180" width="12" height="380" fill="${accent}"/>
      ${pathText(safeArtist, 245, 360, artistSize, { letterSpacing: 12 })}
      ${pathText("A GOOD TIMES CONCERT MEMORY", 245, 505, 52, { letterSpacing: 10, fill: accent })}
      ${pathText(detail, 220, 4420, compactDetailSize, { letterSpacing: 5 })}
      ${pathText(songLabel, 220, 4600, songSize, { letterSpacing: 4, fill: accent })}`
  };

  return Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="topShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05030d" stop-opacity=".82"/><stop offset="1" stop-color="#05030d" stop-opacity="0"/></linearGradient>
        <linearGradient id="bottomShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05030d" stop-opacity="0"/><stop offset=".45" stop-color="#05030d" stop-opacity=".58"/><stop offset="1" stop-color="#05030d" stop-opacity=".9"/></linearGradient>
      </defs>
      <rect x="92" y="92" width="3416" height="4616" rx="14" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="7"/>
      ${layouts[selectedLayout]}
    </svg>
  `);
}

export async function composePrintMaster(sourceBytes, details) {
  const background = await sharp(sourceBytes)
    .resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return sharp(background)
    .composite([{ input: buildTypographySvgV2(details), top: 0, left: 0 }])
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
    artist: clean(body.artist, 120),
    venue: clean(body.venue, 120),
    city: clean(body.city, 100),
    date: clean(body.date, 20),
    song: clean(body.song, 180),
    style: sanitizeStyle(body.style),
    layout: sanitizeLayout(body.layout)
  };
  if (!UUID_PATTERN.test(sourceId) || !TOKEN_PATTERN.test(sourceToken)) return res.status(400).json({ error: "That generated artwork link is invalid." });
  if (!details.artist || !details.venue || !details.date) return res.status(400).json({ error: "Artist, venue, and show date are required." });
  if (hasExcludedReference(details.artist, details.song)) return res.status(400).json({ error: exclusionError() });

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
