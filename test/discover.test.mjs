import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discover, parentDirs } from "../src/discover.mjs";
import { estimateTokens } from "../src/tokens.mjs";
import { of, sandbox, tmp } from "./helpers.mjs";

const names = (m) => m.files.map((f) => f.path);

test("a project with no memory files has nothing loaded", () => {
  const s = sandbox();
  const m = s.analyze();
  assert.deepEqual(m.files, []);
  assert.equal(m.totals.alwaysInContext, 0);
  assert.deepEqual(m.findings, []);
});

test("CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md are all loaded", () => {
  const s = sandbox({ "CLAUDE.md": "# A\n", ".claude/CLAUDE.md": "# B\n", "CLAUDE.local.md": "# C\n" });
  const m = s.analyze();
  assert.deepEqual(names(m), ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]);
  assert.deepEqual(m.files.map((f) => f.kind), ["project", "project-claude", "local"]);
  assert.equal(m.totals.memory, m.files.reduce((n, f) => n + f.tokens, 0));
});

test("each file's tokens are the estimate of its text", () => {
  const text = "# Rules\n\n- Run `npm test` before committing.\n";
  const s = sandbox({ "CLAUDE.md": text });
  assert.equal(s.analyze().files[0].tokens, estimateTokens(text));
});

test("the user memory comes from the config folder, and --no-user leaves it out", () => {
  const s = sandbox({ "CLAUDE.md": "project\n" });
  s.cfgFile("CLAUDE.md", "user rules\n");
  const withUser = s.analyze();
  assert.equal(withUser.files[0].kind, "user");
  assert.equal(withUser.files.length, 2);
  const without = s.analyze({ user: false });
  assert.deepEqual(names(without), ["CLAUDE.md"]);
});

test("the config folder is the one given, never a guess", () => {
  const s = sandbox({ "CLAUDE.md": "project\n" });
  const elsewhere = tmp();
  fs.writeFileSync(path.join(elsewhere, "CLAUDE.md"), "not mine\n");
  const m = s.analyze();
  assert.ok(m.files.every((f) => !f.abs.startsWith(elsewhere)));
  assert.equal(m.configDir, s.cfg);
});

test("CLAUDE.md files in parent folders are loaded, outermost first", () => {
  const s = sandbox({ "CLAUDE.md": "project\n" });
  s.baseFile("CLAUDE.md", "parent rules\n");
  const m = s.analyze();
  assert.deepEqual(m.files.map((f) => f.kind), ["parent", "project"]);
  assert.ok(m.files[0].abs.endsWith(path.join(path.basename(s.base), "CLAUDE.md")));
});

test("parent discovery goes up through several levels", () => {
  const s = sandbox();
  const deep = path.join(s.base, "a", "b", "c");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(s.base, "CLAUDE.md"), "top\n");
  fs.writeFileSync(path.join(s.base, "a", "CLAUDE.md"), "mid\n");
  fs.writeFileSync(path.join(s.base, "a", "b", "CLAUDE.md"), "near\n");
  fs.writeFileSync(path.join(deep, "CLAUDE.md"), "here\n");
  const m = s.analyze({ dir: deep });
  assert.deepEqual(m.files.map((f) => f.kind), ["parent", "parent", "parent", "project"]);
  assert.deepEqual(m.files.map((f) => path.basename(path.dirname(f.abs))), [path.basename(s.base), "a", "b", "c"]);
});

test("parent discovery stops at the ceiling", () => {
  const s = sandbox();
  const deep = path.join(s.base, "a", "b");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(s.base, "CLAUDE.md"), "above the ceiling\n");
  fs.writeFileSync(path.join(s.base, "a", "CLAUDE.md"), "at the ceiling\n");
  const m = s.analyze({ dir: deep, ceiling: path.join(s.base, "a") });
  assert.deepEqual(names(m).map((n) => path.basename(n)), ["CLAUDE.md"]);
  assert.equal(m.files.length, 1);
  assert.ok(m.files[0].abs.includes(`${path.sep}a${path.sep}CLAUDE.md`));
});

