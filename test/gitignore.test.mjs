import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ignoredPaths, ignoreStatus } from "../src/checks/gitignore.mjs";
import { git, hasGit, of, sandbox } from "./helpers.mjs";

const repo = (files) => {
  const s = sandbox(files);
  git(s.dir, "init", "-q");
  return s;
};
const opts = { skip: !hasGit && "git is not installed" };

test("CLAUDE.local.md that is not git-ignored is flagged", opts, () => {
  const s = repo({ "CLAUDE.local.md": "- my notes\n" });
  const [f] = of(s.analyze({ git: true }), "local-not-ignored");
  assert.equal(f.severity, "warn");
  assert.equal(f.file, "CLAUDE.local.md");
  assert.equal(f.line, null);
  assert.match(f.message, /not git-ignored/);
  assert.match(f.fix, /Add "CLAUDE\.local\.md" to \.gitignore/);
});

test("it is fine when .gitignore lists it", opts, () => {
  const s = repo({ "CLAUDE.local.md": "- my notes\n", ".gitignore": "CLAUDE.local.md\n" });
  assert.deepEqual(of(s.analyze({ git: true }), "local-not-ignored"), []);
  assert.equal(ignoreStatus(s.dir), "ignored");
});

test("it is fine when a wildcard in .gitignore covers it", opts, () => {
  const s = repo({ "CLAUDE.local.md": "- my notes\n", ".gitignore": "*.local.md\n" });
  assert.deepEqual(of(s.analyze({ git: true }), "local-not-ignored"), []);
});

test("it is fine when .git/info/exclude lists it", opts, () => {
  const s = repo({ "CLAUDE.local.md": "- my notes\n" });
  fs.mkdirSync(path.join(s.dir, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(s.dir, ".git", "info", "exclude"), "CLAUDE.local.md\n");
  assert.deepEqual(of(s.analyze({ git: true }), "local-not-ignored"), []);
});

test("a committed CLAUDE.local.md is flagged with the right fix", opts, () => {
  const s = repo({ "CLAUDE.local.md": "- my notes\n", ".gitignore": "CLAUDE.local.md\n" });
  git(s.dir, "add", "-f", "CLAUDE.local.md");
  git(s.dir, "commit", "-q", "-m", "x");
  const [f] = of(s.analyze({ git: true }), "local-not-ignored");
  assert.ok(f, "tracked files are not ignored, whatever .gitignore says");
  assert.match(f.message, /committed to git/);
  assert.match(f.fix, /git rm --cached CLAUDE\.local\.md/);
  assert.equal(f.detail.tracked, true);
});

test("outside a git repository there is nothing to say", opts, () => {
  const s = sandbox({ "CLAUDE.local.md": "- my notes\n" });
  assert.deepEqual(of(s.analyze({ git: true }), "local-not-ignored"), []);
  assert.equal(ignoreStatus(s.dir), "unknown");
});

test("without a CLAUDE.local.md there is nothing to say", opts, () => {
  const s = repo({ "CLAUDE.md": "- rules\n" });
  assert.deepEqual(of(s.analyze({ git: true }), "local-not-ignored"), []);
});

test("the git check can be turned off", opts, () => {
  const s = repo({ "CLAUDE.local.md": "- my notes\n" });
  assert.deepEqual(of(s.analyze({ git: false }), "local-not-ignored"), []);
});

test("a project folder inside a larger repository uses that repository's ignore rules", opts, () => {
  const s = sandbox();
  git(s.base, "init", "-q");
  fs.writeFileSync(path.join(s.base, ".gitignore"), "CLAUDE.local.md\n");
  s.file("CLAUDE.local.md", "- notes\n");
  assert.deepEqual(of(s.analyze({ git: true }), "local-not-ignored"), []);
});

// ---------------------------------------------------------------- stale paths and .gitignore

test("a missing path that .gitignore covers is a local or generated file, not a stale one", opts, () => {
  const s = repo({ "CLAUDE.md": "Secrets live in `config/secrets.json` and data in `data/local.db`; the guide is docs/gone.md.\n", ".gitignore": "config/secrets.json\ndata/\n" });
  const found = of(s.analyze({ git: true }), "stale-path");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /^`docs\/gone\.md` does not exist$/);
  const without = of(s.analyze({ git: false }), "stale-path");
  assert.match(without[0].message, /config\/secrets\.json/);
});

test("a line that mentions an ignored path next to a stale one is not removable", opts, () => {
  const s = repo({ "CLAUDE.md": "- Local data is in `data/local.db`, the guide is docs/gone.md.\n", ".gitignore": "data/\n" });
  const [f] = of(s.analyze({ git: true }), "stale-path");
  assert.equal(f.autofix, false);
});

test("ignoredPaths answers for a list of paths in one go", opts, () => {
  const s = repo({ ".gitignore": "*.log\nbuild/\n" });
  const abs = (p) => path.join(s.dir, p);
  const got = ignoredPaths(s.dir, [abs("a.log"), abs("build/x.js"), abs("src/a.ts"), path.join(s.base, "outside.log")]);
  assert.deepEqual([...got].map((p) => path.relative(s.dir, p).split(path.sep).join("/")).sort(), ["a.log", "build/x.js"]);
  assert.equal(ignoredPaths(s.dir, []).size, 0);
});

test("ignoredPaths is empty outside a repository", opts, () => {
  const s = sandbox();
  assert.equal(ignoredPaths(s.dir, [path.join(s.dir, "a.log")]).size, 0);
});
