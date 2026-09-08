import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTypographySvgV2 } from "../api/finalize-artwork.js";
import generatePoster from "../api/generate-poster.js";
import { POSTER_LAYOUTS, POSTER_STYLES, hasExcludedReference, sanitizeLayout, sanitizeStyle } from "../api/_poster-policy.js";

function response() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test("multi-band poster styles and typography layouts are server-approved", () => {
  assert.deepEqual(POSTER_STYLES, ["psychedelic", "cosmic-bluegrass", "southern-gothic", "scenic", "funk", "vintage"]);
  assert.deepEqual(POSTER_LAYOUTS, ["gallery", "corner", "split", "minimal"]);
  assert.equal(sanitizeStyle("cosmic-bluegrass"), "cosmic-bluegrass");
  assert.equal(sanitizeStyle("unknown"), "psychedelic");
  assert.equal(sanitizeLayout("minimal"), "minimal");
  assert.equal(sanitizeLayout("unknown"), "gallery");
});

test("Grateful Dead names and recognizable marks are excluded", () => {
  assert.equal(hasExcludedReference("Grateful Dead"), true);
  assert.equal(hasExcludedReference("a dancing bears poster"), true);
  assert.equal(hasExcludedReference("Steal Your Face"), true);
  assert.equal(hasExcludedReference("Billy Strings at the Gorge"), false);
});

test("every final typography layout creates a distinct art-first overlay", () => {
  const base = { artist: "Night Bloom", venue: "The Riverside Pavilion", city: "Asheville, NC", date: "2026-08-18", song: "Under the stars", style: "cosmic-bluegrass" };
  const svgs = POSTER_LAYOUTS.map(layout => buildTypographySvgV2({ ...base, layout }).toString("utf8"));
  assert.equal(new Set(svgs).size, POSTER_LAYOUTS.length);
  for (const svg of svgs) {
    assert.match(svg, /<svg width="3600" height="4800"/);
    assert.doesNotMatch(svg, /PHISH/);
  }
});

test("the page JavaScript compiles and exposes multi-band controls", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /id="artist"/);
  assert.match(html, /data-style="cosmic-bluegrass"/);
  assert.match(html, /data-layout="minimal"/);
  assert.doesNotMatch(html, /Your Phish show/);
});

test("AI direction rejects excluded projects before calling OpenAI", async () => {
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-never-sent";
  const res = response();
  await generatePoster({
    method: "POST",
    headers: { origin: "https://jell-lab-poster-project.vercel.app", "x-forwarded-for": "poster-policy-test" },
    body: { artist: "Grateful Dead", date: "1977-05-08", venue: "Barton Hall", style: "psychedelic", layout: "gallery" }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.reason, "excluded_artist");
  if (priorKey) process.env.OPENAI_API_KEY = priorKey;
  else delete process.env.OPENAI_API_KEY;
});
