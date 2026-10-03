// The token estimator. Every number this tool prints (per file, per finding, totals, before and
// after) comes from estimateTokens(), so they always add up.
//
// It is an ESTIMATE. Anthropic does not publish a tokenizer for current Claude models, so this
// does not reproduce Claude's real counts. It models how byte-pair tokenizers usually behave:
//
//   words      one token each; long words (over 8 letters) cost ceil(letters / 4); ALL-CAPS words
//              split sooner; camelCase and PascalCase split into their parts (getUserById is 4)
//   numbers    ceil(digits / 3)
//   symbols    one token each; a run of the same symbol (---, ***, ```) costs ceil(length / 4);
//              a few two-character operators (=>, !=, ://) cost one
//   spaces     a single space in front of a word is free (it rides on the word's token);
//              an indent run costs ceil(length / 8); a newline run costs ceil(count / 2)
//   segments   a path, URL or identifier is counted segment by segment, so src/foo/bar.ts is 7
//              tokens (src / foo / bar . ts plus the separators) where characters / 4 says 4
//   other      CJK characters cost 1 each, other non-Latin words ceil(letters / 2), emoji 2
//
// Calibration: on ordinary English markdown the result lands within about 15 percent of the
// common "characters / 4" rule of thumb. It counts more than characters / 4 for code, paths and
// URLs, which that rule undercounts, and less for text that is mostly whitespace.

const SCAN = new RegExp(
  [
    "(?<nl>\\n+)",
    "(?<ws>[^\\S\\n]+)",
    "(?<num>\\p{N}+)",
    "(?<word>[\\p{L}\\p{M}]+)",
    "(?<contraction>['\\u2019](?:s|t|re|ve|ll|d|m)(?![\\p{L}\\p{M}]))",
    "(?<emoji>\\p{Extended_Pictographic}[\\uFE0F\\u200D\\p{Extended_Pictographic}]*)",
    "(?<sym>[^\\s\\p{L}\\p{M}\\p{N}])\\k<sym>*",
  ].join("|"),
  "gu"
);

// Words up to this many letters are one token; longer ones cost ceil(letters / 4).
const LONG_WORD = 8;

// Two-character operators that tokenizers usually keep together. Runs of one repeated character
// (==, &&, //, ::) are already one token through the run rule.
const OPERATORS = new Set(["=>", "->", "<-", "!=", "<=", ">=", "+=", "-=", "*=", "/=", ":=", "?.", "</", "/>", "|>", "<>"]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /\p{Script=Latin}/u;
// camelCase and PascalCase parts: an acronym, a capitalized or lowercase word, or any other run.
const PARTS = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{L}+/gu;

function partCost(part) {
  const len = [...part].length;
  if (len <= 1) return 1;
  if (part === part.toUpperCase() && part !== part.toLowerCase()) return len <= 4 ? 1 : Math.ceil(len / 3);
  return len <= LONG_WORD ? 1 : Math.ceil(len / 4);
}

// One run of letters: split it into scripts and camelCase parts, and add up the parts.
function wordCost(word) {
  if (/^[\x00-\x7f]+$/.test(word)) return partsCost(word); // plain ASCII, the common case
  let cost = 0;
  let latin = "";
  for (const ch of word) {
    if (CJK.test(ch)) cost += 1;
    else if (LATIN.test(ch) || /\p{M}/u.test(ch)) latin += ch;
    else cost += 0.5; // other scripts: about two letters per token
  }
  if (latin) cost += partsCost(latin);
  return Math.ceil(cost);
}

function partsCost(latin) {
  let cost = 0;
  for (const part of latin.match(PARTS) || []) cost += partCost(part);
  return cost || 1;
}

/** Estimated tokens of a text: a whole number, 0 for an empty text. Deterministic. */
export function estimateTokens(text) {
  const s = String(text ?? "")
    .replace(/^﻿/, "")
    .replace(/[​⁠﻿]/g, "")
    .replace(/\r\n?/g, "\n");
  if (!s) return 0;
  let tokens = 0;
  SCAN.lastIndex = 0;
  let m;
  while ((m = SCAN.exec(s)) !== null) {
    const g = m.groups;
    if (g.nl) {
      tokens += Math.ceil(g.nl.length / 2);
    } else if (g.ws) {
      const next = s[SCAN.lastIndex];
      if (g.ws === " " && next !== undefined && next !== "\n") continue; // rides on the next token
      tokens += g.ws.length === 1 ? 1 : Math.ceil(g.ws.length / 8);
    } else if (g.num) {
      tokens += Math.ceil(g.num.length / 3);
    } else if (g.word) {
      tokens += wordCost(g.word);
    } else if (g.contraction) {
      tokens += 1;
    } else if (g.emoji) {
      tokens += 2;
    } else {
      const run = m[0].length;
      if (run === 1) {
        const at = m.index;
        if (s.startsWith("://", at)) {
          tokens += 1;
          SCAN.lastIndex = at + 3;
        } else if (OPERATORS.has(s.slice(at, at + 2))) {
          tokens += 1;
          SCAN.lastIndex = at + 2;
        } else {
          tokens += 1;
        }
      } else {
        tokens += Math.ceil(run / 4);
      }
    }
  }
  return tokens;
}

/** Tokens of whole lines, as they sit in a file: each line keeps its newline. */
export function linesTokens(lines) {
  return lines.length ? estimateTokens(lines.join("\n") + "\n") : 0;
}

/** 1,234 */
export const fmt = (n) => Math.round(n).toLocaleString("en-US");
