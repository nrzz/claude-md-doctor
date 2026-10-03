import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cleanToken, judgePath } from "../src/checks/paths.mjs";
import { dropSplitWindowsPaths } from "../src/checks/references.mjs";
import { commandRefs } from "../src/checks/commands.mjs";
import { ProjectIndex, hasLocalBin, parseJustfile, parseMakefile } from "../src/checks/projectindex.mjs";
import { sandbox } from "./helpers.mjs";

// ---------------------------------------------------------------- cleanToken

test("cleanToken strips decoration, line numbers and anchors, and keeps the path as written", () => {
  const cases = [
    ["`src/a.ts`", null], // the backticks are the caller's business: a backtick is not a path character
    ["(src/a.ts)", "src/a.ts"],
    ["\"src/a.ts\"", "src/a.ts"],
    ["**src/a.ts**", "src/a.ts"],
    ["src/a.ts,", "src/a.ts"],
    ["src/a.ts.", "src/a.ts"],
    ["src/a.ts:42", "src/a.ts"],
    ["src/a.ts:42:7", "src/a.ts"],
    ["docs/a.md#install", "docs/a.md"],
    ["_posts/2026.md", "_posts/2026.md"],
  ];
  for (const [raw, want] of cases) {
    const got = cleanToken(raw);
    assert.equal(got ? got.clean : null, want, raw);
  }
});

test("cleanToken: backslashes become slashes for lookups but the original is kept for display", () => {
  const got = cleanToken("src\\gone\\foo.ts");
  assert.deepEqual(got, { clean: "src/gone/foo.ts", shown: "src\\gone\\foo.ts" });
});

test("cleanToken rejects URLs, globs, placeholders, variables and lists", () => {
  for (const raw of [
    "https://a.com/x.md", "http://localhost:3000/a", "www.example.com/a", "mailto:a@b.c", "git@github.com:org/repo.git", "npm:left-pad",
    "src/*.ts", "src/**/*.ts", "a?.md", "src/[id].ts", "<file>/x.ts", "{a,b}/x", "${HOME}/x", "$HOME/x", "%APPDATA%/x", "a=b/c", "a,b/c.ts", "a|b/c", "x&y/z", "a+b/c", "@scope/pkg", "~/x@y",
    "//cdn.example.com/x.js", "", "   ",
  ]) {
    assert.equal(cleanToken(raw), null, JSON.stringify(raw));
  }
});

test("cleanToken: in a link, a query string and an anchor are removed", () => {
  assert.equal(cleanToken("docs/a.md?plain=1#L10", { link: true }).clean, "docs/a.md");
  assert.equal(cleanToken("docs/a.md?x=1", { link: false }), null, "outside a link a ? is a glob");
});

// ---------------------------------------------------------------- judgePath

function env(s, extra = {}) {
  return { bases: [s.dir], project: s.dir, home: s.home, allowHome: false, ...extra };
}

test("judgePath: an existing path is valid and a missing one is stale", () => {
  const s = sandbox({ "src/a.ts": "x\n", "docs/b.md": "x\n" });
  assert.equal(judgePath("src/a.ts", "code", false, env(s)).status, "valid");
  assert.equal(judgePath("src/gone.ts", "code", false, env(s)).status, "stale");
  assert.equal(judgePath("./src/a.ts", "plain", false, env(s)).status, "valid");
  assert.equal(judgePath("src/", "plain", false, env(s)).status, "valid");
  assert.equal(judgePath("old/", "plain", false, env(s)).status, "stale");
});

test("judgePath: each tier has its own bar for what counts as a path", () => {
  const s = sandbox({ "src/a.ts": "x\n" });
  // no extension, one separator: in plain text it is prose, in backticks it is a path only in some cases
  assert.equal(judgePath("client/server", "plain", false, env(s)), null);
  assert.equal(judgePath("client/server", "code", false, env(s)), null);
  assert.equal(judgePath("client/server", "code", true, env(s)).status, "stale", "the whole span is the path");
  assert.equal(judgePath("src/missing", "code", false, env(s)).status, "stale", "it starts with a folder that exists");
  assert.equal(judgePath("src/missing", "plain", false, env(s)), null);
  assert.equal(judgePath("a/b.ts", "plain", false, env(s)).status, "stale");
  assert.equal(judgePath("docs/page", "link", false, env(s)).status, "stale", "a link target is always a path");
});

test("judgePath: bare file names are only noted when they exist", () => {
  const s = sandbox({ "package.json": "{}" });
  assert.equal(judgePath("package.json", "code", true, env(s)).status, "valid");
  assert.equal(judgePath("tsconfig.json", "code", true, env(s)), null);
  assert.equal(judgePath("package.json", "plain", false, env(s)), null);
  assert.equal(judgePath("tsconfig.json", "link", false, env(s)).status, "stale", "but a link to one is checked");
});

