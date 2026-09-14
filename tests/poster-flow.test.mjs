import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
    assert.match(svg, /INDEPENDENT ARTWORK BY GOOD TIMES/);
    assert.match(svg, /NOT AFFILIATED WITH OR ENDORSED BY THE PERFORMER OR VENUE/);
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

test("layout switching preserves the paid illustration and explains the no-credit workflow", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /switching layouts never spends another AI image credit/);
  assert.match(html, /if\(artworkGeneration\)\{const replacedFinal=Boolean\(finalArtwork\);finalArtwork=null;artworkApproved=false;renderArtwork\(artworkGeneration\)/);
  assert.match(html, /Your illustration is preserved/);
  assert.match(html, /layout-option\[data-layout="minimal"\]:after/);
});

test("the browser ships one artwork flow and no obsolete direct payment links", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const signature of [
    "function syncPreviewState(",
    "function clearArtwork(",
    "function renderArtwork(",
    "async function generateArtwork(",
    "function approveArtwork(",
    "function reviewOrder("
  ]) {
    assert.equal(html.split(signature).length - 1, 1, `${signature} should be defined once`);
  }
  assert.doesNotMatch(html, /buy\.stripe\.com\/test_/);
  assert.match(html, /\/api\/create-checkout-session/);
});

test("the gallery presents six distinct art-first poster directions", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /The art should take you back/);
  assert.match(html, /High Country Orbit/);
  assert.match(html, /Low Country Moon/);
  assert.match(html, /Frequency Garden/);
  assert.equal((html.match(/artist:'/g) || []).length >= 6, true);
  for (const asset of ["cosmic-bluegrass.jpg", "southern-gothic.jpg", "funk-geometry.jpg"]) {
    assert.equal(existsSync(new URL(`../assets/${asset}`, import.meta.url)), true);
  }
});

test("the memory field explains that richer details improve the artwork", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /The more we can feel, the better the artwork becomes/);
  assert.match(html, /people, weather, ground, temperature, colors, lights, sounds, movement/);
});

test("the experience asks for sensory memory and promises to bring the moment back", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const directionSource = readFileSync(new URL("../api/generate-poster.js", import.meta.url), "utf8");
  const artworkSource = readFileSync(new URL("../api/generate-artwork.js", import.meta.url), "utf8");
  assert.match(html, /FEEL THE<br><span class="accent">NIGHT\. AGAIN\./);
  assert.match(html, /What did the air feel like\?/);
  assert.match(html, /LIFE IS SHORT\.<br>MOMENTS CAN BE FOREVER\./);
  assert.match(directionSource, /Translate sensory details into visual decisions/);
  assert.match(artworkSource, /Translate the supplied sensory memory into the image/);
});

test("issue one rebrands the homepage around memory art and the permanent collection", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const required of [
    "FEEL THE<br><span class=\"accent\">NIGHT. AGAIN.",
    "THE GOOD TIMES COLLECTION",
    "GOOD TIMES No. 001",
    "THE ARCHIVE",
    "MADE FOR MEMORIES.",
    "YOUR GOOD TIME",
    "SHARED GOOD TIMES",
    "HOW WE CREATE",
    "Technology helps create the art. The memory is why it exists.",
    "private by default"
  ]) assert.match(html, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /assets\/good-times-no-001-phish-final\.png/);
  assert.match(html, /Good Times is an independent art studio/);
  assert.doesNotMatch(html, /Your concert\.<br>Your memory/);
});

test("the launch experience stays concert-focused", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /The art should take you back/);
  assert.match(html, /First shows, unforgettable encores, miracle tickets/);
  assert.doesNotMatch(html, /The art should stop the scroll/);
  assert.doesNotMatch(html, /weddings, road trips, a kid's first game/);
});

test("the first style offers a colorful and trippy illustrated direction", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const directionSource = readFileSync(new URL("../api/generate-poster.js", import.meta.url), "utf8");
  assert.match(html, /Colorful &amp; trippy/);
  assert.match(html, /Playful characters, impossible worlds, vibrating color/);
  assert.match(html, /background-image:url\('assets\/hero-musical-carnival\.png'\)/);
  assert.match(directionSource, /treat it as COLORFUL & TRIPPY/);
  assert.match(directionSource, /rather than generic fractals or formless swirls/);
});

test("the site promises a visible independence statement on every finished poster", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Visible on every finished poster/);
  assert.match(html, /Each print includes a small, readable edge statement/);
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