test("parentDirs lists folders outermost first up to the ceiling", () => {
  const root = path.parse(process.cwd()).root;
  const proj = path.join(root, "x", "y", "z");
  assert.deepEqual(parentDirs(proj, path.join(root, "x")), [path.join(root, "x"), path.join(root, "x", "y")]);
  assert.deepEqual(parentDirs(proj, proj), []);
  assert.deepEqual(parentDirs(proj, path.join(root, "elsewhere")), []);
  assert.equal(parentDirs(proj)[0], root);
});

test("the same file reached twice is loaded once", () => {
  const s = sandbox({ "CLAUDE.md": "@.claude/CLAUDE.md\n", ".claude/CLAUDE.md": "inner\n" });
  const m = s.analyze();
  assert.equal(m.files.filter((f) => f.abs.endsWith(path.join(".claude", "CLAUDE.md"))).length, 1);
});

test("subfolder CLAUDE.md files are listed as on demand and not counted", () => {
  const s = sandbox({ "CLAUDE.md": "root\n", "packages/web/CLAUDE.md": "web rules\n", "packages/api/deep/CLAUDE.md": "api rules\n" });
  const m = s.analyze();
  assert.deepEqual(m.onDemand.map((f) => f.display), ["packages/api/deep/CLAUDE.md", "packages/web/CLAUDE.md"]);
  assert.equal(m.totals.onDemand, m.onDemand.reduce((n, f) => n + f.tokens, 0));
  assert.deepEqual(names(m), ["CLAUDE.md"]);
  assert.equal(m.totals.alwaysInContext, m.files[0].tokens);
});

test("dependency and build folders are not searched for on-demand files", () => {
  const s = sandbox({
    "node_modules/pkg/CLAUDE.md": "x\n", "dist/CLAUDE.md": "x\n", ".git/CLAUDE.md": "x\n", "build/x/CLAUDE.md": "x\n", "src/CLAUDE.md": "kept\n",
  });
  assert.deepEqual(s.analyze().onDemand.map((f) => f.display), ["src/CLAUDE.md"]);
});

test("a subfolder file that the memory imports is always loaded, not on demand", () => {
  const s = sandbox({ "CLAUDE.md": "@sub/CLAUDE.md\n", "sub/CLAUDE.md": "rules\n" });
  const m = s.analyze();
  assert.deepEqual(m.onDemand, []);
  assert.equal(m.files.length, 2);
});

test("skills: model-invocable descriptions count, user-only ones cost nothing", () => {
  const s = sandbox({
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy the app to staging.\n---\nbody\n",
    ".claude/skills/audit/SKILL.md": "---\nname: audit\ndescription: Audit things.\ndisable-model-invocation: true\n---\nbody\n",
  });
  const m = s.analyze();
  assert.equal(m.skills.length, 2);
  const deploy = m.skills.find((x) => x.name === "deploy");
  const audit = m.skills.find((x) => x.name === "audit");
  assert.equal(deploy.modelInvocable, true);
  assert.ok(deploy.tokens > 5);
  assert.equal(audit.modelInvocable, false);
  assert.equal(audit.tokens, 0);
  assert.equal(m.totals.skills, deploy.tokens);
  assert.equal(m.totals.alwaysInContext, deploy.tokens);
});

test("skills: folded descriptions and a name taken from the folder", () => {
  const s = sandbox({ ".claude/skills/review/SKILL.md": "---\ndescription: >\n  Review a pull\n  request carefully.\n---\nbody\n" });
  const [skill] = s.analyze().skills;
  assert.equal(skill.name, "review");
  assert.equal(skill.description, "Review a pull request carefully.");
});

test("skills and agents in the user config folder are included, --no-user drops them", () => {
  const s = sandbox();
  s.cfgFile("skills/mine/SKILL.md", "---\nname: mine\ndescription: My skill.\n---\n");
  s.cfgFile("agents/helper.md", "---\nname: helper\ndescription: Helps out.\n---\n");
  const m = s.analyze();
  assert.deepEqual(m.skills.map((x) => x.scope), ["user"]);
  assert.deepEqual(m.agents.map((x) => x.scope), ["user"]);
  const without = s.analyze({ user: false });
  assert.deepEqual(without.skills, []);
  assert.deepEqual(without.agents, []);
});