test("judgePath: placeholders, domains, version numbers and generated folders are not judged", () => {
  const s = sandbox();
  for (const raw of ["path/to/file.ts", "your-project/src/a.ts", "xxx/yyy.ts", "github.com/a/b", "1.2/3.4", "10/20/2026", "e.g./i.e."]) {
    assert.equal(judgePath(raw, "code", true, env(s)), null, raw);
  }
  assert.equal(judgePath("dist/bundle.js", "code", false, env(s)), null, "build output may not be built yet");
  assert.equal(judgePath("node_modules/x/index.js", "plain", false, env(s)), null);
});

test("judgePath: absolute paths are judged only inside the project", () => {
  const s = sandbox({ "src/a.ts": "x\n" });
  assert.equal(judgePath(path.join(s.dir, "src", "a.ts").replace(/\\/g, "/"), "code", false, env(s)).status, "valid");
  assert.equal(judgePath(path.join(s.dir, "src", "gone.ts").replace(/\\/g, "/"), "code", false, env(s)).status, "stale");
  assert.equal(judgePath("/usr/local/etc/tool.conf", "code", false, env(s)), null);
  assert.equal(judgePath("../elsewhere/x.md", "plain", false, env(s)), null);
});

test("judgePath: ~/ paths are checked only when the caller says the file may name the home folder", () => {
  const s = sandbox();
  s.homeFile("notes/a.md", "x\n");
  assert.equal(judgePath("~/notes/a.md", "code", false, env(s)), null);
  assert.equal(judgePath("~/notes/a.md", "code", false, env(s, { allowHome: true })).status, "valid");
  assert.equal(judgePath("~/notes/b.md", "code", false, env(s, { allowHome: true })).status, "stale");
});

test("judgePath: a relative path may exist next to the file instead of at the project root", () => {
  const s = sandbox({ "docs/guide/part.md": "x\n" });
  const e = env(s, { bases: [s.dir, path.join(s.dir, "docs", "guide")] });
  assert.equal(judgePath("./part.md", "plain", false, e).status, "valid");
  assert.equal(judgePath("./other.md", "plain", false, e).status, "stale");
});

test("dropSplitWindowsPaths removes the pieces of a drive path that contains spaces", () => {
  assert.deepEqual(dropSplitWindowsPaths("see C:\\Program Files\\Tool\\tool.exe now".split(" ")), ["see", "C:\\Program", "now"]);
  assert.deepEqual(dropSplitWindowsPaths("C:\\Users\\Jo Smith\\notes.txt and src/a.ts".split(" ")), ["C:\\Users\\Jo", "and", "src/a.ts"]);
  assert.deepEqual(dropSplitWindowsPaths("C:\\Program Files (x86)\\Foo\\bar.exe ok".split(" ")), ["C:\\Program", "ok"]);
  assert.deepEqual(dropSplitWindowsPaths(["no", "drive", "here/x.ts"]), ["no", "drive", "here/x.ts"]);
  assert.deepEqual(dropSplitWindowsPaths(["C:\\Windows\\notepad.exe", "src/a.ts"]), ["C:\\Windows\\notepad.exe", "src/a.ts"], "a complete path takes nothing after it");
});

// ---------------------------------------------------------------- Makefile and justfile

test("parseMakefile finds targets, phony declarations and ignores variables and recipes", () => {
  const mk = parseMakefile([
    "CC := gcc", "VERSION ?= 1", "export FLAGS = -O2", "",
    ".PHONY: build test clean", "build: deps", "\t$(CC) -o app main.c", "test lint: build", "\techo \"x: y\"", "", "all::", "\tbuild",
    "# comment: not a target", "ifeq ($(OS),Windows_NT)", "win:", "endif",
  ].join("\n"));
  assert.deepEqual([...mk.targets].sort(), ["all", "build", "clean", "lint", "test", "win"]);
  assert.equal(mk.opaque, false);
});

test("parseMakefile marks a Makefile as opaque when it includes files or uses pattern rules", () => {
  assert.equal(parseMakefile("include common.mk\nbuild:\n").opaque, true);
  assert.equal(parseMakefile("-include local.mk\nbuild:\n").opaque, true);
  assert.equal(parseMakefile("%.o: %.c\n\tcc -c $<\n").opaque, true);
  assert.deepEqual([...parseMakefile("%.o: %.c\n\tcc\nbuild:\n").targets], ["build"]);
});

test("parseJustfile finds recipes with parameters, aliases and attributes", () => {
  const jf = parseJustfile([
    "set shell := [\"bash\", \"-c\"]", "version := \"1.0\"", "export FOO := \"bar: baz\"", "",
    "default: build", "", "build target=\"x\": test", "  echo {{target}}", "", "@quiet:", "  echo hi", "", "[private]", "helper:", "  echo", "", "alias b := build", "# comment: not a recipe",
  ].join("\n"));
  assert.deepEqual([...jf.recipes].sort(), ["b", "build", "default", "helper", "quiet"]);
  assert.equal(jf.opaque, false);
  assert.equal(parseJustfile("import 'common.just'\nbuild:\n  echo\n").opaque, true);
  assert.equal(parseJustfile("mod web\nbuild:\n  echo\n").opaque, true);
});

