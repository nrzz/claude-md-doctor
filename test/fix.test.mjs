import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyFix } from "../src/fix.mjs";
import { parseFrontmatter } from "../src/frontmatter.mjs";
import { renderFix } from "../src/report.mjs";
import { estimateTokens } from "../src/tokens.mjs";
import { sandbox } from "./helpers.mjs";

const RULE = "Always run the linter and the formatter before you commit any changes to the main branch";
const steps = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. First check that the build for target number ${i} is green, then run the packaging script and finally copy the artifacts to the staging bucket.`).join("\n");

// A memory file with one of everything --fix handles.
const RICH = `# Project

You are a helpful assistant.

- Entry point is \`src/real.ts\`.
- Auth lives in \`src/old/auth.ts\`.
- Run \`npm run lint\` before committing.
- Run \`npm run build\` and \`npm test\`.
- ${RULE}
- ${RULE}

## Release process

${steps(14)}

## Style

- Use two spaces for indentation.
`;

const rich = (extra = {}) =>
  sandbox({
    "CLAUDE.md": RICH,
    "src/real.ts": "export {};\n",
    "package.json": JSON.stringify({ scripts: { build: "x", test: "y" } }),
    ...extra,
  });

const list = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
};

// ---------------------------------------------------------------- the proposal (--fix)

test("--fix writes a .lean file and proposed skills and leaves the original byte for byte", () => {
  const s = rich();
  const before = fs.readFileSync(path.join(s.dir, "CLAUDE.md"));
  const model = s.analyze();
  const result = applyFix(model, { write: false });
  assert.equal(result.mode, "proposal");
  assert.deepEqual(fs.readFileSync(path.join(s.dir, "CLAUDE.md")), before);
  assert.ok(s.has("CLAUDE.md.lean"));
  assert.ok(s.has(".claude-md-doctor/proposed-skills/release-process/SKILL.md"));
  assert.deepEqual(list(s.dir), [".claude-md-doctor/proposed-skills/release-process/SKILL.md", "CLAUDE.md", "CLAUDE.md.lean", "package.json", "src/real.ts"]);
});

test("the lean file: stale lines removed, duplicate merged, filler dropped, procedure replaced by a pointer", () => {
  const s = rich();
  applyFix(s.analyze(), { write: false });
  const lean = s.read("CLAUDE.md.lean");
  assert.equal(lean, `# Project

- Entry point is \`src/real.ts\`.
- Run \`npm run build\` and \`npm test\`.
- ${RULE}

Release process: use the \`release-process\` skill.

## Style

- Use two spaces for indentation.
`);
});

test("the proposed skill has a name, a description under 100 characters, and the section's body", () => {
  const s = rich();
  applyFix(s.analyze(), { write: false });
  const text = s.read(".claude-md-doctor/proposed-skills/release-process/SKILL.md");
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, "release-process");
  assert.ok(fm.description.length > 20 && fm.description.length < 100, fm.description);
  assert.match(text, /\n# Release process\n\n1\. First check that the build for target number 0/);
  assert.match(text, /14\. First check that the build for target number 13/);
  assert.ok(text.endsWith("\n"));
});

test("the printed totals are the real estimates before and after", () => {
  const s = rich();
  const model = s.analyze();
  const lean = model.plan.files[0].lean;
  const skillDesc = model.plan.skills[0];
  assert.equal(model.plan.before, model.totals.alwaysInContext);
  assert.equal(model.plan.files[0].after, estimateTokens(lean));
  assert.equal(model.plan.after, model.plan.before - (model.plan.files[0].before - model.plan.files[0].after) + model.plan.skillTokens);
  assert.ok(skillDesc.descTokens > 0);
  assert.ok(model.plan.after < model.plan.before / 2);
  assert.equal(model.summary.potentialSavings, model.plan.saved);
  assert.equal(model.summary.leanTotal, model.plan.after);
});

test("renderFix prints the before and after totals", () => {
  const s = rich();
  const model = s.analyze();
  const result = applyFix(model, { write: false });
  const text = renderFix(model, result);
  assert.match(text, /Proposal written \(your files are untouched\)/);
  assert.match(text, /CLAUDE\.md\.lean +[\d,]+ -> [\d,]+ tokens/);
  assert.match(text, new RegExp(`In context every session: ${model.plan.before.toLocaleString("en-US")} -> ${model.plan.after.toLocaleString("en-US")} tokens`));
  assert.match(text, /--fix --write/);
});

test("running --fix twice writes identical files", () => {
  const s = rich();
  applyFix(s.analyze(), { write: false });
  const first = [s.read("CLAUDE.md.lean"), s.read(".claude-md-doctor/proposed-skills/release-process/SKILL.md")];
  applyFix(s.analyze(), { write: false });
  assert.deepEqual([s.read("CLAUDE.md.lean"), s.read(".claude-md-doctor/proposed-skills/release-process/SKILL.md")], first);
});

