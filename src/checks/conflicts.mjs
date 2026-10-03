// conflict: instructions that likely contradict each other. These are heuristics, so they are
// reported as warnings to review, never fixed automatically.
//
//   directives      "always X" or "must X" against "never X", "do not X", "avoid X" for the same X
//                   (for imperatives, "commit X" against "do not commit X")
//   package managers  two different ones named as the one to use (use pnpm / npm install)
//   indentation     tabs against spaces, or two different space widths
import { lineSlice, textUnits } from "../markdown.mjs";
import { linesTokens } from "../tokens.mjs";
import { clip, contentWords, jaccard, SimilarityIndex } from "../text.mjs";
import { makeFinding } from "../findings.mjs";
import { POINTER } from "./duplicates.mjs";

const NEG = /\b(never|must not|mustn'?t|should not|shouldn'?t|do not|don'?t|cannot|can'?t|avoid|stop)\s+(.+)$/i;
const POS = /\b(always|must|should|ensure|make sure(?: to)?|remember to|be sure to)\s+(.+)$/i;
const IMPERATIVE = /^(?:please\s+)?((?:commit|push|merge|delete|remove|use|run|add|install|update|upgrade|deploy|publish|mock|skip|ignore|track|edit|modify|write|create|rewrite|rebase|squash)\b.*)$/i;
// Where a rule's subject ends and its condition or scope begins.
const CUT = /\s*(?:[,;(]|\s[—–-]\s|\b(?:unless|except|if|when|until|after|before|because|since|otherwise|while|so that|without)\b).*$/i;
const SENTENCES = /(?<=[.!?])\s+|;\s+|\s+(?:but|however)\s+|\s+[-–—]\s+/i;
const MAX_TEXT = 2000; // longer lines are cut: a rule states its subject early
const SIMILAR = 0.75; // two phrases about the same thing share this much
const SAME_HEAD = 0.5; // ...or start the same way (first three content words) and share at least this much

const strip = (s) => s.replace(/^[\s*_>#-]+/, "").replace(/[*_`]/g, "");

/** [{ polarity, phrase, words }] for the rules a unit states. */
export function directives(text) {
  const out = [];
  for (const raw of text.slice(0, MAX_TEXT).split(SENTENCES)) {
    const s = strip(raw).trim();
    if (!s) continue;
    let polarity = 0;
    let phrase = "";
    let m;
    if ((m = NEG.exec(s))) { polarity = -1; phrase = m[2]; }
    else if ((m = POS.exec(s))) { polarity = 1; phrase = m[2]; }
    else if ((m = IMPERATIVE.exec(s))) { polarity = 1; phrase = m[1]; }
    if (!polarity) continue;
    phrase = phrase.replace(CUT, "").replace(/[.!?]+$/, "").trim();
    const words = contentWords(phrase);
    if (words.length >= 2) out.push({ polarity, phrase, words, set: new Set(words), sentence: s });
  }
  return out;
}

function unitsOf(files) {
  const out = [];
  for (const file of files) for (const u of textUnits(file.doc)) if (u.kind !== "row" && !POINTER.test(u.text)) out.push({ file, unit: u });
  return out;
}

const where = (x) => `${x.file.display}:${x.unit.start}`;

// Load order: earlier files first, then line number.
const rank = (ctx, x) => ctx.d.files.indexOf(x.file) * 1e6 + x.unit.start;
const ordered = (ctx, x, y) => (rank(ctx, x) <= rank(ctx, y) ? [x, y] : [y, x]);

function report(ctx, later, earlier, message, fix, detail) {
  ctx.findings.push(makeFinding("conflict", {
    file: later.file.display, line: later.unit.start, endLine: later.unit.end,
    tokens: linesTokens(lineSlice(later.file.doc, later.unit.start, later.unit.end)), saves: 0,
    message, fix, detail: { with: { file: earlier.file.display, line: earlier.unit.start }, ...detail },
  }));
}

const FIX = "Decide which rule holds and delete the other, or scope one of them (\"in tests, ...\").";

// Do two rules talk about the same thing? Mostly the same words, or the same start ("commit
// package-lock.json ...") with the rest overlapping, which catches "...with every dependency change".
function sameSubject(a, b) {
  const j = jaccard(a.set, b.set);
  if (j >= SIMILAR) return true;
  if (a.words.length < 3 || b.words.length < 3 || j < SAME_HEAD) return false;
  return a.words.slice(0, 3).join(" ") === b.words.slice(0, 3).join(" ");
}

function checkDirectives(ctx, units) {
  const all = [];
  for (const x of units) for (const d of directives(x.unit.text)) all.push({ ...x, d });
  // Only rules of opposite polarity can conflict, and only rules sharing words are compared.
  const sets = all.map((a) => a.d.set);
  const seen = { 1: new SimilarityIndex(sets, SAME_HEAD), [-1]: new SimilarityIndex(sets, SAME_HEAD) };
  all.forEach((b, j) => {
    for (const i of seen[-b.d.polarity].candidates(b.d.set)) {
      const a = all[i];
      if (!sameSubject(a.d, b.d)) continue;
      report(ctx, b, a, `"${clip(b.d.sentence, 60)}" contradicts "${clip(a.d.sentence, 60)}" at ${where(a)}`, FIX, { rules: [a.d.sentence, b.d.sentence] });
    }
    seen[b.d.polarity].add(j, b.d.set);
  });
}

// ---- package managers ----

const PM = "(npm|pnpm|yarn|bun)";
const PM_USES = [
  new RegExp(`\\b(?:use|using|prefer|preferably)\\s+${PM}\\b`, "gi"),
  new RegExp(`\\b(?:with|via)\\s+${PM}\\b`, "gi"),
  new RegExp(`\\b${PM}\\s+(?:install|i|ci|add)\\b`, "gi"),
];
const NEGATED = /\b(?:not|never|don'?t|do not|instead of|rather than|over|than|avoid|no longer|without|banned?)\s+(?:to\s+)?(?:(?:run|use|using|call)\s+)?$/i;

function packageManagersIn(text) {
  const found = [];
  for (const sentence of text.split(SENTENCES)) {
    const s = sentence.replace(/`/g, "");
    if (/(\s-g\b|--global)/.test(s)) continue; // installing a tool globally says nothing about the project
    for (const re of PM_USES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        if (NEGATED.test(s.slice(Math.max(0, m.index - 32), m.index))) continue;
        found.push(m[1].toLowerCase());
      }
    }
  }
  return found;
}

function checkPackageManagers(ctx, units) {
  const first = new Map(); // manager -> where it was first named
  const lines = []; // fenced command lines count too
  for (const file of ctx.d.files) {
    if (file.kind === "import") continue; // an imported README may list every manager as an option
    for (const l of file.doc.lines) if (l.kind === "code") lines.push({ file, unit: { start: l.n, end: l.n }, text: l.text });
  }
  const sources = [...units.filter((x) => x.file.kind !== "import").map((x) => ({ ...x, text: x.unit.text })), ...lines];
  for (const x of sources) for (const pm of packageManagersIn(x.text)) if (!first.has(pm)) first.set(pm, x);
  if (first.size < 2) return;
  const [a, b] = [...first.entries()].sort((p, q) => rank(ctx, p[1]) - rank(ctx, q[1]));
  report(ctx, b[1], a[1], `names ${b[0]} as the package manager, but ${where(a[1])} names ${a[0]}`,
    `Pick one package manager and say so once (for example "use ${a[0]}, not ${b[0]}"), then delete the other mentions.`, { managers: [...first.keys()] });
}

// ---- tabs and spaces ----

const WORD_NUM = { two: 2, four: 4, eight: 8 };
const TABS = /\b(?:use|using|prefer|hard|indent(?:ed|ation)?\s+(?:with|using|by)|with)\s+tabs?\b|\btabs?\s+(?:for|as)\s+indent|\bindent(?:ation)?\s*(?:is|=|:)?\s*tabs?\b/gi;
const SPACES = /\b(?:use|using|prefer|indent(?:ed|ation)?\s+(?:with|using|by)|with)\s+(?:(\d+|two|four|eight)[\s-]*)?spaces?\b|\b(\d+|two|four|eight)[\s-]+space\s+indent|\bindent(?:ation)?\s*(?:is|=|:)?\s*(\d+|two|four|eight)\s+spaces?\b/gi;

function indentIn(text) {
  const out = { tabs: false, widths: new Set(), spaces: false };
  for (const sentence of text.split(SENTENCES)) {
    TABS.lastIndex = 0;
    let m;
    while ((m = TABS.exec(sentence))) if (!NEGATED.test(sentence.slice(Math.max(0, m.index - 32), m.index))) out.tabs = true;
    SPACES.lastIndex = 0;
    while ((m = SPACES.exec(sentence))) {
      if (NEGATED.test(sentence.slice(Math.max(0, m.index - 32), m.index))) continue;
      out.spaces = true;
      const w = m[1] || m[2] || m[3];
      if (w) out.widths.add(WORD_NUM[w.toLowerCase()] || Number(w));
    }
  }
  return out;
}

// A rule limited to some files or languages ("tabs in Go files", "2 spaces in YAML", "everywhere else",
// "except ...") does not contradict a rule for the rest.
const SCOPED = /\b(?:in|for|inside|within)\s+(?:the\s+|all\s+)?(?:[\w.+-]+\s+)?(?:files?|code|sources?|yaml|yml|json|toml|go|golang|python|py|makefiles?|markdown|md|tests?|scripts?|templates?)\b|\beverywhere else\b|\bexcept\b|\bonly (?:in|for)\b/i;

function checkIndentation(ctx, units) {
  const tabs = [];
  const spaces = [];
  const widths = new Map(); // width -> where it was first asked for
  for (const x of units) {
    const r = indentIn(x.unit.text);
    if (SCOPED.test(x.unit.text)) continue;
    // a line that asks for both ("tabs in Go, 2 spaces elsewhere") already scopes them
    if (r.tabs && !r.spaces) tabs.push(x);
    if (r.spaces && !r.tabs) spaces.push(x);
    for (const w of r.widths) if (!widths.has(w)) widths.set(w, x);
  }
  if (tabs.length && spaces.length) {
    const [early, late] = ordered(ctx, tabs[0], spaces[0]);
    const what = (x) => (x === tabs[0] ? "tabs" : "spaces");
    report(ctx, late, early, `asks for ${what(late)} but ${where(early)} asks for ${what(early)}`, FIX, { kinds: ["tabs", "spaces"] });
  }
  if (widths.size > 1) {
    const [[w1, x1], [w2, x2]] = [...widths.entries()];
    const [early, late] = ordered(ctx, x1, x2);
    const width = (x) => (x === x1 ? w1 : w2);
    report(ctx, late, early, `asks for ${width(late)}-space indentation but ${where(early)} asks for ${width(early)}`, FIX, { widths: [w1, w2] });
  }
}

export function checkConflicts(ctx) {
  const units = unitsOf(ctx.d.files);
  checkDirectives(ctx, units);
  checkPackageManagers(ctx, units);
  checkIndentation(ctx, units);
}