test("agents: the description is counted; the name falls back to the file name", () => {
  const s = sandbox({ ".claude/agents/reviewer.md": "---\ndescription: Reviews code for bugs.\ntools: Read\n---\nYou review.\n" });
  const m = s.analyze();
  assert.equal(m.agents[0].name, "reviewer");
  assert.ok(m.agents[0].tokens > 5);
  assert.equal(m.totals.agents, m.agents[0].tokens);
});

test("the always-in-context total is memory plus skills plus agents", () => {
  const s = sandbox({
    "CLAUDE.md": "# Rules\n\n- Be kind.\n",
    ".claude/skills/a/SKILL.md": "---\nname: a\ndescription: Does a.\n---\n",
    ".claude/agents/b.md": "---\nname: b\ndescription: Does b.\n---\n",
  });
  const t = s.analyze().totals;
  assert.equal(t.alwaysInContext, t.memory + t.skills + t.agents);
  assert.ok(t.memory > 0 && t.skills > 0 && t.agents > 0);
});

test("a binary file named CLAUDE.md is skipped with a note", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.dir, "CLAUDE.md"), Buffer.from([0x23, 0x00, 0x01, 0x02, 0x00]));
  const m = s.analyze();
  assert.deepEqual(m.files, []);
  assert.match(m.notes[0], /not a readable text file/);
});

test("CRLF line endings and a BOM do not change the count", () => {
  const lf = "# Rules\n\n- one\n- two\n";
  const a = sandbox({ "CLAUDE.md": lf }).analyze().files[0].tokens;
  const b = sandbox({ "CLAUDE.md": "﻿" + lf.replace(/\n/g, "\r\n") }).analyze().files[0].tokens;
  assert.equal(a, b);
});

test("a symlinked CLAUDE.md is read once and counts as the file it points to", (t) => {
  const s = sandbox({ "AGENTS.md": "shared rules\n" });
  try {
    fs.symlinkSync(path.join(s.dir, "AGENTS.md"), path.join(s.dir, "CLAUDE.md"));
  } catch {
    t.skip("symbolic links are not allowed here");
    return;
  }
  const m = s.analyze();
  assert.equal(m.files.length, 1);
});

// ---- imports in the load tree ----

test("an import is loaded and its tokens are counted", () => {
  const s = sandbox({ "CLAUDE.md": "See @docs/style.md for style.\n", "docs/style.md": "Use two spaces.\n" });
  const m = s.analyze();
  assert.deepEqual(names(m), ["CLAUDE.md", "docs/style.md"]);
  assert.equal(m.files[1].importedBy, "CLAUDE.md");
  assert.equal(m.files[1].importLine, 1);
  assert.equal(m.files[1].depth, 1);
  assert.equal(m.tree[0].children[0].file.display, "docs/style.md");
});

test("nested imports resolve from the importing file's folder", () => {
  const s = sandbox({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "@b.md\n", "docs/b.md": "leaf\n", "b.md": "wrong place\n" });
  assert.deepEqual(names(s.analyze()), ["CLAUDE.md", "docs/a.md", "docs/b.md"]);
});

test("~/ imports resolve against the given home folder", () => {
  const s = sandbox({ "CLAUDE.md": "@~/notes/mine.md\n" });
  s.homeFile("notes/mine.md", "my private notes\n");
  const m = s.analyze();
  assert.equal(m.files.length, 2);
  assert.ok(m.files[1].abs.startsWith(s.home));
});

test("an absolute import is loaded", () => {
  const s = sandbox();
  const target = path.join(s.base, "shared.md");
  fs.writeFileSync(target, "shared\n");
  s.file("CLAUDE.md", `@${target}\n`);
  assert.equal(s.analyze().files.length, 2);
});

test("a file imported twice is loaded and counted once", () => {
  const s = sandbox({ "CLAUDE.md": "@a.md\n@b.md\n", "a.md": "@shared.md\n", "b.md": "@shared.md\n", "shared.md": "shared text that costs something\n" });
  const m = s.analyze();
  assert.equal(m.files.filter((f) => f.path === "shared.md").length, 1);
  const bNode = m.tree[0].children[1];
  assert.equal(bNode.children[0].note, "already loaded");
  assert.equal(bNode.children[0].tokens, 0);
  assert.equal(m.totals.memory, m.files.reduce((n, f) => n + f.tokens, 0));
  assert.deepEqual(of(m, "import-error"), []);
});

