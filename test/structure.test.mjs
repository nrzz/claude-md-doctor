import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { BIG_BLOCK_LINES, BIG_IMPORT_TOKENS } from "../src/checks/structure.mjs";
import { procedureScore, proposeSkill, SKILL_MIN_TOKENS } from "../src/skills.mjs";
import { parseDoc, sectionsOf } from "../src/markdown.mjs";
import { estimateTokens } from "../src/tokens.mjs";
import { of, sandbox } from "./helpers.mjs";

// A numbered procedure of `n` steps, each a sentence of a known weight.
const steps = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. First check that the build for target number ${i} is green, then run the packaging script and finally copy the artifacts to the staging bucket.`).join("\n");
const section = (title, body) => `## ${title}\n\n${body}\n`;
const skills = (files, opts) => of(sandbox(files).analyze(opts), "move-to-skill");

// ---------------------------------------------------------------- move-to-skill

test("a long numbered procedure under a release heading is a move-to-skill finding", () => {
  const text = `# Project\n\n- Keep it small.\n\n${section("Release process", steps(14))}\n## Style\n\n- Use two spaces.\n`;
  const [f] = skills({ "CLAUDE.md": text });
  assert.equal(f.severity, "warn");
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.line, 5);
  assert.ok(f.tokens > SKILL_MIN_TOKENS);
  assert.ok(f.saves > 0 && f.saves < f.tokens);
  assert.match(f.message, /"Release process" is [\d,]+ tokens and reads like a procedure/);
  assert.match(f.fix, /\.claude\/skills\/release-process\/SKILL\.md/);
  assert.equal(f.detail.slug, "release-process");
  assert.ok(f.detail.description.length < 100);
  assert.equal(f.autofix, true);
});

test("the tokens saved are the section minus a one-line pointer minus the skill's description", () => {
  const text = section("Release process", steps(14));
  const doc = parseDoc(text);
  const [sec] = sectionsOf(doc, 2);
  const p = proposeSkill(doc, sec);
  assert.equal(p.net, p.sectionTokens - p.pointerTokens - p.descTokens);
  const [f] = skills({ "CLAUDE.md": text });
  assert.equal(f.saves, p.net);
});

test("headings that name a procedure are recognised", () => {
  for (const title of ["Deploying to production", "How to add a migration", "Local setup", "Publishing a release", "Rollback runbook", "Onboarding checklist", "Upgrading dependencies"]) {
    const found = skills({ "CLAUDE.md": section(title, steps(14)) });
    assert.equal(found.length, 1, title);
  }
});

test("a long section that is not a procedure is left alone", () => {
  const prose = Array.from({ length: 14 }, (_, i) => `- Module ${i} owns its own data and exposes a small interface, and no other module may reach into its tables or caches directly.`).join("\n");
  assert.deepEqual(skills({ "CLAUDE.md": section("Architecture", prose) }), []);
});

test("a long list of numbered RULES is not a procedure", () => {
  const rules = Array.from({ length: 16 }, (_, i) => `${i + 1}. Module number ${i} keeps its public interface small and exposes none of its internal data structures to callers.`).join("\n");
  assert.ok(estimateTokens(rules) > SKILL_MIN_TOKENS);
  assert.deepEqual(skills({ "CLAUDE.md": section("Coding conventions", rules) }), []);
});

test("a procedure under 350 tokens stays in the memory", () => {
  const text = section("Release process", steps(3));
  assert.ok(estimateTokens(text) < SKILL_MIN_TOKENS);
  assert.deepEqual(skills({ "CLAUDE.md": text }), []);
});

test("the section's sub-headings count as part of it", () => {
  const body = `### Before\n\n${steps(7)}\n\n### After\n\n${steps(7)}`;
  const [f] = skills({ "CLAUDE.md": section("Release process", body) });
  assert.ok(f);
  assert.equal(f.endLine > f.line + 10, true);
});

test("a section that imports a file is not moved", () => {
  const body = `See @docs/steps.md first.\n\n${steps(14)}`;
  assert.deepEqual(skills({ "CLAUDE.md": section("Release process", body), "docs/steps.md": "x\n" }), []);
});

test("sections of imported files are not proposed as skills", () => {
  assert.deepEqual(skills({ "CLAUDE.md": "@docs/release.md\n", "docs/release.md": section("Release process", steps(14)) }), []);
});

test("a procedure in a parent folder's CLAUDE.md is reported but cannot be auto-fixed", () => {
  const s = sandbox({ "CLAUDE.md": "# x\n" });
  s.baseFile("CLAUDE.md", section("Release process", steps(14)));
  const [f] = of(s.analyze(), "move-to-skill");
  assert.equal(f.autofix, false);
});

test("procedureScore explains itself", () => {
  const doc = parseDoc(section("Release process", steps(5)));
  const [sec] = sectionsOf(doc, 2);
  const { score, reasons } = procedureScore(doc, sec);
  assert.ok(score >= 3);
  assert.ok(reasons.some((r) => /numbered steps/.test(r)));
});

