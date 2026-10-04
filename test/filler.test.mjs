import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { of, sandbox } from "./helpers.mjs";

const filler = (files, opts) => of(sandbox(files).analyze(opts), "filler");
const md = (text) => ({ "CLAUDE.md": text });
const messages = (list) => list.map((f) => f.line);

const FILLER_LINES = [
  "You are a helpful assistant.",
  "You are a helpful AI assistant.",
  "You are an expert software engineer.",
  "You are a world-class senior developer.",
  "Act as a senior software engineer.",
  "Write clean code.",
  "Always write clean, readable, maintainable code.",
  "Write high-quality code.",
  "Follow best practices.",
  "Always follow industry best practices.",
  "Use coding best practices and conventions.",
  "Be careful.",
  "Be thorough and accurate.",
  "Think step by step.",
  "Think carefully.",
  "Double-check your work.",
  "Review your code carefully.",
  "Do your best.",
  "Use your best judgment.",
  "Use common sense.",
  "Make sure the code is correct.",
  "Ensure your output is high quality.",
  "Don't make mistakes.",
  "Do not hallucinate.",
];

for (const line of FILLER_LINES) {
  test(`filler: "${line}"`, () => {
    const s = sandbox(md(`# Rules\n\n- ${line}\n- Run \`npm test\` before you commit your work.\n`));
    const found = of(s.analyze(), "filler");
    assert.equal(found.length, 1, "exactly the filler line");
    assert.equal(found[0].line, 3);
  });
}

test("a filler finding is an info note with the line's tokens as its saving", () => {
  const [f] = filler(md("You are a helpful assistant.\n"));
  assert.equal(f.severity, "info");
  assert.ok(f.tokens >= 5);
  assert.equal(f.saves, f.tokens);
  assert.equal(f.autofix, true);
  assert.equal(f.fix, "Delete the line.");
  assert.match(f.message, /does not change what Claude does/);
});

test("filler as a paragraph, with markdown around it", () => {
  assert.equal(filler(md("**You are a helpful assistant.**\n\nMore text about the project follows here.\n")).length, 1);
});

// ---------------------------------------------------------------- false-positive guards

const real = (name, line) => test(`not filler: ${name}`, () => assert.deepEqual(filler(md(`- ${line}\n`)), []));

real("a rule with substance around the phrase", "Follow best practices for React hooks: list every dependency, never call a hook conditionally, and keep effects small.");
real("a persona with a specific job", "You are a code reviewer: list only bugs and security problems, skip style comments, and cite the line numbers.");
real("a specific quality rule", "Write tests that fail first, then make them pass, and keep each test under twenty lines.");
real("a specific instruction about being careful", "Be careful with migrations: never edit a file in db/migrations after it has been merged to main.");
real("an instruction to think about something specific", "Think about backwards compatibility whenever you change a public function signature in the sdk package.");
real("a short line that names what to be careful with", "Be careful with database migrations.");
real("a command", "Run `npm test` before you commit.");
real("a path rule", "Source files live in src/ and tests live in test/.");

test("headings and code are never filler", () => {
  assert.deepEqual(filler(md("## Write clean code\n\n```\nFollow best practices.\n```\n")), []);
});

test("a long line is not treated as filler even if it starts like one", () => {
  const long = "You are a helpful assistant that works on the billing service and must always use the shared money type for amounts, never floats, and add a migration for every schema change you make.";
  assert.deepEqual(filler(md(`${long}\n`)), []);
});

// ---------------------------------------------------------------- "be concise" repeated

test('"be concise" once is a real instruction', () => {
  assert.deepEqual(filler(md("- Be concise.\n- Run `npm test` before you commit.\n")), []);
});

test('"be concise" repeated: only the repeats are filler', () => {
  const found = filler(md("- Be concise.\n- Keep responses short.\n- Always be brief.\n- Respond concisely.\n"));
  assert.deepEqual(messages(found).sort(), [2, 3, 4]);
  assert.match(found[0].message, /repeats the style instruction at CLAUDE\.md:1/);
  assert.equal(found[0].detail.of.line, 1);
});

test("the repeats can be in another file", () => {
  const s = sandbox({ "CLAUDE.md": "- Be concise.\n", "CLAUDE.local.md": "- Keep answers brief.\n" });
  const [f] = of(s.analyze(), "filler");
  assert.equal(f.file, "CLAUDE.local.md");
  assert.equal(f.autofix, true);
});

test("filler in the user memory is reported but not auto-fixed", () => {
  const s = sandbox();
  s.cfgFile("CLAUDE.md", "- Write clean code.\n");
  const [f] = of(s.analyze(), "filler");
  assert.equal(f.autofix, false);
});

test("a filler item with nested bullets is left alone by --fix", () => {
  const [f] = filler(md("- Follow best practices.\n  - for example this one\n"));
  assert.equal(f.autofix, false);
});