test("an import cycle is reported and each file is loaded once", () => {
  const s = sandbox({ "CLAUDE.md": "@a.md\n", "a.md": "@b.md\n", "b.md": "@a.md\n" });
  const m = s.analyze();
  const errors = of(m, "import-error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /import cycle: a\.md -> b\.md -> a\.md/);
  assert.equal(errors[0].file, "b.md");
  assert.equal(errors[0].line, 1);
  assert.equal(m.files.length, 3);
});

test("a file that imports itself is a cycle", () => {
  const s = sandbox({ "CLAUDE.md": "@CLAUDE.md\n" });
  const errors = of(s.analyze(), "import-error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /import cycle/);
});

test("imports nest five levels deep and a sixth is an error", () => {
  const s = sandbox({
    "CLAUDE.md": "@l1.md\n", "l1.md": "@l2.md\n", "l2.md": "@l3.md\n", "l3.md": "@l4.md\n", "l4.md": "@l5.md\n", "l5.md": "@l6.md\n", "l6.md": "too deep\n",
  });
  const m = s.analyze();
  assert.deepEqual(names(m), ["CLAUDE.md", "l1.md", "l2.md", "l3.md", "l4.md", "l5.md"]);
  assert.equal(m.files[5].depth, 5);
  const errors = of(m, "import-error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /nested deeper than 5 levels/);
  assert.equal(errors[0].file, "l5.md");
});

test("exactly five levels of imports load without an error", () => {
  const s = sandbox({ "CLAUDE.md": "@l1.md\n", "l1.md": "@l2.md\n", "l2.md": "@l3.md\n", "l3.md": "@l4.md\n", "l4.md": "@l5.md\n", "l5.md": "end\n" });
  const m = s.analyze();
  assert.equal(m.files.length, 6);
  assert.deepEqual(of(m, "import-error"), []);
});

test("a missing import target is an error with the line number", () => {
  const s = sandbox({ "CLAUDE.md": "intro\n\nSee @docs/gone.md here.\n" });
  const [e] = of(s.analyze(), "import-error");
  assert.equal(e.severity, "error");
  assert.equal(e.file, "CLAUDE.md");
  assert.equal(e.line, 3);
  assert.match(e.message, /@docs\/gone\.md does not exist/);
});

test("mentions, scoped packages, aliases and e-mail addresses are not import errors", () => {
  const s = sandbox({ "CLAUDE.md": "Ask @someone. Types come from @types/node. Alias @/lib/x. Mail a@b.co. Use @Override and @john.doe.\n" });
  assert.deepEqual(of(s.analyze(), "import-error"), []);
});

test("an import inside a code span or a code block is not loaded and not an error", () => {
  const s = sandbox({ "CLAUDE.md": "Write `@docs/missing.md` to import.\n\n```\n@docs/also-missing.md\n```\n", "docs/missing.md": "exists but is not imported\n" });
  const m = s.analyze();
  assert.equal(m.files.length, 1);
  assert.deepEqual(of(m, "import-error"), []);
});

test("importing a folder is an error", () => {
  const s = sandbox({ "CLAUDE.md": "@./docs\n", "docs/a.md": "x\n" });
  const [e] = of(s.analyze(), "import-error");
  assert.match(e.message, /is a folder/);
});

test("importing a binary file is an error", () => {
  const s = sandbox({ "CLAUDE.md": "@image.md\n" });
  fs.writeFileSync(path.join(s.dir, "image.md"), Buffer.from([0, 1, 2, 3, 0]));
  const [e] = of(s.analyze(), "import-error");
  assert.match(e.message, /not a text file/);
});

test("imports in an imported file are found from that file's own text, not the parent's", () => {
  const s = sandbox({ "CLAUDE.md": "@a.md\n", "a.md": "text @b.md more\n", "b.md": "leaf\n" });
  assert.deepEqual(names(s.analyze()), ["CLAUDE.md", "a.md", "b.md"]);
});

test("discover() works without the analysis on top", () => {
  const s = sandbox({ "CLAUDE.md": "x\n" });
  const d = discover({ dir: s.dir, configDir: s.cfg, home: s.home, ceiling: s.base });
  assert.equal(d.files.length, 1);
  assert.equal(d.project, s.dir);
});

// ---------------------------------------------------------------- more discovery

test("two memory files that are the same file through a link are loaded once", (t) => {
  const s = sandbox({ "CLAUDE.md": "shared rules\n" });
  fs.mkdirSync(path.join(s.dir, ".claude"), { recursive: true });
  try {
    fs.symlinkSync(path.join(s.dir, "CLAUDE.md"), path.join(s.dir, ".claude", "CLAUDE.md"));
  } catch {
    t.skip("symbolic links are not allowed here");
    return;
  }
  const m = s.analyze();
  assert.equal(m.files.length, 1);
  assert.equal(m.files[0].kind, "project");
});

test("a ~\\ import (Windows style) resolves against the home folder", () => {
  const s = sandbox({ "CLAUDE.md": "@~\\notes\\mine.md\n" });
  s.homeFile("notes/mine.md", "my notes\n");
  assert.equal(s.analyze().files.length, 2);
});

test("a parent folder's CLAUDE.md imports relative to its own folder", () => {
  const s = sandbox({ "CLAUDE.md": "project\n" });
  s.baseFile("CLAUDE.md", "See @shared/rules.md\n");
  s.baseFile("shared/rules.md", "parent rules\n");
  const m = s.analyze();
  assert.deepEqual(m.files.map((f) => f.kind), ["parent", "import", "project"]);
  assert.equal(m.files[1].importedBy.endsWith("CLAUDE.md"), true);
});

test("a folder named CLAUDE.md is ignored", () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.dir, "CLAUDE.md"));
  const m = s.analyze();
  assert.deepEqual(m.files, []);
  assert.deepEqual(m.findings, []);
});