test("a memory file with nothing to fix gets no .lean file", () => {
  const s = sandbox({ "CLAUDE.md": "# Project\n\n- Run `npm test` before you commit.\n" });
  const model = s.analyze();
  const result = applyFix(model, { write: false });
  assert.equal(result.nothing, true);
  assert.deepEqual(list(s.dir), ["CLAUDE.md"]);
  assert.match(renderFix(model, result), /Nothing to change/);
});

test(".lean files and the proposals folder are not read as memory on the next run", () => {
  const s = rich();
  applyFix(s.analyze(), { write: false });
  const again = s.analyze();
  assert.deepEqual(again.files.map((f) => f.path), ["CLAUDE.md"]);
  assert.deepEqual(again.onDemand, []);
  assert.deepEqual(again.skills, []);
});

// ---------------------------------------------------------------- --fix --write

test("--write backs the original up, writes the lean file in place and the skill into .claude/skills", () => {
  const s = rich();
  const original = fs.readFileSync(path.join(s.dir, "CLAUDE.md"));
  const model = s.analyze();
  const result = applyFix(model, { write: true, now: new Date(2026, 9, 4, 15, 30, 12) });
  assert.equal(result.mode, "write");
  const backup = path.join(s.dir, "CLAUDE.md.bak-md-doctor-20261004-153012");
  assert.deepEqual(result.backups, [backup]);
  assert.deepEqual(fs.readFileSync(backup), original);
  assert.equal(s.read("CLAUDE.md"), model.plan.files[0].lean);
  assert.ok(s.has(".claude/skills/release-process/SKILL.md"));
  assert.equal(s.has("CLAUDE.md.lean"), false);
  assert.equal(s.has(".claude-md-doctor"), false);
});

test("--write is idempotent: the second run changes nothing", () => {
  const s = rich();
  applyFix(s.analyze(), { write: true, now: new Date(2026, 9, 4, 15, 30, 12) });
  const snapshot = list(s.dir);
  const memory = s.read("CLAUDE.md");
  const skill = s.read(".claude/skills/release-process/SKILL.md");
  const second = s.analyze();
  const result = applyFix(second, { write: true, now: new Date(2026, 9, 4, 15, 30, 13) });
  assert.equal(result.nothing, true);
  assert.deepEqual(list(s.dir), snapshot);
  assert.equal(s.read("CLAUDE.md"), memory);
  assert.equal(s.read(".claude/skills/release-process/SKILL.md"), skill);
  assert.equal(second.plan.saved, 0);
  assert.deepEqual(second.findings.filter((f) => f.autofix), []);
});

test("after --write the lean memory has no autofixable findings left", () => {
  const s = rich();
  applyFix(s.analyze(), { write: true });
  const after = s.analyze();
  assert.deepEqual(after.findings.filter((f) => f.id !== "over-budget"), []);
  assert.ok(after.totals.alwaysInContext < 120);
});

test("an existing skill folder is never overwritten: the new skill gets another name", () => {
  const s = rich({ ".claude/skills/release-process/SKILL.md": "---\nname: release-process\ndescription: Mine.\n---\nmy own steps\n" });
  const mine = s.read(".claude/skills/release-process/SKILL.md");
  const model = s.analyze();
  assert.equal(model.plan.skills[0].slug, "release-process-2");
  applyFix(model, { write: true });
  assert.equal(s.read(".claude/skills/release-process/SKILL.md"), mine);
  assert.ok(s.has(".claude/skills/release-process-2/SKILL.md"));
  assert.match(s.read("CLAUDE.md"), /Release process: use the `release-process-2` skill\./);
});

test("--write stops before touching anything if a skill folder appeared after the analysis", () => {
  const s = rich();
  const model = s.analyze();
  s.file(".claude/skills/release-process/SKILL.md", "appeared meanwhile\n");
  assert.throws(() => applyFix(model, { write: true }), /already exists; nothing was changed/);
  assert.equal(s.read("CLAUDE.md"), RICH);
  assert.deepEqual(list(s.dir).filter((f) => f.includes(".bak-")), []);
  assert.equal(s.read(".claude/skills/release-process/SKILL.md"), "appeared meanwhile\n");
});

test("two writes in the same second do not overwrite the first backup", () => {
  const s = rich();
  const now = new Date(2026, 9, 4, 15, 30, 12);
  applyFix(s.analyze(), { write: true, now });
  // put the original back, remove the skill, and apply again within the same second
  s.file("CLAUDE.md", RICH);
  fs.rmSync(path.join(s.dir, ".claude"), { recursive: true });
  applyFix(s.analyze(), { write: true, now });
  const backups = list(s.dir).filter((f) => f.includes(".bak-md-doctor-"));
  assert.deepEqual(backups, ["CLAUDE.md.bak-md-doctor-20261004-153012", "CLAUDE.md.bak-md-doctor-20261004-153012-1"]);
});

