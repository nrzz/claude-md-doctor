import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { directives } from "../src/checks/conflicts.mjs";
import { of, sandbox } from "./helpers.mjs";

const conflicts = (files, opts) => of(sandbox(files).analyze(opts), "conflict");
const md = (text) => ({ "CLAUDE.md": text });

// ---------------------------------------------------------------- directives

test("directives: positive, negative and imperative rules", () => {
  const found = directives("Always use semicolons. Never use tabs. Do not commit secrets. Run the linter first.");
  assert.deepEqual(found.map((d) => d.polarity), [1, -1, -1, 1]);
  assert.deepEqual(found.map((d) => d.phrase), ["use semicolons", "use tabs", "commit secrets", "Run the linter first"]);
});

test("directives: a rule's condition is cut off from its subject", () => {
  const [d] = directives("Always run the tests before committing, unless the change is docs only.");
  assert.equal(d.phrase, "run the tests");
});

test("directives need at least two content words", () => {
  assert.deepEqual(directives("Always test."), []);
});

// ---------------------------------------------------------------- always vs never

test('"always X" against "never X" is a conflict, reported on the later one', () => {
  const [f] = conflicts(md("# Rules\n\n- Always use semicolons in this repository.\n- Never use semicolons in this repository.\n"));
  assert.equal(f.severity, "warn");
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.line, 4);
  assert.match(f.message, /contradicts/);
  assert.match(f.message, /CLAUDE\.md:3/);
  assert.deepEqual(f.detail.with, { file: "CLAUDE.md", line: 3 });
  assert.equal(f.saves, 0);
  assert.equal(f.autofix, false);
  assert.match(f.fix, /Decide which rule holds/);
});

test('"must X" against "must not X" is a conflict', () => {
  assert.equal(conflicts(md("- You must run the formatter before pushing.\n- You must not run the formatter before pushing.\n")).length, 1);
});

test('"commit" against "do not commit" on the same subject is a conflict', () => {
  const found = conflicts(md("- Commit changes after each task.\n- Do not commit changes until asked.\n"));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('"commit package-lock.json" against "never commit package-lock.json files"', () => {
  assert.equal(conflicts(md("- Commit package-lock.json with every dependency change.\n- Never commit package-lock.json files.\n")).length, 1);
});

test("a conflict across files: user memory against the project memory", () => {
  const s = sandbox(md("- Never use semicolons in this repository.\n"));
  s.cfgFile("CLAUDE.md", "- Always use semicolons in this repository.\n");
  const [f] = of(s.analyze(), "conflict");
  assert.equal(f.file, "CLAUDE.md");
  assert.match(f.message, /CLAUDE\.md:1/);
  assert.match(f.detail.with.file, /CLAUDE\.md$/);
});

test("a conflict between CLAUDE.md and CLAUDE.local.md", () => {
  const s = sandbox({ "CLAUDE.md": "- Always mock the database in unit tests.\n", "CLAUDE.local.md": "- Never mock the database in unit tests.\n" });
  const [f] = of(s.analyze(), "conflict");
  assert.equal(f.file, "CLAUDE.local.md");
});

// ---------------------------------------------------------------- not conflicts

const noConflict = (name, text) => test(`not a conflict: ${name}`, () => assert.deepEqual(conflicts(md(text)).map((f) => f.message), []));

noConflict("a rule with a different scope", "- Always run the tests before committing.\n- Never run the tests in production.\n");
noConflict("different subjects", "- Always commit to feature branches.\n- Never commit to main.\n");
noConflict("the same polarity twice", "- Always use pnpm in this repository.\n- Always use pnpm for installs here.\n");
noConflict("a rule and its own exception in one sentence", "- Never use any, except in test files.\n");
noConflict("a negative rule alone", "- Do not commit secrets or credentials.\n");
noConflict("unrelated rules", "- Always write tests for new features.\n- Never log personal data.\n- Avoid deep nesting.\n");

// ---------------------------------------------------------------- package managers

test("two different package managers named as the one to use", () => {
  const [f] = conflicts(md("- Use pnpm for installs.\n- Use npm for installs.\n"));
  assert.match(f.message, /names npm as the package manager, but CLAUDE\.md:1 names pnpm/);
  assert.deepEqual(f.detail.managers.sort(), ["npm", "pnpm"]);
  assert.equal(f.line, 2);
});

test("install commands count: pnpm install in one place, yarn add in another", () => {
  const [f] = conflicts(md("Setup:\n\n```bash\npnpm install\n```\n\nTo add a package run `yarn add left-pad`.\n"));
  assert.ok(f);
  assert.deepEqual(f.detail.managers.sort(), ["pnpm", "yarn"]);
});

test("saying which one NOT to use is not a conflict", () => {
  assert.deepEqual(conflicts(md("- Use pnpm, not npm.\n- Never use yarn; do not run npm install.\n")), []);
});

test("one package manager everywhere is fine", () => {
  assert.deepEqual(conflicts(md("- Use pnpm.\n\n```bash\npnpm install\npnpm test\n```\n")), []);
});

test("installing a tool globally with npm says nothing about the project", () => {
  assert.deepEqual(conflicts(md("- Use pnpm for installs.\n- Install the CLI with `npm install -g tool`.\n")), []);
});

test("an imported README that lists every package manager is not a conflict", () => {
  const files = { "CLAUDE.md": "Use pnpm here. @README.md\n", "README.md": "Install with npm install, or yarn add, or bun add.\n" };
  assert.deepEqual(conflicts(files), []);
});

// ---------------------------------------------------------------- indentation

test("tabs against spaces", () => {
  const [f] = conflicts(md("- Indent with tabs.\n- Use 2 spaces for indentation.\n"));
  assert.match(f.message, /asks for spaces but CLAUDE\.md:1 asks for tabs/);
});

test("two different space widths", () => {
  const [f] = conflicts(md("- Use 2 spaces for indentation.\n- Use 4-space indentation.\n"));
  assert.match(f.message, /4-space indentation but CLAUDE\.md:1 asks for 2/);
  // A width for some files only is an exception, not a contradiction.
  assert.deepEqual(conflicts(md("- Use 2 spaces for indentation.\n- Use 4-space indentation in Python files.\n")), []);
});

test('"spaces, never tabs" is not a conflict', () => {
  assert.deepEqual(conflicts(md("- Use 2 spaces for indentation, never tabs.\n- Do not use tabs.\n")), []);
});

test("the same indentation twice is fine", () => {
  assert.deepEqual(conflicts(md("- Use 2 spaces for indentation.\n- Two spaces, always.\n- Indent with 2 spaces in YAML too.\n")), []);
});

test("conflicts are only ever warnings, and never auto-fixed", () => {
  const found = conflicts(md("- Always use semicolons here.\n- Never use semicolons here.\n- Use pnpm.\n- Use npm.\n- Use tabs.\n- Use 2 spaces.\n"));
  assert.ok(found.length >= 3);
  assert.ok(found.every((f) => f.severity === "warn" && f.autofix === false && f.saves === 0));
});

test("a line that scopes tabs and spaces itself is not a conflict", () => {
  assert.deepEqual(conflicts(md("- Use tabs in Go files and 2 spaces everywhere else.\n")), []);
  assert.deepEqual(conflicts(md("- Use tabs in Go files and 2 spaces everywhere else.\n- Use 2 spaces in YAML.\n")), []);
});