test("skills: a stray file in the skills folder is ignored, and CRLF front matter is read", () => {
  const s = sandbox({ ".claude/skills/README.md": "not a skill\n" });
  fs.mkdirSync(path.join(s.dir, ".claude", "skills", "deploy"), { recursive: true });
  fs.writeFileSync(path.join(s.dir, ".claude", "skills", "deploy", "SKILL.md"), "---\r\nname: deploy\r\ndescription: Deploy it.\r\ndisable-model-invocation: true\r\n---\r\nbody\r\n");
  const m = s.analyze();
  assert.equal(m.skills.length, 1);
  assert.equal(m.skills[0].description, "Deploy it.");
  assert.equal(m.skills[0].modelInvocable, false);
});

test("skills and agents are sorted by name so the report is stable", () => {
  const s = sandbox({
    ".claude/skills/zeta/SKILL.md": "---\nname: zeta\ndescription: Z.\n---\n",
    ".claude/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: A.\n---\n",
    ".claude/agents/b.md": "---\nname: b\ndescription: B.\n---\n",
    ".claude/agents/a.md": "---\nname: a\ndescription: A.\n---\n",
  });
  const m = s.analyze();
  assert.deepEqual(m.skills.map((x) => x.name), ["alpha", "zeta"]);
  assert.deepEqual(m.agents.map((x) => x.name), ["a", "b"]);
});

test("a skill with no description costs only its name", () => {
  const s = sandbox({ ".claude/skills/bare/SKILL.md": "---\nname: bare\n---\nbody\n" });
  const [skill] = s.analyze().skills;
  assert.equal(skill.description, "");
  assert.ok(skill.tokens >= 2 && skill.tokens <= 4, String(skill.tokens));
});

test("the project folder is the folder given, even when it is below a git repository's root", () => {
  const s = sandbox({ "CLAUDE.md": "project rules\n" });
  const sub = path.join(s.dir, "packages", "web");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "CLAUDE.md"), "web rules\n");
  const m = s.analyze({ dir: sub });
  assert.deepEqual(m.files.map((f) => [f.kind, f.path]), [["parent", s.dir.replace(/\\/g, "/") + "/CLAUDE.md"], ["project", "CLAUDE.md"]]);
});
