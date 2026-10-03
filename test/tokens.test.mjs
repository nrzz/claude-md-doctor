import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ROOT } from "./helpers.mjs";
import path from "node:path";
import { estimateTokens, fmt, linesTokens } from "../src/tokens.mjs";

const c4 = (s) => Math.ceil(s.length / 4); // the rule of thumb the estimator is calibrated against

test("an empty or missing text is zero tokens", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(null), 0);
});

test("the same text always gives the same number", () => {
  const text = "# Title\n\n- Run `npm test` before you commit.\n- See src/foo/bar.ts and https://example.com/a?b=1.\n";
  const first = estimateTokens(text);
  for (let i = 0; i < 5; i++) assert.equal(estimateTokens(text), first);
});

test("a BOM and CRLF line endings do not change the count", () => {
  const lf = "# Title\n\n- one\n- two\n";
  assert.equal(estimateTokens("﻿" + lf), estimateTokens(lf));
  assert.equal(estimateTokens(lf.replace(/\n/g, "\r\n")), estimateTokens(lf));
});

test("short words cost one token and the space before a word is free", () => {
  assert.equal(estimateTokens("hello"), 1);
  assert.equal(estimateTokens("hello world"), 2);
  assert.equal(estimateTokens("one two three four five"), 5);
});

test("long words cost ceil(letters / 4)", () => {
  assert.equal(estimateTokens("internationalization"), 5); // 20 letters
  assert.equal(estimateTokens("responsibility"), 4); // 14 letters
  assert.equal(estimateTokens("configure"), 3); // 9 letters, the first length over the cut
  assert.equal(estimateTokens("projects"), 1); // 8 letters stay one token
});

test("camelCase and PascalCase split into their parts", () => {
  assert.equal(estimateTokens("getUserById"), 4);
  assert.equal(estimateTokens("HTTPServer"), 2);
  assert.equal(estimateTokens("parseJSON"), 2);
});

test("ALL-CAPS words split sooner than ordinary words", () => {
  assert.equal(estimateTokens("API"), 1);
  assert.equal(estimateTokens("NEVER"), 2);
  assert.equal(estimateTokens("IMPORTANT"), 3);
});

test("numbers cost one token per three digits", () => {
  assert.equal(estimateTokens("100"), 1);
  assert.equal(estimateTokens("2000"), 2);
  assert.equal(estimateTokens("1234567"), 3);
});

test("symbols cost one token each and a run of one symbol is cheap", () => {
  assert.equal(estimateTokens("a,b"), 3);
  assert.equal(estimateTokens("---"), 1);
  assert.equal(estimateTokens("```"), 1);
  assert.equal(estimateTokens("----------"), 3);
  assert.equal(estimateTokens("=> != ->"), 3);
});

test("contractions are two tokens, not three", () => {
  assert.equal(estimateTokens("don't"), 2);
  assert.equal(estimateTokens("it's"), 2);
});

test("a path is counted segment by segment, and costs more than characters / 4", () => {
  assert.equal(estimateTokens("src/foo/bar.ts"), 7);
  assert.ok(estimateTokens("src/foo/bar.ts") > c4("src/foo/bar.ts"));
  assert.equal(estimateTokens("./scripts/x.sh"), 7);
});

test("a URL is counted per segment too", () => {
  const url = "https://github.com/nrzz/claude-md-doctor";
  assert.equal(estimateTokens(url), 13);
  assert.ok(estimateTokens(url) > c4(url));
});

test("code costs more than characters / 4 says", () => {
  const code = "function add(a, b) {\n  return a + b;\n}\n";
  assert.ok(estimateTokens(code) > c4(code) * 1.4);
});

test("indentation runs and newline runs are cheap", () => {
  assert.equal(estimateTokens("a\n\n\nb"), 4); // a, a blank-line run of 3 newlines is 2, b
  assert.ok(estimateTokens("a\n        b") <= 4); // an 8-space indent is one token
});

test("emoji cost two tokens and CJK characters one each", () => {
  assert.equal(estimateTokens("\u{1F680}"), 2);
  assert.equal(estimateTokens("日本語"), 3);
});

test("linesTokens counts whole lines with their newlines", () => {
  const lines = ["- Run `npm test`.", "- Use pnpm."];
  assert.equal(linesTokens(lines), estimateTokens(lines.join("\n") + "\n"));
  assert.equal(linesTokens([]), 0);
});

test("fmt groups thousands", () => {
  assert.equal(fmt(1234), "1,234");
  assert.equal(fmt(12), "12");
  assert.equal(fmt(1234.6), "1,235");
});

// ---- calibration against characters / 4 ----

const PROSE = `Claude Code keeps every conversation on the machine it ran on. A Team plan gives each person a seat, not a shared history, and Claude Code has no built-in way to hand a local session to a teammate. Git already carries the shared parts of a project's setup, such as the memory file, the settings and the skills. What was missing is a simple way to hand over the work that is half done, so that the next person can continue without asking the first one to explain everything again.

When you start a new session, the memory files are loaded before you type anything. Every line in them is read on every turn, so a long file costs real money and also dilutes the instructions that matter. Keep only what Claude cannot work out from the code, and move task-specific notes into places that are read on demand.`;

const MEMORY = `# Project

- Run \`npm test\` before committing; the suite takes about 20 seconds.
- Source lives in \`src/\`, tests in \`test/\`. Entry point: \`src/index.ts\`.
- Use pnpm, not npm. Node 20 or newer.
- Never commit \`.env\`; secrets come from the vault.

## Style

- TypeScript strict mode. Prefer small functions and early returns.
- Two spaces for indentation, double quotes, no semicolons.
- Errors are returned as \`Result<T, E>\` values, never thrown across module boundaries.
`;

test("on ordinary English prose the estimate is within 15 percent of characters / 4", () => {
  const ratio = estimateTokens(PROSE) / c4(PROSE);
  assert.ok(ratio > 0.85 && ratio < 1.15, `ratio ${ratio.toFixed(3)}`);
});

test("on a typical memory file the estimate stays within 25 percent of characters / 4", () => {
  const ratio = estimateTokens(MEMORY) / c4(MEMORY);
  assert.ok(ratio > 0.9 && ratio < 1.25, `ratio ${ratio.toFixed(3)}`);
});

test("on this repository's own README the estimate is within 20 percent of characters / 4", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const ratio = estimateTokens(readme) / c4(readme);
  assert.ok(ratio > 0.9 && ratio < 1.2, `ratio ${ratio.toFixed(3)}`);
});

test("no module computes tokens from characters / 4: the estimator is the only counter", () => {
  const dir = path.join(ROOT, "src");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".mjs")) files.push(p);
    }
  };
  walk(dir);
  assert.ok(files.length > 10);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!/\.length\s*\/\s*4\b/.test(text), `${path.relative(ROOT, f)} divides a length by 4`);
  }
});
