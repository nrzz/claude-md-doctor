import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyFix } from "../src/fix.mjs";
import { renderFix, renderMarkdown, renderText, toJson } from "../src/report.mjs";
import { estimateTokens } from "../src/tokens.mjs";
import { sandbox } from "./helpers.mjs";

// A small seeded random generator, so a failure can be reproduced from its seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

const RULE = "Always run the linter and the formatter before you commit any changes to the main branch";
const steps = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. First check that the build for target number ${i} is green, then run the packaging script and finally copy the artifacts to the staging bucket.`).join("\n");

// Lines that must survive a rewrite: valid, not filler, not repeated.
const KEEPERS = [
  "- Run `npm test` before you commit.",
  "- Source lives in `src/real.ts`.",
  "- Keep functions small and focused on one thing.",
  "- Prefer composition over inheritance in new modules.",
  "- Public types are exported from `src/real.ts` only.",
  "- Use `npm run build` to compile the project.",
];
// Lines --fix may remove or move.
const NOISE = [
  "You are a helpful assistant.",
  "- Write clean code.",
  "- Follow best practices.",
  "- Be concise.",
  "- Keep answers brief.",
  "- Auth lives in `src/old/auth.ts`.",
  "- Run `npm run lint` before committing.",
  "- See docs/gone.md for details.",
  "1. Run `make deploy` to ship.",
  `- ${RULE}`,
  `- ${RULE}`,
  "- Always use semicolons here.",
  "- Never use semicolons here.",
  "```bash\nnpm run build\nnpm run nope\n```",
  "```bash\nnpm run nope\n```",
  "## Release process\n\n" + steps(14),
  "## Deploying to production\n\n" + steps(14),
];
const NEUTRAL = ["# Project", "## Style", "## Notes", "### Details", "", "", "<!-- a note -->", "| a | b |\n| --- | --- |\n| 1 | 2 |", "Some plain paragraph text about the project.", "```json\n{}\n```", "@docs/style.md", "@docs/gone.md"];

function randomDoc(seed) {
  const r = rng(seed);
  const chunks = [];
  const n = 6 + Math.floor(r() * 18);
  for (let i = 0; i < n; i++) {
    const roll = r();
    chunks.push(roll < 0.35 ? pick(r, KEEPERS) : roll < 0.75 ? pick(r, NOISE) : pick(r, NEUTRAL));
  }
  return chunks.join(r() < 0.5 ? "\n" : "\n\n") + "\n";
}

const FILES = {
  "src/real.ts": "export {};\n",
  "docs/style.md": "Use two spaces for indentation in every source file of the project.\n",
  "package.json": JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }),
};

// ---------------------------------------------------------------- the rewrite is safe

test("lean files are fixed points: fixing a lean file again changes nothing (200 random memory files)", () => {
  const s = sandbox(FILES);
  for (let seed = 1; seed <= 200; seed++) {
    const text = randomDoc(seed);
    s.file("CLAUDE.md", text);
    const first = s.analyze();
    if (!first.plan.files.some((f) => f.changed)) continue;
    const lean = first.plan.files[0].lean;
    s.file("CLAUDE.md", lean);
    const second = s.analyze();
    assert.deepEqual(second.plan.files.filter((f) => f.changed).map((f) => f.file.display), [], `seed ${seed} is not a fixed point:\n${text}\n--- lean ---\n${lean}`);
    assert.deepEqual(second.findings.filter((f) => f.autofix), [], `seed ${seed} left fixable findings`);
  }
});

test("a rewrite never makes the memory bigger and never loses a valid line (200 random memory files)", () => {
  const s = sandbox(FILES);
  for (let seed = 1; seed <= 200; seed++) {
    const text = randomDoc(seed);
    s.file("CLAUDE.md", text);
    const m = s.analyze();
    assert.ok(m.plan.after <= m.plan.before + m.plan.skillTokens, `seed ${seed}`);
    for (const f of m.plan.files) {
      assert.ok(f.after <= f.before, `seed ${seed}: ${f.before} -> ${f.after}`);
      const kept = f.lean + m.plan.skills.map((k) => k.skillText).join("\n");
      for (const line of KEEPERS) {
        if (text.includes(line)) assert.ok(kept.includes(line), `seed ${seed} lost "${line}"`);
      }
      for (const line of ["# Project", "## Style"]) {
        if (text.includes(line) && /\n- /.test(text.slice(text.indexOf(line)))) continue; // a heading may go when its section empties
      }
    }
  }
});

test("applying the plan on disk gives the planned text and one backup, for random files", () => {
  const s = sandbox(FILES);
  for (let seed = 301; seed <= 330; seed++) {
    const text = randomDoc(seed);
    for (const f of fs.readdirSync(s.dir)) if (f.startsWith("CLAUDE.md.bak")) fs.rmSync(path.join(s.dir, f));
    fs.rmSync(path.join(s.dir, ".claude"), { recursive: true, force: true });
    s.file("CLAUDE.md", text);
    const m = s.analyze();
    const changed = m.plan.files.filter((f) => f.changed);
    const result = applyFix(m, { write: true, now: new Date(2026, 0, 1, 0, 0, seed % 60) });
    if (!changed.length) { assert.equal(result.nothing, true); assert.equal(s.read("CLAUDE.md"), text); continue; }
    assert.equal(s.read("CLAUDE.md"), changed[0].lean);
    assert.equal(result.backups.length, 1);
    assert.equal(fs.readFileSync(result.backups[0], "utf8"), text);
  }
});

// ---------------------------------------------------------------- nothing throws

const ATOMS = ["`", "``", "```", "~~~", "@", "@x.md", "[", "]", "(", ")", "](", "<!--", "-->", "#", "##", "- ", "1. ", "|", " ", "  ", "\t", "\n", "\n\n", "\r\n", "src/a.ts", "npm run x", "e.g.", "\u00e9", "\u65e5\u672c", "\u{1F600}", "C:\\x\\y", "../", "~/", "<file>", "${X}", "*", "**", "_", "&", ";", ":", "\\", "/", "make test", "dotnet test x.csproj", "always ", "never ", "do not ", "use tabs", "use npm", "use pnpm", "you are a helpful assistant."];

test("random junk never makes the analysis, the fix plan or any report throw (300 inputs)", () => {
  const s = sandbox({ "package.json": "{}" });
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed * 7919);
    const len = 1 + Math.floor(r() * 120);
    let text = "";
    for (let i = 0; i < len; i++) text += pick(r, ATOMS);
    s.file("CLAUDE.md", text);
    s.file("CLAUDE.local.md", text.split("").reverse().join(""));
    let m;
    try {
      m = s.analyze();
      renderText(m);
      renderText(m, { color: true });
      renderMarkdown(m);
      JSON.stringify(toJson(m));
      const result = applyFix(m, { write: false });
      renderFix(m, result);
    } catch (e) {
      assert.fail(`seed ${seed} threw: ${e.stack}\n${JSON.stringify(text)}`);
    }
    for (const f of m.findings) {
      assert.ok(["error", "warn", "info"].includes(f.severity));
      assert.ok(Number.isInteger(f.tokens) && f.tokens >= 0, `seed ${seed}: tokens ${f.tokens}`);
      assert.ok(Number.isInteger(f.saves) && f.saves >= 0, `seed ${seed}: saves ${f.saves}`);
      assert.ok(f.message.length > 0 && f.fix.length > 0);
    }
    fs.rmSync(path.join(s.dir, ".claude-md-doctor"), { recursive: true, force: true });
    for (const f of fs.readdirSync(s.dir)) if (f.endsWith(".lean")) fs.rmSync(path.join(s.dir, f));
  }
});

test("the estimator never throws and is never negative on random text", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    let text = "";
    for (let i = 0; i < 60; i++) text += pick(r, ATOMS) + (r() < 0.3 ? String.fromCharCode(Math.floor(r() * 0xffff)) : "");
    const n = estimateTokens(text);
    assert.ok(Number.isInteger(n) && n >= 0);
  }
});

// ---------------------------------------------------------------- nothing takes forever

// Each of these used to be (or could easily become) quadratic. 20,000 characters keep the test
// quick when the code is fine and obvious when it is not.
const NASTY = {
  "open brackets": "[".repeat(20000),
  "open links": "[a](".repeat(5000),
  "unmatched backticks": "`a ``b ```c ".repeat(1500),
  "at signs": "@a ".repeat(6000),
  "a long run of spaces inside a rule": `Always use${" ".repeat(20000)}tabs\n`,
  "a heading with trailing spaces": `# Title${" ".repeat(20000)}\n`,
  "angle brackets": "<".repeat(20000),
  "a long path-like token": `src/${"a/".repeat(5000)}x.ts`,
  "many comment openers": "<!-- ".repeat(4000),
  "deeply nested bullets": Array.from({ length: 800 }, (_, i) => `${"  ".repeat(i % 30)}- nested item ${i} with some words`).join("\n"),
};

for (const [name, text] of Object.entries(NASTY)) {
  test(`stays fast on ${name}`, () => {
    const s = sandbox({ "CLAUDE.md": text, "package.json": "{}" });
    const t0 = Date.now();
    s.analyze();
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `${ms} ms`);
  });
}

test("a memory file of 6,000 distinct lines is analyzed in seconds, not minutes", () => {
  const text = Array.from({ length: 6000 }, (_, i) => `- Rule number ${i}: always handle the case ${i} for module m${i % 97} before shipping, and never skip item ${i * 7}.`).join("\n");
  const s = sandbox({ "CLAUDE.md": text });
  const t0 = Date.now();
  const m = s.analyze();
  assert.ok(Date.now() - t0 < 15000);
  assert.ok(m.totals.memory > 50000);
});