test("the proposed skill keeps the body and moves sub-headings up a level", () => {
  const text = "## Release process\n\nIntro line.\n\n### Step one\n\nDo it.\n";
  const doc = parseDoc(text);
  const p = proposeSkill(doc, sectionsOf(doc, 2)[0], "release-process");
  assert.match(p.skillText, /^---\nname: release-process\ndescription: "/);
  assert.match(p.skillText, /\n---\n\n# Release process\n\nIntro line\.\n\n## Step one\n\nDo it\.\n$/);
  assert.equal(p.pointer, "Release process: use the `release-process` skill.");
});

test("the generated description is under 100 characters, even for a long heading", () => {
  const long = "Releasing the production build of the customer facing web application to every region";
  const doc = parseDoc(`## ${long}\n\nbody\n`);
  const p = proposeSkill(doc, sectionsOf(doc, 2)[0]);
  assert.ok(p.description.length < 100, p.description);
  assert.ok(p.description.length > 20);
});

test("heading punctuation does not leak into the slug or the pointer", () => {
  const doc = parseDoc("## **Deploy**: staging & prod!\n\nbody\n");
  const p = proposeSkill(doc, sectionsOf(doc, 2)[0]);
  assert.equal(p.slug, "deploy-staging-prod");
  assert.match(p.pointer, /^Deploy: staging & prod!/);
});

// ---------------------------------------------------------------- big-code-block

const block = (n, lang = "bash") => `\`\`\`${lang}\n${Array.from({ length: n }, (_, i) => `echo "step ${i}"`).join("\n")}\n\`\`\`\n`;
const blocks = (files, opts) => of(sandbox(files).analyze(opts), "big-code-block");

test("a fenced block of more than 25 lines is flagged", () => {
  const [f] = blocks({ "CLAUDE.md": `## Deploy script\n\n${block(26)}` });
  assert.equal(f.severity, "warn");
  assert.equal(f.line, 3);
  assert.equal(f.endLine, 30);
  assert.ok(f.tokens > 50);
  assert.equal(f.saves < f.tokens, true);
  assert.match(f.message, /a 26-line code block costs/);
  assert.equal(f.detail.lines, 26);
  assert.equal(f.detail.suggested, "scripts/deploy-script.sh");
});

test("exactly 25 lines is allowed", () => {
  assert.equal(BIG_BLOCK_LINES, 25);
  assert.deepEqual(blocks({ "CLAUDE.md": block(25) }), []);
});

test("the suggested file depends on the language", () => {
  assert.equal(blocks({ "CLAUDE.md": `## Config\n\n${block(30, "json")}` })[0].detail.suggested, "docs/config.json");
  assert.equal(blocks({ "CLAUDE.md": `## Config\n\n${block(30, "")}` })[0].detail.suggested, "docs/config.txt");
  assert.equal(blocks({ "CLAUDE.md": `## Build\n\n${block(30, "powershell")}` })[0].detail.suggested, "scripts/build.ps1");
});

test("an unclosed fence is measured to the end of the file", () => {
  const text = `\`\`\`bash\n${Array.from({ length: 30 }, (_, i) => `echo ${i}`).join("\n")}\n`;
  const [f] = blocks({ "CLAUDE.md": text });
  assert.equal(f.endLine, 31);
});

test("big blocks in imported files are reported too, since they are loaded every session", () => {
  const [f] = blocks({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": block(30) });
  assert.equal(f.file, "docs/a.md");
});

// ---------------------------------------------------------------- big-import

const doc = (paragraphs) => Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i} explains one part of the system in a few plain sentences so that the file has some weight in it.`).join("\n\n");
const imports = (files, opts) => of(sandbox(files).analyze(opts), "big-import");

test("an import that pulls in more than 1,500 tokens is flagged", () => {
  const big = doc(120);
  assert.ok(estimateTokens(big) > BIG_IMPORT_TOKENS);
  const [f] = imports({ "CLAUDE.md": "# Project\n\nRead @README.md for the overview.\n", "README.md": big });
  assert.equal(f.severity, "warn");
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.line, 3);
  assert.ok(f.tokens > BIG_IMPORT_TOKENS);
  assert.ok(f.saves > BIG_IMPORT_TOKENS - 20);
  assert.match(f.message, /^@README\.md pulls [\d,]+ tokens into every session/);
  assert.match(f.fix, /one-line pointer/);
  assert.equal(f.detail.ref, "README.md");
});

test("an import under the limit is fine", () => {
  assert.deepEqual(imports({ "CLAUDE.md": "@README.md\n", "README.md": doc(20) }), []);
});

test("the size of an import includes what it imports in turn", () => {
  // b.md alone is about 1,100 tokens, a.md's own text about 560: only together do they pass 1,500
  const files = { "CLAUDE.md": "@a.md\n", "a.md": `@b.md\n\n${doc(20)}`, "b.md": doc(40) };
  const found = imports(files);
  assert.equal(found.length, 1);
  assert.equal(found[0].detail.ref, "a.md");
});

test("a file imported twice is only judged where it is loaded", () => {
  const files = { "CLAUDE.md": "@a.md\n@b.md\n", "a.md": "@shared.md\n", "b.md": "@shared.md\n", "shared.md": doc(120) };
  const found = imports(files);
  assert.deepEqual(found.map((f) => f.detail.ref).sort(), ["a.md", "shared.md"]);
});

test("a root memory file is never a big-import by itself", () => {
  assert.deepEqual(imports({ "CLAUDE.md": doc(150) }), []);
});