test("each memory file the project owns gets its own lean file and backup", () => {
  const s = sandbox({
    "CLAUDE.md": "# A\n\nYou are a helpful assistant.\n\n- Keep it simple.\n",
    ".claude/CLAUDE.md": "# B\n\nWrite clean code.\n\n- Keep it small.\n",
    "CLAUDE.local.md": "# C\n\nFollow best practices.\n\n- Keep it local.\n",
  });
  const result = applyFix(s.analyze(), { write: true, now: new Date(2026, 9, 4, 1, 2, 3) });
  assert.equal(result.backups.length, 3);
  assert.equal(s.read("CLAUDE.md"), "# A\n\n- Keep it simple.\n");
  assert.equal(s.read(".claude/CLAUDE.md"), "# B\n\n- Keep it small.\n");
  assert.equal(s.read("CLAUDE.local.md"), "# C\n\n- Keep it local.\n");
  assert.ok(s.has(".claude/CLAUDE.md.bak-md-doctor-20261004-010203"));
  assert.ok(s.has("CLAUDE.local.md.bak-md-doctor-20261004-010203"));
});

test("files outside the project are never rewritten: user memory, parent folders, imports", () => {
  const s = sandbox({ "CLAUDE.md": "# Project\n\n@docs/extra.md\n", "docs/extra.md": "You are a helpful assistant.\n- Keep the docs short and tidy.\n" });
  const userText = "You are a helpful assistant.\n\n- Use pnpm.\n";
  s.cfgFile("CLAUDE.md", userText);
  s.baseFile("CLAUDE.md", "Write clean code.\n");
  const model = s.analyze();
  assert.ok(model.findings.filter((f) => f.id === "filler").length >= 3);
  const result = applyFix(model, { write: true });
  assert.equal(result.nothing, true);
  assert.equal(fs.readFileSync(path.join(s.cfg, "CLAUDE.md"), "utf8"), userText);
  assert.equal(fs.readFileSync(path.join(s.base, "CLAUDE.md"), "utf8"), "Write clean code.\n");
  assert.equal(s.read("docs/extra.md"), "You are a helpful assistant.\n- Keep the docs short and tidy.\n");
  assert.deepEqual(list(s.cfg), ["CLAUDE.md"]);
});

test("a CLAUDE.md that is a link to a file outside the project is not rewritten", (t) => {
  const s = sandbox();
  const outside = path.join(s.base, "shared-rules.md");
  fs.writeFileSync(outside, "You are a helpful assistant.\n\n- Keep it simple.\n");
  try {
    fs.symlinkSync(outside, path.join(s.dir, "CLAUDE.md"));
  } catch {
    t.skip("symbolic links are not allowed here");
    return;
  }
  const model = s.analyze();
  assert.equal(model.files[0].rewritable, false);
  const result = applyFix(model, { write: true });
  assert.equal(result.nothing, true);
  assert.equal(fs.readFileSync(outside, "utf8"), "You are a helpful assistant.\n\n- Keep it simple.\n");
});

test("CRLF line endings and a BOM survive the rewrite", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.dir, "CLAUDE.md"), "﻿# Project\r\n\r\nYou are a helpful assistant.\r\n\r\n- Keep it simple.\r\n");
  applyFix(s.analyze(), { write: true });
  const bytes = fs.readFileSync(path.join(s.dir, "CLAUDE.md"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString("utf8"), "﻿# Project\r\n\r\n- Keep it simple.\r\n");
});

// ---------------------------------------------------------------- the shape of the lean text

const leanOf = (text, extra = {}) => {
  const s = sandbox({ "CLAUDE.md": text, "src/real.ts": "x\n", "package.json": JSON.stringify({ scripts: { build: "x" } }), ...extra });
  const model = s.analyze();
  return model.plan.files.length ? model.plan.files[0].lean : null;
};

test("removing a bullet between two others leaves them together", () => {
  assert.equal(leanOf("- One of the real rules.\n- Auth lives in `src/old/a.ts`.\n- Two of the real rules.\n"), "- One of the real rules.\n- Two of the real rules.\n");
});

test("removing a paragraph between blank lines leaves one blank line", () => {
  assert.equal(leanOf("Intro paragraph about the project.\n\nYou are a helpful assistant.\n\nOutro paragraph about the project.\n"), "Intro paragraph about the project.\n\nOutro paragraph about the project.\n");
});

test("removing the last lines leaves a single trailing newline", () => {
  assert.equal(leanOf("- A real rule.\n\n- Run `npm run nope` always.\n"), "- A real rule.\n");
});

test("removing the first lines leaves no leading blank line", () => {
  assert.equal(leanOf("You are a helpful assistant.\n\n# Title\n\n- A real rule.\n"), "# Title\n\n- A real rule.\n");
});

