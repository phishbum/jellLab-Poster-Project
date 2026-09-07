import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 30;
const requestBuckets = new Map();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

let sqlClient;
let schemaReady;

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getSql()`
      CREATE TABLE IF NOT EXISTS poster_projects (
        id UUID PRIMARY KEY,
        access_hash CHAR(64) NOT NULL,
        project_data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.catch(error => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
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

function clean(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max) : "";
}

function cleanDirection(value) {
  const source = value && typeof value === "object" ? value : null;
  if (!source) return null;
  return {
    headline: clean(source.headline, 70),
    tagline: clean(source.tagline, 120),
    concept: clean(source.concept, 700),
    composition: clean(source.composition, 400),
    typography: clean(source.typography, 280),
    motifs: Array.isArray(source.motifs) ? source.motifs.slice(0, 5).map(item => clean(item, 80)).filter(Boolean) : [],
    palette: Array.isArray(source.palette) ? source.palette.slice(0, 5).filter(item => /^#[0-9a-f]{6}$/i.test(item)) : [],
    image_prompt: clean(source.image_prompt, 1200)
  };
}

function cleanArtwork(value) {
  const source = value && typeof value === "object" ? value : null;
  if (!source || !UUID_PATTERN.test(source.id) || !TOKEN_PATTERN.test(source.token)) return null;
  const query = `id=${encodeURIComponent(source.id)}&token=${encodeURIComponent(source.token)}`;
  return {
    id: source.id,
    token: source.token,
    assetUrl: `/api/artwork?${query}`,
    downloadUrl: `/api/artwork?${query}&download=1`,
    model: clean(source.model, 80),
    quality: clean(source.quality, 30),
    size: clean(source.size, 30),
    kind: clean(source.kind, 30),
    format: clean(source.format, 20),
    density: Number.isFinite(Number(source.density)) ? Number(source.density) : null,
    createdAt: clean(source.createdAt, 40),
    estimatedImageOutputCostUsd: Number.isFinite(Number(source.estimatedImageOutputCostUsd)) ? Number(source.estimatedImageOutputCostUsd) : null
  };
}

function cleanProject(value) {
  const source = value && typeof value === "object" ? value : {};
  const artworkGeneration = cleanArtwork(source.artworkGeneration);
  const finalArtwork = cleanArtwork(source.finalArtwork);
  const format = ["Digital file", "Printed poster"].includes(source.format) ? source.format : "Digital file";
  const size = ["12 × 16 in", "18 × 24 in"].includes(source.size) ? source.size : "12 × 16 in";
  return {
    date: clean(source.date, 20),
    venue: clean(source.venue, 120),
    city: clean(source.city, 100),
    song: clean(source.song, 180),
    memory: clean(source.memory, 1400),
    style: ["psychedelic", "scenic", "vintage"].includes(source.style) ? source.style : "psychedelic",
    aiDirection: cleanDirection(source.aiDirection),
    artworkGeneration,
    finalArtwork,
    artworkApproved: Boolean(source.artworkApproved && finalArtwork),
    format,
    size,
    total: (format === "Printed poster" ? 49 : 24) + (size === "18 × 24 in" ? 20 : 0)
  };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validSecret(candidate, storedHash) {
  if (!TOKEN_PATTERN.test(candidate) || !TOKEN_PATTERN.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashToken(candidate), "hex"), Buffer.from(storedHash, "hex"));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Vary", "Origin");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST for this endpoint." });
  }
  if (!allowedOrigin(req)) return res.status(403).json({ error: "This request origin is not allowed." });
  if (!underRateLimit(req)) return res.status(429).json({ error: "Too many project requests. Please wait a moment." });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Permanent project saving is temporarily unavailable." });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "The request body must be valid JSON." });
  }

  try {
    await ensureSchema();
    const sql = getSql();

    if (body.action === "load") {
      const id = clean(body.id, 40);
      const token = clean(body.token, 70);
      if (!UUID_PATTERN.test(id) || !TOKEN_PATTERN.test(token)) return res.status(400).json({ error: "That private project link is invalid." });
      const rows = await sql`SELECT access_hash, project_data, updated_at FROM poster_projects WHERE id = ${id} LIMIT 1`;
      if (!rows.length || !validSecret(token, rows[0].access_hash)) return res.status(404).json({ error: "That private project could not be found." });
      return res.status(200).json({ project: rows[0].project_data, updatedAt: rows[0].updated_at });
    }

    if (body.action !== "save") return res.status(400).json({ error: "Choose save or load." });
    const project = cleanProject(body.project);
    if (!project.date || !project.venue) return res.status(400).json({ error: "Add a show date and venue before saving." });

    const existingId = clean(body.id, 40);
    const existingToken = clean(body.token, 70);
    if (existingId || existingToken) {
      if (!UUID_PATTERN.test(existingId) || !TOKEN_PATTERN.test(existingToken)) return res.status(400).json({ error: "That private project key is invalid." });
      const rows = await sql`SELECT access_hash FROM poster_projects WHERE id = ${existingId} LIMIT 1`;
      if (!rows.length || !validSecret(existingToken, rows[0].access_hash)) return res.status(404).json({ error: "That private project could not be updated." });
      await sql`UPDATE poster_projects SET project_data = ${JSON.stringify(project)}::jsonb, updated_at = NOW() WHERE id = ${existingId}`;
      return res.status(200).json({ id: existingId, token: existingToken, updatedAt: new Date().toISOString() });
    }

    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const accessHash = hashToken(token);
    await sql`INSERT INTO poster_projects (id, access_hash, project_data) VALUES (${id}, ${accessHash}, ${JSON.stringify(project)}::jsonb)`;
    return res.status(201).json({ id, token, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Permanent project request failed.", { name: error?.name || "Error", message: error?.message || "Unknown error" });
    return res.status(502).json({ error: "The private project could not be saved or loaded. Please try again." });
  }
}
