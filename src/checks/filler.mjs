// filler: generic lines that do not change what Claude does. "You are a helpful assistant",
// "write clean code", "follow best practices" tell the model nothing it does not already do.
// A style line such as "be concise" is a real instruction, so only its repeats are filler.
import { lineSlice, textUnits } from "../markdown.mjs";
import { importCandidates } from "../imports.mjs";
import { linesTokens } from "../tokens.mjs";
import { clip, wordsOf } from "../text.mjs";
import { makeFinding } from "../findings.mjs";
import { POINTER } from "./duplicates.mjs";

// Patterns run on a normalized line: lowercase words with no punctuation.
const FILLER = [
  /you are (?:a |an )?(?:very |highly |extremely |truly )?(?:helpful|friendly|smart|expert|senior|professional|world class|experienced|skilled|talented|knowledgeable|brilliant)(?: [a-z]+){0,4}/,
  /act as (?:a |an )(?:senior |expert |experienced )?(?:[a-z]+ ){0,3}[a-z]+/,
  /(?:please )?(?:always )?write (?:clean|good|high quality|readable|maintainable|quality|production ready|elegant|beautiful|correct|robust|working)(?: and (?:clean|readable|maintainable|efficient|well structured|documented|tested|robust))*(?: code)?/,
  /(?:please )?(?:always )?(?:follow|use|apply|adhere to) (?:the )?(?:(?:industry|coding|general|standard|software engineering) )?best practices?(?: and (?:conventions|standards|patterns))?/,
  /(?:please )?(?:always )?(?:be|stay) (?:careful|thorough|precise|accurate|diligent|professional|helpful|friendly)/,
  /(?:please )?(?:think|reason) (?:step by step|carefully|deeply|harder)/,
  /(?:please )?(?:double check|review) your (?:work|answers?|code)(?: carefully)?/,
  /(?:please )?(?:do|try) your best/,
  /(?:please )?use (?:your )?(?:best )?(?:judg(?:e)?ment|common sense)/,
  /(?:please )?(?:make sure|ensure) (?:the |your )?(?:code|answers?|output|solution) (?:is|are) (?:correct|clean|good|high quality|bug free|working)/,
  /(?:please )?(?:dont|do not) (?:make mistakes|hallucinate|be lazy)/,
];

// Style asks that matter once and are noise when repeated.
const CONCISE = [
  /(?:please )?(?:always )?be (?:concise|brief|succinct|terse)/,
  /(?:please )?(?:always )?(?:keep|make) (?:your )?(?:responses?|answers?|replies|messages?|output|explanations?)(?: (?:short|brief|concise|succinct))?/,
  /(?:please )?(?:always )?(?:answer|respond|reply) (?:briefly|concisely|succinctly|tersely)/,
  /(?:please )?(?:no|avoid) (?:unnecessary|extra) (?:verbosity|explanations?|preamble|words)/,
];

// Does a pattern match and cover most of the line? (A rule with real content around it is not filler.)
function covers(patterns, words) {
  const norm = words.join(" ");
  for (const re of patterns) {
    const m = re.exec(norm);
    if (!m) continue;
    const matched = m[0].trim().split(" ").length;
    if (words.length <= 8 || matched / words.length >= 0.6) return m[0].trim();
  }
  return null;
}

export function checkFiller(ctx) {
  const concise = [];
  for (const file of ctx.d.files) {
    const imports = importCandidates(file.doc).map((c) => c.line);
    for (const u of textUnits(file.doc)) {
      if (u.kind === "row" || POINTER.test(u.text)) continue;
      const words = wordsOf(u.text);
      if (!words.length || words.length > 25) continue;
      const hasImport = imports.some((ln) => ln >= u.start && ln <= u.end);
      const fixable = file.rewritable && !u.hasChildren && !hasImport;
      const own = linesTokens(lineSlice(file.doc, u.start, u.end));

      const phrase = covers(FILLER, words);
      if (phrase) {
        const f = makeFinding("filler", {
          file: file.display, line: u.start, endLine: u.end, tokens: own, saves: own,
          message: `"${clip(u.text, 70)}" does not change what Claude does`,
          fix: "Delete the line.",
          autofix: fixable,
          detail: { phrase },
        });
        ctx.findings.push(f);
        if (fixable) ctx.ops.push({ type: "remove", file, start: u.start, end: u.end, reasons: ["filler"] });
        continue;
      }
      const style = covers(CONCISE, words);
      if (style) {
        if (!concise.length) { concise.push({ file, u }); continue; } // the first one stays
        const first = concise[0];
        const f = makeFinding("filler", {
          file: file.display, line: u.start, endLine: u.end, tokens: own, saves: own,
          message: `"${clip(u.text, 70)}" repeats the style instruction at ${first.file.display}:${first.u.start}`,
          fix: "Keep one such line and delete the repeats.",
          autofix: fixable,
          detail: { phrase: style, of: { file: first.file.display, line: first.u.start } },
        });
        ctx.findings.push(f);
        ctx.ops.push({ type: "remove", file, start: u.start, end: u.end, reasons: ["filler"], dupOf: { file: first.file, line: first.u.start }, fixable });
      }
    }
  }
}
