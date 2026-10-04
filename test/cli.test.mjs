import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main, parseArgs } from "../src/cli.mjs";
import { ciFails } from "../src/analyze.mjs";
import { ROOT, runCli, sandbox } from "./helpers.mjs";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const steps = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. First check that the build for target number ${i} is green, then run the packaging script and finally copy the artifacts to the staging bucket.`).join("\n");

// ---------------------------------------------------------------- argument parsing (in process)

test("parseArgs: defaults", () => {
  assert.deepEqual(parseArgs([]), { dir: null, budget: 2000, json: false, markdown: false, ci: false, fix: false, write: false, noUser: false, help: false, version: false });
});

test("parseArgs: every flag", () => {
  const o = parseArgs(["some/dir", "--budget", "1500", "--json", "--ci", "--fix", "--write", "--no-user"]);
  assert.deepEqual(o, { dir: "some/dir", budget: 1500, json: true, markdown: false, ci: true, fix: true, write: true, noUser: true, help: false, version: false });
  assert.equal(parseArgs(["--budget=900"]).budget, 900);
  assert.equal(parseArgs(["--markdown"]).markdown, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("parseArgs: the folder can come before or after the flags", () => {
  assert.equal(parseArgs(["--json", "x"]).dir, "x");
  assert.equal(parseArgs(["x", "--json"]).dir, "x");
});

test("parseArgs: bad input is a usage error", () => {
  assert.throws(() => parseArgs(["--budget"]), /whole number of tokens/);
  assert.throws(() => parseArgs(["--budget", "abc"]), /whole number of tokens/);
  assert.throws(() => parseArgs(["--budget", "0"]), /whole number of tokens/);
  assert.throws(() => parseArgs(["--budget", "-5"]), /whole number of tokens/);
  assert.throws(() => parseArgs(["--budget", "1.5"]), /whole number of tokens/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option --nope/);
  assert.throws(() => parseArgs(["a", "b"]), /only one folder/);
  assert.throws(() => parseArgs(["--json", "--markdown"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--write"]), /only works together with --fix/);
});

test("main() in process: output goes to the given streams and the exit code comes back", async () => {
  const s = sandbox({ "CLAUDE.md": "- Run `npm test`.\n" });
  let out = "";
  let err = "";
  const code = await main([s.dir], { stdout: { write: (x) => { out += x; }, isTTY: false }, stderr: { write: (x) => { err += x; } }, env: { ...s.env(), NO_COLOR: "1" }, home: s.home });
  assert.equal(code, 0);
  assert.match(out, /claude-md-doctor 1\.0\.1/);
  assert.equal(err, "");
});

test("main() in process: colors only on a terminal and only without NO_COLOR", async () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n" });
  const run = async (isTTY, env) => {
    let out = "";
    await main([s.dir], { stdout: { write: (x) => { out += x; }, isTTY }, stderr: { write() {} }, env: { ...s.env(), ...env }, home: s.home });
    return out;
  };
  assert.ok((await run(true, {})).includes("\x1b["));
  assert.ok(!(await run(true, { NO_COLOR: "1" })).includes("\x1b["));
  assert.ok(!(await run(false, {})).includes("\x1b["));
});

// ---------------------------------------------------------------- the real command line

test("--help lists every option and exits 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.code, 0);
  for (const flag of ["--budget", "--json", "--markdown", "--ci", "--fix", "--write", "--no-user", "--help", "--version", "CLAUDE_CONFIG_DIR", "NO_COLOR"]) assert.ok(r.out.includes(flag), flag);
  assert.equal(r.err, "");
});

test("--version prints the package version", () => {
  const r = runCli(["--version"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), pkg.version);
});

test("a bad option exits 2 with a message on stderr and nothing on stdout", () => {
  const r = runCli(["--wat"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --wat/);
  assert.match(r.err, /--help/);
  assert.equal(r.out, "");
});

test("a folder that does not exist exits 2", () => {
  const s = sandbox();
  const r = s.cli([path.join(s.base, "nope")]);
  assert.equal(r.code, 2);
  assert.match(r.err, /is not a folder/);
});

test("a file instead of a folder exits 2", () => {
  const s = sandbox({ "CLAUDE.md": "x\n" });
  assert.equal(s.cli([path.join(s.dir, "CLAUDE.md")]).code, 2);
});

test("with no folder given, the current folder is checked", () => {
  const s = sandbox({ "CLAUDE.md": "- Rule one for the project.\n" });
  const r = s.cli([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^ +\d+ {2}CLAUDE\.md$/m);
  assert.ok(r.out.includes(s.dir.replace(/\\/g, "/")));
});

test("a folder given as an argument is checked, whatever the current folder", () => {
  const s = sandbox({ "CLAUDE.md": "- Rule one for the project.\n" });
  const r = runCli([s.dir], { cwd: s.base, env: s.env() });
  assert.equal(r.code, 0);
  assert.match(r.out, /CLAUDE\.md/);
});

test("a folder with spaces and parentheses in its name works", () => {
  const s = sandbox();
  const odd = path.join(s.base, "my project (v2)");
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, "CLAUDE.md"), "- Rule one for the project.\n");
  const r = runCli([odd], { env: s.env() });
  assert.equal(r.code, 0);
  assert.match(r.out, /my project \(v2\)/);
});

test("a relative folder argument works", () => {
  const s = sandbox({ "sub/CLAUDE.md": "- Rule one for the project.\n" });
  const r = runCli(["sub"], { cwd: s.dir, env: s.env() });
  assert.equal(r.code, 0);
  assert.match(r.out, /CLAUDE\.md/);
});

// ---------------------------------------------------------------- exit codes with --ci

test("--ci passes (exit 0) when there are no errors and the budget holds", () => {
  const s = sandbox({ "CLAUDE.md": "- Run `npm test` before you commit.\n" });
  const r = s.cli(["--ci"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /CI: passed/);
});

test("--ci fails (exit 1) when the budget is exceeded", () => {
  const s = sandbox({ "CLAUDE.md": "- Run `npm test` before you commit and keep going.\n" });
  const r = s.cli(["--ci", "--budget", "5"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /CI: failed \(over budget\)/);
  assert.match(r.out, /ERROR over-budget/);
});

test("--ci fails (exit 1) on an error finding even within the budget", () => {
  const s = sandbox({ "CLAUDE.md": "See @docs/gone.md for the rules.\n" });
  const r = s.cli(["--ci"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /CI: failed \(1 error finding\)/);
});

test("--ci passes when there are only warnings and notes", () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n- Auth lives in `src/old/a.ts`.\n" });
  const r = s.cli(["--ci"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /WARN {2}stale-path/);
});

test("without --ci the exit code is 0 whatever is found", () => {
  const s = sandbox({ "CLAUDE.md": "See @docs/gone.md for the rules.\n" });
  assert.equal(s.cli([]).code, 0);
  assert.equal(s.cli(["--budget", "1"]).code, 0);
});

test("the budget is exact: a total equal to the budget passes, one over fails", () => {
  const s = sandbox({ "CLAUDE.md": "- Run `npm test` before you commit.\n" });
  const total = s.analyze().totals.alwaysInContext;
  assert.equal(s.cli(["--ci", "--budget", String(total)]).code, 0);
  assert.equal(s.cli(["--ci", "--budget", String(total - 1)]).code, 1);
});

test("--ci counts skill and agent descriptions toward the budget", () => {
  const s = sandbox({
    "CLAUDE.md": "- Rule.\n",
    ".claude/skills/a/SKILL.md": `---\nname: a\ndescription: ${"A long description of what this skill does and when to use it. ".repeat(6)}\n---\n`,
  });
  const m = s.analyze();
  assert.ok(m.totals.skills > 50);
  assert.equal(s.cli(["--ci", "--budget", String(m.totals.memory)]).code, 1);
  assert.equal(s.cli(["--ci", "--budget", String(m.totals.alwaysInContext)]).code, 0);
});

test("ciFails is true for an error finding or an exceeded budget only", () => {
  const ok = sandbox({ "CLAUDE.md": "- Rule.\n" }).analyze();
  assert.equal(ciFails(ok), false);
  assert.equal(ciFails(sandbox({ "CLAUDE.md": "- Rule.\n" }).analyze({ budget: 1 })), true);
  assert.equal(ciFails(sandbox({ "CLAUDE.md": "@gone.md\n" }).analyze()), true);
  assert.equal(ciFails(sandbox({ "CLAUDE.md": "You are a helpful assistant.\n" }).analyze()), false);
});

// ---------------------------------------------------------------- output formats

test("--json prints one JSON document and nothing else", () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n- Auth lives in `src/old/a.ts`.\n" });
  const r = s.cli(["--json"]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.schema, 1);
  assert.deepEqual(j.findings.map((f) => f.id).sort(), ["filler", "stale-path"]);
  assert.deepEqual(j.ci, { enabled: false, pass: true });
  assert.equal(r.err, "");
});

test("--json --ci reports the verdict in the document and in the exit code", () => {
  const s = sandbox({ "CLAUDE.md": "- Rule.\n" });
  const r = s.cli(["--json", "--ci", "--budget", "1"]);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).ci, { enabled: true, pass: false });
});

test("--markdown prints markdown", () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n" });
  const r = s.cli(["--markdown"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^## claude-md-doctor/);
  assert.match(r.out, /- \*\*info\*\* `filler`/);
});

test("output piped to a file or another program has no color codes", () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n" });
  const r = runCli([s.dir], { env: { ...s.env(), NO_COLOR: "" } }); // not a terminal here either way
  assert.ok(!r.out.includes("\x1b["));
});

// ---------------------------------------------------------------- what is read

test("the user memory comes from CLAUDE_CONFIG_DIR, and --no-user leaves it out", () => {
  const s = sandbox({ "CLAUDE.md": "- Project rule one.\n" });
  s.cfgFile("CLAUDE.md", "- User rule one.\n");
  const withUser = JSON.parse(s.cli(["--json"]).out);
  assert.deepEqual(withUser.files.map((f) => f.kind), ["user", "project"]);
  assert.equal(withUser.configDir, s.cfg.replace(/\\/g, "/"));
  const without = JSON.parse(s.cli(["--json", "--no-user"]).out);
  assert.deepEqual(without.files.map((f) => f.kind), ["project"]);
});

test("~/ imports use the home folder of the process", () => {
  const s = sandbox({ "CLAUDE.md": "@~/notes/mine.md\n" });
  s.homeFile("notes/mine.md", "my notes\n");
  const j = JSON.parse(s.cli(["--json"]).out);
  assert.equal(j.files.length, 2);
  assert.deepEqual(j.findings, []);
});

test("parent folders are searched up to the ceiling set in the environment", () => {
  const s = sandbox({ "CLAUDE.md": "- Project rule.\n" });
  s.baseFile("CLAUDE.md", "- Parent rule.\n");
  assert.deepEqual(JSON.parse(s.cli(["--json"]).out).files.map((f) => f.kind), ["parent", "project"]);
});

test("the tool reads files only: running it changes nothing in the project or the config folder", () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n- Auth lives in `src/old/a.ts`.\n" });
  s.cfgFile("CLAUDE.md", "- User rule.\n");
  const snapshot = () => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}:${fs.statSync(p).size}`); } };
    walk(s.base);
    return out.sort();
  };
  const before = snapshot();
  s.cli([]);
  s.cli(["--json"]);
  s.cli(["--markdown"]);
  s.cli(["--ci"]);
  assert.deepEqual(snapshot(), before);
});

