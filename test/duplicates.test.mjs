import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { of, sandbox } from "./helpers.mjs";

const dups = (s, opts) => of(s.analyze(opts), "duplicate");

const RULE = "Always run the linter and the formatter before you commit any changes to the main branch";

test("an identical bullet is flagged on its second copy", () => {
  const s = sandbox({ "CLAUDE.md": `# Rules\n\n- ${RULE}\n- Keep functions small.\n- ${RULE}\n` });
  const [f] = dups(s);
  assert.equal(f.severity, "warn");
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.line, 5);
  assert.match(f.message, /^repeats CLAUDE\.md:3:/);
  assert.equal(f.detail.exact, true);
  assert.deepEqual(f.detail.of, { file: "CLAUDE.md", line: 3 });
  assert.ok(f.tokens > 10);
  assert.equal(f.saves, f.tokens);
  assert.equal(f.autofix, true);
});

test("three copies give two findings, both pointing at the first", () => {
  const s = sandbox({ "CLAUDE.md": `- ${RULE}\n\n- ${RULE}\n\n- ${RULE}\n` });
  const found = dups(s);
  assert.deepEqual(found.map((f) => f.line).sort(), [3, 5]);
  assert.ok(found.every((f) => f.detail.of.line === 1));
});

test("case, punctuation and markdown do not hide a duplicate", () => {
  const s = sandbox({ "CLAUDE.md": "- **Always** run the linter, and the formatter, before you commit any changes to main!\n- always run the linter and the formatter before you commit any changes to main\n" });
  assert.equal(dups(s).length, 1);
});

test("near-identical lines (one word different out of fourteen) are flagged as near duplicates", () => {
  const a = "Always run the linter and the formatter before you commit any changes to main today";
  const b = "Always run the linter and the formatter before you commit any changes to trunk today";
  const s = sandbox({ "CLAUDE.md": `- ${a}\n- ${b}\n` });
  const [f] = dups(s);
  assert.equal(f.detail.exact, false);
  assert.match(f.message, /^nearly repeats/);
  assert.deepEqual(f.detail.differ.sort(), ["main", "trunk"]);
  assert.match(f.fix, /Merge the two into one line \(they differ in: /);
  assert.equal(f.autofix, false, "--fix only removes exact repeats");
  assert.ok(f.saves > 0, "merging them would still save the second line");
});

test("lines that differ in a number are not duplicates", () => {
  const a = "Always run the linter and the formatter on port 3000 before you commit any changes to main today";
  const b = "Always run the linter and the formatter on port 8080 before you commit any changes to main today";
  assert.deepEqual(dups(sandbox({ "CLAUDE.md": `- ${a}\n- ${b}\n` })), []);
  const steps = "1. First check the build and then run the packaging script and finally copy the artifacts to staging\n2. First check the build and then run the packaging script and finally copy the artifacts to staging";
  assert.deepEqual(dups(sandbox({ "CLAUDE.md": `${steps}\n` })).length, 1, "the same words and no number difference are an exact repeat");
});

test("lines that share less than 85 percent of their words are not duplicates", () => {
  const a = "Always run the linter and the formatter before you commit any changes to main today";
  const b = "Always run the linter and the formatter before you push any code to the remote today";
  const s = sandbox({ "CLAUDE.md": `- ${a}\n- ${b}\n` });
  assert.deepEqual(dups(s), []);
});

test("lines of fewer than five words are never duplicates", () => {
  const s = sandbox({ "CLAUDE.md": "- Run the tests.\n- Run the tests.\n- Use pnpm.\n- Use pnpm.\n" });
  assert.deepEqual(dups(s), []);
});

test("lines that differ in polarity are not duplicates (the conflict check looks at those)", () => {
  const s = sandbox({ "CLAUDE.md": "- Always use semicolons at the end of every statement in this repository\n- Never use semicolons at the end of every statement in this repository\n" });
  assert.deepEqual(dups(s), []);
});

test("headings, table rows and code lines are not compared", () => {
  const s = sandbox({
    "CLAUDE.md": "## Always run the linter and the formatter before you commit\n## Always run the linter and the formatter before you commit\n\n| Always run the linter and the formatter | before commit |\n| Always run the linter and the formatter | before commit |\n\n```\nAlways run the linter and the formatter before you commit\nAlways run the linter and the formatter before you commit\n```\n",
  });
  assert.deepEqual(dups(s), []);
});

test("a wrapped bullet is compared as a whole", () => {
  const s = sandbox({ "CLAUDE.md": "- Always run the linter and the formatter\n  before you commit any changes to the main branch\n- Always run the linter and the formatter before you commit any changes to the main branch\n" });
  const [f] = dups(s);
  assert.equal(f.line, 3);
  assert.deepEqual(f.detail.of, { file: "CLAUDE.md", line: 1 });
});

test("a duplicate across the project memory and CLAUDE.local.md is flagged on the local file", () => {
  const s = sandbox({ "CLAUDE.md": `- ${RULE}\n`, "CLAUDE.local.md": `- ${RULE}\n` });
  const [f] = dups(s);
  assert.equal(f.file, "CLAUDE.local.md");
  assert.equal(f.autofix, true);
  assert.match(f.fix, /keep CLAUDE\.md/);
});

test("a duplicate across .claude/CLAUDE.md and CLAUDE.md is flagged on the later file", () => {
  const s = sandbox({ "CLAUDE.md": `- ${RULE}\n`, ".claude/CLAUDE.md": `- ${RULE}\n` });
  const [f] = dups(s);
  assert.equal(f.file, ".claude/CLAUDE.md");
});

test("a rule repeated from a parent folder's CLAUDE.md is flagged on the project and can be removed there", () => {
  const s = sandbox({ "CLAUDE.md": `- ${RULE}\n` });
  s.baseFile("CLAUDE.md", `- ${RULE}\n`);
  const [f] = dups(s);
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.autofix, true);
});

