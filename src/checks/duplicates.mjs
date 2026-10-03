// duplicate: the same instruction twice, within one file or across files (user, parent, project,
// local, imports). Two list items or paragraphs count as the same when, normalized, they are
// identical, or share at least 85 percent of their words (Jaccard on word sets) and both have at
// least five words. Lines that differ in polarity ("always" against "never", "not") or in a
// number are not duplicates; the conflict check looks at polarity.
//
// Which copy is reported: the later one in load order, unless the later copy sits in an imported
// file we do not rewrite and the earlier one is in a memory file we do: then the memory file's
// copy is the one to drop.
//
// --fix removes only exact repeats. A near repeat can differ in the one word that matters (main
// against trunk), so it is reported with the words that differ and left for a person to merge.
import { lineSlice, textUnits } from "../markdown.mjs";
import { importCandidates } from "../imports.mjs";
import { linesTokens } from "../tokens.mjs";
import { clip, jaccard, SimilarityIndex, wordsOf } from "../text.mjs";
import { makeFinding } from "../findings.mjs";

const THRESHOLD = 0.85;
const MIN_WORDS = 5;
const MIN_WEIGHT = 30; // an identical line with fewer words still counts when it is this long

const POLARITY = new Set(("always never not no dont doesnt cant cannot avoid without must mustnt should shouldnt only stop forbidden prohibited disallow").split(" "));

// The one-line pointers --fix writes ("Release: use the `release` skill.") are never duplicates.
export const POINTER = /\buse the `[a-z0-9][a-z0-9-]*` skill\b/i;

// What must match for two lines to be the same instruction: the same polarity words, and the same
// numbers (use port 3000 is not use port 8080, and step 4 is not step 5).
const signature = (words) => `${words.filter((w) => POLARITY.has(w)).sort().join(",")}|${words.filter((w) => /\d/.test(w)).sort().join(",")}`;

// Characters, with CJK counting double: such text has few spaces, so few "words".
const weight = (s) => s.length + (s.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;

export function checkDuplicates(ctx) {
  const importLines = new Map();
  const importsOf = (file) => {
    if (!importLines.has(file)) importLines.set(file, importCandidates(file.doc).map((c) => c.line));
    return importLines.get(file);
  };

  // The units worth comparing, in load order.
  const items = [];
  for (const file of ctx.d.files) {
    for (const u of textUnits(file.doc)) {
      if (u.kind === "row" || POINTER.test(u.text)) continue;
      const words = wordsOf(u.text);
      const key = words.join(" ");
      if (words.length < MIN_WORDS && weight(key) < MIN_WEIGHT) continue;
      items.push({ file, unit: u, words, set: new Set(words), key, sig: signature(words) });
    }
  }

  const index = new SimilarityIndex(items.map((it) => it.set), THRESHOLD);
  const exact = new Map(); // polarity + normalized text -> the first item with it
  items.forEach((it, id) => {
    let match = exact.get(`${it.sig}|${it.key}`) || null;
    if (!match && it.words.length >= MIN_WORDS) {
      for (const other of index.candidates(it.set)) {
        const s = items[other];
        if (s.sig !== it.sig || s.words.length < MIN_WORDS) continue;
        if (Math.min(s.set.size, it.set.size) / Math.max(s.set.size, it.set.size) < THRESHOLD) continue;
        if (jaccard(s.set, it.set) >= THRESHOLD) { match = s; break; }
      }
    }
    if (!match) { // the first of its kind: later copies are compared with it
      exact.set(`${it.sig}|${it.key}`, it);
      index.add(id, it.set);
      return;
    }

    // A near repeat stays in the file, so a later exact copy of it is a repeat of it.
    if (match.key !== it.key && !exact.has(`${it.sig}|${it.key}`)) exact.set(`${it.sig}|${it.key}`, it);

    const { file, unit: u } = it;
    let drop = { file, unit: u };
    let keep = match;
    if (file.kind === "import" && !file.rewritable && match.file.rewritable) { drop = match; keep = it; }

    const own = linesTokens(lineSlice(drop.file.doc, drop.unit.start, drop.unit.end));
    const same = match.key === it.key;
    const hasImport = importsOf(drop.file).some((ln) => ln >= drop.unit.start && ln <= drop.unit.end);
    // Never remove a copy when the other one lives in the user's personal file: it may be the only
    // copy teammates have. Items with nested bullets are left alone too.
    const fixable = same && drop.file.rewritable && !drop.unit.hasChildren && !hasImport && drop.file.kind !== "user" && keep.file.kind !== "user";
    const gone = [...match.set].filter((w) => !it.set.has(w));
    const added = [...it.set].filter((w) => !match.set.has(w));
    ctx.findings.push(makeFinding("duplicate", {
      file: drop.file.display, line: drop.unit.start, endLine: drop.unit.end, tokens: own, saves: own,
      message: `${same ? "repeats" : "nearly repeats"} ${keep.file.display}:${keep.unit.start}: "${clip(drop.unit.text, 70)}"`,
      fix: keep.file.kind === "user"
        ? `Also in your user memory (${keep.file.display}). Keep one copy: here if teammates need the rule, otherwise only in your user file.`
        : same
          ? `Delete this copy and keep ${keep.file === drop.file ? `line ${keep.unit.start}` : keep.file.display}.`
          : `Merge the two into one line (they differ in: ${[...gone, ...added].slice(0, 6).join(", ")}).`,
      autofix: fixable,
      detail: { of: { file: keep.file.display, line: keep.unit.start }, exact: same, differ: same ? [] : [...gone, ...added].slice(0, 12) },
    }));
    // Every repeat is registered, removable or not: a copy that stays can stand in for an original that leaves.
    ctx.ops.push({ type: "remove", file: drop.file, start: drop.unit.start, end: drop.unit.end, reasons: ["duplicate"], dupOf: { file: keep.file, line: keep.unit.start }, fixable });
  });
}