// ---------------------------------------------------------------- --fix from the command line

test("--fix writes the proposal and prints the before and after totals", () => {
  const s = sandbox({ "CLAUDE.md": `You are a helpful assistant.\n\n## Release process\n\n${steps(14)}\n` });
  const r = s.cli(["--fix"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Proposal written \(your files are untouched\)/);
  assert.match(r.out, /In context every session: [\d,]+ -> [\d,]+ tokens \(saves [\d,]+, \d+%\)/);
  assert.ok(s.has("CLAUDE.md.lean"));
  assert.ok(s.has(".claude-md-doctor/proposed-skills/release-process/SKILL.md"));
  assert.match(s.read("CLAUDE.md"), /You are a helpful assistant/);
});

test("--fix --write applies it, backs up first, and a second run changes nothing", () => {
  const s = sandbox({ "CLAUDE.md": `You are a helpful assistant.\n\n## Release process\n\n${steps(14)}\n` });
  const r = s.cli(["--fix", "--write"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Applied to your files \(every original backed up first\)/);
  const backups = fs.readdirSync(s.dir).filter((f) => f.startsWith("CLAUDE.md.bak-md-doctor-"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^CLAUDE\.md\.bak-md-doctor-\d{8}-\d{6}$/);
  assert.match(s.read(backups[0]), /You are a helpful assistant/);
  assert.equal(s.read("CLAUDE.md"), "Release process: use the `release-process` skill.\n");
  assert.ok(s.has(".claude/skills/release-process/SKILL.md"));
  const memory = s.read("CLAUDE.md");
  const again = s.cli(["--fix", "--write"]);
  assert.equal(again.code, 0);
  assert.match(again.out, /Nothing to change/);
  assert.equal(s.read("CLAUDE.md"), memory);
  assert.equal(fs.readdirSync(s.dir).filter((f) => f.includes(".bak-md-doctor-")).length, 1);
});

test("--fix with --json adds what was written to the document", () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n\n- Keep it simple.\n" });
  const j = JSON.parse(s.cli(["--fix", "--json"]).out);
  assert.equal(j.fix.mode, "proposal");
  assert.deepEqual(j.fix.files, ["CLAUDE.md.lean"]);
});

test("--write without --fix is refused", () => {
  const s = sandbox({ "CLAUDE.md": "You are a helpful assistant.\n" });
  const r = s.cli(["--write"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /only works together with --fix/);
  assert.equal(s.read("CLAUDE.md"), "You are a helpful assistant.\n");
});

test("--fix with nothing to fix says so and writes nothing", () => {
  const s = sandbox({ "CLAUDE.md": "- Run `npm test` before you commit.\n" });
  const r = s.cli(["--fix"]);
  assert.match(r.out, /Nothing to change/);
  assert.deepEqual(fs.readdirSync(s.dir), ["CLAUDE.md"]);
});

test("--budget=N works as well as --budget N", () => {
  const s = sandbox({ "CLAUDE.md": "- Run `npm test` before you commit and keep going.\n" });
  assert.equal(s.cli(["--ci", "--budget=5"]).code, 1);
  assert.equal(s.cli(["--ci", "--budget=500"]).code, 0);
  assert.equal(JSON.parse(s.cli(["--json", "--budget=777"]).out).budget, 777);
});