test("a duplicate of a line in the user memory is reported but never auto-removed", () => {
  const s = sandbox({ "CLAUDE.md": `- ${RULE}\n` });
  s.cfgFile("CLAUDE.md", `- ${RULE}\n`);
  const [f] = dups(s);
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.autofix, false);
  assert.match(f.fix, /Also in your user memory/);
  assert.match(f.fix, /teammates/);
});

test("a duplicate inside the user memory itself is reported but not auto-fixed", () => {
  const s = sandbox();
  s.cfgFile("CLAUDE.md", `- ${RULE}\n- ${RULE}\n`);
  const [f] = dups(s);
  assert.equal(f.autofix, false);
});

test("a line repeated from an imported file is reported on the memory file, which can drop it", () => {
  const s = sandbox({ "CLAUDE.md": `@docs/rules.md\n\n- ${RULE}\n`, "docs/rules.md": `- ${RULE}\n` });
  const [f] = dups(s);
  // the imported file is not ours to rewrite, so the memory's own copy is the one to go
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.line, 3);
  assert.equal(f.autofix, true);
  assert.deepEqual(f.detail.of, { file: "docs/rules.md", line: 1 });
});

test("a duplicate bullet with nested bullets is reported but left alone by --fix", () => {
  const s = sandbox({ "CLAUDE.md": `- ${RULE}\n- ${RULE}\n  - with a sub point\n` });
  const [f] = dups(s);
  assert.equal(f.autofix, false);
});

test("a duplicate line that carries an import is not auto-removed", () => {
  const line = "Always read @docs/rules.md and follow every rule written in it before you start any task";
  const s = sandbox({ "CLAUDE.md": `- ${line}\n- ${line}\n`, "docs/rules.md": "x\n" });
  const [f] = dups(s);
  assert.equal(f.autofix, false);
});

test("the pointer lines --fix writes are never duplicates of each other", () => {
  const s = sandbox({ "CLAUDE.md": "Release process: use the `release-process` skill.\nRelease process: use the `release-process-2` skill.\n" });
  assert.deepEqual(dups(s), []);
});

test("different lines produce no findings", () => {
  const s = sandbox({ "CLAUDE.md": "- Run `npm test` before you commit.\n- Keep the public API small and well documented.\n- Prefer composition over inheritance in new modules.\n" });
  assert.deepEqual(dups(s), []);
});

test("an identical long line in CJK text is a duplicate even without spaces", () => {
  const line = "请在提交代码之前运行所有测试并确保全部通过否则不要提交";
  const s = sandbox({ "CLAUDE.md": `- ${line}\n- ${line}\n` });
  assert.equal(dups(s).length, 1);
});