test("a file without a trailing newline keeps that", () => {
  assert.equal(leanOf("- A real rule.\n- Auth lives in `src/old/a.ts`."), "- A real rule.");
});

test("removing a stale bullet removes its nested bullets with it", () => {
  assert.equal(leanOf("- Keep this.\n- The old module is `src/old/a.ts`:\n  - it rotates tokens\n  - it keeps sessions\n- Keep this too.\n"), "- Keep this.\n- Keep this too.\n");
});

test("a stale line inside a shell block is removed; the block stays while it has content", () => {
  const lean = leanOf("```bash\nnpm run build\nnpm run nope\n```\n");
  assert.equal(lean, "```bash\nnpm run build\n```\n");
});

test("a block with nothing left goes away, and so does the heading that only held it", () => {
  const lean = leanOf("# Project\n\n- A real rule.\n\n## Commands\n\n```bash\nnpm run nope\n```\n\n## Style\n\n- Two spaces.\n");
  assert.equal(lean, "# Project\n\n- A real rule.\n\n## Style\n\n- Two spaces.\n");
});

test("a heading whose section was already empty is left alone", () => {
  const lean = leanOf("# Project\n\n## Empty\n\n## Style\n\n- Two spaces.\n- Auth lives in `src/old/a.ts`.\n");
  assert.equal(lean, "# Project\n\n## Empty\n\n## Style\n\n- Two spaces.\n");
});

test("a table row with a stale path is removed", () => {
  const lean = leanOf("| File | Purpose |\n| --- | --- |\n| `src/real.ts` | entry |\n| `src/old/a.ts` | legacy |\n");
  assert.equal(lean, "| File | Purpose |\n| --- | --- |\n| `src/real.ts` | entry |\n");
});

test("exact repeats are merged into the first copy, near repeats are left for a person", () => {
  const a = "Always run the linter and the formatter before you commit any changes to main today";
  const b = "Always run the linter and the formatter before you commit any changes to trunk today";
  assert.equal(leanOf(`- ${a}\n- Something else entirely different about the build.\n- ${a}\n`), `- ${a}\n- Something else entirely different about the build.\n`);
  // main and trunk may be two different branches: a tool must not choose between them
  assert.equal(leanOf(`- ${a}\n- Something else entirely different about the build.\n- ${b}\n`), null);
});

test("a duplicate is kept when its original leaves the memory for a skill", () => {
  const text = `# Project\n\n## Release process\n\n- ${RULE}\n${steps(14)}\n\n## Style\n\n- ${RULE}\n`;
  const lean = leanOf(text);
  assert.match(lean, /Release process: use the `release-process` skill\./);
  assert.match(lean, new RegExp(`- ${RULE}`), "the second copy stays: the first one is no longer always loaded");
});

test("a stale line inside a section that moves to a skill is simply moved with it", () => {
  const text = `## Release process\n\n- Notes are in \`docs/old/notes.md\`.\n${steps(14)}\n`;
  const s = sandbox({ "CLAUDE.md": text });
  const model = s.analyze();
  assert.equal(model.plan.files[0].lean, "Release process: use the `release-process` skill.\n");
  assert.match(model.plan.skills[0].skillText, /docs\/old\/notes\.md/);
});

test("two sections with the same heading get two skills", () => {
  const text = `## Release process\n\n${steps(14)}\n\n## Release process\n\n${steps(14)}\n`;
  const s = sandbox({ "CLAUDE.md": text });
  const model = s.analyze();
  assert.deepEqual(model.plan.skills.map((k) => k.slug), ["release-process", "release-process-2"]);
  assert.match(model.plan.files[0].lean, /`release-process` skill\.\n\nRelease process: use the `release-process-2` skill\.\n$/);
});

test("a lean file is a fixed point: fixing it again changes nothing", () => {
  const s = rich();
  const lean = s.analyze().plan.files[0].lean;
  const t = rich();
  t.file("CLAUDE.md", lean);
  const again = t.analyze();
  assert.equal(again.plan.files.filter((f) => f.changed).length, 0);
});

test("a proposed skill is an ordinary skill that Claude can pick up from its description", () => {
  const s = rich();
  const [skill] = s.analyze().plan.skills;
  assert.doesNotMatch(skill.skillText, /disable-model-invocation/);
  assert.ok(skill.descTokens > 5 && skill.descTokens < 40, String(skill.descTokens));
});

test("--fix reports the new skill's description as part of the 'after' total", () => {
  const s = rich();
  const m = s.analyze();
  const memorySaved = m.plan.files.reduce((n, f) => n + f.before - f.after, 0);
  assert.equal(m.plan.after, m.plan.before - memorySaved + m.plan.skillTokens);
  assert.ok(m.plan.skillTokens > 0);
});
