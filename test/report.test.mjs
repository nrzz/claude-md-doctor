import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyFix } from "../src/fix.mjs";
import { renderMarkdown, renderText, toJson } from "../src/report.mjs";
import { sandbox } from "./helpers.mjs";

const steps = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. First check that the build for target number ${i} is green, then run the packaging script and finally copy the artifacts to the staging bucket.`).join("\n");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// A project with every kind of thing the report can show.
function busy() {
  const s = sandbox({
    "CLAUDE.md": `# Project\n\nYou are a helpful assistant.\n\n- Auth lives in \`src/old/auth.ts\`.\n- See @docs/style.md and @docs/gone.md.\n\n## Release process\n\n${steps(14)}\n`,
    "CLAUDE.local.md": "- My notes.\n",
    "docs/style.md": "Use two spaces for indentation in every file.\n",
    "packages/web/CLAUDE.md": "Web rules apply here.\n",
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy the app.\n---\n",
    ".claude/skills/audit/SKILL.md": "---\nname: audit\ndescription: Audit.\ndisable-model-invocation: true\n---\n",
    ".claude/agents/helper.md": "---\nname: helper\ndescription: Helps.\n---\n",
  });
  s.cfgFile("CLAUDE.md", "- Use pnpm.\n");
  return s;
}

// ---------------------------------------------------------------- text

test("the text report shows the load tree, totals, on-demand files and findings", () => {
  const s = busy();
  const m = s.analyze({ budget: 2000 });
  const text = renderText(m);
  assert.match(text, /^claude-md-doctor 1\.0\.1/);
  assert.match(text, /Always loaded: memory files/);
  assert.match(text, /^ +[\d,]+ {2}CLAUDE\.md$/m);
  assert.match(text, /^ +[\d,]+ {4}@docs\/style\.md$/m, "an import is indented under the file that pulls it in");
  assert.match(text, /@docs\/gone\.md \(missing\)/);
  assert.match(text, /user memory/);
  assert.match(text, /personal, not for git/);
  assert.match(text, /memory total/);
  assert.match(text, /Always in context: skill and agent descriptions/);
  assert.match(text, /1 skill the model can invoke +\(1 user-only skill cost nothing\)/);
  assert.match(text, /1 agent/);
  assert.match(text, /Loaded on demand/);
  assert.match(text, /packages\/web\/CLAUDE\.md/);
  assert.match(text, /In context every session +[\d,]+ tokens +budget 2,000 +within budget \(\d+% used\)/);
  assert.match(text, /Findings: \d+ errors?, \d+ warnings?, \d+ notes?/);
});

test("each finding shows its severity, id, location, saving and fix marker", () => {
  const text = renderText(busy().analyze());
  assert.match(text, /^ERROR import-error +CLAUDE\.md:6$/m);
  assert.match(text, /^WARN {2}stale-path +CLAUDE\.md:5 {2}saves ~\d+ tokens {2}\[--fix\]$/m);
  assert.match(text, /^WARN {2}move-to-skill +CLAUDE\.md:8-\d+ {2}saves ~[\d,]+ tokens {2}\[--fix\]$/m);
  assert.match(text, /^NOTE {2}filler +CLAUDE\.md:3/m);
  assert.match(text, /^ {6}fix: /m);
});

test("the headline shows OVER when the budget is exceeded", () => {
  const text = renderText(busy().analyze({ budget: 100 }));
  assert.match(text, /budget 100 +OVER by [\d,]+/);
  assert.match(text, /^ERROR over-budget/m);
});

test("the over-budget finding leads and names the biggest contributors", () => {
  const m = busy().analyze({ budget: 100 });
  assert.equal(m.findings[0].id, "over-budget");
  assert.match(m.findings[0].fix, /^Biggest: CLAUDE\.md [\d,]+;/);
});

test("with nothing wrong the report says so", () => {
  const s = sandbox({ "CLAUDE.md": "# Project\n\n- Run `npm test` before you commit.\n" });
  const text = renderText(s.analyze());
  assert.match(text, /No problems found\./);
  assert.doesNotMatch(text, /Findings:/);
});

test("with no memory files the report says none were found", () => {
  const text = renderText(sandbox().analyze());
  assert.match(text, /none found: no CLAUDE\.md/);
  assert.match(text, /none found in \.claude\/skills/);
});

test("long messages wrap to a readable width", () => {
  const text = renderText(busy().analyze({ budget: 100 }), { width: 100 });
  for (const line of text.split("\n")) assert.ok(line.length <= 106, `${line.length}: ${line}`);
});

test("colors: none by default, ANSI codes when asked, and the same words either way", () => {
  const m = busy().analyze();
  const plain = renderText(m, { color: false });
  const colored = renderText(m, { color: true });
  assert.ok(!plain.includes("\x1b["));
  assert.ok(colored.includes("\x1b[31m"), "errors are red");
  assert.ok(colored.includes("\x1b[33m"), "warnings are yellow");
  assert.equal(strip(colored), plain);
});