// ---------------------------------------------------------------- the project index

test("the project index reads scripts, dependencies and nearby packages", () => {
  const s = sandbox({
    "package.json": JSON.stringify({ scripts: { build: "x" }, dependencies: { a: "1" }, devDependencies: { b: "1" } }),
    "packages/web/package.json": JSON.stringify({ scripts: { dev: "y" } }),
    "node_modules/pkg/package.json": JSON.stringify({ scripts: { hidden: "z" } }),
    "Makefile": "all:\n",
  });
  const index = new ProjectIndex(s.dir);
  assert.deepEqual([...index.pkg(s.dir).scripts], ["build"]);
  assert.deepEqual([...index.pkg(s.dir).deps].sort(), ["a", "b"]);
  assert.deepEqual([...index.allScripts()].sort(), ["build", "dev"]);
  assert.equal(index.hasAnyManifest(), true);
  assert.equal(index.scan().makefiles.length, 1);
  assert.equal(index.pkg(path.join(s.dir, "nowhere")), null);
});

test("the project index finds files that share a name, for 'did it move?' hints", () => {
  const s = sandbox({ "src/auth/auth.ts": "x\n", "lib/auth.ts": "y\n", "README.md": "z\n" });
  const index = new ProjectIndex(s.dir);
  assert.deepEqual(index.sameName("src/old/auth.ts").sort(), ["lib/auth.ts", "src/auth/auth.ts"]);
  assert.deepEqual(index.sameName("nothing.ts"), []);
  assert.deepEqual(index.sameName("src/auth/"), ["src/auth/"], "a folder is matched by its name too");
});

test("hasLocalBin looks in node_modules/.bin", () => {
  const s = sandbox({ "node_modules/.bin/tsc": "#!/bin/sh\n", "node_modules/.bin/eslint.cmd": "@echo\n" });
  assert.equal(hasLocalBin(s.dir, "tsc"), true);
  assert.equal(hasLocalBin(s.dir, "eslint"), true);
  assert.equal(hasLocalBin(s.dir, "prettier"), false);
});

// ---------------------------------------------------------------- commandRefs directly

function cmdEnv(s) {
  return { project: s.dir, fileDir: s.dir, index: new ProjectIndex(s.dir) };
}

test("commandRefs: statuses for a chain of commands", () => {
  const s = sandbox({ "package.json": JSON.stringify({ scripts: { build: "x", test: "y" } }) });
  const refs = commandRefs("$ npm run build && npm run nope; npm test | tee out.log", cmdEnv(s));
  assert.deepEqual(refs.map((r) => [r.text, r.status]), [["npm run build", "valid"], ["npm run nope", "stale"], ["npm test", "valid"]]);
  assert.match(refs[1].message, /package\.json has no "nope" script/);
});

test("commandRefs: comments, empty text and unrelated commands give nothing", () => {
  const s = sandbox({ "package.json": "{}" });
  assert.deepEqual(commandRefs("# npm run nope", cmdEnv(s)), []);
  assert.deepEqual(commandRefs("   ", cmdEnv(s)), []);
  assert.deepEqual(commandRefs("git status && ls -la", cmdEnv(s)), []);
});

test("commandRefs: environment variables, sudo and quotes in front of a command are skipped over", () => {
  const s = sandbox({ "package.json": JSON.stringify({ scripts: { build: "x" } }) });
  const refs = commandRefs("CI=1 NODE_ENV=production sudo npm run \"build\"", cmdEnv(s));
  assert.deepEqual(refs.map((r) => r.status), ["valid"]);
});

test("commandRefs: cd carries across lines of a block through the state object", () => {
  const s = sandbox({ "package.json": JSON.stringify({ scripts: { build: "x" } }), "web/package.json": JSON.stringify({ scripts: { dev: "y" } }) });
  const state = {};
  const e = cmdEnv(s);
  assert.deepEqual(commandRefs("cd web", e, state), []);
  assert.equal(state.cwdAbs, path.join(s.dir, "web"));
  assert.deepEqual(commandRefs("npm run dev", e, state).map((r) => r.status), ["valid"]);
  assert.deepEqual(commandRefs("npm run build", e, state).map((r) => r.status), ["valid"], "defined in another package: not stale");
  assert.deepEqual(commandRefs("npm run missing", e, state).map((r) => r.status), ["stale"]);
  commandRefs("cd ../nowhere", e, state);
  assert.equal(state.cwdUnknown, true);
  assert.deepEqual(commandRefs("npm run missing", e, state), [], "after a cd we cannot follow, nothing is judged");
});
