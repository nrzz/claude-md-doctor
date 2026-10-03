// Small text helpers shared by the checks: normalizing lines for comparison, a light stemmer,
// set similarity, slugs and edit distance.

/** Lowercase words of a line with markdown, punctuation and apostrophes removed. */
export function normalize(text) {
  return String(text ?? "")
    .replace(/!?\[([^\]]{0,300})\]\([^)]{0,400}\)/g, "$1") // links keep their text
    .replace(/<[^>\n]{1,200}>/g, " ") // html tags
    .replace(/[`*_~]+/g, " ") // emphasis and code ticks
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const wordsOf = (text) => normalize(text).split(" ").filter(Boolean);

/** Jaccard similarity of two Sets: 1 for the same set, 0 for none shared. */
export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (large.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export const STOPWORDS = new Set((
  "a an the and or but if then else when while of to in on at by for with from into onto over under about as is are was were be been being " +
  "it its this that these those there here you your we our they their them i me my he she his her us do does did doing done has have had having " +
  "can could should would will shall may might must not no nor so than too very just also only any all each every some more most other such " +
  "which who whom whose what where why how up down out off again further once both few own same s t don dont"
).split(" "));

const DOUBLED = /(tt|pp|gg|nn|mm|rr|bb)$/;

/** A light stemmer, enough to match "commit", "commits" and "committing". Not a linguistic one. */
export function stem(word) {
  let w = word;
  if (w.length > 3 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ing")) w = w.slice(0, -3).replace(DOUBLED, (m) => m[0]);
  else if (w.length > 3 && w.endsWith("ed")) w = w.slice(0, -2).replace(DOUBLED, (m) => m[0]);
  else if (w.length > 3 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 2 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Stemmed content words of a phrase (stop words dropped), as an array. */
export const contentWords = (text) => wordsOf(text).filter((w) => !STOPWORDS.has(w)).map(stem);

/** A lowercase a-z0-9 slug with single hyphens, cut at a hyphen near `max` characters. */
export function slugify(s, max = 40) {
  const full = String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= max) return full;
  const cut = full.slice(0, max);
  const at = cut.lastIndexOf("-");
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/-+$/, "");
}

/** One line, at most `max` characters, with "..." when cut. */
export function clip(s, max = 100) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 3)).trimEnd()}...` : t;
}

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Edit distance between two short strings. */
export function distance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The candidate closest to `name` within `max` edits, or null. */
export function closest(name, candidates, max = 2) {
  let best = null;
  let bestDist = max + 1;
  for (const c of candidates) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// ---- finding similar sets without comparing everything with everything ----

/**
 * An index for "which earlier sets have a Jaccard similarity of at least `threshold` with this
 * one?". It uses prefix filtering: order every word by how rare it is in the whole collection, and
 * two sets that are similar enough must share a word among their first few (their "prefix"). So
 * only sets that share a prefix word are compared, instead of every pair.
 */
export class SimilarityIndex {
  constructor(sets, threshold) {
    this.threshold = threshold;
    const freq = new Map();
    for (const set of sets) for (const w of set) freq.set(w, (freq.get(w) || 0) + 1);
    const order = [...freq.keys()].sort((a, b) => freq.get(a) - freq.get(b) || (a < b ? -1 : a > b ? 1 : 0));
    this.rank = new Map(order.map((w, i) => [w, i]));
    this.postings = new Map(); // word -> ids of the sets that have it in their prefix
  }

  prefix(set) {
    const words = [...set].sort((a, b) => this.rank.get(a) - this.rank.get(b));
    const keep = words.length - Math.ceil(this.threshold * words.length) + 1;
    return words.slice(0, Math.max(1, keep));
  }

  add(id, set) {
    for (const w of this.prefix(set)) {
      if (!this.postings.has(w)) this.postings.set(w, []);
      this.postings.get(w).push(id);
    }
  }

  /** Ids added so far that could be similar to `set`, in ascending order. */
  candidates(set) {
    const out = new Set();
    for (const w of this.prefix(set)) for (const id of this.postings.get(w) || []) out.add(id);
    return [...out].sort((a, b) => a - b);
  }
}