test("the text report says what an automatic fix would do", () => {
  const text = renderText(busy().analyze());
  assert.match(text, /Automatic fixes would change 1 file and take [\d,]+ tokens down to about [\d,]+ \(saves [\d,]+, \d+%\)/);
});

test("skipping the user memory is mentioned in the header", () => {
  const text = renderText(busy().analyze({ user: false }));
  assert.match(text, /user memory skipped/);
  assert.doesNotMatch(text, /\(user memory\)/);
});

test("an import that is loaded twice is shown once and marked", () => {
  const s = sandbox({ "CLAUDE.md": "@a.md\n@b.md\n", "a.md": "@c.md\n", "b.md": "@c.md\n", "c.md": "Shared text for both.\n" });
  assert.match(renderText(s.analyze()), /@c\.md \(already loaded above, counted once\)/);
});

// ---------------------------------------------------------------- markdown

test("the markdown report is compact and has what a pull-request comment needs", () => {
  const md = renderMarkdown(busy().analyze({ budget: 100 }));
  assert.match(md, /^## claude-md-doctor/);
  assert.match(md, /\*\*[\d,]+ tokens in context every session\*\* \(budget 100: \*\*over by [\d,]+\*\*\)/);
  assert.match(md, /Estimates, not Claude's own count\./);
  assert.match(md, /- Memory files: [\d,]+ tokens in \d+ files/);
  assert.match(md, /- Skill and agent descriptions: [\d,]+ tokens \(1 skill, 1 agent\)/);
  assert.match(md, /- Loaded on demand, not counted: 1 file/);
  assert.match(md, /\| File \| Tokens \|/);
  assert.match(md, /### Findings: /);
  assert.match(md, /- \*\*error\*\* `over-budget`/);
  assert.match(md, /- \*\*warn\*\* `stale-path` `CLAUDE\.md:5` \(saves ~\d+\): `src\/old\/auth\.ts` does not exist\. Fix: /);
  assert.match(md, /`claude-md-doctor --fix` writes a proposal/);
  assert.ok(!md.includes("\x1b["));
});

test("the markdown report caps the findings at 25 and says how many more there are", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `- See \`src/gone${i}.ts\` for part ${i}.`).join("\n");
  const m = sandbox({ "CLAUDE.md": `${lines}\n` }).analyze();
  assert.equal(m.findings.length, 40);
  const md = renderMarkdown(m);
  assert.equal((md.match(/^- \*\*warn\*\*/gm) || []).length, 25);
  assert.match(md, /\.\.\.and 15 more \(run `claude-md-doctor` for the full list, or `--json`\)\./);
});

test("the markdown report for a clean project is short", () => {
  const md = renderMarkdown(sandbox({ "CLAUDE.md": "- Run `npm test`.\n" }).analyze());
  assert.match(md, /No problems found\./);
  assert.ok(md.split("\n").length < 14);
});

test("pipes in file names are escaped in the markdown table", (t) => {
  const s = sandbox({ "CLAUDE.md": "@docs/a|b.md\n" });
  try {
    s.file("docs/a|b.md", "x\n");
  } catch {
    t.skip("this file system does not allow | in a file name");
    return;
  }
  assert.match(renderMarkdown(s.analyze()), /docs\/a\\\|b\.md/);
});

// ---------------------------------------------------------------- JSON

const json = (model, extra) => JSON.parse(JSON.stringify(toJson(model, extra)));

test("the JSON report has the documented top-level shape", () => {
  const j = json(busy().analyze({ budget: 2000 }));
  assert.deepEqual(Object.keys(j), ["schema", "tool", "version", "project", "configDir", "budget", "totals", "files", "tree", "skills", "agents", "onDemand", "findings", "summary", "plan", "fix", "ci"]);
  assert.equal(j.schema, 1);
  assert.equal(j.tool, "claude-md-doctor");
  assert.equal(j.version, "1.0.1");
  assert.equal(j.budget, 2000);
  assert.equal(j.fix, null);
  assert.equal(typeof j.project, "string");
  assert.ok(!j.project.includes("\\"), "forward slashes on every system");
});

test("JSON totals", () => {
  const j = json(busy().analyze({ budget: 100 }));
  assert.deepEqual(Object.keys(j.totals), ["memory", "skills", "agents", "onDemand", "alwaysInContext", "overBudget"]);
  assert.equal(j.totals.alwaysInContext, j.totals.memory + j.totals.skills + j.totals.agents);
  assert.equal(j.totals.memory, j.files.reduce((n, f) => n + f.tokens, 0));
  assert.equal(j.totals.overBudget, true);
  assert.equal(j.summary.overBudget, true);
});

test("JSON files, tree, skills, agents and on-demand entries", () => {
  const j = json(busy().analyze());
  const file = j.files.find((f) => f.path === "docs/style.md");
  assert.deepEqual(Object.keys(file).sort(), ["abs", "depth", "importLine", "importedBy", "kind", "lines", "path", "ref", "rewritable", "tokens"]);
  assert.equal(file.importedBy, "CLAUDE.md");
  assert.equal(file.depth, 1);
  assert.equal(file.rewritable, false);
  assert.deepEqual(Object.keys(j.tree[0]), ["path", "ref", "tokens", "note", "children"]);
  assert.ok(j.tree.some((n) => n.children.some((c) => c.note === "missing")));
  assert.deepEqual(j.skills.map((x) => [x.name, x.modelInvocable]).sort(), [["audit", false], ["deploy", true]]);
  assert.deepEqual(Object.keys(j.skills[0]), ["name", "scope", "path", "description", "modelInvocable", "tokens"]);
  assert.deepEqual(Object.keys(j.agents[0]), ["name", "scope", "path", "description", "tokens"]);
  assert.deepEqual(j.onDemand.map((x) => x.path), ["packages/web/CLAUDE.md"]);
});

test("JSON findings carry every field the docs promise", () => {
  const j = json(busy().analyze());
  assert.ok(j.findings.length >= 4);
  for (const f of j.findings) {
    assert.deepEqual(Object.keys(f), ["id", "severity", "file", "line", "endLine", "tokens", "saves", "message", "fix", "autofix", "detail"]);
    assert.ok(["error", "warn", "info"].includes(f.severity));
    assert.equal(typeof f.id, "string");
    assert.equal(typeof f.message, "string");
    assert.equal(typeof f.fix, "string");
    assert.equal(typeof f.tokens, "number");
    assert.equal(typeof f.saves, "number");
    assert.equal(typeof f.autofix, "boolean");
    assert.equal(typeof f.detail, "object");
  }
  const ids = new Set(j.findings.map((f) => f.id));
  for (const id of ["import-error", "stale-path", "filler", "move-to-skill"]) assert.ok(ids.has(id), id);
});

test("JSON summary and plan", () => {
  const j = json(busy().analyze());
  assert.deepEqual(Object.keys(j.summary), ["errors", "warnings", "notes", "overBudget", "potentialSavings", "leanTotal"]);
  assert.equal(j.summary.errors, j.findings.filter((f) => f.severity === "error").length);
  assert.equal(j.summary.warnings, j.findings.filter((f) => f.severity === "warn").length);
  assert.equal(j.summary.notes, j.findings.filter((f) => f.severity === "info").length);
  assert.equal(j.plan.after, j.summary.leanTotal);
  assert.equal(j.plan.before - j.plan.after, j.summary.potentialSavings);
  assert.deepEqual(j.plan.files.map((f) => f.path), ["CLAUDE.md"]);
  assert.deepEqual(j.plan.skills.map((k) => k.slug), ["release-process"]);
});

test("JSON is stable: the same project gives the same output", () => {
  const s = busy();
  assert.equal(JSON.stringify(toJson(s.analyze())), JSON.stringify(toJson(s.analyze())));
});

test("JSON includes what --fix did", () => {
  const s = busy();
  const m = s.analyze();
  const result = applyFix(m, { write: false });
  const j = json(m, { fixResult: result, ci: { enabled: true, pass: false } });
  assert.equal(j.fix.mode, "proposal");
  assert.deepEqual(j.fix.files, ["CLAUDE.md.lean"]);
  assert.deepEqual(j.fix.skills, [".claude-md-doctor/proposed-skills/release-process/SKILL.md"]);
  assert.deepEqual(j.fix.backups, []);
  assert.deepEqual(j.ci, { enabled: true, pass: false });
});

test("JSON findings are sorted: errors, then warnings, then notes", () => {
  const j = json(busy().analyze({ budget: 100 }));
  const rank = { error: 0, warn: 1, info: 2 };
  const ranks = j.findings.map((f) => rank[f.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("once --fix has run, the report does not offer it again", () => {
  const m = busy().analyze();
  assert.match(renderText(m), /`claude-md-doctor --fix` writes a proposal/);
  const fixed = renderText(m, { fixed: true });
  assert.doesNotMatch(fixed, /writes a proposal/);
  assert.match(fixed, /Automatic fixes would change/);
});

test("the biggest skill and agent descriptions are named, so it is clear what to shorten", () => {
  const files = {};
  for (let i = 0; i < 11; i++) files[`.claude/skills/s${i}/SKILL.md`] = `---\nname: s${i}\ndescription: ${"A description that is a little longer. ".repeat(i + 1)}\n---\n`;
  files[".claude/agents/helper.md"] = "---\nname: helper\ndescription: Helps.\n---\n";
  const text = renderText(sandbox(files).analyze());
  assert.match(text, /^ +[\d,]+ {4}s10 {2}\(project skill\)$/m, "the biggest comes first");
  assert.match(text, /\.\.\.and 3 more/);
  assert.ok(text.indexOf("s10  (project skill)") < text.indexOf("s3  (project skill)"));
  assert.doesNotMatch(text, /s0 {2}\(project skill\)/, "the smallest is left out");
  assert.match(text, /^ +\d+ {4}helper {2}\(project agent\)$/m);
});
