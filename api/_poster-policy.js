const EXCLUDED_REFERENCES = [
  /\bgrateful\s+dead\b/i,
  /\bsteal\s+your\s+face\b/i,
  /\bstealie\b/i,
  /\bdancing\s+bears?\b/i,
  /\bmarching\s+bears?\b/i,
  /\b13[ -]?point\s+lightning\s+bolt\b/i
];

export const POSTER_STYLES = ["psychedelic", "cosmic-bluegrass", "southern-gothic", "scenic", "funk", "vintage"];
export const POSTER_LAYOUTS = ["gallery", "corner", "split", "minimal"];

export function cleanPosterText(value, max) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

export function hasExcludedReference(...values) {
  const text = values.filter(value => typeof value === "string").join(" ");
  return EXCLUDED_REFERENCES.some(pattern => pattern.test(text));
}

export function sanitizeStyle(value) {
  return POSTER_STYLES.includes(value) ? value : "psychedelic";
}

export function sanitizeLayout(value) {
  return POSTER_LAYOUTS.includes(value) ? value : "gallery";
}

export function exclusionError() {
  return "GOOD TIMES does not create Grateful Dead-related artwork. Please choose a different concert memory.";
}
